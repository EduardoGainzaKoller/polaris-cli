import type { PermissionGate } from '../permissions/gate.ts';
import type { Capability, PermissionProfile } from '../permissions/policy.ts';
import { isAvailable } from '../permissions/policy.ts';
import type { ToolAccess } from '../providers/provider.ts';
import { editFileTool } from './edit-file.ts';
import { globFiles } from './glob-files.ts';
import { grepText } from './grep-text.ts';
import { readFile } from './read-file.ts';
import { runCommandTool } from './run-command.ts';
import { ToolError } from './workspace.ts';
import { writeFileTool } from './write-file.ts';

export interface ToolContext {
  /** Workspace root; every path a tool touches must resolve inside it. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  /**
   * The state the approval was granted against, handed back to `execute` so a
   * mutating tool can refuse a change the user never actually saw.
   */
  readonly fingerprint?: string | null;
  /** Live output while the tool runs; the UI shows it, the model does not. */
  readonly onOutput?: (text: string) => void;
}

export interface ToolOutput {
  /** What the model reads. */
  readonly content: string;
  /** One line for the UI, e.g. "84 lines" — computed here so nobody parses `content`. */
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** What the user is shown before authorising a mutating call. */
export interface ToolPreview {
  /**
   * A fuller name for the approval card when the transcript label is too
   * terse to judge on its own ("Run" is a fine row; "Run command" is what a
   * person needs to read before saying yes).
   */
  readonly title?: string;
  /** Short rows under the title: `cwd: …`, `New file · 12 lines`. */
  readonly facts?: readonly string[];
  /** Unified diff of the proposed change, already cut to a readable size. */
  readonly diff?: string;
  /**
   * A hash of what the change was computed against, or null when the tool has
   * no meaningful prior state. `execute` receives it back and re-checks it.
   */
  readonly fingerprint: string | null;
  /** Where a command would run, resolved inside the workspace. */
  readonly cwd?: string;
  /** For a write replacing an existing file wholesale: its current length. */
  readonly replacesLines?: number;
}

/** JSON Schema subset the tools use; providers pass it through unchanged. */
export interface InputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export interface ToolDefinition<TInput = unknown> {
  /** Wire name the model calls. */
  readonly name: string;
  /** Human name shown in the UI. */
  readonly title: string;
  /** What this tool does to the world; the permission profile decides the rest. */
  readonly capability: Capability;
  readonly description: string;
  readonly inputSchema: InputSchema;
  /** Validates untrusted model input; throws ToolError when it is malformed. */
  parse(input: unknown): TInput;
  /** Short description of what the call is about, e.g. the path or pattern. */
  target(input: TInput): string;
  /**
   * Describes the change before it happens, for the approval card. Read-only
   * tools omit it: there is nothing to approve.
   */
  preview?(input: TInput, context: ToolContext): Promise<ToolPreview>;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

export type ToolCallResult =
  | {
      readonly ok: true;
      readonly title: string;
      readonly target: string;
      readonly output: ToolOutput;
    }
  | {
      readonly ok: false;
      readonly title: string;
      readonly target: string;
      readonly error: string;
      /** True when a person said no — not a failure the model should retry. */
      readonly denied?: boolean;
    };

/**
 * The tools Polaris executes itself. Which ones exist is a capability question
 * and is answered here, by the profile; whether a call may proceed is a
 * permission question and is answered by the gate, per call.
 */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, ToolDefinition>;
  readonly #gate: PermissionGate | undefined;

  constructor(tools: readonly ToolDefinition[], gate?: PermissionGate) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.#gate = gate;
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /**
   * Human name and target for a call about to run, without executing it, and
   * the file it will change when it is a write or an edit.
   */
  preview(
    name: string,
    input: unknown,
  ): { title: string; target: string; paths?: readonly string[] } {
    const tool = this.#tools.get(name);
    if (!tool) return { title: name, target: '' };
    try {
      const target = tool.target(tool.parse(input));
      const changes = tool.capability === 'write' || tool.capability === 'edit';
      return { title: tool.title, target, ...(changes ? { paths: [target] } : {}) };
    } catch {
      return { title: tool.title, target: '' };
    }
  }

