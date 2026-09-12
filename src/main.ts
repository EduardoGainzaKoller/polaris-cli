#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runRepl } from './cli/repl.ts';
import { loadConfig } from './config/config.ts';
import { toUserMessage } from './core/errors.ts';
import { debug, isDebug, setDebug } from './core/logger.ts';
import { Session } from './core/session.ts';
import { anthropicApiProvider } from './providers/anthropic-api/index.ts';
import { claudeProvider } from './providers/claude/index.ts';
import { mockProvider } from './providers/mock/index.ts';
import { registerProvider } from './providers/provider.ts';
import { ui } from './ui/output.ts';

const VERSION = '0.1.0';

const USAGE = `Polaris ${VERSION}

Usage: polaris [options]

Options:
  --provider <id>  mock (default), anthropic-api or claude
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

  const cwd = process.cwd();
  const config = await loadConfig();
  if (values.provider) config.provider = values.provider;
  if (values.model) config.model = values.model;
  debug('main', 'cwd', cwd, 'config', config);

  const session = new Session({ cwd, config });
  await session.start();

  ui.banner(cwd, session.providerId, session.modelId);
  await runRepl(session);
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
