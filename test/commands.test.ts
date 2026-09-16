import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import { type CommandContext, parseCommand } from '../src/cli/commands/types.ts';
import { loadConfig, saveConfig } from '../src/config/config.ts';
import { PolarisApp } from '../src/core/app.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { registerProvider } from '../src/providers/provider.ts';

registerProvider(mockProvider);

function registry(): CommandRegistry {
  const created = new CommandRegistry();
  return created.register(...builtinCommands(created));
}

interface Harness {
  app: PolarisApp;
  context: CommandContext;
  offered: string[][];
  exited: boolean;
  lastNotice(): string;
}

async function harness(
  options: { canSelect?: boolean; choose?: (options: string[]) => string | null } = {},
): Promise<Harness> {
  const app = new PolarisApp({ cwd: '/work/example', config: { provider: 'mock' } });
  await app.start();
  const state = { offered: [] as string[][], exited: false };

  const context: CommandContext = {
    app,
    canSelect: options.canSelect ?? true,
    select: async (_title, choices) => {
      state.offered.push(choices);
      return options.choose ? options.choose(choices) : null;
    },
    clearScreen: () => {},
    requestExit: () => {
      state.exited = true;
    },
  };

  return {
    app,
    context,
    get offered() {
      return state.offered;
    },
    get exited() {
      return state.exited;
    },
    lastNotice: () => app.state.messages.at(-1)?.text ?? '',
  } as Harness;
}

test('plain text is not a command', () => {
  assert.equal(parseCommand('analiza este repositorio'), null);
  assert.equal(parseCommand('   '), null);
});

test('slash commands are parsed with args, bare exit is a command', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: [] });
  assert.deepEqual(parseCommand('  /MODEL  gpt-5  x '), { name: 'model', args: ['gpt-5', 'x'] });
  assert.deepEqual(parseCommand('QUIT'), { name: 'exit', args: [] });
});

test('the registry resolves names and aliases and lists every command', () => {
  const commands = registry();
  assert.equal(commands.get('help')?.name, 'help');
  assert.equal(commands.get('q')?.name, 'exit');
  assert.equal(commands.get('nope'), undefined);
  assert.deepEqual(
    commands.list().map((command) => command.name),
    ['clear', 'config', 'exit', 'help', 'model', 'provider', 'status', 'tools'],
  );
});

test('/status reports provider, model and turns', async () => {
  const h = await harness();
  await h.app.submit('hola');
  await registry().get('status')?.run(h.context, []);

  const notice = h.lastNotice();
  assert.match(notice, /provider\s+mock/);
  assert.match(notice, /model\s+echo/);
  assert.match(notice, /turns\s+2/);
  assert.match(notice, /session\s+active/);
  await h.app.close();
});

test('/help lists the commands', async () => {
  const h = await harness();
  await registry().get('help')?.run(h.context, []);
  assert.match(h.lastNotice(), /\/provider/);
  assert.match(h.lastNotice(), /\/model/);
  await h.app.close();
});

test('/clear empties the transcript without ending the session', async () => {
  const h = await harness();
  await h.app.submit('hola');
  await registry().get('clear')?.run(h.context, []);
  assert.equal(h.app.state.messages.length, 0);
  assert.equal(h.app.state.turns, 2);
  await h.app.close();
});

test('/exit asks the UI to shut down', async () => {
  const h = await harness();
  await registry().get('exit')?.run(h.context, []);
  assert.equal(h.exited, true);
  await h.app.close();
});

test('/provider offers the registered providers to the picker', async () => {
  const h = await harness();
  await registry().get('provider')?.run(h.context, []);
  // Only what this test registered: the real set is assembled in main.ts.
  assert.ok(h.offered[0]?.includes('mock'));
  await h.app.close();
});

test('a cancelled picker changes nothing and says nothing', async () => {
  const h = await harness({ choose: () => null });
  const before = h.app.state.messages.length;
  await registry().get('provider')?.run(h.context, []);
  assert.equal(h.app.state.provider, 'mock');
  assert.equal(h.app.state.messages.length, before);
  await h.app.close();
});

test('/provider with an unknown id explains instead of switching', async () => {
  const h = await harness();
  await registry().get('provider')?.run(h.context, ['nope']);
  assert.equal(h.app.state.provider, 'mock');
  assert.match(h.lastNotice(), /Unknown provider "nope"/);
  await h.app.close();
});

test('/provider with the current id is a no-op', async () => {
  const h = await harness();
  await registry().get('provider')?.run(h.context, ['mock']);
  assert.match(h.lastNotice(), /Already using mock/);
  await h.app.close();
});

test('a UI without a picker tells the user to pass the id', async () => {
  const h = await harness({ canSelect: false });
  await registry().get('provider')?.run(h.context, []);
  assert.equal(h.offered.length, 0, 'no picker was attempted');
  assert.match(h.lastNotice(), /Available providers/);
  await h.app.close();
});

test('/model uses discovery when the provider supports it', async () => {
  const h = await harness({ choose: (options) => options[1] ?? null });
  await registry().get('model')?.run(h.context, []);
  assert.deepEqual(h.offered[0], ['echo', 'echo-uppercase']);
  assert.equal(h.app.state.model, 'echo-uppercase');
  await h.app.close();
});

test('/model explains when the provider cannot enumerate models', async () => {
  registerProvider({
    id: 'no-discovery',
    async createSession() {
      return {
        model: 'fixed-1',
        async *send(): AsyncIterable<never> {},
        async close() {},
      };
    },
  });

  const app = new PolarisApp({ cwd: '/work', config: { provider: 'no-discovery' } });
  await app.start();
  const context: CommandContext = {
    app,
    canSelect: true,
    select: async () => null,
    clearScreen: () => {},
    requestExit: () => {},
  };

  await registry().get('model')?.run(context, []);
  const notice = app.state.messages.at(-1)?.text ?? '';
  assert.match(notice, /not supported by this provider/);
  assert.match(notice, /fixed-1/);
  await app.close();
});

test('/config shows the file and values, /config save writes them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'polaris-config-'));
  const previous = process.env.POLARIS_HOME;
  process.env.POLARIS_HOME = home;

  try {
    const h = await harness();
    await registry().get('config')?.run(h.context, []);
    assert.match(h.lastNotice(), /provider\s+mock/);

    await registry().get('config')?.run(h.context, ['save']);
    assert.match(h.lastNotice(), /Saved provider and model/);

    const written = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as unknown;
    assert.deepEqual(written, { provider: 'mock', model: 'echo' });
    assert.deepEqual(await loadConfig(), { provider: 'mock', model: 'echo' });
    await h.app.close();
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = previous;
  }
});

test('a malformed config file falls back to defaults instead of failing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'polaris-config-'));
  const previous = process.env.POLARIS_HOME;
  process.env.POLARIS_HOME = home;
  try {
    await saveConfig({ provider: 'codex' });
    assert.deepEqual(await loadConfig(), { provider: 'codex' });
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = previous;
  }
});
