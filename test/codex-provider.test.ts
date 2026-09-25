import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PolarisError } from '../src/core/errors.ts';
import { PermissionGate } from '../src/permissions/gate.ts';
import { authorizeTask } from '../src/permissions/task.ts';
import type { CodexConnection, JsonObject } from '../src/providers/codex/app-server.ts';
import { codexProvider, createCodexProvider } from '../src/providers/codex/index.ts';
import type { ModelEvent } from '../src/providers/provider.ts';
import { autoGate, skillContext, testSession } from './helpers.ts';

const THREAD = 'thread-1';
const MODEL = 'gpt-5.6-luna';

interface FakeOptions {
  /** One reply (as chunks) per turn. */
  replies?: string[][];
  authMethod?: string | null;
  /** Emitted as the turn status instead of `completed`. */
  turnStatus?: string;
  chunkDelayMs?: number;
  /** Thread items (started, then completed) emitted before each turn's text. */
  items?: Array<Array<{ started: JsonObject; completed: JsonObject }>>;
  /** Behave like an App Server without the experimental `dynamicTools` field. */
  rejectDynamicTools?: boolean;
}

/**
 * A fake App Server: same JSON-RPC surface, no process, no quota. Only our own
 * seam is faked — the protocol methods and payloads are the real ones.
 */
function fakeCodex(options: FakeOptions = {}) {
  const seen = {
    requests: [] as Array<{ method: string; params: JsonObject }>,
    notifications: [] as string[],
    closed: false,
  };
  const replies = [...(options.replies ?? [['ok']])];
  let notify: ((method: string, params: JsonObject) => void) | null = null;
  let onRequest: ((method: string, params: JsonObject) => unknown) | null = null;
  let onClose: ((error: Error) => void) | null = null;
  let turnCount = 0;
  let interrupted = false;

  const connection: CodexConnection = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      seen.requests.push({ method, params: (params ?? {}) as JsonObject });
      if (method === 'getAuthStatus') {
        const authMethod = options.authMethod === undefined ? 'chatgpt' : options.authMethod;
        return { authMethod, authToken: null } as T;
      }
      if (method === 'thread/start') {
        if (options.rejectDynamicTools && (params as JsonObject)?.dynamicTools) {
          throw new Error('unknown field `dynamicTools`');
        }
        return { thread: { id: THREAD }, model: MODEL, reasoningEffort: 'medium' } as T;
      }
      if (method === 'model/list') {
        // Shape from `codex app-server generate-ts`: the catalog is under `data`.
        return {
          data: [
            {
              id: MODEL,
              model: MODEL,
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: '' },
                { reasoningEffort: 'medium', description: '' },
                { reasoningEffort: 'high', description: '' },
              ],
            },
            { id: 'internal', model: 'internal', hidden: true, supportedReasoningEfforts: [] },
          ],
        } as T;
      }
      if (method === 'turn/start') {
        const turnId = `turn-${++turnCount}`;
        interrupted = false;
        void stream(turnId, replies.shift() ?? ['ok']);
        return { turn: { id: turnId } } as T;
      }
      if (method === 'turn/interrupt') {
        interrupted = true;
        return {} as T;
      }
      return {} as T;
    },
    notify(method) {
      seen.notifications.push(method);
    },
    onNotification(handler) {
      notify = handler;
    },
    onRequest(handler) {
      onRequest = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    async close() {
      seen.closed = true;
    },
  };

  async function stream(turnId: string, chunks: string[]): Promise<void> {
    // A notification Polaris does not render yet must never break the turn.
    notify?.('item/reasoning/textDelta', { turnId, delta: 'thinking about it' });
    for (const item of options.items?.shift() ?? []) {
      notify?.('item/started', { threadId: THREAD, turnId, item: item.started });
      notify?.('item/completed', { threadId: THREAD, turnId, item: item.completed });
    }
    for (const delta of chunks) {
      if (interrupted) break;
      if (options.chunkDelayMs) await new Promise((r) => setTimeout(r, options.chunkDelayMs));
      notify?.('item/agentMessage/delta', { threadId: THREAD, turnId, itemId: 'i1', delta });
    }
    const status = interrupted ? 'interrupted' : (options.turnStatus ?? 'completed');
    notify?.('turn/completed', {
      threadId: THREAD,
      turn: { id: turnId, status, error: status === 'failed' ? { message: 'boom' } : null },
    });
  }

  return {
    seen,
    connect: async () => connection,
    /** Drives the handlers the provider installed on the connection. */
    emit: (method: string, params: JsonObject = {}) => notify?.(method, params),
    ask: (method: string, params: JsonObject = {}) => onRequest?.(method, params),
    kill: (error: Error) => onClose?.(error),
    requestsFor: (method: string) => seen.requests.filter((r) => r.method === method),
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: ModelEvent[]): string {
  return events.map((e) => (e.type === 'text-delta' ? e.text : '')).join('');
}

