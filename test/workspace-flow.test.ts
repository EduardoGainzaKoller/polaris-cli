import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp } from '../src/core/app.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { type ModelEvent, registerProvider } from '../src/providers/provider.ts';
import { makeRepo, PERMISSION_PROFILES, TEST_ACCESS, writeFiles } from './helpers.ts';

registerProvider(mockProvider);

/**
 * The whole v0.7 loop, offline: the mock "model" edits and runs checks with
 * the real tools, the real gate and the real change tracker, in a throwaway
 * repository. Commands are approved automatically, as a user pressing Enter.
 */
async function open(
  cwd: string,
  options: { permissions?: PermissionProfile; provider?: string; answer?: 'allow' | 'deny' } = {},
) {
  const app = new PolarisApp({
    cwd,
    config: {
      provider: options.provider ?? 'mock',
      permissions: options.permissions ?? 'workspace-write',
    },
  });
  app.subscribe((state) => {
    if (state.approval) queueMicrotask(() => app.resolveApproval(options.answer ?? 'allow'));
  });
  await app.start();
  const registry = new CommandRegistry().register(...builtinCommands(new CommandRegistry()));
  const confirmations: string[] = [];
  const context: CommandContext = {
    app,
    canSelect: false,
    select: async () => null,
    confirm: async (question, details) => {
      confirmations.push([question, ...details].join('\n'));
      return true;
    },
    clearScreen: () => {},
    requestExit: () => {},
  };
  const command = async (line: string) => {
    const [name = '', ...args] = line.slice(1).split(' ');
    await registry.get(name)?.run(context, args);
    return app.state.messages.at(-1)?.text ?? '';
  };
  return { app, command, confirmations };
}

/** A check script: `node check.js <exit code>`. */
const CHECK = { 'check.js': 'process.exit(Number(process.argv[2] ?? 0));\n' };

const read = (dir: string, path: string) => readFile(join(dir, path), 'utf8');

test('edit, run a passing check: the turn ends verified and says so', async () => {
  const repo = await makeRepo({ ...CHECK, 'src/a.ts': 'export const a = 1;\n' });
  const { app } = await open(repo);
  await app.submit('@write(src/a.ts :: export const a = 2;) @run(node check.js 0) done');

  assert.equal(app.state.workspace.changed, 1);
  assert.equal(app.state.workspace.verification, 'verified');
  const report = app.state.messages.at(-1)?.text ?? '';
  assert.match(report, /Verification/);
  assert.match(report, /M src\/a\.ts/);
  assert.match(report, /✓ node check\.js 0/);
  assert.match(report, /✓ no unexpected changes/);
  assert.match(report, /Result\s+passed/);
  await app.close();
});

test('edit, pass, edit again: the status goes back to unverified', async () => {
  const repo = await makeRepo({ ...CHECK, 'src/a.ts': '1\n' });
  const { app, command } = await open(repo);
  await app.submit('@write(src/a.ts :: 2) @run(node check.js 0) ok');
  assert.equal(app.state.workspace.verification, 'verified');

  await app.submit('@write(src/a.ts :: 3) one more tweak');
  assert.equal(app.state.workspace.verification, 'unverified');
  assert.match(app.state.messages.at(-1)?.text ?? '', /stale — ran before the latest change/);
  assert.match(await command('/status'), /checks\s+unverified/);
  await app.close();
});

test('a failing check is reported as failed, not as done', async () => {
  const repo = await makeRepo({ ...CHECK, 'src/a.ts': '1\n' });
  const { app } = await open(repo);
  await app.submit('@write(src/a.ts :: 2) @run(node check.js 3) finished');
  assert.equal(app.state.workspace.verification, 'failed');
  const report = app.state.messages.at(-1)?.text ?? '';
  assert.match(report, /✗ node check\.js 3\s+exit 3/);
  assert.match(report, /Result\s+failed/);
  await app.close();
});

test('a check cancelled mid-run leaves verification incomplete', async () => {
  const repo = await makeRepo({
    'slow-check.js': 'setTimeout(() => {}, 30000);\n',
    'src/a.ts': '1\n',
  });
  const { app } = await open(repo);
  const stop = app.subscribe((state) => {
    if (state.status === 'running') queueMicrotask(() => app.cancel());
  });
  await app.submit('@write(src/a.ts :: 2) @run(node slow-check.js) never');
  stop();
  assert.equal(app.state.workspace.verification, 'incomplete');
  await app.close();
});

test('pre-existing work: /diff separates it and /undo leaves it byte for byte', async () => {
  const repo = await makeRepo({ 'README.md': '# Project\n', 'src/service.ts': 'v1\n' });
  await writeFile(join(repo, 'README.md'), '# Project\n\nMy unfinished notes.\n');
  const readme = await readFile(join(repo, 'README.md'));

  const { app, command, confirmations } = await open(repo);
  await app.submit('@write(src/service.ts :: v2) editing the service');

  const diff = await command('/diff');
  const [session = '', preexisting = ''] = diff.split('Pre-existing changes');
  assert.match(session, /src\/service\.ts\s+\+1 -1/);
  assert.doesNotMatch(session, /README/);
  assert.match(preexisting, /README\.md/);
  assert.match(diff, /-v1\n\s*\+v2/);

  const undone = await command('/undo');
  assert.match(
    confirmations[0] ?? '',
    /Undo changes since cp-1 \(session start\)\?\nsrc\/service\.ts/,
  );
  assert.match(undone, /Restored 1 file to cp-1/);
  assert.equal(await read(repo, 'src/service.ts'), 'v1\n');
  assert.deepEqual(await readFile(join(repo, 'README.md')), readme);
  assert.equal(app.state.workspace.changed, 0);
  await app.close();
});

