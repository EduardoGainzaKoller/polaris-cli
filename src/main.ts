#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runRepl } from './cli/repl.ts';
import { loadConfig, polarisHome } from './config/config.ts';
import { PolarisApp } from './core/app.ts';
import { toUserMessage } from './core/errors.ts';
import { debug, isDebug, setDebug, setLogFile } from './core/logger.ts';
import { isProfile, PERMISSION_PROFILES } from './permissions/policy.ts';
import { anthropicApiProvider } from './providers/anthropic-api/index.ts';
import { claudeProvider } from './providers/claude/index.ts';
import { codexProvider } from './providers/codex/index.ts';
import { mockProvider } from './providers/mock/index.ts';
import { registerProvider } from './providers/provider.ts';
import { ui } from './ui/output.ts';
import { VERSION } from './version.ts';

const USAGE = `Polaris ${VERSION}

Usage: polaris [options]

Options:
  --provider <id>  mock (default), anthropic-api, claude or codex
  --model <id>     Override the configured model
  --permissions <profile>
                   read-only, ask (default) or workspace-write, for this run only
  --debug          Print internal logs to stderr
  -v, --version    Print the version
  -h, --help       Show this message
`;

async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      provider: { type: 'string' },
      model: { type: 'string' },
      permissions: { type: 'string' },
      debug: { type: 'boolean', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    ui.write(USAGE);
    return 0;
  }
  if (values.version) {
    ui.line(VERSION);
    return 0;
  }

  setDebug(values.debug === true || process.env.POLARIS_DEBUG === '1');

  registerProvider(mockProvider);
  registerProvider(anthropicApiProvider);
  registerProvider(claudeProvider);
  registerProvider(codexProvider);

  const cwd = process.cwd();
  const config = await loadConfig();
  if (values.provider) config.provider = values.provider;
  if (values.model) config.model = values.model;
  // A flag is an override for this run and is never written back: a profile
  // the user passed once must not silently become their stored default.
  if (values.permissions) {
    if (!isProfile(values.permissions)) {
      ui.error(
        `Unknown permission profile "${values.permissions}". Use one of: ${PERMISSION_PROFILES.join(', ')}.`,
      );
      return 1;
    }
    config.permissions = values.permissions;
  }
  debug('main', 'cwd', cwd, 'config', config);

  // The TUI needs a terminal it owns; anything else (pipes, scripts, CI) gets
  // the line renderer, which drives the very same controller. Only the former
  // can present an approval, and a session that cannot ask must not pretend to.
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;

  const app = new PolarisApp({ cwd, config, approvals: interactive });
  await app.start();
  if (interactive && isDebug()) {
    const file = setLogFile(join(polarisHome(), 'logs', 'polaris.log'));
    ui.line(`debug log: ${file}`);
  }

  try {
    if (interactive) {
      const { runTui } = await import('./ui/tui/index.tsx');
      await runTui(app);
    } else {
      await runRepl(app);
    }
  } finally {
    // Changes Polaris made are kept, never reverted on the way out; the user
    // just gets told what is still there.
    const summary = app.exitSummary();
    await app.close();
    if (summary) ui.line(summary);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    ui.error(toUserMessage(error));
    if (isDebug() && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  });
