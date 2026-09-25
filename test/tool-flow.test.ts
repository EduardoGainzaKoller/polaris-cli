import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp, type UiMessage } from '../src/core/app.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { type ModelEvent, registerProvider } from '../src/providers/provider.ts';
import { transcriptLines } from '../src/ui/layout.ts';
import { PERMISSION_PROFILES, TEST_ACCESS } from './helpers.ts';

let workspace: string;

registerProvider(mockProvider);

/** Emits exactly the events it is given, so UI state can be tested in isolation. */
let script: ModelEvent[] = [];
registerProvider({
  id: 'scripted',
  supports: PERMISSION_PROFILES,
  async createSession() {
    return {
      access: TEST_ACCESS,
      model: 'scripted-1',
      async *send(_input, signal): AsyncIterable<ModelEvent> {
        for (const event of script) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          signal?.throwIfAborted();
          yield event;
        }
      },
      async close() {},
    };
  },
});

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'polaris-flow-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), '{\n  "name": "demo"\n}\n');
  await writeFile(join(workspace, 'src', 'provider.ts'), 'export interface ModelProvider {}\n');
});

async function app(provider: string, permissions?: PermissionProfile): Promise<PolarisApp> {
  const created = new PolarisApp({
    cwd: workspace,
    config: { provider, ...(permissions ? { permissions } : {}) },
  });
  await created.start();
  return created;
}

function tools(messages: readonly UiMessage[]): UiMessage[] {
  return messages.filter((message) => message.role === 'tool');
}

// ------------------------------------------------------------------ mock

test('the mock runs real Polaris tools: success, error and several in one turn', async () => {
  const polaris = await app('mock');
  await polaris.submit('@glob(**/*.ts) @read(package.json) @read(nope.ts) analiza');

  const calls = tools(polaris.state.messages);
  assert.deepEqual(
    calls.map((message) => [
      message.tool?.name,
      message.tool?.target,
      message.state,
      message.tool?.detail,
    ]),
    [
      ['Glob', '**/*.ts', 'complete', '1 file'],
      ['Read', 'package.json', 'complete', '3 lines'],
      ['Read', 'nope.ts', 'error', 'File not found.'],
    ],
  );
  assert.equal(polaris.state.messages.at(-1)?.text, 'You said: analiza');
  assert.equal(polaris.state.status, 'ready', 'a failed tool does not fail the turn');
  await polaris.close();
});

test('the mock is cancellable between tools', async () => {
  const polaris = await app('mock');
  const turn = polaris.submit('@read(package.json) @wait(500) @read(src/provider.ts) hola');
  await new Promise((resolve) => setTimeout(resolve, 60));
  polaris.cancel();
  await turn;

  assert.equal(tools(polaris.state.messages).length, 1, 'the second read never started');
  assert.equal(polaris.state.status, 'cancelled');
  await polaris.submit('sigues');
  assert.equal(polaris.state.messages.at(-1)?.text, 'You said: sigues');
  await polaris.close();
});

// ------------------------------------------------------------ UI state

test('tool-start makes a running entry, tool-result completes it', async () => {
  script = [
    { type: 'message-start' },
    { type: 'tool-start', id: 't1', name: 'Read', target: 'src/main.ts' },
    { type: 'tool-result', id: 't1', summary: '84 lines' },
    { type: 'text-delta', text: 'Done.' },
    { type: 'message-end' },
  ];
  const polaris = await app('scripted');
  const seen: string[] = [];
  polaris.subscribe((state) => {
    const call = tools(state.messages)[0];
    if (call) seen.push(`${call.state}:${state.status}`);
  });
  await polaris.submit('lee');

  assert.ok(seen.includes('streaming:reading'), 'running, with a "reading" status');
  const [call] = tools(polaris.state.messages);
  assert.equal(call?.state, 'complete');
  assert.equal(call?.tool?.detail, '84 lines');
  await polaris.close();
});

test('tool-error marks the entry failed and the turn carries on', async () => {
  script = [
    { type: 'tool-start', id: 't1', name: 'Read', target: '../secret' },
    { type: 'tool-error', id: 't1', error: 'Path is outside the workspace.' },
    { type: 'text-delta', text: 'No puedo.' },
  ];
  const polaris = await app('scripted');
  await polaris.submit('lee');
  const [call] = tools(polaris.state.messages);
  assert.equal(call?.state, 'error');
  assert.equal(call?.tool?.detail, 'Path is outside the workspace.');
  assert.equal(polaris.state.status, 'ready');
  await polaris.close();
});

test('parallel tools are tracked independently and the status says "working"', async () => {
  script = [
    { type: 'tool-start', id: 'a', name: 'Glob', target: '**/*.ts' },
    { type: 'tool-start', id: 'b', name: 'Grep', target: '"x"' },
    { type: 'tool-result', id: 'b', summary: '2 matches' },
    { type: 'tool-result', id: 'a', summary: '9 files' },
  ];
  const polaris = await app('scripted');
  const statuses = new Set<string>();
  polaris.subscribe((state) => statuses.add(state.status));
  await polaris.submit('busca');

  assert.ok(statuses.has('working'), 'two tools at once');
  assert.ok(statuses.has('searching'), 'one search left');
  assert.deepEqual(
    tools(polaris.state.messages).map((message) => message.tool?.detail),
    ['9 files', '2 matches'],
  );
  await polaris.close();
});

