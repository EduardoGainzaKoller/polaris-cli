import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AgentManager,
  MAIN_AGENT,
  type ParentScope,
  type SpawnChild,
} from '../src/agents/manager.ts';
import { AgentRegistry } from '../src/agents/registry.ts';
import type { ContextManager } from '../src/context/manager.ts';
import { PermissionGate } from '../src/permissions/gate.ts';
import { authorizeTask } from '../src/permissions/task.ts';
import { anthropicApiProvider } from '../src/providers/anthropic-api/index.ts';
import { type ClaudeRun, createClaudeProvider } from '../src/providers/claude/index.ts';
import { workspaceGuard } from '../src/providers/claude/tools.ts';
import type { CodexConnection, JsonObject } from '../src/providers/codex/app-server.ts';
import { createCodexProvider } from '../src/providers/codex/index.ts';
import type { ModelEvent, ModelProvider, ModelSession } from '../src/providers/provider.ts';
import { skillContext, writeFiles } from './helpers.ts';

/**
 * Provider parity, offline: each adapter creates an isolated child, gives it
 * read-only tools only, streams its activity and returns only the result.
 * The mechanisms differ — a Messages API conversation, a Claude query, a
 * Codex thread — the Polaris semantics do not.
 */

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const textOf = (events: ModelEvent[]) =>
  events.map((event) => (event.type === 'text-delta' ? event.text : '')).join('');

const RESULT = JSON.stringify({
  summary: 'Tokens are issued in auth.ts.',
  relevantFiles: ['auth.ts'],
  findings: [{ statement: 'issueToken signs tokens.', basis: 'observed', file: 'auth.ts' }],
  openQuestions: [],
});

/** A main session wired to a real AgentManager, whose children come from `spawnWith`. */
async function delegating(
  provider: ModelProvider,
  spawnWith: (main: ModelSession, workspace: string) => SpawnChild,
) {
  const { manager, workspace } = await skillContext();
  await writeFiles(workspace, {
    'auth.ts': 'export const issueToken = () => "CHILD-FILE-CONTENT";\n',
  });
  let main: ModelSession | null = null;
  const agents = new AgentManager({
    registry: AgentRegistry.builtin(),
    context: manager,
    workspace,
    spawn: (spec) => spawnWith(main as ModelSession, workspace)(spec),
  });
  const gate = new PermissionGate('smart', { workspace });
  main = await provider.createSession({
    cwd: workspace,
    permissions: 'smart',
    gate,
    context: manager.session({ delegation: agents.port(MAIN_AGENT) }),
  });
  const controller = new AbortController();
  const scope: ParentScope = {
    runId: MAIN_AGENT,
    depth: 0,
    objective: 'Analyze auth',
    profile: 'smart',
    task: authorizeTask('Analyze auth', null),
    signal: controller.signal,
  };
  agents.beginTurn(scope);
  return { main, agents, manager, workspace, controller };
}

// --------------------------------------------------------- anthropic-api

