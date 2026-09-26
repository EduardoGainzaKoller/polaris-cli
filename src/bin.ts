#!/usr/bin/env node
import { MIN_NODE_MAJOR, nodeSupported } from './cli/node-check.ts';

/**
 * The installed `polaris` command. It checks the Node.js version before
 * anything else loads, so an unsupported Node gets one sentence instead of a
 * syntax error from deep inside a dependency.
 */
if (!nodeSupported(process.versions.node)) {
  process.stderr.write(
    `Polaris requires Node.js >= ${MIN_NODE_MAJOR}.\nCurrent version: ${process.versions.node}.\n` +
      'Install a current LTS release from https://nodejs.org and try again.\n',
  );
  process.exit(1);
}

await import('./main.ts');
