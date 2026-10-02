import { isAbsolute } from 'node:path';
import type { CanUseTool, HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionGate } from '../../permissions/gate.ts';
import type { Capability, PermissionProfile } from '../../permissions/policy.ts';
import { isAvailable } from '../../permissions/policy.ts';
import { truncateDiff, unifiedDiff } from '../../tools/diff.ts';
import { resolveInWorkspace } from '../../tools/workspace.ts';
import { readIfExists } from '../../tools/write-file.ts';
import type { ModelEvent, ToolAccess } from '../provider.ts';

/**
 * The Claude runtime runs its own agent loop and its own tools. Polaris decides
 * which ones exist, maps each to a Polaris capability, and lets the runtime's
 * own permission callback ask the user — there is no second agent loop and no
 * second set of rules here.
 */

/** Runtime tool → what it does to the world. Anything unlisted does not exist. */
const CAPABILITIES: Record<string, Capability> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  Write: 'write',
  Edit: 'edit',
  Bash: 'command',
};

/**
 * Removed from the request outright, so the model never sees them. `tools`
 * already excludes everything not in `CAPABILITIES`; this is the second lock,
 * and it names the tools that would step outside v0.6's scope even under
 * workspace-write. MCP is not listed: `strictMcpConfig` means the only server
 * that exists is Polaris's own skill server, and the PreToolUse guard denies
 * any other tool name anyway.
 */
