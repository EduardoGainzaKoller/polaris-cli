import { isAbsolute } from 'node:path';
import type { HookCallback, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolveInWorkspace } from '../../tools/workspace.ts';
import type { ModelEvent, ToolAccess } from '../provider.ts';

/**
 * The Claude runtime runs its own agent loop and its own tools; Polaris decides
 * which ones exist and translates what they do into the shared event protocol.
 */

/** The only built-in tools the runtime is given. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

/**
 * Removed from the request outright, so the model never even sees them. The
 * `tools` list above already excludes them; this is the second lock.
 */
export const DENIED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'mcp__*',
];

export const CLAUDE_TOOL_ACCESS: ToolAccess = {
  mode: 'read-only',
  runtime: 'Claude runtime',
  tools: [...READ_ONLY_TOOLS],
};

/**
 * A PreToolUse hook runs before every permission rule and its deny cannot be
 * overridden, so it is where the workspace boundary is enforced — with the same
 * symlink-aware check the Polaris tools use. Anything that is not one of the
 * three read-only tools is denied as well, whatever else the runtime allows.
 */
export function workspaceGuard(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};

    const deny = (reason: string) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: reason,
      },
    });

    if (!(READ_ONLY_TOOLS as readonly string[]).includes(input.tool_name)) {
      return deny(`${input.tool_name} is not available: Polaris is read-only.`);
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
    return {};
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
      const name = String(block.name ?? 'Tool');
      this.#started.set(block.id, name);
      events.push({
        type: 'tool-start',
        id: block.id,
        name,
        target: targetOf(name, block.input, this.#cwd),
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
      events.push(
        block.is_error === true
          ? { type: 'tool-error', id: block.tool_use_id, error: firstLine(text) || 'Tool failed.' }
          : { type: 'tool-result', id: block.tool_use_id, summary: summarize(name, text) },
      );
    }
    return events;
  }
}

type Block = Record<string, unknown> & { type?: unknown };

function blocks(content: unknown): Block[] {
  return Array.isArray(content)
    ? (content.filter((block) => typeof block === 'object') as Block[])
    : [];
}

function targetOf(name: string, input: unknown, cwd: string): string {
  const value = (input ?? {}) as Record<string, unknown>;
  if (name === 'Read' && typeof value.file_path === 'string')
    return relativeTo(cwd, value.file_path);
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
  return 'done';
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').slice(0, 200);
}