let server: Server;
let requests: Array<Record<string, unknown>> = [];
/** One scripted response per request, in order. */
let responses: Array<{ tool?: { id: string; name: string; input: unknown }; text?: string }> = [];

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const next = responses.shift() ?? { text: 'ok' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      const block = next.tool
        ? { type: 'tool_use', id: next.tool.id, name: next.tool.name, input: {} }
        : { type: 'text', text: '' };
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: block,
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: next.tool
          ? { type: 'input_json_delta', partial_json: JSON.stringify(next.tool.input) }
          : { type: 'text_delta', text: next.text ?? '' },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: next.tool ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      sse(res, 'message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const toolNames = (request: Record<string, unknown> | undefined) =>
  ((request?.tools ?? []) as Array<{ name: string }>).map((tool) => tool.name);

test('anthropic-api: the child is a new conversation with read tools; the parent gets the result', async () => {
  requests = [];
  responses = [
    {
      tool: {
        id: 'd1',
        name: 'delegate_task',
        input: { agent: 'repository-explorer', task: 'Find the token issuer' },
      },
    },
    { tool: { id: 'r1', name: 'read_file', input: { path: 'auth.ts' } } },
    { text: RESULT },
    { text: 'Done: tokens come from auth.ts.' },
  ];
  const { main } = await delegating(
    anthropicApiProvider,
    (_, cwd) => (spec) => anthropicApiProvider.createSession({ cwd, ...spec }),
  );
  const events = await collect(main.send('Analyze auth'));
  assert.equal(textOf(events), 'Done: tokens come from auth.ts.');
  // The delegation is orchestration: never a tool row of the parent.
  assert.ok(!events.some((event) => event.type === 'tool-start'));

  const [parent, child, childAgain, parentAgain] = requests;
  assert.ok(toolNames(parent).includes('delegate_task'));
  assert.deepEqual(toolNames(child), [
    'read_file',
    'glob_files',
    'grep_text',
    'load_skill',
    'read_skill_reference',
  ]);
  // The child starts from nothing but its delegation message.
  const childMessages = child?.messages as Array<{ role: string; content: unknown }>;
  assert.equal(childMessages.length, 1);
  assert.match(String(childMessages[0]?.content), /<delegated_task>\nFind the token issuer/);
  assert.doesNotMatch(JSON.stringify(child?.messages), /Analyze auth.*Analyze auth/);
  assert.match(String(child?.system), /You are repository-explorer/);
  assert.match(String(child?.system), /PROJECT-RULE/);
  assert.match(
    JSON.stringify(childAgain?.messages),
    /CHILD-FILE-CONTENT/,
    'the child read the file',
  );
  // The parent receives the result — and not what the child read.
  const last = JSON.stringify(parentAgain?.messages);
  assert.match(last, /delegation_result agent=\\"repository-explorer\\" status=\\"completed\\"/);
  assert.doesNotMatch(last, /CHILD-FILE-CONTENT/);
  await main.close();
});

// ------------------------------------------------------------------ claude

function fakeClaude(answer: string) {
  const runs: Array<{
    options: Options | undefined;
    prompts: string[];
    closed: boolean;
    interrupts: number;
  }> = [];
  const run = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options?: Options;
  }): ClaudeRun => {
    const seen = { options, prompts: [] as string[], closed: false, interrupts: 0 };
    runs.push(seen);
    return {
      interrupt: async () => {
        seen.interrupts += 1;
      },
      supportedModels: async () => [],
      applyFlagSettings: async () => {},
      return: async () => {
        seen.closed = true;
        return undefined;
      },
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          seen.prompts.push(JSON.stringify(message.message.content));
          yield {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: answer },
            },
          } as unknown as SDKMessage;
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: answer,
          } as unknown as SDKMessage;
        }
      },
    };
  };
  return { run, runs };
}

test('claude: the child is its own query with Read, Glob and Grep only, and no native subagents', async () => {
  const { run, runs } = fakeClaude(RESULT);
  const provider = createClaudeProvider(run);
  const { main, agents } = await delegating(
    provider,
    (_, cwd) => (spec) => provider.createSession({ cwd, ...spec }),
  );
  const result = await agents.delegate(MAIN_AGENT, 'repository-explorer', 'Find the token issuer');
  assert.equal(result.status, 'completed');
  assert.equal(result.structured, true);

  // The main session has not started a query yet; the child's is the only one.
  assert.equal(runs.length, 1);
  const child = runs[0];
  assert.deepEqual(child?.options?.tools, ['Read', 'Glob', 'Grep']);
  assert.ok((child?.options?.disallowedTools ?? []).includes('Agent'));
  assert.ok((child?.options?.disallowedTools ?? []).includes('Task'));
  assert.deepEqual(child?.options?.settingSources, [], 'no .claude/agents, no settings');
  assert.equal(child?.options?.strictMcpConfig, true);
  assert.match(String(child?.options?.systemPrompt), /You are repository-explorer/);
  assert.match(child?.prompts[0] ?? '', /Find the token issuer/);
  assert.equal(child?.closed, true, 'the child query is closed when the run ends');

  // The main session offers delegate_task through Polaris's own MCP server.
  await collect(main.send('hola'));
  const mainOptions = runs[1]?.options;
  const server = mainOptions?.mcpServers?.polaris as { instance?: { _registeredTools?: object } };
  assert.ok(server, 'the polaris MCP server is registered for the main agent');
  if (server.instance?._registeredTools) {
    assert.ok(Object.keys(server.instance._registeredTools).includes('delegate_task'));
  }
  assert.ok(
    ((mainOptions?.tools ?? []) as string[]).includes('Bash'),
    'the main agent keeps its own tools',
  );
  await main.close();
});

