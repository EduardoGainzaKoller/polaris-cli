#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runRepl } from './cli/repl.ts';
import { loadConfig, polarisHome } from './config/config.ts';
import { PolarisApp } from './core/app.ts';
import { toUserMessage } from './core/errors.ts';
import { debug, isDebug, setDebug, setLogFile } from './core/logger.ts';
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
  debug('main', 'cwd', cwd, 'config', config);

  const app = new PolarisApp({ cwd, config });
  await app.start();

  // The TUI needs a terminal it owns; anything else (pipes, scripts, CI) gets
  // the line renderer, which drives the very same controller.
  const interactive = process.stdout.isTTY === true && process.stdin.isTTY === true;
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
    await app.close();
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