export const DENIED_TOOLS = ['MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'Task'];

/** The runtime tools a profile makes available, within an agent's ceiling when there is one. */
export function toolsFor(
  profile: PermissionProfile,
  capabilities?: readonly Capability[],
): string[] {
  return Object.entries(CAPABILITIES)
    .filter(
      ([, capability]) =>
        isAvailable(profile, capability) && (!capabilities || capabilities.includes(capability)),
    )
    .map(([name]) => name);
}

export function claudeAccess(
  profile: PermissionProfile,
  capabilities?: readonly Capability[],
): ToolAccess {
  return { mode: profile, runtime: 'Claude runtime', tools: toolsFor(profile, capabilities) };
}

/**
 * The runtime's official permission callback, and the only place a Claude tool
 * call is authorised. It hands the call to the same gate the Polaris tools
 * use, so the user sees one approval card whatever the provider is.
 *
 * The gate answers `allow` on its own for read-only calls and for edits under
 * workspace-write, so the user is asked exactly as often as the profile says.
 */
/**
 * Polaris's own tools, as the runtime names them: the in-process MCP server
 * `polaris` serving `load_skill`, `read_skill_reference` and — for the main
 * agent — `delegate_task`. They go to Polaris's context manager and agent
 * manager, never the workspace, so they need no approval and no boundary
 * check here (an agent's session meets its own gate) — and they are all the
 * MCP there is.
 */
export const SKILL_SERVER = 'polaris';
export const SKILL_TOOL_NAMES = [
  `mcp__${SKILL_SERVER}__load_skill`,
  `mcp__${SKILL_SERVER}__read_skill_reference`,
  `mcp__${SKILL_SERVER}__delegate_task`,
] as const;

function isSkillTool(name: string): boolean {
  return (SKILL_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Decisions the PreToolUse hook already made, by tool-use id, so the
 * permission callback — when the runtime still calls it — never asks twice.
 */
export type ClaudeDecisions = Map<string, { allowed: boolean; reason: string }>;

export function permissionBridge(
  cwd: string,
  gate: PermissionGate,
  decisions: ClaudeDecisions = new Map(),
): CanUseTool {
  return async (toolName, input, { signal, toolUseID }) => {
    if (isSkillTool(toolName)) return { behavior: 'allow', updatedInput: input };
    const known = toolUseID ? decisions.get(toolUseID) : undefined;
    if (known) {
      decisions.delete(toolUseID);
      return known.allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: known.reason };
    }
    const verdict = await authorizeCall(cwd, gate, toolName, input, signal);
    return verdict.allowed
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: verdict.reason };
  };
}

/**
 * One Claude tool call through Polaris's policy. The runtime's own tool input
 * is described as a Polaris operation, so the policy decides by what the call
 * does, not by which tool name it has.
 */
async function authorizeCall(
  cwd: string,
  gate: PermissionGate,
  toolName: string,
  input: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<{ allowed: boolean; reason: string }> {
  const capability = CAPABILITIES[toolName];
  if (!capability) return { allowed: false, reason: `${toolName} is not available in Polaris.` };
  const { replacesLines, ...card } = await describe(toolName, input, cwd);
  const path = [input.file_path, input.path].find((value) => typeof value === 'string');
  const verdict = await gate.authorize(
    {
      capability,
      target: card.target,
      ...(capability !== 'command' && typeof path === 'string' ? { paths: [path] } : {}),
      ...(capability === 'command' ? { command: String(input.command ?? ''), cwd } : {}),
      ...(replacesLines ? { replacesLines } : {}),
    },
    card,
    signal,
  );
  return verdict.allowed
    ? { allowed: true, reason: verdict.decision?.reason ?? 'Allowed by Polaris.' }
    : { allowed: false, reason: verdict.reason };
}

/** Builds the approval card from the runtime's own tool input. */
async function describe(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{
  title: string;
  target: string;
  facts?: string[];
  diff?: string;
  replacesLines?: number;
}> {
  const path = typeof input.file_path === 'string' ? input.file_path : '';
  const shown = path ? relativeTo(cwd, path) : '';

  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    return {
      title: 'Run command',
      target: command,
      facts: [`cwd: ${cwd}`, ...(typeof input.description === 'string' ? [input.description] : [])],
    };
  }
  if (toolName === 'Write') {
    const content = typeof input.content === 'string' ? input.content : '';
    const before = await safeRead(cwd, path);
    const lines = content.split('\n').length;
    return {
      title: 'Write',
      target: shown,
      facts: [before === null ? `New file · ${lines} lines` : `Replaces ${shown}`],
      ...(before === null ? {} : { replacesLines: before.split('\n').length }),
      diff: truncateDiff(
        before === null
          ? content
              .split('\n')
              .map((line) => `+${line}`)
              .join('\n')
          : unifiedDiff(shown, before, content),
      ),
    };
  }
  if (toolName === 'Edit') {
    const before = await safeRead(cwd, path);
    const oldText = typeof input.old_string === 'string' ? input.old_string : '';
    const newText = typeof input.new_string === 'string' ? input.new_string : '';
    // The diff is built from the runtime's own strings, so the card shows the
    // change that will actually be applied rather than a paraphrase of it.
    const after =
      before === null
        ? null
        : input.replace_all === true
          ? before.split(oldText).join(newText)
          : before.replace(oldText, newText);
    return {
      title: 'Edit',
      target: shown,
      ...(before !== null && after !== null
        ? { diff: truncateDiff(unifiedDiff(shown, before, after)) }
        : {
            diff: [
              ...oldText.split('\n').map((line) => `-${line}`),
              ...newText.split('\n').map((line) => `+${line}`),
            ].join('\n'),
          }),
    };
  }
  return { title: toolName, target: shown || String(input.pattern ?? '') };
}

async function safeRead(cwd: string, path: string): Promise<string | null> {
  if (!path) return null;
  try {
    return await readIfExists(await resolveInWorkspace(cwd, path));
  } catch {
    return null;
  }
}

/**
 * A PreToolUse hook runs before every permission rule and its deny cannot be
 * overridden, so it is where the workspace boundary is enforced — with the same
 * symlink-aware check the Polaris tools use. It is the sandbox to
 * `permissionBridge`'s approval: the bridge decides whether to ask, this
 * decides what is reachable at all.
 */
export function workspaceGuard(
  cwd: string,
  profile: PermissionProfile,
  gate?: PermissionGate,
  decisions: ClaudeDecisions = new Map(),
  capabilities?: readonly Capability[],
): HookCallback {
  const allowed = toolsFor(profile, capabilities);
  return async (input, toolUseID, options) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    });

    if (isSkillTool(input.tool_name)) return {};
    if (!allowed.includes(input.tool_name)) {
      return deny(`${input.tool_name} is not available under the "${profile}" permission profile.`);
    }

    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const paths = [toolInput.file_path, toolInput.path].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    // An absolute glob would search outside the workspace no matter what `path` says.
    const pattern = toolInput.pattern;
    if (input.tool_name === 'Glob' && typeof pattern === 'string' && isAbsolute(pattern)) {
      paths.push(pattern.split(/[*?[{]/)[0] ?? pattern);
    }

    for (const path of paths) {
      try {
        await resolveInWorkspace(cwd, path);
      } catch {
        return deny('Path is outside the workspace.');
      }
    }
    if (!gate) return {};

    // The runtime approves some commands on its own — `ls`, `find`, even
    // `git status && … && git diff` — without ever calling canUseTool. This
    // hook runs for every call, so Polaris's policy decides here, and the
    // answer is handed to canUseTool in case the runtime asks it as well.
    const verdict = await authorizeCall(cwd, gate, input.tool_name, toolInput, options?.signal);
    if (toolUseID) decisions.set(toolUseID, verdict);
    if (!verdict.allowed) return deny(verdict.reason);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'allow' as const,
        permissionDecisionReason: verdict.reason,
      },
    };
  };
}