  /**
   * Runs one call. Anything the model can recover from — bad input, a missing
   * file, a path outside the workspace, a refused approval — comes back as
   * `ok: false` for the model to read. Only cancellation propagates as an
   * exception, because it ends the turn rather than informing it.
   *
   * Nothing happens before the gate answers: the preview reads, the approval
   * waits, and only then does `execute` touch anything.
   */
  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolCallResult> {
    const tool = this.#tools.get(name);
    if (!tool) return { ok: false, title: name, target: '', error: `Unknown tool "${name}".` };

    let parsed: unknown;
    try {
      parsed = tool.parse(input);
    } catch (error) {
      return { ok: false, title: tool.title, target: '', error: describe(error) };
    }
    const target = tool.target(parsed);
    const fail = (error: string, denied?: boolean) => ({
      ok: false as const,
      title: tool.title,
      target,
      error,
      ...(denied ? { denied: true } : {}),
    });

    try {
      context.signal?.throwIfAborted();

      let fingerprint: string | null | undefined;
      if (this.#gate && tool.capability !== 'read') {
        let preview: ToolPreview = { fingerprint: null };
        try {
          preview = (await tool.preview?.(parsed, context)) ?? preview;
        } catch (error) {
          // A preview that cannot be computed is a change that cannot be
          // approved: an unreadable file, a path outside the workspace.
          if (context.signal?.aborted) throw error;
          return fail(describe(error));
        }
        const changes = tool.capability === 'write' || tool.capability === 'edit';
        const verdict = await this.#gate.authorize(
          {
            capability: tool.capability,
            target,
            ...(changes ? { paths: [target] } : {}),
            ...(tool.capability === 'command' ? { command: target } : {}),
            ...(preview.cwd ? { cwd: preview.cwd } : {}),
            ...(preview.replacesLines ? { replacesLines: preview.replacesLines } : {}),
          },
          {
            title: preview.title ?? tool.title,
            target,
            ...(preview.facts ? { facts: preview.facts } : {}),
            ...(preview.diff ? { diff: preview.diff } : {}),
          },
          context.signal,
        );
        if (!verdict.allowed) return fail(verdict.reason, true);
        fingerprint = preview.fingerprint;
      }

      const output = await tool.execute(parsed, {
        ...context,
        ...(fingerprint === undefined ? {} : { fingerprint }),
      });
      return { ok: true, title: tool.title, target, output };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return fail(describe(error));
    }
  }
}

/** Every tool Polaris can execute, in the order /tools lists them. */
const ALL_TOOLS = [
  readFile,
  globFiles,
  grepText,
  writeFileTool,
  editFileTool,
  runCommandTool,
] as ToolDefinition[];

/**
 * The tools a profile makes available. A denied capability is not offered to
 * the model at all — under `read-only` there is no `write_file` to call, which
 * is a stronger guarantee than a prompt that says not to.
 */
export function createRegistry(
  profile: PermissionProfile,
  gate?: PermissionGate,
  capabilities?: readonly Capability[],
): ToolRegistry {
  return new ToolRegistry(available(profile, capabilities), gate);
}

/** How Polaris-executed tools are described to the UI and to /tools. */
export function polarisAccess(
  profile: PermissionProfile,
  capabilities?: readonly Capability[],
): ToolAccess {
  return {
    mode: profile,
    runtime: 'Polaris',
    tools: available(profile, capabilities).map((tool) => tool.name),
  };
}

/** The profile's tools, within an agent's ceiling when there is one. */
function available(
  profile: PermissionProfile,
  capabilities: readonly Capability[] | undefined,
): ToolDefinition[] {
  return ALL_TOOLS.filter(
    (tool) =>
      isAvailable(profile, tool.capability) &&
      (!capabilities || capabilities.includes(tool.capability)),
  );
}

/** Capability of a Polaris tool by wire name, for /tools. */
export function capabilityOf(name: string): Capability | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name)?.capability;
}

/** Filesystem errors become sentences; nothing else about the host leaks. */
function describe(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'File not found.';
  if (code === 'EACCES' || code === 'EPERM') return 'Permission denied.';
  if (code === 'EISDIR') return 'Path is a directory; use glob_files to list it.';
  return error instanceof Error ? error.message : 'Tool failed.';
}
