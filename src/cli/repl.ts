import * as readline from 'node:readline/promises';
import { toUserMessage } from '../core/errors.ts';
import { debug, isDebug } from '../core/logger.ts';
import type { Session } from '../core/session.ts';
import { ui } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { createRegistry } from './commands/builtin.ts';
import { CommandRegistry } from './commands/registry.ts';
import { parseCommand } from './commands/types.ts';

const PROMPT = `${theme.accent('❯')} `;

/**
 * Interrupt policy (deliberately close to what a shell does):
 *   - while the model is answering, Ctrl+C cancels that turn only;
 *   - while typing, Ctrl+C discards the current line and arms an exit;
 *   - Ctrl+C again on an empty line, or Ctrl+D, exits.
 */
export async function runRepl(session: Session): Promise<void> {
  const registry = createRegistry(new CommandRegistry());
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    // Piped stdin (scripts, tests) must not go through the terminal line editor.
    terminal: process.stdin.isTTY === true,
    historySize: 200,
    prompt: PROMPT,
  });

  let exiting = false;
  let exitArmed = false;
  let turnAbort: AbortController | null = null;

  const context = {
    session,
    requestExit: () => {
      exiting = true;
    },
    clearScreen: () => ui.clearScreen(),
  };

  rl.on('SIGINT', () => {
    if (turnAbort) {
      turnAbort.abort();
      return;
    }
    if (rl.line.length === 0 && exitArmed) {
      exiting = true;
      rl.close();
      return;
    }
    clearInputLine(rl);
    exitArmed = true;
    ui.line();
    ui.info('(press Ctrl+C again or type /exit to quit)');
    rl.prompt();
  });

  rl.prompt();
  for await (const line of rl) {
    // Stop readline from consuming buffered input while this turn runs.
    rl.pause();
    exitArmed = false;

    if (line.trim().length > 0) {
      try {
        await handle(line);
      } catch (error) {
        reportError(error);
      }
    }

    if (exiting) break;
    rl.prompt();
  }

  rl.close();
  await session.close();
  ui.line();
  ui.line(theme.dim('Goodbye.'));

  async function handle(line: string): Promise<void> {
    const parsed = parseCommand(line);
    if (parsed) {
      const command = registry.get(parsed.name);
      if (!command) {
        ui.error(`Unknown command /${parsed.name} — try /help`);
        ui.line();
        return;
      }
      debug('repl', 'command', parsed.name);
      await command.run(context, parsed.args);
      return;
    }

    turnAbort = new AbortController();
    try {
      ui.line();
      ui.assistant(await session.prompt(line, turnAbort.signal));
    } catch (error) {
      if (turnAbort.signal.aborted) {
        ui.line();
        ui.info('Cancelled.');
        ui.line();
      } else {
        reportError(error);
      }
    } finally {
      turnAbort = null;
    }
  }
}

/** Same effect as Ctrl+U: drop whatever the user had typed. */
function clearInputLine(rl: readline.Interface): void {
  if (rl.line.length > 0) rl.write(null, { ctrl: true, name: 'u' });
}

function reportError(error: unknown): void {
  ui.error(toUserMessage(error));
  ui.line();
  if (isDebug() && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
}
