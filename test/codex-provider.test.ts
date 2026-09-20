import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolarisError } from '../src/core/errors.ts';
import type { CodexConnection, JsonObject } from '../src/providers/codex/app-server.ts';
import { codexProvider, createCodexProvider } from '../src/providers/codex/index.ts';
import type { ModelEvent } from '../src/providers/provider.ts';

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/work/example' });

  assert.deepEqual(
    codex.seen.requests.map((r) => r.method),
    ['initialize', 'getAuthStatus', 'thread/start'],
  );
  assert.deepEqual(codex.seen.notifications, ['initialized']);

  const [initialize, auth, thread] = codex.seen.requests;
  assert.deepEqual(initialize?.params.clientInfo, {
    name: 'polaris',
    title: 'Polaris',
    version: (await import('../src/version.ts')).VERSION,
  });
  assert.equal(auth?.params.includeToken, false, 'Polaris never asks for the token');
  assert.equal(thread?.params.cwd, '/work/example');
  assert.equal(thread?.params.sandbox, 'read-only');
  assert.equal(thread?.params.approvalPolicy, 'never');
  assert.deepEqual(thread?.params.config, { web_search: 'disabled' }, 'no web access');
  assert.equal(session.model, MODEL, 'the model comes from the runtime, not from Polaris');
  await session.close();
});

test('a runtime without a login is reported, and the process is not left running', async () => {
  const codex = fakeCodex({ authMethod: null });
  await assert.rejects(
    () => createCodexProvider(codex.connect).createSession({ cwd: '/tmp' }),
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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });
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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });
  await assert.rejects(() => collect(session.send('hola', AbortSignal.abort())));
  assert.equal(codex.requestsFor('turn/start').length, 0);
});

test('a failed turn is reported cleanly', async () => {
  const codex = fakeCodex({ turnStatus: 'failed' });
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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

test('approval requests are declined, never auto-accepted', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

  assert.deepEqual(codex.ask('item/commandExecution/requestApproval', { command: 'rm -rf /' }), {
    decision: 'decline',
  });
  assert.deepEqual(codex.ask('item/fileChange/requestApproval', {}), { decision: 'decline' });
  assert.deepEqual(codex.ask('execCommandApproval', {}), {
    decision: { denied: { rejection: 'Polaris does not grant approvals.' } },
  });
  assert.throws(() => codex.ask('some/unknownRequest', {}), /unsupported request/);
  await session.close();
});

test('notifications for unknown turns and unknown methods are harmless', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  assert.deepEqual(events[2], { type: 'tool-result', id: 'call_1', summary: '1 match' });
  await session.close();
});

test('model discovery reads the catalog Codex actually returns, hiding internal models', async () => {
  const codex = fakeCodex();
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });
  assert.deepEqual(await session.listModels?.(), [MODEL]);
  await session.close();
});

test('effort comes from the model catalog and is sent with every turn', async () => {
  const codex = fakeCodex({ replies: [['a'], ['b']] });
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });

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
  const session = await createCodexProvider(codex.connect).createSession({ cwd: '/tmp' });
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
    () => provider.createSession({ cwd: '/tmp' }),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /Codex CLI was not found/i);
      return true;
    },
  );
  delete process.env.POLARIS_CODEX_EXECUTABLE;
});