test('the codex provider is registered under its own id', () => {
  assert.equal(codexProvider.id, 'codex');
  assert.equal(createCodexProvider().id, 'codex');
});

test('the session performs the documented handshake before anything else', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/work/example'),
  );

  assert.deepEqual(
    codex.seen.requests.map((r) => r.method),
    ['initialize', 'getAuthStatus', 'configRequirements/read', 'thread/start'],
  );
  assert.deepEqual(codex.seen.notifications, ['initialized']);

  const [initialize, auth, , thread] = codex.seen.requests;
  assert.deepEqual(initialize?.params.clientInfo, {
    name: 'polaris',
    title: 'Polaris',
    version: (await import('../src/version.ts')).VERSION,
  });
  assert.equal(auth?.params.includeToken, false, 'Polaris never asks for the token');
  assert.equal(thread?.params.cwd, '/work/example');
  // The default profile is "ask", which Codex enforces with its own sandbox
  // and its own approval policy rather than anything Polaris invents.
  assert.equal(thread?.params.sandbox, 'workspace-write');
  // `untrusted`, not `on-request`: on-request only asks when the runtime wants
  // to leave the sandbox, so nothing inside the workspace would ever be asked.
  assert.equal(thread?.params.approvalPolicy, 'untrusted');
  assert.notEqual(thread?.params.sandbox, 'danger-full-access');
  assert.deepEqual(thread?.params.config, { web_search: 'disabled' }, 'no web access');
  assert.equal(session.model, MODEL, 'the model comes from the runtime, not from Polaris');
  await session.close();
});

test('a runtime without a login is reported, and the process is not left running', async () => {
  const codex = fakeCodex({ authMethod: null });
  await assert.rejects(
    () => createCodexProvider(codex.connect).createSession(testSession('/tmp')),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /not authenticated/i);
      assert.match(error.message, /sign in with ChatGPT/i);
      return true;
    },
  );
  assert.equal(codex.seen.closed, true);
});

test('agent message deltas become Polaris events, other notifications are ignored', async () => {
  const codex = fakeCodex({ replies: [['Hola', ' Eduardo']] });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  const events = await collect(session.send('Me llamo Eduardo'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['message-start', 'text-delta', 'text-delta', 'message-end'],
  );
  assert.equal(textOf(events), 'Hola Eduardo');
  await session.close();
});

test('every prompt is a new turn on the same thread', async () => {
  const codex = fakeCodex({ replies: [['Hola Eduardo'], ['Eduardo']] });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  assert.equal(textOf(await collect(session.send('Me llamo Eduardo'))), 'Hola Eduardo');
  assert.equal(textOf(await collect(session.send('Como me llamo'))), 'Eduardo');

  assert.equal(codex.requestsFor('thread/start').length, 1, 'one thread for the whole session');
  const turns = codex.requestsFor('turn/start');
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((t) => t.params.threadId),
    [THREAD, THREAD],
  );
  assert.deepEqual(turns[0]?.params.input, [
    { type: 'text', text: 'Me llamo Eduardo', text_elements: [] },
  ]);
  await session.close();
});

