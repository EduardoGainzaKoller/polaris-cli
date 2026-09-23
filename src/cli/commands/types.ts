import type { PolarisApp } from '../../core/app.ts';

export interface CommandContext {
  readonly app: PolarisApp;
  /** False for UIs with no picker (a pipe, a future non-interactive renderer). */
  readonly canSelect: boolean;
  /** Ask the user to choose; null when they cancelled. */
  select(title: string, options: string[], current?: string | null): Promise<string | null>;
  /**
   * A yes/no question for something destructive. There is no default: only
   * an explicit yes returns true.
   */
  confirm(question: string, details: readonly string[]): Promise<boolean>;
  /** Wipe the visible scrollback; session state is untouched. */
  clearScreen(): void;
  /** Ask the UI to shut down after this command finishes. */
  requestExit(): void;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
  /**
   * True when running this would leave the runtime inconsistent while an
   * approval is open — anything that replaces the provider session, since the
   * pending request belongs to the session being thrown away.
   */
  readonly blockedByApproval?: boolean;
  run(context: CommandContext, args: string[]): void | Promise<void>;
}

export interface ParsedCommand {
  readonly name: string;
  readonly args: string[];
}

/**
 * Returns null when the input is a plain prompt for the model.
 * `/exit` and the bare word `exit`/`quit` are both treated as commands.
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const bare = trimmed.toLowerCase();
  if (!trimmed.startsWith('/')) {
    return bare === 'exit' || bare === 'quit' ? { name: 'exit', args: [] } : null;
  }

  const [name = '', ...args] = trimmed.slice(1).split(/\s+/);
  return { name: name.toLowerCase(), args };
}
