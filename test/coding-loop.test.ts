import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp, type UiMessage } from '../src/core/app.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { registerProvider } from '../src/providers/provider.ts';

registerProvider(mockProvider);

/**
 * The whole v0.6 loop, end to end and offline: the mock plays the model, the
 * tools are the real ones, the gate is the real one, and the approvals are
 * answered the way the TUI answers them.
 */
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'polaris-loop-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'hello.ts'), "export const hello = () => 'hi';\n");
});

function polaris(permissions: PermissionProfile = 'ask'): PolarisApp {
  return new PolarisApp({ cwd: workspace, config: { provider: 'mock', permissions } });
}

/** Answers approvals as they appear, the way a person at the keyboard would. */
function answerWith(app: PolarisApp, decide: (request: { title: string }) => 'allow' | 'deny') {
  const seen: string[] = [];
  const stop = app.subscribe((state) => {
    if (!state.approval) return;
    seen.push(`${state.approval.title} ${state.approval.target}`);
    const decision = decide(state.approval);
    queueMicrotask(() => app.resolveApproval(decision));
  });
  return { seen, stop };
}

function tools(messages: readonly UiMessage[]): UiMessage[] {
  return messages.filter((message) => message.role === 'tool');
}

test('read, edit, run: the first real coding loop, each mutation approved', async () => {
  const app = polaris('ask');
  await app.start();
  const answers = answerWith(app, () => 'allow');

  await app.submit(
    "@read(src/hello.ts) @edit(src/hello.ts :: 'hi' :: 'hello world') " +
      '@run(node -e "console.log(1)") listo',
  );

  const calls = tools(app.state.messages);
  assert.deepEqual(
    calls.map((call) => `${call.tool?.name}:${call.state}`),
    ['Read:complete', 'Edit:complete', 'Run:complete'],
  );
  // The read was never an ask; the edit and the command both were.
  assert.deepEqual(answers.seen, ['Edit src/hello.ts', 'Run command node -e "console.log(1)"']);
  assert.equal(
    await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'),
    "export const hello = () => 'hello world';\n",
  );
  answers.stop();
  await app.close();
});

