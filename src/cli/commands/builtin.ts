import { configPath, saveConfig } from '../../config/config.ts';
import { listProviders } from '../../providers/provider.ts';
import { shortenPath } from '../../ui/output.ts';
import type { CommandRegistry } from './registry.ts';
import type { Command, CommandContext } from './types.ts';

/** Commands speak to the user through the transcript, so every UI shows them the same way. */
export function builtinCommands(registry: CommandRegistry): Command[] {
  return [
    {
      name: 'help',
      summary: 'Show available commands',
      aliases: ['?'],
      run({ app }) {
        app.notice(
          registry
            .list()
            .map((command) => `  /${command.name.padEnd(9)} ${command.summary}`)
            .join('\n'),
        );
      },
    },
    {
      name: 'status',
      summary: 'Show the current session',
      run({ app }) {
        const state = app.state;
        app.notice(
          [
            `  cwd       ${shortenPath(state.cwd)}`,
            `  provider  ${state.provider}`,
            `  model     ${state.model}`,
            `  effort    ${state.effort ?? 'default'}`,
            `  tools     ${state.access?.mode ?? 'none'}`,
            `  turns     ${state.turns}`,
            `  session   ${state.status === 'error' ? 'error' : 'active'}`,
          ].join('\n'),
        );
      },
    },
    {
      name: 'tools',
      summary: 'Show what Polaris can do in this workspace',
      run({ app }) {
        const access = app.state.access;
        if (!access) {
          app.notice('No provider session is active.');
          return;
        }
        const width = Math.max(...access.tools.map((tool) => tool.length));
        app.notice(
          [
            `  Tools (${access.runtime})`,
            ...access.tools.map((tool) => `  ${tool.padEnd(width)}  enabled`),
            '',
            `  Mode: ${access.mode} — Polaris cannot modify the workspace.`,
          ].join('\n'),
        );
      },
    },
    {
      name: 'provider',
      summary: 'Switch provider: /provider [id]',
      run: async (context, args) => {
        const ids = listProviders().map((provider) => provider.id);
        const chosen = await pick(context, args[0], 'Select provider', ids, 'provider');
        if (!chosen) return;
        if (chosen === context.app.state.provider) {
          context.app.notice(`Already using ${chosen}.`);
          return;
        }
        await context.app.setProvider(chosen);
      },
    },
    {
      name: 'model',
      summary: 'Switch model: /model [id]',
      run: async (context, args) => {
        if (args[0]) {
          await context.app.setModel(args[0]);
          return;
        }
        const models = await context.app.listModels();
        if (!models || models.length === 0) {
          context.app.notice(
            `Model discovery is not supported by this provider.\n  Current model: ${context.app.state.model}\n  Use /model <id> to set one.`,
          );
          return;
        }
        const chosen = await pick(context, undefined, 'Select model', models, 'model');
        if (!chosen || chosen === context.app.state.model) return;
        await context.app.setModel(chosen);
      },
    },
    {
      name: 'effort',
      summary: 'Reasoning effort: /effort [level]',
      run: async (context, args) => {
        const levels = await context.app.listEfforts();
        if (!levels || levels.length === 0) {
          context.app.notice(
            `${context.app.state.provider} does not let the reasoning effort be chosen for ${context.app.state.model}.`,
          );
          return;
        }
        const chosen = await pick(context, args[0], 'Select effort', levels, 'effort');
        if (!chosen || chosen === context.app.state.effort) return;
        await context.app.setEffort(chosen);
      },
    },
    {
      name: 'config',
      summary: 'Show or save configuration: /config [save]',
      run: async ({ app }, args) => {
        if (args[0] === 'save') {
          const state = app.state;
          const path = await saveConfig({
            provider: state.provider,
            model: state.model,
            ...(state.effort ? { effort: state.effort } : {}),
          });
          app.notice(`Saved provider, model and effort to ${shortenPath(path)}.`);
          return;
        }
        const config = app.config;
        app.notice(
          [
            `  file      ${shortenPath(configPath())}`,
            `  provider  ${config.provider}`,
            `  model     ${config.model ?? '(provider default)'}`,
            `  effort    ${config.effort ?? '(model default)'}`,
            '  /config save writes the session’s provider, model and effort there.',
          ].join('\n'),
        );
      },
    },
    {
      name: 'clear',
      summary: 'Clear the transcript (keeps the session)',
      run({ app, clearScreen }) {
        app.clearTranscript();
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

/** Uses the argument when given, otherwise the UI's picker, otherwise explains how. */
async function pick(
  context: CommandContext,
  argument: string | undefined,
  title: string,
  options: string[],
  what: string,
): Promise<string | null> {
  if (argument) {
    if (options.includes(argument)) return argument;
    context.app.notice(`Unknown ${what} "${argument}". Available: ${options.join(', ')}`, 'error');
    return null;
  }
  if (!context.canSelect) {
    context.app.notice(`Available ${what}s: ${options.join(', ')}\n  Use /${what} <id>.`);
    return null;
  }
  // A cancelled picker changes nothing and says nothing.
  const current =
    {
      provider: context.app.state.provider,
      model: context.app.state.model,
      effort: context.app.state.effort,
    }[what] ?? null;
  return context.select(title, options, current);
}

export function createRegistry(registry: CommandRegistry): CommandRegistry {
  return registry.register(...builtinCommands(registry));
}
