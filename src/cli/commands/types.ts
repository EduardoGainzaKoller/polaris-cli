import type { Session } from '../../core/session.ts';

export interface CommandContext {
  readonly session: Session;
  /** Ask the REPL to shut down after this command finishes. */
  requestExit(): void;
  /** Wipe the visible scrollback without touching session state. */
  clearScreen(): void;
}

export interface Command {
  readonly name: string;
  readonly summary: string;
  readonly aliases?: readonly string[];
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
