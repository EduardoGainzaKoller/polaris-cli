import { shortenPath, ui } from '../../ui/output.ts';
import type { CommandRegistry } from './registry.ts';
import type { Command } from './types.ts';

export function builtinCommands(registry: CommandRegistry): Command[] {
  return [
    {
      name: 'help',
      summary: 'Show available commands',
      aliases: ['?'],
      run() {
        ui.line();
        ui.table(registry.list().map((command) => [`/${command.name}`, command.summary]));
      },
    },
    {
      name: 'status',
      summary: 'Show current session',
      run({ session }) {
        ui.line();
        ui.table([
          ['cwd', shortenPath(session.cwd)],
          ['provider', session.providerId],
          ['model', session.modelId],
          ['turns', String(session.history.length)],
          ['session', session.active ? 'active' : 'inactive'],
        ]);
      },
    },
    {
      name: 'clear',
      summary: 'Clear the terminal (keeps the session)',
      run({ clearScreen }) {
        clearScreen();
      },
    },
    {
      name: 'exit',
      summary: 'Exit Polaris',
      aliases: ['quit', 'q'],
      run({ requestExit }) {
        requestExit();
      },
    },
  ];
}

export function createRegistry(registry: CommandRegistry): CommandRegistry {
  return registry.register(...builtinCommands(registry));
}
