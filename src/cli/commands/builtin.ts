import { configPath, saveConfig } from '../../config/config.ts';
import { usageLines } from '../../core/usage.ts';
import {
  decide,
  isProfile,
  PERMISSION_PROFILES,
  PROFILE_SUMMARY,
} from '../../permissions/policy.ts';
import { listProviders } from '../../providers/provider.ts';
import { capabilityOf } from '../../tools/registry.ts';
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
            .map((command) => `  /${command.name.padEnd(12)} ${command.summary}`)
            .join('\n'),
        );
      },
    },
    {
      name: 'status',
      summary: 'Show the session, and how much of the model you have used',
      run: async ({ app }) => {
        const state = app.state;
        const usage = await app.usage();
        const session = [
          `  cwd       ${shortenPath(state.cwd)}`,
          `  provider  ${state.provider}`,
          `  model     ${state.model}`,
          `  effort    ${state.effort ?? 'default'}`,
          `  perms     ${state.permissions}`,
          `  tools     ${state.access?.runtime ?? 'none'}`,
          ...(usage?.plan ? [`  plan      ${usage.plan}`] : []),
          `  turns     ${state.turns}`,
          `  session   ${state.status === 'error' ? 'error' : 'active'}`,
        ];

        // Every runtime measures something different, and one of them may
        // measure nothing at all; say which rather than printing an empty
        // section or, worse, zeroes that look like measurements.
        const consumption = usage
          ? ['', ...usageLines(usage)]
          : ['', `  ${state.provider} does not report token usage.`];

        app.notice([...session, ...consumption].join('\n'));
      },
    },
    {
      name: 'tools',
      summary: 'Show what Polaris can do in this workspace',
      run({ app }) {
        const state = app.state;
        const access = state.access;
        if (!access) {
          app.notice('No provider session is active.');
          return;
        }
        // Every tool the runtime offers, with what the profile does about it:
        // auto, ask, or not offered at all.
        const rows = access.tools.map((tool) => {
          const capability = capabilityOf(tool) ?? guessCapability(tool);
          const verdict = capability ? decide(state.permissions, capability) : 'allow';
          return [tool, verdict === 'allow' ? 'auto' : verdict] as const;
        });
        const width = Math.max(...rows.map(([tool]) => tool.length), 12);

        app.notice(
          [
            `  Tools (${access.runtime})`,
            ...rows.map(([tool, verdict]) => `  ${tool.padEnd(width)}  ${verdict}`),
            ...deniedCapabilities(state.permissions).map(
              (name) => `  ${name.padEnd(width)}  denied`,
            ),
            '',
            `  Permissions: ${state.permissions}`,
            access.sandboxed
              ? '  Commands run inside the runtime’s own OS sandbox.'
              : '  Commands are not sandboxed: approval, workspace cwd and a timeout bound them.',
          ].join('\n'),
        );
      },
    },
    {
      name: 'permissions',
      blockedByApproval: true,
      summary: 'Show or change the permission profile: /permissions [profile]',
      run: async (context, args) => {
        const { app } = context;
        if (!args[0]) {
          const width = Math.max(...PERMISSION_PROFILES.map((name) => name.length));
          app.notice(
            [
              `  Current: ${app.state.permissions}`,
              '',
              ...PERMISSION_PROFILES.map(
                (name) => `  ${name.padEnd(width)}  ${PROFILE_SUMMARY[name]}`,
              ),
              '',
              '  /permissions <profile> switches; /config save stores it.',
            ].join('\n'),
          );
          return;
        }
        const chosen = await pick(
          context,
          args[0],
          'Select permissions',
          [...PERMISSION_PROFILES],
          'permissions',
        );
        if (!chosen || !isProfile(chosen)) return;
        await app.setPermissions(chosen);
      },
    },
    {
      name: 'provider',
      blockedByApproval: true,
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
      blockedByApproval: true,
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
      blockedByApproval: true,
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
            permissions: state.permissions,
            ...(state.effort ? { effort: state.effort } : {}),
          });
          app.notice(`Saved provider, model, effort and permissions to ${shortenPath(path)}.`);
          return;
        }
        const config = app.config;
        app.notice(
          [
            `  file      ${shortenPath(configPath())}`,
            `  provider  ${config.provider}`,
            `  model     ${config.model ?? '(provider default)'}`,
            `  effort    ${config.effort ?? '(model default)'}`,
            `  perms     ${config.permissions}`,
            '  /config save writes the session’s provider, model, effort and permissions there.',
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
      permissions: context.app.state.permissions,
    }[what] ?? null;
  return context.select(title, options, current);
}

/** Runtime tool names are not Polaris wire names, so /tools still classifies them. */
function guessCapability(tool: string): 'read' | 'write' | 'edit' | 'command' | undefined {
  const name = tool.toLowerCase();
  if (/run|bash|command|shell/.test(name)) return 'command';
  if (name.includes('write')) return 'write';
  if (name.includes('edit')) return 'edit';
  return undefined;
}

/** Capabilities the profile removes entirely, so /tools shows them as denied. */
function deniedCapabilities(profile: Parameters<typeof decide>[0]): string[] {
  const named = { write: 'Write', edit: 'Edit', command: 'Run Command' } as const;
  return Object.entries(named)
    .filter(([capability]) => decide(profile, capability as 'write') === 'deny')
    .map(([, label]) => label);
}

export function createRegistry(registry: CommandRegistry): CommandRegistry {
  return registry.register(...builtinCommands(registry));
}