test('Ctrl+C interrupts the turn and the thread keeps working', async () => {
  const codex = fakeCodex({
    replies: [['La ', 'JVM ', 'es ', 'una ', 'maquina'], ['OK']],
    chunkDelayMs: 10,
  });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  const controller = new AbortController();

  let seen = '';
  await assert.rejects(async () => {
    for await (const event of session.send('Explicame la JVM', controller.signal)) {
      if (event.type !== 'text-delta') continue;
      seen += event.text;
      if (seen.includes('JVM')) controller.abort();
    }
  });

  const interrupts = codex.requestsFor('turn/interrupt');
  assert.equal(interrupts.length, 1, 'the turn is interrupted, the runtime is not killed');
  assert.deepEqual(interrupts[0]?.params, { threadId: THREAD, turnId: 'turn-1' });
  assert.ok(seen.length < 'La JVM es una maquina'.length, 'the answer was cut short');

  assert.equal(textOf(await collect(session.send('Responde solo OK'))), 'OK');
  assert.equal(codex.requestsFor('thread/start').length, 1, 'still the same thread');
  await session.close();
});

test('an already aborted signal never starts a turn', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  await assert.rejects(() => collect(session.send('hola', AbortSignal.abort())));
  assert.equal(codex.requestsFor('turn/start').length, 0);
});

test('a failed turn is reported cleanly', async () => {
  const codex = fakeCodex({ turnStatus: 'failed' });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  await assert.rejects(
    () => collect(session.send('hola')),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.equal(error.message, 'Codex turn failed.');
      return true;
    },
  );
  await session.close();
});

test('a runtime that dies mid-turn ends the turn with a clean message', async () => {
  const codex = fakeCodex({ replies: [['nunca llega']], chunkDelayMs: 50 });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  const events = session.send('hola');
  const started = events[Symbol.asyncIterator]();
  await started.next();
  codex.kill(new PolarisError('Codex runtime stopped unexpectedly.'));

  await assert.rejects(
    async () => {
      while (!(await started.next()).done) {
        /* drain */
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /stopped unexpectedly/i);
      return true;
    },
  );
});

test('the approval policy is one that actually asks about the workspace', async () => {
  // Found live: with `on-request`, Codex edits files and runs commands inside
  // its sandbox without ever asking, so an "ask" profile asked nothing at all.
  for (const permissions of ['smart', 'workspace-write'] as const) {
    const codex = fakeCodex();
    const session = await createCodexProvider(codex.connect).createSession(
      testSession('/work', { permissions }),
    );
    const thread = codex.requestsFor('thread/start')[0];
    assert.equal(thread?.params.approvalPolicy, 'untrusted', permissions);
    assert.equal(thread?.params.sandbox, 'workspace-write', permissions);
    await session.close();
  }
});

test('a Windows shell wrapper is unwrapped before it is shown for approval', async () => {
  // Found live: on Windows every command is wrapped in powershell.exe, and
  // approving `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  // -Command '...'` tells nobody what they are agreeing to.
  const { gate, asked } = autoGate('smart', 'allow');
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/work', { permissions: 'smart', gate }),
  );

  await codex.ask('item/commandExecution/requestApproval', {
    command:
      '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'npm test\'',
    commandActions: [{ type: 'unknown', command: 'npm test' }],
    cwd: '/work',
  });
  assert.deepEqual(asked, ['Run command npm test']);
  await session.close();
});

test('read-only keeps both the sandbox and the approval policy closed', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/tmp', { permissions: 'read-only' }),
  );
  const thread = codex.requestsFor('thread/start')[0];
  assert.equal(thread?.params.sandbox, 'read-only');
  assert.equal(thread?.params.approvalPolicy, 'never');
  await session.close();
});