test('a refusal stops the operation and leaves the session working', async () => {
  const app = polaris('ask');
  await app.start();
  const answers = answerWith(app, () => 'deny');
  const before = await readFile(join(workspace, 'src', 'hello.ts'), 'utf8');

  await app.submit("@edit(src/hello.ts :: 'hi' :: 'wiped') vale");

  const [edit] = tools(app.state.messages);
  assert.equal(edit?.state, 'cancelled', 'a refusal is not a failure');
  assert.equal(edit?.tool?.denied, true);
  assert.equal(await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'), before);
  assert.equal(app.state.status, 'ready', 'the turn finished normally');
  assert.equal(answers.seen.length, 1);

  // And the session carries on: the next turn works.
  await app.submit('@read(src/hello.ts) y ahora?');
  assert.equal(tools(app.state.messages).at(-1)?.state, 'complete');
  answers.stop();
  await app.close();
});

test('read-only makes the mutation impossible, not merely discouraged', async () => {
  const app = polaris('read-only');
  await app.start();
  let asked = 0;
  const stop = app.subscribe((state) => {
    if (state.approval) asked += 1;
  });
  const before = await readFile(join(workspace, 'src', 'hello.ts'), 'utf8');

  await app.submit("@edit(src/hello.ts :: 'hi' :: 'wiped') @run(node -e \"console.log(1)\") va");

  assert.equal(asked, 0, 'nothing was even offered for approval');
  for (const call of tools(app.state.messages)) {
    assert.equal(call.state, 'error');
    assert.match(call.tool?.detail ?? '', /Unknown tool/);
  }
  assert.equal(await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'), before);
  stop();
  await app.close();
});

test('workspace-write edits without asking, but still asks for commands', async () => {
  const app = polaris('workspace-write');
  await app.start();
  const answers = answerWith(app, () => 'allow');

  await app.submit(
    "@edit(src/hello.ts :: 'hi' :: 'automatic') @run(node -e \"console.log(1)\") ok",
  );

  assert.deepEqual(
    answers.seen,
    ['Run command node -e "console.log(1)"'],
    'only the command was an ask',
  );
  assert.match(await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'), /automatic/);
  answers.stop();
  await app.close();
});

test('a write outside the workspace is refused under every profile', async () => {
  for (const profile of ['ask', 'workspace-write'] as PermissionProfile[]) {
    const app = polaris(profile);
    await app.start();
    const answers = answerWith(app, () => 'allow');

    await app.submit('@write(../outside.txt :: leaked) hecho');
    const [call] = tools(app.state.messages);
    assert.equal(call?.state, 'error', profile);
    assert.match(call?.tool?.detail ?? '', /outside the workspace/i);
    answers.stop();
    await app.close();
  }
});

test('live command output reaches the transcript while the command runs', async () => {
  const app = polaris('workspace-write');
  await app.start();
  const answers = answerWith(app, () => 'allow');
  const streaming: string[] = [];
  const stop = app.subscribe((state) => {
    for (const message of state.messages) {
      if (message.state === 'streaming' && message.tool?.output)
        streaming.push(message.tool.output);
    }
  });

  await app.submit('@run(node -e "console.log(\'working\')") listo');
  assert.ok(
    streaming.some((text) => text.includes('working')),
    'the UI saw the output before the command finished',
  );
  stop();
  answers.stop();
  await app.close();
});

test('a failing command is a result the loop can act on', async () => {
  const app = polaris('workspace-write');
  await app.start();
  const answers = answerWith(app, () => 'allow');

  await app.submit('@run(node -e "process.exit(3)") y?');
  const [call] = tools(app.state.messages);
  // Not an error state: the command failed, the tool worked.
  assert.equal(call?.state, 'complete');
  assert.match(call?.tool?.detail ?? '', /exit 3/);
  assert.equal(app.state.status, 'ready');
  answers.stop();
  await app.close();
});

test('the profile can be changed mid-session and takes effect immediately', async () => {
  const app = polaris('ask');
  await app.start();
  assert.equal(app.state.permissions, 'ask');

  await app.setPermissions('read-only');
  assert.equal(app.state.permissions, 'read-only');

  const before = await readFile(join(workspace, 'src', 'hello.ts'), 'utf8');
  await app.submit("@edit(src/hello.ts :: 'hi' :: 'nope') va");
  assert.equal(await readFile(join(workspace, 'src', 'hello.ts'), 'utf8'), before);
  await app.close();
});

test('commands that would strand a pending approval are blocked while one is open', async () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  for (const name of ['provider', 'model', 'effort', 'permissions']) {
    assert.equal(registry.get(name)?.blockedByApproval, true, name);
  }
  assert.notEqual(registry.get('status')?.blockedByApproval, true, '/status is always safe');
});

test('/permissions lists the profiles and switches between them', async () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  const app = polaris('ask');
  await app.start();

  const context: CommandContext = {
    app,
    canSelect: true,
    select: async () => null,
    clearScreen: () => {},
    requestExit: () => {},
  };

  await registry.get('permissions')?.run(context, []);
  const listing = app.state.messages.at(-1)?.text ?? '';
  assert.match(listing, /Current: ask/);
  assert.match(listing, /read-only\s+Inspect the repository only/);
  assert.match(listing, /workspace-write\s+Allow workspace edits/);

  await registry.get('permissions')?.run(context, ['workspace-write']);
  assert.equal(app.state.permissions, 'workspace-write');

  await registry.get('permissions')?.run(context, ['full-access']);
  assert.match(app.state.messages.at(-1)?.text ?? '', /Unknown permissions/);
  assert.equal(app.state.permissions, 'workspace-write', 'nothing changed');
  await app.close();
});
