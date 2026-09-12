import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import { parseCommand } from '../src/cli/commands/types.ts';

test('plain text is not a command', () => {
  assert.equal(parseCommand('analiza este repositorio'), null);
  assert.equal(parseCommand('   '), null);
});

test('slash commands are parsed with args', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: [] });
  assert.deepEqual(parseCommand('  /MODEL  gpt-5  x '), { name: 'model', args: ['gpt-5', 'x'] });
});

test('bare exit and quit are commands', () => {
  assert.deepEqual(parseCommand('exit'), { name: 'exit', args: [] });
  assert.deepEqual(parseCommand('QUIT'), { name: 'exit', args: [] });
});

test('registry resolves names and aliases, unknown returns undefined', () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));

  assert.equal(registry.get('help')?.name, 'help');
  assert.equal(registry.get('q')?.name, 'exit');
  assert.equal(registry.get('nope'), undefined);
  assert.deepEqual(
    registry.list().map((c) => c.name),
    ['clear', 'exit', 'help', 'status'],
  );
});

test('/exit requests shutdown, /clear does not touch history', () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));

  let exited = false;
  let cleared = false;
  const context = {
    session: { cwd: '/tmp', providerId: 'mock', modelId: 'echo', history: [], active: true },
    requestExit: () => {
      exited = true;
    },
    clearScreen: () => {
      cleared = true;
    },
  } as never;

  registry.get('exit')?.run(context, []);
  registry.get('clear')?.run(context, []);
  assert.ok(exited);
  assert.ok(cleared);
});

test('/status reports the active provider and model', () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));

  const context = {
    session: {
      cwd: '/work/example',
      providerId: 'claude',
      modelId: 'claude-sonnet-5',
      history: [{ role: 'user', text: 'hola' }],
      active: true,
    },
    requestExit: () => {},
    clearScreen: () => {},
  } as never;

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    registry.get('status')?.run(context, []);
  } finally {
    process.stdout.write = original;
  }

  const output = written.join('');
  assert.match(output, /provider\s+claude/);
  assert.match(output, /model\s+claude-sonnet-5/);
  assert.match(output, /session\s+active/);
  assert.match(output, /example/);
});