test('claude: the guard of an explorer refuses Bash, Write and Edit outright', async () => {
  const { workspace } = await skillContext();
  const gate = new PermissionGate('read-only', {
    workspace,
    agent: { name: 'repository-explorer', capabilities: ['read'] },
  });
  let asked = 0;
  gate.onApproval(async () => {
    asked += 1;
    return 'allow';
  });
  const guard = workspaceGuard(workspace, 'read-only', gate, new Map(), ['read']);
  const decide = async (tool: string, input: Record<string, unknown>) => {
    const output = (await guard(
      { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input } as never,
      'id',
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };
    return output.hookSpecificOutput?.permissionDecision;
  };
  assert.equal(await decide('Read', { file_path: join(workspace, 'POLARIS.md') }), 'allow');
  assert.equal(await decide('Bash', { command: 'git status' }), 'deny');
  assert.equal(await decide('Write', { file_path: join(workspace, 'x.ts'), content: 'x' }), 'deny');
  assert.equal(await decide('Edit', { file_path: join(workspace, 'POLARIS.md') }), 'deny');
  assert.equal(asked, 0);
});

// ------------------------------------------------------------------- codex

function fakeAppServer(options: { slowChild?: boolean } = {}) {
  const seen = {
    connects: 0,
    closed: false,
    requests: [] as Array<{ method: string; params: JsonObject }>,
    toolReplies: [] as unknown[],
  };
  let notify: (method: string, params: JsonObject) => void = () => {};
  let onRequest: (method: string, params: JsonObject) => Promise<unknown> = async () => ({});
  let threads = 0;
  let turns = 0;
  let mainThread: string | null = null;
  const pending = new Map<string, string>();

  const connection: CodexConnection = {
    async request<T>(method: string, params?: unknown): Promise<T> {
      const body = (params ?? {}) as JsonObject;
      seen.requests.push({ method, params: body });
      if (method === 'getAuthStatus') return { authMethod: 'chatgpt' } as T;
      if (method === 'thread/start') {
        const id = `thread-${++threads}`;
        mainThread ??= id;
        return { thread: { id }, model: 'gpt-test', reasoningEffort: 'medium' } as T;
      }
      if (method === 'turn/start') {
        const turnId = `turn-${++turns}`;
        const threadId = String(body.threadId);
        setTimeout(() => void play(threadId, turnId), 1);
        return { turn: { id: turnId } } as T;
      }
      if (method === 'turn/interrupt') {
        const threadId = String(body.threadId);
        setTimeout(
          () =>
            notify('turn/completed', {
              threadId,
              turn: { id: body.turnId, status: 'interrupted' },
            }),
          1,
        );
        return {} as T;
      }
      return {} as T;
    },
    notify() {},
    onNotification(handler) {
      notify = handler;
    },
    onRequest(handler) {
      onRequest = handler;
    },
    onClose() {},
    async close() {
      seen.closed = true;
    },
  };

  async function play(threadId: string, turnId: string) {
    const delta = (text: string) =>
      notify('item/agentMessage/delta', { threadId, turnId, itemId: `${turnId}-msg`, delta: text });
    if (threadId === mainThread) {
      // The main model delegates, waits for the answer, then replies.
      const reply = await onRequest('item/tool/call', {
        threadId,
        turnId,
        callId: 'call-1',
        tool: 'delegate_task',
        arguments: { agent: 'repository-explorer', task: 'Find the token issuer' },
      });
      seen.toolReplies.push(reply);
      delta('Main answer.');
    } else {
      if (options.slowChild) {
        pending.set(threadId, turnId);
        return;
      }
      notify('item/started', {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'cat auth.ts',
          commandActions: [
            { type: 'read', path: 'auth.ts', name: 'auth.ts', command: 'cat auth.ts' },
          ],
          status: 'inProgress',
        },
      });
      notify('item/completed', {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'cat auth.ts',
          commandActions: [
            { type: 'read', path: 'auth.ts', name: 'auth.ts', command: 'cat auth.ts' },
          ],
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'x',
        },
      });
      delta(RESULT);
    }
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }

  return {
    connect: async () => {
      seen.connects += 1;
      return connection;
    },
    seen,
  };
}