test('text after a tool starts a new answer, so the transcript keeps its order', async () => {
  script = [
    { type: 'text-delta', text: 'Voy a mirar.' },
    { type: 'tool-start', id: 't1', name: 'Read', target: 'a.ts' },
    { type: 'tool-result', id: 't1', summary: '3 lines' },
    { type: 'text-delta', text: 'Listo.' },
  ];
  const polaris = await app('scripted');
  await polaris.submit('mira');
  assert.deepEqual(
    polaris.state.messages.map((message) => message.role),
    ['user', 'assistant', 'tool', 'assistant'],
  );
  await polaris.close();
});

test('cancelling marks still-running tools as cancelled', async () => {
  script = [
    { type: 'tool-start', id: 't1', name: 'Grep', target: '"x"' },
    { type: 'text-delta', text: 'never' },
    { type: 'text-delta', text: 'never' },
  ];
  const polaris = await app('scripted');
  const turn = polaris.submit('busca');
  await new Promise((resolve) => setTimeout(resolve, 8));
  polaris.cancel();
  await turn;
  assert.equal(tools(polaris.state.messages)[0]?.state, 'cancelled');
  await polaris.close();
});

// --------------------------------------------------------------- layout

test('tools render as one compact line plus their outcome, grouped together', () => {
  const lines = transcriptLines(
    [
      { id: '1', role: 'user', text: 'Analiza', state: 'complete' },
      {
        id: '2',
        role: 'tool',
        text: '',
        state: 'complete',
        tool: { name: 'Glob', target: '**/*.ts', detail: '31 files' },
      },
      {
        id: '3',
        role: 'tool',
        text: '',
        state: 'streaming',
        tool: { name: 'Read', target: 'package.json' },
      },
      {
        id: '4',
        role: 'tool',
        text: '',
        state: 'error',
        tool: { name: 'Read', target: '../x', detail: 'Path is outside the workspace.' },
      },
    ],
    60,
  );
  assert.deepEqual(
    lines.map((line) => [line.kind, line.label ?? '', line.text, line.aside ?? '']),
    [
      ['user', '', '', ''],
      ['user', '', 'Analiza', ''],
      ['user', '', '', ''],
      ['blank', '', '', ''],
      // A short outcome sits beside the row…
      ['tool', 'Glob', '**/*.ts', '31 files'],
      ['tool', 'Read', 'package.json', ''],
      // …an error goes on its own line, so it is never cut.
      ['tool', 'Read', '../x', ''],
      ['detail', '', 'Path is outside the workspace.', ''],
    ],
  );
});

// ------------------------------------------------------------- commands

function context(polaris: PolarisApp): CommandContext {
  return {
    app: polaris,
    canSelect: false,
    select: async () => null,
    clearScreen: () => {},
    requestExit: () => {},
  };
}

async function toolsNotice(profile: PermissionProfile): Promise<string> {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  const polaris = await app('mock', profile);
  await registry.get('tools')?.run(context(polaris), []);
  const notice = polaris.state.messages.at(-1)?.text ?? '';
  await polaris.close();
  return notice;
}

test('/tools describes the policy by what things do, not tool by tool', async () => {
  const smart = await toolsNotice('smart');
  assert.match(
    smart,
    /Tools \(Polaris\): read_file, glob_files, grep_text, write_file, edit_file, run_command/,
  );
  assert.match(smart, /Read \/ Glob \/ Grep\s+auto/);
  assert.match(smart, /Write \/ Edit\s+auto when the request asks for changes · ask otherwise/);
  assert.match(smart, /safe Git inspection\s+auto/);
  assert.match(smart, /project code, installs, network\s+ask/);
  assert.match(smart, /Outside the workspace\s+denied/);
  assert.match(smart, /Permissions: smart/);
  // Polaris runs commands itself here, with no sandbox, and says so.
  assert.match(smart, /not sandboxed/);
});

test('/tools under read-only: no edits, and no command beyond safe inspection', async () => {
  const notice = await toolsNotice('read-only');
  assert.doesNotMatch(notice, /write_file/);
  assert.match(notice, /Write \/ Edit\s+denied/);
  assert.match(notice, /safe Git inspection\s+auto/);
  assert.match(notice, /anything else\s+denied/);
});

test('/tools shows edits as automatic under workspace-write, commands still classified', async () => {
  const notice = await toolsNotice('workspace-write');
  assert.match(notice, /Write \/ Edit\s+auto\n/);
  assert.match(notice, /project code, installs, network\s+ask/);
});

test('/status reports the permission profile', async () => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  const polaris = await app('mock', 'workspace-write');
  await registry.get('status')?.run(context(polaris), []);
  assert.match(polaris.state.messages.at(-1)?.text ?? '', /perms\s+workspace-write/);
  await polaris.close();
});