test('/checkpoint then /undo returns only what came after it', async () => {
  const repo = await makeRepo({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
  const { app, command } = await open(repo);
  await app.submit('@write(a.txt :: a1) first');
  assert.match(await command('/checkpoint before b'), /Checkpoint created: cp-2 \(before b\)/);
  await app.submit('@write(b.txt :: b1) second');

  assert.match(await command('/checkpoints'), /cp-1\s+session start[\s\S]*cp-2\s+before b.*latest/);
  await command('/undo');
  assert.equal(await read(repo, 'a.txt'), 'a1\n');
  assert.equal(await read(repo, 'b.txt'), 'b0\n');
  await app.close();
});

test('a refused undo changes nothing', async () => {
  const repo = await makeRepo({ 'a.txt': 'a0\n' });
  const { app, command } = await open(repo);
  await app.submit('@write(a.txt :: a1) edit');
  const registry = new CommandRegistry().register(...builtinCommands(new CommandRegistry()));
  await registry.get('undo')?.run(
    {
      app,
      canSelect: false,
      select: async () => null,
      confirm: async () => false,
      clearScreen: () => {},
      requestExit: () => {},
    },
    [],
  );
  assert.match(app.state.messages.at(-1)?.text ?? '', /Undo cancelled/);
  assert.equal(await read(repo, 'a.txt'), 'a1\n');
  assert.match(await command('/status'), /changes\s+1 by Polaris/);
  await app.close();
});

test('edits made by a runtime on its own, without Polaris tools, are still found', async () => {
  const repo = await makeRepo({ 'src/native.ts': 'before\n' });
  // A runtime that edits natively and announces nothing — the worst case.
  registerProvider({
    id: 'native-editor',
    supports: PERMISSION_PROFILES,
    async createSession({ cwd }) {
      return {
        access: TEST_ACCESS,
        model: 'native-1',
        async *send(): AsyncIterable<ModelEvent> {
          yield { type: 'tool-start', id: 't1', name: 'Tool', target: 'something' };
          await writeFiles(cwd, { 'src/native.ts': 'after\n' });
          yield { type: 'tool-result', id: 't1', summary: 'done' };
          yield { type: 'text-delta', text: 'ok' };
        },
        async close() {},
      };
    },
  });
  const { app, command } = await open(repo, { provider: 'native-editor' });
  await app.submit('change it');

  assert.equal(app.state.workspace.changed, 1);
  assert.match(await command('/diff'), /src\/native\.ts\s+\+1 -1\s+\(not written by a file tool\)/);
  await command('/undo');
  assert.equal(await read(repo, 'src/native.ts'), 'before\n');
  await app.close();
});

test('/new: new conversation, same provider, model and profile, files and all', async () => {
  const repo = await makeRepo({ 'a.txt': 'a0\n' });
  const sessions = { created: 0, closed: 0 };
  registerProvider({
    ...mockProvider,
    id: 'counted',
    async createSession(options) {
      sessions.created += 1;
      const session = await mockProvider.createSession(options);
      return {
        ...session,
        send: session.send.bind(session),
        close: async () => {
          sessions.closed += 1;
          await session.close();
        },
      };
    },
  });
  const { app, command } = await open(repo, { permissions: 'ask', provider: 'counted' });
  await app.setModel('echo-uppercase');
  await app.submit('@write(a.txt :: a1) change');
  const before = app.state;
  assert.ok(before.turns > 0);
  const { created, closed } = sessions;

  await command('/new');
  const after = app.state;
  assert.equal(sessions.created, created + 1, 'a new runtime session');
  assert.equal(sessions.closed, closed + 1, 'the old one closed');
  assert.equal(after.provider, before.provider);
  assert.equal(after.model, 'echo-uppercase');
  assert.equal(after.permissions, 'ask');
  assert.equal(after.turns, 0, 'the conversation is gone');
  assert.equal(await read(repo, 'a.txt'), 'a1\n', 'the files are not');
  // A new baseline: session one's change is now the user's to keep.
  assert.equal(after.workspace.changed, 0);
  assert.equal(after.workspace.preexisting, 1);
  assert.match(await command('/undo'), /Nothing to undo/);
  assert.equal(await read(repo, 'a.txt'), 'a1\n');
  await app.close();
});

test('/status reports Git, and says so plainly outside a repository', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n' });
  const { app, command } = await open(repo);
  assert.match(await command('/status'), /git\s+main @ [0-9a-f]{7}/);
  await app.close();

  const plain = await realpath(await mkdtemp(join(tmpdir(), 'polaris-plain-')));
  const outside = await open(plain);
  const status = await outside.command('/status');
  assert.match(status, /git\s+not a repository/);
  assert.match(status, /changes\s+0 by Polaris · 0 pre-existing/);
  await outside.app.close();
});

test('the exit summary lists what is kept, and nothing when nothing changed', async () => {
  const repo = await makeRepo({ ...CHECK, 'a.txt': 'a0\n' });
  const { app } = await open(repo);
  assert.equal(app.exitSummary(), null);
  await app.submit('@write(a.txt :: a1) @run(node check.js 0) ok');
  assert.match(app.exitSummary() ?? '', /Changes kept: 1 file\n\s+Verification: passed/);
  await app.close();
  assert.equal(await read(repo, 'a.txt'), 'a1\n', 'exiting never reverts');
});
