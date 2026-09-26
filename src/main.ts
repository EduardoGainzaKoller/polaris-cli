import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { configExists, configPath, loadConfig, polarisHome } from './config/config.ts';
import { isUnexpected, PolarisError, toUserMessage } from './core/errors.ts';
import { debug, info, isDebug, logPath, openSessionLog, setDebug } from './core/logger.ts';
import { PERMISSION_PROFILES, toProfile } from './permissions/policy.ts';
import { ui } from './ui/output.ts';
import { VERSION } from './version.ts';

const USAGE = `Polaris ${VERSION} — AI coding agent (Developer Preview)

Usage:
  polaris [options]          start in the current directory
  polaris doctor [--report]  check the setup; --report saves a sanitised file

Options:
  --provider <id>            codex, claude, anthropic-api or mock
  --model <id>               model to use, as the provider names it
  --permissions <profile>    read-only, smart (default) or workspace-write, this run only
  --debug                    log everything to the session log
  -v, --version              print the version
  -h, --help                 show this message

Providers:
  codex           the Codex CLI and your ChatGPT sign-in (run \`codex\` to sign in)
  claude          the Claude Agent SDK and your Claude Code sign-in or ANTHROPIC_API_KEY
  anthropic-api   the Anthropic API, with ANTHROPIC_API_KEY set in your environment
  mock            offline demo, no account needed

Examples:
  polaris
  polaris --provider codex
  polaris --provider claude --permissions read-only
  polaris doctor
`;

interface Flags {
  provider?: string;
  model?: string;
  permissions?: string;
  debug: boolean;
  version: boolean;
  help: boolean;
  report: boolean;
}

/** Nothing heavy is loaded until it is needed: --help never touches an SDK. */
async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: { values: Flags; positionals: string[] };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        permissions: { type: 'string' },
        debug: { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        report: { type: 'boolean', default: false },
      },
    }) as { values: Flags; positionals: string[] };
  } catch (error) {
    ui.error(`${toUserMessage(error)}\nRun polaris --help for the options.`);
    return 2;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    ui.write(USAGE);
    return 0;
  }
  if (values.version) {
    ui.line(`Polaris ${VERSION}`);
    return 0;
  }
  if (positionals[0] === 'doctor') return doctor(values.report);
  if (positionals.length > 0) {
    ui.error(`Unknown command "${positionals[0]}". Run polaris --help.`);
    return 2;
  }
  return session(values);
}

async function doctor(report: boolean): Promise<number> {
  const { formatDoctor, REPORT_CONTENTS, runDoctor, systemEnvironment, writeReport } = await import(
    './cli/doctor.ts'
  );
  const result = await runDoctor(systemEnvironment(VERSION));
  const text = formatDoctor(result);
  ui.write(`${text}\n`);
  if (report) {
    ui.write(`\n${REPORT_CONTENTS}\n`);
    const path = await writeReport(text, process.cwd());
    ui.write(`\nReport saved: ${path}\n`);
  }
  return result.blocking ? 1 : 0;
}

async function session(values: Flags): Promise<number> {
  setDebug(values.debug || process.env.POLARIS_DEBUG === '1');
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;

  const log = openSessionLog(join(polarisHome(), 'logs'));
  info(
    'startup',
    `Polaris ${VERSION}`,
    `node ${process.versions.node}`,
    process.platform,
    process.arch,
    interactive ? 'tui' : 'line mode',
  );
  if (values.debug && log) ui.line(`debug log: ${log}`);

  const firstRun = !(await configExists());
  const config = await loadConfig();

  if (firstRun && !values.provider) {
    const chosen = await firstRunSetup(interactive);
    if (chosen === undefined) return 0;
    if (chosen) config.provider = chosen;
  }
  if (values.provider) config.provider = values.provider;
  if (values.model) config.model = values.model;
  // A flag is an override for this run and is never written back: a profile
  // the user passed once must not silently become their stored default.
  if (values.permissions) {
    const profile = toProfile(values.permissions);
    if (!profile) {
      ui.error(
        `Unknown permission profile "${values.permissions}". Use one of: ${PERMISSION_PROFILES.join(', ')}.`,
      );
      return 2;
    }
    config.permissions = profile;
  }
  debug('main', 'cwd', process.cwd(), 'config', config);

  const [{ PolarisApp }, { registerProviders }] = await Promise.all([
    import('./core/app.ts'),
    import('./providers/all.ts'),
  ]);
  await registerProviders();
  const { sweepStaleCheckpoints } = await import('./workspace/changes.ts');
  void sweepStaleCheckpoints();

  const app = new PolarisApp({ cwd: process.cwd(), config, approvals: interactive });
  const shutdown = installShutdown(app);
  try {
    await app.start();
  } catch (error) {
    shutdown.dispose();
    await app.close().catch(() => undefined);
    throw providerFailure(config.provider, error);
  }
  info('provider', config.provider, 'model', app.state.model, 'permissions', app.state.permissions);

  try {
    if (interactive) {
      const { runTui } = await import('./ui/tui/index.tsx');
      await runTui(app);
    } else {
      const { runRepl } = await import('./cli/repl.ts');
      await runRepl(app);
    }
  } finally {
    // Changes Polaris made are kept, never reverted on the way out; the user
    // just gets told what is still there.
    const summary = app.exitSummary();
    shutdown.dispose();
    await app.close();
    info('shutdown', 'normal exit');
    if (summary) ui.line(summary);
  }
  return 0;
}

