import { configPath, saveConfig } from '../../config/config.ts';
import { type Activity, ago, clock } from '../../core/activity.ts';
import type { AppState } from '../../core/app.ts';
import { isDebug } from '../../core/logger.ts';
import { usageLines } from '../../core/usage.ts';
import { RESULT_LABEL } from '../../core/verification.ts';
import {
  isProfile,
  PERMISSION_PROFILES,
  PROFILE_SUMMARY,
  toProfile,
} from '../../permissions/policy.ts';
import { listProviders } from '../../providers/provider.ts';
import { MAX_SESSION_DIFF_LINES } from '../../tools/limits.ts';
import { statusOf } from '../../ui/activity.ts';
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
          // What the current request authorises: a debugging aid, not news.
          ...(isDebug()
            ? [
                `  task      ${app.task.intent}${app.task.modifyWorkspace ? ' · edits allowed' : ' · no edits'}`,
              ]
            : []),
          `  tools     ${state.access?.runtime ?? 'none'}`,
          ...(usage?.plan ? [`  plan      ${usage.plan}`] : []),
          `  turns     ${state.turns}`,
          `  session   ${state.status === 'error' ? 'error' : 'active'}`,
          `  activity  ${activityRow(state.activity)}`,
          ...contextRows(state.context),
          '',
          ...workspaceRows(state.workspace),
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
        // Semantic policy, not a per-tool table: what happens depends on
        // what the task asked for and what a command would cross.
        const profile = state.permissions;
        const edits =
          profile === 'read-only'
            ? ['Write / Edit', 'denied']
            : profile === 'workspace-write'
              ? ['Write / Edit', 'auto']
              : ['Write / Edit', 'auto when the request asks for changes · ask otherwise'];
        const commands =
          profile === 'read-only'
            ? [
                ['  safe Git inspection', 'auto'],
                ['  anything else', 'denied'],
              ]
            : [
                ['  safe Git inspection', 'auto'],
                ['  project code, installs, network', 'ask'],
                ['  unknown or compound commands', 'ask'],
                ['  destructive Git', 'ask (high risk)'],
              ];
        const rows: Array<[string, string]> = [
          ['Read / Glob / Grep', 'auto'],
          [edits[0] as string, edits[1] as string],
          ['Commands', ''],
          ...(commands as Array<[string, string]>),
          ['Project context, skills', 'auto'],
          ['Outside the workspace', 'denied'],
        ];
        const width = Math.max(...rows.map(([label]) => label.length));
        app.notice(
          [
            `  Tools (${access.runtime}): ${access.tools.join(', ')}`,
            '',
            ...rows.map(([label, verdict]) => `  ${label.padEnd(width)}  ${verdict}`.trimEnd()),
            '',
            `  Permissions: ${profile}`,
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
          app.notice(
            [
              '  Permissions',
              '',
              ...PERMISSION_PROFILES.flatMap((name) => [
                `  ${name}${name === app.state.permissions ? ' [current]' : ''}`,
                `    ${PROFILE_SUMMARY[name]}`,
              ]),
              '',
              '  Outside the workspace is always denied; no approval can override it.',
              '  /permissions <profile> switches and saves it. `ask` is accepted as `smart`.',
            ].join('\n'),
          );
          return;
        }
        const chosen = await pick(
          context,
          args[0] ? (toProfile(args[0]) ?? args[0]) : undefined,
          'Select permissions',
          [...PERMISSION_PROFILES],
          'permissions',
        );
        if (!chosen || !isProfile(chosen)) return;
        await app.setPermissions(chosen);
        // The profile is the one setting kept between sessions on its own.
        await saveConfig({ ...app.config, permissions: app.state.permissions });
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
      name: 'diff',
      summary: 'Show what Polaris changed this session: /diff [file]',
      run: async ({ app }, args) => {
        const { changes, preexisting } = await app.changes();
        const only = args[0]?.replaceAll('\\', '/').replace(/^\.\//, '');
        const shown = only ? changes.filter((change) => change.path === only) : changes;
        if (only && shown.length === 0) {
          app.notice(`${only} has no changes from this session.`);
          return;
        }
        const diffs = [];
        for (const change of shown) diffs.push({ change, diff: await app.diff(change) });

        const lines = ['  Changes this session'];
        if (changes.length === 0) lines.push('    none');
        for (const { change, diff } of diffs) {
          const stat = diff.text.startsWith('Binary')
            ? 'binary'
            : `+${diff.added} -${diff.removed}`;
          const notes = [
            change.kind === 'modified' ? '' : change.kind,
            change.preexisting ? 'on top of your changes' : '',
            change.unexpected ? 'not written by a file tool' : '',
            change.external ? 'changed outside Polaris since' : '',
          ].filter(Boolean);
          lines.push(`    ${change.path}  ${stat}${notes.length ? `  (${notes.join(', ')})` : ''}`);
        }
        if (preexisting.length > 0) {
          lines.push('', '  Pre-existing changes (yours; Polaris leaves them alone)');
          for (const item of preexisting.slice(0, 20)) lines.push(`    ${item.path}`);
          if (preexisting.length > 20) lines.push(`    … ${preexisting.length - 20} more`);
        }
        if (!app.state.workspace.git) {
          lines.push('', '  Not a Git repository: only files changed by file tools are tracked.');
        }

        let budget = MAX_SESSION_DIFF_LINES;
        for (const { diff } of diffs) {
          const body = diff.text.split('\n');
          if (budget <= 0) {
            lines.push('', `  … diff truncated: ${diffs.length} files changed. Use /diff <file>.`);
            break;
          }
          lines.push(
            '',
            `  ── ${diff.path} ──`,
            ...body.slice(0, budget).map((line) => `  ${line}`),
          );
          if (body.length > budget) lines.push(`  … ${body.length - budget} more lines`);
          budget -= body.length;
        }
        app.notice(lines.join('\n'));
      },
    },
    {
      name: 'checkpoint',
      summary: 'Save the current state of Polaris’s changes: /checkpoint [label]',
      run: async ({ app }, args) => {
        const checkpoint = await app.checkpoint(args.join(' '));
        app.notice(
          `Checkpoint created: ${checkpoint.id} (${checkpoint.label}). /undo returns here.`,
        );
      },
    },
    {
      name: 'checkpoints',
      summary: 'List this session’s checkpoints',
      run({ app }) {
        const checkpoints = app.checkpoints;
        const width = Math.max(...checkpoints.map((checkpoint) => checkpoint.label.length), 12);
        app.notice(
          [
            '  Checkpoints',
            ...checkpoints.map(
              (checkpoint, index) =>
                `  ${checkpoint.id.padEnd(6)} ${checkpoint.label.padEnd(width)}  ${time(checkpoint.at)}${index === checkpoints.length - 1 ? '  latest' : ''}`,
            ),
            '',
            '  Checkpoints live only for this session; they are not Git commits.',
          ].join('\n'),
        );
      },
    },
    {
      name: 'undo',
      summary: 'Restore Polaris’s changes to the latest checkpoint: /undo [cp-N]',
      run: async (context, args) => {
        const { app } = context;
        const id = args.find((arg) => arg !== '--yes');
        const plan = await app.planUndo(id);
        const { checkpoint } = plan;
        const skipped = plan.skipped.map(
          (item) => `Cannot safely restore ${item.path}: ${item.reason}.`,
        );
        if (plan.restore.length === 0) {
          app.notice(
            skipped.length > 0
              ? skipped.join('\n')
              : `Nothing to undo: Polaris has changed nothing since ${checkpoint.id} (${checkpoint.label}).`,
          );
          return;
        }
        const confirmed =
          args.includes('--yes') ||
          (await context.confirm(`Undo changes since ${checkpoint.id} (${checkpoint.label})?`, [
            ...plan.restore.map((item) => item.path),
            ...plan.skipped.map((item) => `${item.path} — left alone: ${item.reason}`),
          ]));
        if (!confirmed) {
          app.notice('Undo cancelled. Nothing was changed.');
          return;
        }
        const result = await app.undo(plan);
        app.notice(
          [
            `Restored ${result.restored.length} ${result.restored.length === 1 ? 'file' : 'files'} to ${checkpoint.id}.`,
            ...result.restored.map((path) => `  ${path}`),
            ...result.skipped.map((item) => `Cannot safely restore ${item.path}: ${item.reason}.`),
          ].join('\n'),
        );
      },
    },
    {
      name: 'new',
      blockedByApproval: true,
      summary: 'Start a new conversation (same provider, model, permissions and files)',
      run: async ({ app }) => {
        await app.newConversation();
      },
    },
    {
      name: 'verify',
      blockedByApproval: true,
      summary: 'Run this project’s checks against the current changes',
      run: async ({ app }) => {
        await app.verify();
      },
    },
    {
      name: 'activity',
      summary: 'Show what is running right now, and since when',
      run({ app }) {
        const live = app.state.activity;
        if (live.length === 0) {
          app.notice('No active operations.');
          return;
        }
        const now = Date.now();
        const lines = ['  Activity'];
        const depth = (activity: Activity): number => {
          const parent = live.find((item) => item.id === activity.parentId);
          return parent ? depth(parent) + 1 : 0;
        };
        for (const activity of live) {
          const pad = '  '.repeat(depth(activity) + 1);
          const leaf = !live.some((child) => child.parentId === activity.id);
          lines.push(
            '',
            `${pad}${activity.kind === 'command' ? `Run ${activity.label}` : activity.label}`,
            `${pad}  state          ${activity.state}`,
            `${pad}  elapsed        ${clock(now - activity.startedAt)}`,
            `${pad}  last activity  ${ago(now - activity.lastActivityAt)} ago`,
          );
          const status = statusOf(activity, now, leaf);
          if (status) lines.push(`${pad}  ${status}`);
        }
        app.notice(lines.join('\n'));
      },
    },
    {
      name: 'context',
      blockedByApproval: true,
      summary: 'Project instructions from POLARIS.md: /context [show|reload]',
      run: async ({ app }, args) => {
        if (args[0] === 'reload') {
          await app.reloadContext();
          return;
        }
        const { project } = app.context;
        const budget = app.context.budget();
        const lines = ['  Project Context', ''];
        if (project.sources.length === 0) {
          lines.push('  No POLARIS.md found between the workspace and the repository root.');
        } else {
          lines.push('  Sources (farthest first; the nearest takes precedence)');
          for (const source of project.sources) {
            lines.push(
              `    ${source.display}  ${source.lines} ${source.lines === 1 ? 'line' : 'lines'}`,
            );
          }
        }
        for (const error of project.errors) lines.push(`  ✗ ${error}`);
        lines.push(
          '',
          `  Added to the model: ~${chars(budget.project)} project · ~${chars(budget.skills)} skills · ~${chars(budget.references)} references`,
        );
        if (args[0] === 'show') {
          for (const source of project.sources) {
            lines.push(
              '',
              `  ── ${source.display} ──`,
              ...source.content.split('\n').map((line) => `  ${line}`),
            );
          }
        } else if (project.sources.length > 0) {
          lines.push('  /context show prints them; /context reload re-reads them.');
        }
        app.notice(lines.join('\n'));
      },
    },
    {
      name: 'skills',
      summary: 'List the skills Polaris can load: /skills [reload]',
      run: async ({ app }, args) => {
        if (args[0] === 'reload') await app.reloadSkills();
        const skills = app.context.skills;
        const loaded = new Set(app.state.context.loaded);
        const available = skills.list();
        const lines = ['  Skills', ''];
        if (available.length === 0) {
          lines.push('  None found in .polaris/skills/ or ~/.polaris/skills/.');
        }
        const width = Math.max(12, ...available.map((skill) => skill.name.length));
        for (const skill of available) {
          lines.push(
            `  ${skill.name.padEnd(width)}  ${skill.scope.padEnd(7)}  ${loaded.has(skill.name) ? 'loaded' : ''}`.trimEnd(),
            `    ${skill.description}`,
            `    ${skill.display}${skill.overrides ? `  (overrides ${skill.overrides})` : ''}`,
          );
        }
        const invalid = skills.invalid();
        if (invalid.length > 0) {
          lines.push('', '  Invalid');
          for (const skill of invalid) {
            lines.push(`  ${skill.name.padEnd(width)}  ${skill.scope.padEnd(7)}  ${skill.error}`);
          }
        }
        if (args[0] === 'reload') lines.push('', '  Rediscovered. Nothing was loaded.');
        app.notice(lines.join('\n'));
      },
    },
    {
      name: 'skill',
      blockedByApproval: true,
      summary: 'Load a skill into this conversation: /skill <name> | /skill unload <name>',
      run: async ({ app }, args) => {
        if (args[0] === 'unload') {
          if (!args[1]) {
            app.notice('Usage: /skill unload <name>', 'error');
            return;
          }
          await app.unloadSkill(args[1]);
          return;
        }
        const name = args[0];
        if (!name) {
          app.notice('Usage: /skill <name>. /skills lists them.', 'error');
          return;
        }
        if (await app.loadSkill(name)) {
          app.notice(`Skill loaded: ${name}. It stays active for this conversation.`);
        }
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

/** `./gradlew test (00:42)`, or idle. */
function activityRow(live: readonly Activity[]): string {
  const leaf = [...live]
    .reverse()
    .find((item) => !live.some((child) => child.parentId === item.id));
  if (!leaf) return 'idle';
  return `${leaf.label} (${clock(Date.now() - leaf.startedAt)})`;
}

/** The project-context and skill rows of /status. */
function contextRows(context: AppState['context']): string[] {
  return [
    `  context   ${context.sources.length > 0 ? context.sources.join(', ') : 'no POLARIS.md'}`,
    `  skills    ${context.loaded.length} loaded · ${context.available} available`,
  ];
}

function chars(count: number): string {
  return count < 1000 ? `${count} chars` : `${(count / 1000).toFixed(1)}k chars`;
}

/** The Git and verification rows of /status. */
function workspaceRows(workspace: AppState['workspace']): string[] {
  const git = workspace.git;
  return [
    git
      ? `  git       ${git.branch ?? 'detached'}${git.head ? ` @ ${git.head.slice(0, 7)}` : ' (no commits)'}`
      : '  git       not a repository',
    `  changes   ${workspace.changed} by Polaris · ${workspace.preexisting} pre-existing`,
    `  checks    ${RESULT_LABEL[workspace.verification]}`,
  ];
}

function time(date: Date): string {
  return date.toTimeString().slice(0, 5);
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

export function createRegistry(registry: CommandRegistry): CommandRegistry {
  return registry.register(...builtinCommands(registry));
}