test('codex: the child is a new ephemeral read-only thread on the same App Server', async () => {
  const fake = fakeAppServer();
  const provider = createCodexProvider(fake.connect);
  const { main } = await delegating(
    provider,
    (main, cwd) => (spec) =>
      (main.createChild as NonNullable<ModelSession['createChild']>)({ cwd, ...spec }),
  );
  const events = await collect(main.send('Analyze auth'));
  assert.equal(textOf(events), 'Main answer.');

  assert.equal(fake.seen.connects, 1, 'no second App Server process');
  const starts = fake.seen.requests.filter((request) => request.method === 'thread/start');
  assert.equal(starts.length, 2);
  const [parent, child] = starts.map((request) => request.params);
  assert.ok(
    ((parent?.dynamicTools ?? []) as Array<{ name: string }>).some(
      (tool) => tool.name === 'delegate_task',
    ),
  );
  assert.equal(child?.ephemeral, true);
  assert.equal(child?.sandbox, 'read-only');
  assert.equal(child?.approvalPolicy, 'never');
  assert.equal(child?.model, 'gpt-test', 'the parent’s model');
  assert.ok(
    !((child?.dynamicTools ?? []) as Array<{ name: string }>).some(
      (tool) => tool.name === 'delegate_task',
    ),
  );
  assert.match(String(child?.developerInstructions), /You are repository-explorer/);
  assert.ok(!fake.seen.requests.some((request) => request.method === 'thread/fork'));

  const childTurn = fake.seen.requests.find(
    (request) => request.method === 'turn/start' && request.params.threadId === 'thread-2',
  );
  assert.match(JSON.stringify(childTurn?.params.input), /Find the token issuer/);
  // The parent's thread got the result, as the tool call's reply.
  const reply = JSON.stringify(fake.seen.toolReplies[0]);
  assert.match(reply, /delegation_result agent=\\"repository-explorer\\" status=\\"completed\\"/);
  assert.match(reply, /1 file read/);
  // Released: unsubscribed, the connection still open for the main thread.
  assert.ok(
    fake.seen.requests.some(
      (request) =>
        request.method === 'thread/unsubscribe' && request.params.threadId === 'thread-2',
    ),
  );
  assert.equal(fake.seen.closed, false);
  await main.close();
  assert.equal(fake.seen.closed, true);
});

test('codex: cancelling a child interrupts the child’s turn only', async () => {
  const fake = fakeAppServer({ slowChild: true });
  const provider = createCodexProvider(fake.connect);
  const { main, workspace, manager } = await delegating(provider, () => () => {
    throw new Error('unused');
  });
  const child = await (main.createChild as NonNullable<ModelSession['createChild']>)({
    cwd: workspace,
    permissions: 'read-only',
    gate: new PermissionGate('read-only', { workspace }),
    context: (manager as ContextManager).scoped({ project: true, skillCatalog: false }).session(),
    capabilities: ['read'],
  });
  const controller = new AbortController();
  const running = collect(child.send('Explore', controller.signal));
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(running);
  const interrupts = fake.seen.requests.filter((request) => request.method === 'turn/interrupt');
  assert.deepEqual(
    interrupts.map((request) => request.params.threadId),
    ['thread-2'],
  );
  await child.close();
  assert.equal(
    fake.seen.closed,
    false,
    'closing the child leaves the main thread’s server running',
  );
  await main.close();
});