test('a server approval request becomes a Polaris approval and comes back as a decision', async () => {
  const allowed = autoGate('smart', 'allow');
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/work', { permissions: 'smart', gate: allowed.gate }),
  );

  assert.deepEqual(
    await codex.ask('item/commandExecution/requestApproval', {
      command: 'npm test',
      cwd: '/work',
    }),
    { decision: 'accept' },
  );
  assert.deepEqual(allowed.asked, ['Run command npm test']);

  // The diff arrives on item/started; the approval that follows carries only
  // ids, so the card must find it in the session's own cache.
  codex.emit('item/started', {
    turnId: 'turn-x',
    item: {
      type: 'fileChange',
      id: 'patch_1',
      status: 'inProgress',
      changes: [{ path: '/work/src/a.ts', diff: '-old\n+new' }],
    },
  });
  assert.deepEqual(await codex.ask('item/fileChange/requestApproval', { itemId: 'patch_1' }), {
    decision: 'accept',
  });
  assert.deepEqual(allowed.asked.at(-1), 'Edit src/a.ts');
  await session.close();
});

test('a refused approval declines in Codex vocabulary, legacy shape included', async () => {
  const refused = autoGate('smart', 'deny');
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/tmp', { permissions: 'smart', gate: refused.gate }),
  );

  assert.deepEqual(
    await codex.ask('item/commandExecution/requestApproval', { command: 'rm -rf /' }),
    { decision: 'decline' },
  );
  assert.deepEqual(await codex.ask('execCommandApproval', { command: ['rm', '-rf', '/'] }), {
    decision: { denied: { rejection: 'The user declined this operation.' } },
  });
  // Anything Polaris cannot present is refused rather than guessed at.
  assert.deepEqual(await codex.ask('some/unknownRequest', {}), { decision: 'decline' });
  await session.close();
});

test('read-only never lets a command through, whatever the runtime asks', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession('/tmp', { permissions: 'read-only' }),
  );
  assert.deepEqual(
    await codex.ask('item/commandExecution/requestApproval', { command: 'npm test' }),
    { decision: 'decline' },
  );
  await session.close();
});

test('notifications for unknown turns and unknown methods are harmless', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  codex.emit('thread/tokenUsage/updated', { threadId: THREAD, usage: { total: 10 } });
  codex.emit('item/agentMessage/delta', { turnId: 'turn-does-not-exist', delta: 'ghost' });
  codex.emit('turn/completed', { turn: { id: 'turn-does-not-exist', status: 'completed' } });

  assert.equal(textOf(await collect(session.send('hola'))), 'ok', 'the session still works');
  await session.close();
});

test('sandboxed commands in a turn surface as tool events before the answer', async () => {
  const codex = fakeCodex({
    replies: [['Está en provider.ts']],
    items: [
      [
        {
          started: {
            type: 'commandExecution',
            id: 'call_1',
            command: 'rg ModelProvider',
            status: 'inProgress',
            commandActions: [{ type: 'search', command: 'rg', query: 'ModelProvider', path: null }],
          },
          completed: {
            type: 'commandExecution',
            id: 'call_1',
            command: 'rg ModelProvider',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'src/providers/provider.ts:40: export interface ModelProvider',
            commandActions: [{ type: 'search', command: 'rg', query: 'ModelProvider', path: null }],
          },
        },
      ],
    ],
  });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  const events = await collect(session.send('¿Dónde se define ModelProvider?'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['message-start', 'tool-start', 'tool-result', 'text-delta', 'message-end'],
  );
  assert.deepEqual(events[1], {
    type: 'tool-start',
    id: 'call_1',
    name: 'Grep',
    target: '"ModelProvider"',
  });
  assert.deepEqual(events[2], {
    type: 'tool-result',
    id: 'call_1',
    summary: '1 match',
    exitCode: 0,
  });
  await session.close();
});

test('model discovery reads the catalog Codex actually returns, hiding internal models', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  assert.deepEqual(await session.listModels?.(), [MODEL]);
  await session.close();
});

