import * as readline from 'node:readline/promises';
import type { AppState, PolarisApp, UiMessage } from '../core/app.ts';
import { toUserMessage } from '../core/errors.ts';
import { debug, isDebug } from '../core/logger.ts';
import { ui } from '../ui/output.ts';
import { theme } from '../ui/theme.ts';
import { createRegistry } from './commands/builtin.ts';
import { CommandRegistry } from './commands/registry.ts';
import { parseCommand } from './commands/types.ts';

const PROMPT = `${theme.accent('❯')} `;

/**
 * The line-based renderer, used when Polaris is not attached to a terminal
 * (pipes, scripts, CI) and as the fallback for terminals that cannot host the
 * TUI. It drives the same `PolarisApp` as the full-screen UI — the controller
 * is the only thing that talks to providers.
 *
 * Interrupt policy: while a turn is running, Ctrl+C cancels that turn only;
 * while typing, it clears the line and arms an exit; a second Ctrl+C on an
 * empty line, or Ctrl+D, exits.
 */
export async function runRepl(app: PolarisApp): Promise<void> {
  const registry = createRegistry(new CommandRegistry());
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    historySize: 200,
    prompt: PROMPT,
  });

  let exiting = false;
  let exitArmed = false;

  const printer = createPrinter();
  const unsubscribe = app.subscribe(printer.render);

  rl.on('SIGINT', () => {
    if (app.cancel()) return;
    if (rl.line.length === 0 && exitArmed) {
      exiting = true;
      rl.close();
      return;
    }
    if (rl.line.length > 0) rl.write(null, { ctrl: true, name: 'u' });
    exitArmed = true;
    ui.line();
    ui.info('(press Ctrl+C again or type /exit to quit)');
    rl.prompt();
  });

  ui.banner(app.cwd, app.state.provider, app.state.model);
  rl.prompt();

  for await (const line of rl) {
    rl.pause();
    exitArmed = false;
    if (line.trim().length > 0) {
      try {
        await handle(line);
      } catch (error) {
        ui.error(toUserMessage(error));
        if (isDebug() && error instanceof Error && error.stack) {
          process.stderr.write(`${error.stack}\n`);
        }
      }
    }
    if (exiting) break;
    rl.prompt();
  }

  unsubscribe();
  rl.close();
  ui.line();
  ui.line(theme.dim('Goodbye.'));

  async function handle(line: string): Promise<void> {
    const parsed = parseCommand(line);
    if (!parsed) {
      ui.line();
      await app.submit(line);
      return;
    }
    const command = registry.get(parsed.name);
    if (!command) {
      ui.error(`Unknown command /${parsed.name} — try /help`);
      ui.line();
      return;
    }
    debug('repl', 'command', parsed.name);
    await command.run(
      {
        app,
        // No picker without a terminal: commands ask for an explicit argument.
        canSelect: false,
        select: async () => null,
        // The prompt is paused while a command runs, so there is nobody to
        // answer; a destructive command explains how to confirm explicitly.
        confirm: async (question) => {
          ui.info(`${question} Re-run with --yes to confirm without the interactive UI.`);
          return false;
        },
        clearScreen: () => ui.clearScreen(),
        requestExit: () => {
          exiting = true;
        },
      },
      parsed.args,
    );
  }
}

/**
 * Turns transcript state into incremental output: each repaint writes only the
 * characters that are new, so a stream reads as continuous text.
 */
function createPrinter() {
  const written = new Map<string, number>();
  const closed = new Set<string>();
  /** True while an answer's last line is unfinished: a tool row must not join it. */
  let midLine = false;

  return {
    render(state: AppState): void {
      for (const message of state.messages) {
        if (message.role === 'user') {
          written.set(message.id, message.text.length);
          continue;
        }
        if (message.role === 'tool') {
          // A line renderer cannot redraw, so each tool is printed once, finished.
          if (message.state === 'streaming' || closed.has(message.id) || !message.tool) continue;
          closed.add(message.id);
          const { name, target, detail } = message.tool;
          const marker = message.state === 'error' ? theme.error('×') : theme.dim('●');
          const outcome = message.state === 'cancelled' ? 'cancelled' : detail;
          // An agent's tool calls finish before the agent does, so they are
          // printed first, indented as what they are: its work.
          const indent = '  '.repeat(message.depth ?? 0);
          if (midLine) ui.line();
          midLine = false;
          ui.line(
            `${indent}${marker} ${name} ${target}${outcome ? theme.dim(` · ${outcome}`) : ''}`,
          );
          continue;
        }
        const already = written.get(message.id) ?? 0;
        if (message.text.length > already) {
          process.stdout.write(prefix(message, already) + message.text.slice(already));
          written.set(message.id, message.text.length);
          midLine = !message.text.endsWith('\n');
        }
        if (message.state !== 'streaming' && !closed.has(message.id)) {
          closed.add(message.id);
          if ((written.get(message.id) ?? 0) > 0) ui.line();
          midLine = false;
          if (message.state === 'cancelled') ui.info('Cancelled.');
          ui.line();
        }
      }
    },
  };

  function prefix(message: UiMessage, already: number): string {
    if (already > 0) return '';
    // Notices get a blank line of their own so they never run into the prompt.
    const lead = message.role === 'system' ? '\n' : '';
    return message.state === 'error' ? `${lead}${theme.error('✗')} ` : lead;
  }
}