/**
 * Turns runtime messages into tool events. Calls come from the complete
 * assistant message (which carries the full input); results come back in the
 * following user message, matched by the runtime's own tool_use id.
 */
export class ClaudeToolTranslator {
  readonly #started = new Map<string, string>();
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  translate(message: SDKMessage): ModelEvent[] {
    if (message.type === 'assistant') return this.#calls(message.message.content);
    if (message.type === 'user') return this.#results(message.message.content);
    return [];
  }

  #calls(content: unknown): ModelEvent[] {
    const events: ModelEvent[] = [];
    for (const block of blocks(content)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
      if (this.#started.has(block.id)) continue;
      // Skill loads are reported by Polaris's context manager, under the
      // skill's own name — never as `mcp__polaris__load_skill`.
      if (isSkillTool(String(block.name ?? ''))) continue;
      const name = String(block.name ?? 'Tool');
      this.#started.set(block.id, name);
      events.push({
        type: 'tool-start',
        id: block.id,
        name: label(name),
        target: targetOf(name, block.input, this.#cwd),
        ...changedPath(name, block.input),
      });
    }
    return events;
  }

  #results(content: unknown): ModelEvent[] {
    const events: ModelEvent[] = [];
    for (const block of blocks(content)) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
      const name = this.#started.get(block.tool_use_id);
      if (!name) continue;
      this.#started.delete(block.tool_use_id);
      const text = resultText(block.content);
      if (block.is_error === true) {
        const message = firstLine(text) || 'Tool failed.';
        events.push({
          type: 'tool-error',
          id: block.tool_use_id,
          error: message,
          // A refusal reads differently from a failure, in the transcript and
          // in the icon; the gate's own wording is what identifies it.
          ...(isDenial(message) ? { denied: true } : {}),
        });
        continue;
      }
      events.push({
        type: 'tool-result',
        id: block.tool_use_id,
        summary: summarize(name, text),
      });
    }
    return events;
  }
}

/** The file a native Write or Edit is about to change, in the event's terms. */
function changedPath(name: string, input: unknown): { paths?: readonly string[] } {
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return {};
  const value = (input ?? {}) as Record<string, unknown>;
  const path = value.file_path ?? value.notebook_path;
  return typeof path === 'string' ? { paths: [path] } : {};
}

function isDenial(message: string): boolean {
  return /denied by the user|not permitted under|no approval surface/i.test(message);
}

/** The runtime's tool names, in Polaris's vocabulary. */
function label(name: string): string {
  return name === 'Bash' ? 'Run' : name;
}

type Block = Record<string, unknown> & { type?: unknown };

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? (content.filter((block) => typeof block === 'object') as Block[])
    : [];
}

function targetOf(name: string, input: unknown, cwd: string): string {
  const value = (input ?? {}) as Record<string, unknown>;
  if (name === 'Bash' && typeof value.command === 'string') return value.command;
  if (typeof value.file_path === 'string') return relativeTo(cwd, value.file_path);
  if (typeof value.pattern === 'string') {
    return name === 'Grep' ? `"${value.pattern}"` : value.pattern;
  }
  return '';
}

function relativeTo(cwd: string, path: string): string {
  const normalizedCwd = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  const normalized = path.replaceAll('\\', '/');
  return normalized.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)
    ? normalized.slice(normalizedCwd.length + 1)
    : normalized;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return blocks(content)
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}

/** A best-effort count from the runtime's own output, which has no metadata. */
function summarize(name: string, text: string): string {
  if (/^\s*no (files|matches) found/i.test(text)) return name === 'Glob' ? '0 files' : 'no matches';
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (name === 'Read') return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
  if (name === 'Glob') return `${lines} ${lines === 1 ? 'file' : 'files'}`;
  if (name === 'Grep')
    return lines === 0 ? 'no matches' : `${lines} ${lines === 1 ? 'result' : 'results'}`;
  if (name === 'Write' || name === 'Edit') return 'applied';
  if (name === 'Bash') return `${lines} ${lines === 1 ? 'line' : 'lines'} of output`;
  return 'done';
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').slice(0, 200);
}