test('effort comes from the model catalog and is sent with every turn', async () => {
  const codex = fakeCodex({ replies: [['a'], ['b']] });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));

  assert.equal(session.effort, 'medium', 'the thread reports its starting effort');
  assert.deepEqual(await session.efforts?.(), ['low', 'medium', 'high']);

  await session.setEffort?.('high');
  await collect(session.send('hola'));
  assert.equal(codex.requestsFor('turn/start').at(-1)?.params.effort, 'high');
  assert.equal(codex.requestsFor('thread/start').length, 1, 'no new thread for an effort change');

  await assert.rejects(() => session.setEffort?.('xhigh') ?? Promise.resolve(), /does not support/);
  assert.equal(session.effort, 'high');
  await session.close();
});

test('closing the session shuts the runtime down', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  await collect(session.send('hola'));
  await session.close();
  assert.equal(codex.seen.closed, true);
});

test('a missing Codex CLI is reported without a stack trace', async () => {
  process.env.POLARIS_CODEX_EXECUTABLE = 'polaris-no-such-codex-binary';
  // Imported after the override so the module picks it up.
  const { connectToAppServer } = await import('../src/providers/codex/app-server.ts?missing');
  const provider = createCodexProvider(connectToAppServer as never);

  await assert.rejects(
    () => provider.createSession(testSession('/tmp')),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /Codex CLI was not found/i);
      return true;
    },
  );
  delete process.env.POLARIS_CODEX_EXECUTABLE;
});

// ---------------------------------------------------------- project context

test('project context and skill tools go through the official thread fields', async () => {
  const codex = fakeCodex();
  const { session: context } = await skillContext();
  const session = await createCodexProvider(codex.connect).createSession({
    ...testSession('/tmp'),
    context,
  });

  const init = codex.requestsFor('initialize')[0]?.params as JsonObject;
  assert.deepEqual(init.capabilities, { experimentalApi: true });
  const thread = codex.requestsFor('thread/start')[0]?.params as JsonObject;
  const instructions = String(thread.developerInstructions);
  assert.match(instructions, /PROJECT-RULE/);
  assert.match(instructions, /- testing: Write and run tests\./);
  assert.doesNotMatch(instructions, /TESTING-BODY/);
  assert.deepEqual(
    (thread.dynamicTools as Array<{ name: string }>).map((tool) => tool.name),
    ['load_skill', 'read_skill_reference'],
  );

  const reply = (await codex.ask('item/tool/call', {
    threadId: THREAD,
    turnId: 't',
    callId: 'c',
    namespace: null,
    tool: 'load_skill',
    arguments: { name: 'testing' },
  })) as { success: boolean; contentItems: Array<{ type: string; text: string }> };
  assert.equal(reply.success, true);
  assert.equal(reply.contentItems[0]?.type, 'inputText');
  assert.match(reply.contentItems[0]?.text ?? '', /TESTING-BODY/);

  const reference = (await codex.ask('item/tool/call', {
    tool: 'read_skill_reference',
    arguments: { skill: 'testing', path: '../../../POLARIS.md' },
  })) as { success: boolean };
  assert.equal(reference.success, false, 'references stay inside their skill');
  await session.close();
});

test('without dynamic tools Codex still gets the context, and the user loads skills', async () => {
  const codex = fakeCodex({ rejectDynamicTools: true, replies: [['a']] });
  const { manager, session: context } = await skillContext();
  const session = await createCodexProvider(codex.connect).createSession({
    ...testSession('/tmp'),
    context,
  });
  const [refused, accepted] = codex.requestsFor('thread/start');
  assert.ok(refused?.params.dynamicTools);
  assert.equal(accepted?.params.dynamicTools, undefined);
  assert.match(String(accepted?.params.developerInstructions), /tell the user to run \/skill/);

  await manager.load('testing');
  await collect(session.send('go'));
  const input = codex.requestsFor('turn/start')[0]?.params.input as Array<{ text: string }>;
  assert.equal(input.length, 2);
  assert.match(input[0]?.text ?? '', /<loaded_skill name="testing">/);
  assert.equal(input[1]?.text, 'go');
  await session.close();
});

