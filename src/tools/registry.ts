import { globFiles } from './glob-files.ts';
import { grepText } from './grep-text.ts';
import { readFile } from './read-file.ts';
import { ToolError } from './workspace.ts';

export interface ToolContext {
  /** Workspace root; every path a tool touches must resolve inside it. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface ToolOutput {
  /** What the model reads. */
  readonly content: string;
  /** One line for the UI, e.g. "84 lines" — computed here so nobody parses `content`. */
  readonly summary: string;
  readonly metadata: Readonly<Record<string, unknown>>;
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
  readonly description: string;
  readonly inputSchema: InputSchema;
  /** Validates untrusted model input; throws ToolError when it is malformed. */
  parse(input: unknown): TInput;
  /** Short description of what the call is about, e.g. the path or pattern. */
  target(input: TInput): string;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

export type ToolCallResult =
  | {
      readonly ok: true;
      readonly title: string;
      readonly target: string;
      readonly output: ToolOutput;
    }
  | { readonly ok: false; readonly title: string; readonly target: string; readonly error: string };

/**
 * The tools Polaris executes itself. In v0.5 the set is fixed and read-only by
 * construction: none of them opens a file for writing, and there is no option
 * to add one that does.
 */
export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, ToolDefinition>;

  constructor(tools: readonly ToolDefinition[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** Human name and target for a call about to run, without executing it. */
  preview(name: string, input: unknown): { title: string; target: string } {
    const tool = this.#tools.get(name);
    if (!tool) return { title: name, target: '' };
    try {
      return { title: tool.title, target: tool.target(tool.parse(input)) };
    } catch {
      return { title: tool.title, target: '' };
    }
  }

  /**
   * Runs one call. Anything the model can recover from — bad input, a missing
   * file, a path outside the workspace — comes back as `ok: false` for the
   * model to read. Only cancellation propagates as an exception, because it
   * ends the turn rather than informing it.
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

    try {
      context.signal?.throwIfAborted();
      const output = await tool.execute(parsed, context);
      return { ok: true, title: tool.title, target, output };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      return { ok: false, title: tool.title, target, error: describe(error) };
    }
  }
}

/** How Polaris-executed tools are described to the UI and to /tools. */
export const POLARIS_TOOL_ACCESS = {
  mode: 'read-only',
  runtime: 'Polaris',
  tools: ['read_file', 'glob_files', 'grep_text'],
} as const;

export function createReadOnlyRegistry(): ToolRegistry {
  return new ToolRegistry([readFile, globFiles, grepText] as ToolDefinition[]);
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