/**
 * The first run: detect what is installed, say what Polaris is, and ask for
 * one thing — the provider. Returns the chosen id, null to keep the default,
 * or undefined when the user cancelled (nothing is saved, so it asks again).
 */
async function firstRunSetup(interactive: boolean): Promise<string | null | undefined> {
  const [{ detectProviders }, { completeOnboarding, planOnboarding, PREVIEW_NOTICE }] =
    await Promise.all([import('./providers/detect.ts'), import('./cli/onboarding.ts')]);
  if (!interactive) {
    // No one to ask: say what this is, keep the defaults, save nothing.
    ui.write(`Polaris ${VERSION} — Developer Preview\n${PREVIEW_NOTICE.join('\n')}\n\n`);
    return null;
  }
  const checks = await detectProviders();
  const plan = planOnboarding(checks);
  const { runOnboarding } = await import('./ui/tui/Onboarding.tsx');
  const chosen = await runOnboarding(checks, plan);
  if (!chosen) {
    ui.line('Setup cancelled — nothing was saved. Run polaris again whenever you are ready.');
    return undefined;
  }
  await completeOnboarding(chosen);
  info('onboarding', 'provider', chosen);
  ui.line(
    `Saved ${chosen} as your provider in ${configPath()}. Change it any time with /provider.`,
  );
  return chosen;
}

/** A provider that cannot start is a situation, with somewhere to go next. */
function providerFailure(provider: string, error: unknown): PolarisError {
  info('provider', 'start failed', provider, error);
  return new PolarisError(
    [
      `Could not start ${provider}: ${toUserMessage(error)}`,
      '',
      '  Check your setup:        polaris doctor',
      '  Try another provider:    polaris --provider <codex|claude|anthropic-api|mock>',
    ].join('\n'),
    { cause: error, code: 'POLARIS_PROVIDER_START_FAILED' },
  );
}

/**
 * Ctrl+C belongs to the UI; these are the other ways a process ends — a
 * terminal closing, a kill, a crash. Each restores the terminal, closes the
 * runtime (and its child processes) and exits, instead of leaving a raw-mode
 * terminal and orphans behind.
 */
function installShutdown(app: { close(): Promise<void> }): { dispose(): void } {
  let closing = false;
  const stop = async (reason: string, error?: unknown) => {
    if (closing) return;
    closing = true;
    info('shutdown', reason, ...(error === undefined ? [] : [error]));
    const { restoreTerminal } = await import('./ui/terminal.ts');
    restoreTerminal();
    if (error !== undefined) reportCrash(error);
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000).unref()),
    ]);
    process.exit(error === undefined ? 143 : 1);
  };
  const onSignal = (signal: NodeJS.Signals) => void stop(signal);
  const onCrash = (error: unknown) => void stop('crash', error);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  return {
    dispose() {
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('uncaughtException', onCrash);
      process.off('unhandledRejection', onCrash);
    },
  };
}

/** A bug, said plainly, with where to go next. The stack is in the log. */
function reportCrash(error: unknown): void {
  info('crash', error);
  const lines = [
    `Polaris encountered an unexpected error: ${toUserMessage(error)}`,
    '',
    '  Check your setup:   polaris doctor',
    '  More detail:        polaris --debug',
  ];
  const log = logPath();
  if (log) lines.push(`  Log file:           ${log}`);
  ui.error(lines.join('\n'));
  if (isDebug() && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error: unknown) => {
    const { restoreTerminal } = await import('./ui/terminal.ts');
    restoreTerminal();
    if (isUnexpected(error)) {
      reportCrash(error);
    } else {
      info('error', error);
      const code = error instanceof PolarisError && error.code ? `\n(${error.code})` : '';
      ui.error(`${toUserMessage(error)}${code}`);
      if (isDebug() && error instanceof Error && error.stack) {
        process.stderr.write(`${error.stack}\n`);
      }
    }
    process.exitCode = 1;
  });