test('a dynamic tool call for a skill is not rendered as a tool', async () => {
  const call = { id: 'd1', type: 'dynamicToolCall', tool: 'load_skill', status: 'inProgress' };
  const codex = fakeCodex({
    items: [[{ started: call, completed: { ...call, status: 'completed' } }]],
  });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  const events = await collect(session.send('go'));
  assert.equal(
    events.some((event) => event.type === 'tool-start'),
    false,
  );
  await session.close();
});

// ---------------------------------------------------------- smart permissions

test('smart: routine Codex requests are answered by the policy, boundaries reach the user', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'polaris-codex-smart-')));
  const gate = new PermissionGate('smart', { workspace });
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(`${request.target} · ${request.reason}`);
    return 'allow';
  });
  gate.beginTask(authorizeTask('Implement the login and add tests.', null));
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession(
    testSession(workspace, { permissions: 'smart', gate }),
  );
  const approve = (params: JsonObject) =>
    codex.ask('item/commandExecution/requestApproval', params);

  // Safe Git inspection, and a read Codex itself parsed as one: no card.
  assert.deepEqual(await approve({ command: 'git status', cwd: workspace }), {
    decision: 'accept',
  });
  assert.deepEqual(
    await approve({
      command: 'Get-Content -LiteralPath src/a.ts',
      commandActions: [
        { type: 'read', command: 'Get-Content src/a.ts', name: 'a.ts', path: 'src/a.ts' },
      ],
      cwd: workspace,
    }),
    { decision: 'accept' },
  );
  // A patch inside the workspace, for a task that asked for changes: no card.
  codex.emit('item/started', {
    item: {
      id: 'fc1',
      type: 'fileChange',
      changes: [{ path: join(workspace, 'src', 'a.ts'), diff: '+x' }],
    },
  });
  assert.deepEqual(await codex.ask('item/fileChange/requestApproval', { itemId: 'fc1' }), {
    decision: 'accept',
  });
  assert.deepEqual(asked, []);

  // Crossing a boundary asks, and says which one.
  await approve({ command: 'npm install zod', cwd: workspace });
  await approve({
    command: 'npm test',
    cwd: workspace,
    networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
  });
  assert.deepEqual(asked, [
    'npm install zod · May modify dependencies, run install scripts and access the network.',
    'npm test · Requests network access to registry.npmjs.org.',
  ]);
  // A read chained to something else is not a read.
  await approve({
    command: 'Get-Content a.txt; Remove-Item b.txt',
    commandActions: [{ type: 'read', command: 'Get-Content a.txt', name: 'a.txt', path: 'a.txt' }],
    cwd: workspace,
  });
  assert.equal(asked.length, 3);
  // Outside the workspace: declined, and nobody is asked.
  assert.deepEqual(await approve({ command: 'git status', cwd: tmpdir() }), {
    decision: 'decline',
  });
  assert.equal(asked.length, 3);
  await session.close();
});

test('an error Codex says it will retry does not end the turn', async () => {
  const codex = fakeCodex({ replies: [['still ', 'here']], chunkDelayMs: 20 });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  const events = collect(session.send('hola'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  codex.emit('error', {
    error: { message: 'Reconnecting... 2/5' },
    willRetry: true,
    threadId: THREAD,
    turnId: 'turn-1',
  });
  assert.equal(textOf(await events), 'still here');
  await session.close();
});

test('an error Codex will not retry ends the turn with its reason, credentials redacted', async () => {
  const codex = fakeCodex({ replies: [['x'.repeat(1)]], chunkDelayMs: 50 });
  const session = await createCodexProvider(codex.connect).createSession(testSession('/tmp'));
  const events = collect(session.send('hola'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  codex.emit('error', {
    error: {
      message: 'unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac****fvMA',
    },
    willRetry: false,
    threadId: THREAD,
    turnId: 'turn-1',
  });
  await assert.rejects(events, (error: Error) => {
    assert.match(error.message, /Codex is not authenticated/);
    assert.doesNotMatch(error.message, /sk-/);
    return true;
  });
  await session.close();
});
