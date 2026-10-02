import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  AgentManager,
  type ChildSpec,
  childTask,
  delegationMessage,
  narrower,
  type ParentScope,
} from '../src/agents/manager.ts';
import { AgentRegistry, REPOSITORY_EXPLORER } from '../src/agents/registry.ts';
import { fromAnswer, parseAnswer, RESULT_CONTRACT, renderResult } from '../src/agents/result.ts';
import { createRegistry } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp } from '../src/core/app.ts';
import { PermissionGate } from '../src/permissions/gate.ts';
import { PERMISSION_PROFILES } from '../src/permissions/policy.ts';
import { authorizeTask } from '../src/permissions/task.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import {
  type ModelEvent,
  type ModelSession,
  type ProviderSessionOptions,
  registerProvider,
} from '../src/providers/provider.ts';
import { makeRepo, skillContext, TEST_ACCESS, writeFiles } from './helpers.ts';

registerProvider(mockProvider);

/** The mock, with what each agent session was given recorded. */
const spied: { instructions: string[]; inputs: string[]; options: ProviderSessionOptions[] } = {
  instructions: [],
  inputs: [],
  options: [],
};
registerProvider({
  id: 'spy',
  supports: PERMISSION_PROFILES,
  async createSession(options) {
    const session = await mockProvider.createSession(options);
    if (!options.capabilities) return session;
    spied.options.push(options);
    spied.instructions.push(options.context?.instructions({ canLoad: true }) ?? '');
    return {
      ...session,
      send(input, signal) {
        spied.inputs.push(input);
        return session.send(input, signal);
      },
    };
  },
});

// ------------------------------------------------------------- registry

test('the registry holds repository-explorer: read-only, inherits provider and model', () => {
  const registry = AgentRegistry.builtin();
  const explorer = registry.get('repository-explorer');
  assert.ok(explorer);
  assert.match(explorer.description, /Explore and understand the repository/);
  assert.deepEqual(explorer.capabilities, ['read']);
  assert.equal(explorer.permissions, 'read-only');
  assert.deepEqual(explorer.context, { project: true, skillCatalog: true, skills: [] });
  assert.equal(explorer.provider, 'inherit');
  assert.equal(explorer.model, 'inherit');
  assert.deepEqual(
    registry.list().map((agent) => agent.name),
    ['repository-explorer'],
  );
  assert.equal(registry.get('planner'), undefined);
});

test('a duplicate or badly named agent definition is rejected', () => {
  assert.throws(() => new AgentRegistry([REPOSITORY_EXPLORER, REPOSITORY_EXPLORER]), /twice/);
  assert.throws(
    () => new AgentRegistry([{ ...REPOSITORY_EXPLORER, name: 'Repository Explorer' }]),
    /kebab-case/,
  );
});

// --------------------------------------------------------------- result

const STATS = { durationMs: 1200, toolCalls: 3, filesRead: 2 };

test('a JSON answer, bare or fenced, becomes a structured result', () => {
  const json = JSON.stringify({
    summary: 'Auth uses JWT filters.',
    relevantFiles: ['src/SecurityConfig.java'],
    findings: [
      {
        statement: 'Tokens are issued in TokenService.',
        basis: 'observed',
        file: 'src/TokenService.java',
        lines: '10-24',
      },
      { statement: 'No refresh token storage.', basis: 'inferred' },
    ],
    openQuestions: ['Expiry is untested.'],
  });
  for (const answer of [json, `Here it is:\n\`\`\`json\n${json}\n\`\`\`\n`]) {
    const result = fromAnswer('repository-explorer', answer, STATS);
    assert.equal(result.structured, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.summary, 'Auth uses JWT filters.');
    assert.deepEqual(result.relevantFiles, ['src/SecurityConfig.java']);
    assert.equal(result.findings[0]?.lines, '10-24');
    assert.equal(result.findings[1]?.basis, 'inferred');
  }
});

test('an answer that is not valid JSON is kept as text, not lost and not a crash', () => {
  for (const answer of ['Auth lives in src/auth. {broken', '{"findings": []}', '']) {
    const result = fromAnswer('repository-explorer', answer, STATS);
    assert.equal(result.structured, false);
    assert.equal(result.status, 'completed');
    assert.ok(result.summary.length > 0);
  }
  // Progress notes, then the result on lines of its own: what Codex sends.
  const notes = fromAnswer(
    'repository-explorer',
    `I'll trace it.

Narrowing down.

{"summary": "Found."}`,
    STATS,
  );
  assert.equal(notes.structured, true);
  assert.equal(notes.summary, 'Found.');
  // Never the first-{-to-last-} trick: braces in prose are not a result.
  assert.equal(parseAnswer('I found {"summary": "x"} somewhere and } more').parsed, null);
});

test('the parent reads the status first, and a cut result says it was cut', () => {
  const partial = fromAnswer(
    'repository-explorer',
    'x'.repeat(20_000),
    STATS,
    'partial',
    'tool budget',
  );
  const text = renderResult(partial, 2_000);
  assert.ok(text.length <= 2_000);
  assert.match(text.split('\n')[0] ?? '', /status="partial"/);
  assert.match(text, /Result truncated by Polaris/);
  assert.match(text, /<\/delegation_result>$/);
});

// ---------------------------------------------------- permissions ceiling

test('the explorer gate allows reads and denies everything else without asking', async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'polaris-ceiling-')));
  const gate = new PermissionGate('read-only', {
    workspace,
    agent: { name: 'repository-explorer', capabilities: ['read'] },
  });
  gate.beginTask(
    childTask(REPOSITORY_EXPLORER, 'Implement refresh tokens', authorizeTask('Implement it', null)),
  );
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(request.title);
    return 'allow';
  });
  const card = { title: 'x', target: 'x' };
  const verdict = (capability: 'read' | 'write' | 'edit' | 'command', extra = {}) =>
    gate.authorize({ capability, target: 'a.ts', paths: ['a.ts'], ...extra }, card);

  assert.equal((await verdict('read')).allowed, true);
  for (const capability of ['write', 'edit'] as const) {
    const result = await verdict(capability);
    assert.equal(result.allowed, false);
  }
  const command = await gate.authorize(
    { capability: 'command', target: 'git status', command: 'git status' },
    card,
  );
  assert.equal(command.allowed, false);
  assert.ok(!command.allowed && /not available to repository-explorer/.test(command.reason));
  // Outside the workspace: a read the main agent would be asked about is simply refused.
  const outside = await gate.authorize(
    { capability: 'read', target: '../secret', paths: [join(workspace, '..', 'secret')] },
    card,
  );
  assert.equal(outside.allowed, false);
  assert.deepEqual(asked, [], 'an agent never puts an approval to the user');
});

test('a child never runs wider than its parent or its definition', () => {
  assert.equal(narrower('smart', REPOSITORY_EXPLORER.permissions), 'read-only');
  assert.equal(narrower('workspace-write', REPOSITORY_EXPLORER.permissions), 'read-only');
  assert.equal(narrower('read-only', REPOSITORY_EXPLORER.permissions), 'read-only');
  // An implementation request upstream does not give the explorer edits.
  const parent = authorizeTask('Implement refresh tokens', null);
  assert.equal(parent.modifyWorkspace, true);
  const child = childTask(REPOSITORY_EXPLORER, 'Fix the token expiry and add tests', parent);
  assert.equal(child.inspectWorkspace, true);
  assert.equal(child.modifyWorkspace, false);
  assert.equal(child.createFiles, false);
  // A writing agent would still be capped by a parent that may not edit.
  const writer = { ...REPOSITORY_EXPLORER, capabilities: ['read', 'edit'] as const };
  assert.equal(
    childTask(writer, 'Fix it', authorizeTask('Explain it', null)).modifyWorkspace,
    false,
  );
});

// --------------------------------------------------------- AgentManager

const JSON_ANSWER = JSON.stringify({
  summary: 'Found it.',
  relevantFiles: ['auth.ts'],
  findings: [{ statement: 'auth.ts issues tokens.', basis: 'observed', file: 'auth.ts' }],
  openQuestions: [],
});

/** A session that plays `events`, then answers `answer`. */
function scripted(
  log: { closed: number; inputs: string[] },
  options: { events?: ModelEvent[]; answer?: string; delayMs?: number; fail?: Error } = {},
): ModelSession {
  return {
    model: 'fake',
    access: TEST_ACCESS,
    async *send(input, signal) {
      log.inputs.push(input);
      for (const event of options.events ?? []) yield event;
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        });
      }
      if (options.fail) throw options.fail;
      yield { type: 'text-delta', text: options.answer ?? JSON_ANSWER };
    },
    async close() {
      log.closed += 1;
    },
  };
}

async function managerWith(
  session: (log: { closed: number; inputs: string[] }) => ModelSession,
  watch?: { changed: string[] },
) {
  const { manager: context, workspace } = await skillContext();
  const log = { closed: 0, inputs: [] as string[] };
  const specs: ChildSpec[] = [];
  const events: string[] = [];
  const agents = new AgentManager({
    registry: AgentRegistry.builtin(),
    context,
    workspace,
    spawn: async (spec) => {
      specs.push(spec);
      return session(log);
    },
    ...(watch ? { watch: { settle: async () => {}, changed: async () => watch.changed } } : {}),
  });
  agents.onEvent((event) =>
    events.push(
      event.type === 'run-event'
        ? `event:${event.event.type}`
        : `${event.type}:${event.run.status}`,
    ),
  );
  return { agents, context, log, specs, events, workspace };
}

const scope = (
  signal = new AbortController().signal,
  over: Partial<ParentScope> = {},
): ParentScope => ({
  runId: 'main',
  depth: 0,
  objective: 'Implement refresh tokens',
  profile: 'smart',
  task: authorizeTask('Implement refresh tokens', null),
  signal,
  ...over,
});

test('a run goes pending → running → completed, and its session is closed', async () => {
  const read: ModelEvent[] = [
    { type: 'tool-start', id: 't1', name: 'Read', target: 'auth.ts' },
    { type: 'tool-result', id: 't1', summary: '3 lines' },
  ];
  const { agents, log, events } = await managerWith((log) => scripted(log, { events: read }));
  const result = await agents.run('repository-explorer', 'Find the auth flow', scope());
  assert.equal(result.status, 'completed');
  assert.equal(result.structured, true);
  assert.deepEqual(result.stats.toolCalls, 1);
  assert.equal(result.stats.filesRead, 1);
  assert.deepEqual(events, [
    'run-start:pending',
    'event:tool-start',
    'event:tool-result',
    'event:text-delta',
    'run-end:completed',
  ]);
  assert.equal(log.closed, 1);
  assert.deepEqual(agents.live(), []);
});

test('the child context is isolated: its role, the project, the task — nothing of the parent', async () => {
  const { agents, context, log, specs } = await managerWith((log) => scripted(log));
  // The main conversation has loaded a skill; the explorer must not inherit it.
  await context.load('testing');
  assert.deepEqual(
    context.loaded.map((skill) => skill.metadata.name),
    ['testing'],
  );
  await agents.run(
    'repository-explorer',
    'Find how authentication works',
    scope(undefined, { objective: 'Implement refresh tokens' }),
  );
  const [spec] = specs;
  assert.ok(spec);
  const instructions = spec.context.instructions({ canLoad: true });
  assert.match(instructions, /You are repository-explorer/);
  assert.match(instructions, /PROJECT-RULE/, 'POLARIS.md is shared repository context');
  assert.match(instructions, /- testing: Write and run tests\./, 'the catalog, not the body');
  assert.doesNotMatch(
    instructions,
    /TESTING-BODY/,
    'the parent’s loaded skill stays with the parent',
  );
  assert.doesNotMatch(instructions, /available_agents/);
  assert.equal(spec.context.canDelegate, false);
  assert.deepEqual(spec.capabilities, ['read']);
  assert.equal(spec.permissions, 'read-only');
  assert.equal(spec.gate.task.modifyWorkspace, false);

  const input = log.inputs[0] ?? '';
  assert.match(input, /Find how authentication works/);
  assert.match(input, /Implement refresh tokens/);
  assert.match(input, new RegExp(RESULT_CONTRACT.split('\n')[0] ?? ''));
});

test('a skill the agent loads stays in its run; the parent’s list is unchanged', async () => {
  const { agents, context, specs } = await managerWith((log) => scripted(log));
  await agents.run('repository-explorer', 'Find tests', scope());
  const child = specs[0]?.context;
  assert.ok(child);
  const reply = await child.loadSkill('testing', { inline: true });
  assert.equal(reply.ok, true);
  assert.match(reply.text, /TESTING-BODY/);
  assert.deepEqual(context.loaded, []);
});

test('a failing child becomes a failed result, and the manager is ready for the next', async () => {
  const { agents, log } = await managerWith((log) =>
    scripted(log, { fail: new Error('Provider session failed.') }),
  );
  const result = await agents.run('repository-explorer', 'Find auth', scope());
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /Provider session failed/);
  assert.equal(log.closed, 1);
  assert.deepEqual(agents.live(), []);

  const spawnFails = new AgentManager({
    registry: AgentRegistry.builtin(),
    context: (await skillContext()).manager,
    workspace: tmpdir(),
    spawn: async () => {
      throw new Error('runtime unavailable');
    },
  });
  const failed = await spawnFails.run('repository-explorer', 'Find auth', scope());
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason ?? '', /runtime unavailable/);
});

test('cancelling the parent cancels the child and closes its session', async () => {
  const { agents, log, events } = await managerWith((log) => scripted(log, { delayMs: 10_000 }));
  const controller = new AbortController();
  const running = agents.run('repository-explorer', 'Explore slowly', scope(controller.signal));
  await until(() => log.inputs.length > 0);
  assert.equal(agents.live()[0]?.status, 'running');
  controller.abort();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(log.closed, 1);
  assert.deepEqual(agents.live(), []);
  assert.equal(events.at(-1), 'run-end:cancelled');
});

test('a run over its tool budget stops with a partial result, not a success', async () => {
  const many: ModelEvent[] = Array.from({ length: 5 }, (_, index) => ({
    type: 'tool-start' as const,
    id: `t${index}`,
    name: 'Read',
    target: `f${index}.ts`,
  }));
  const { manager: context, workspace } = await skillContext();
  const log = { closed: 0, inputs: [] as string[] };
  const tight = new AgentRegistry([
    { ...REPOSITORY_EXPLORER, budget: { maxToolCalls: 2, maxRuntimeMs: 60_000 } },
  ]);
  const agents = new AgentManager({
    registry: tight,
    context,
    workspace,
    spawn: async () => ({
      ...scripted(log),
      async *send(_input, signal) {
        for (const event of many) {
          signal?.throwIfAborted();
          yield event;
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        yield { type: 'text-delta', text: JSON_ANSWER };
      },
    }),
  });
  const result = await agents.run('repository-explorer', 'Read everything', scope());
  assert.equal(result.status, 'partial');
  assert.match(result.reason ?? '', /tool budget of 2 calls/);
  assert.ok(result.relevantFiles.length >= 2, 'what it read so far is kept');
  assert.equal(log.closed, 1);
});

test('depth, concurrency and the per-request limit are enforced in code', async () => {
  const { agents } = await managerWith((log) => scripted(log, { delayMs: 30 }));
  // An agent cannot delegate: depth 1 is the ceiling.
  const nested = await agents.run('repository-explorer', 'Explore', scope(undefined, { depth: 1 }));
  assert.equal(nested.status, 'failed');
  assert.match(nested.reason ?? '', /cannot delegate/);

  // One child per parent at a time.
  const first = agents.run('repository-explorer', 'A', scope());
  const second = await agents.run('repository-explorer', 'B', scope());
  assert.match(second.reason ?? '', /already running/);
  await first;

  // Per request: the same task once, and at most three delegations.
  agents.beginTurn(scope());
  assert.equal(
    (await agents.delegate('main', 'repository-explorer', 'Task one')).status,
    'completed',
  );
  const again = await agents.delegate('main', 'repository-explorer', '  task ONE ');
  assert.match(again.reason ?? '', /already delegated/);
  await agents.delegate('main', 'repository-explorer', 'Task two');
  await agents.delegate('main', 'repository-explorer', 'Task three');
  const fourth = await agents.delegate('main', 'repository-explorer', 'Task four');
  assert.equal(fourth.status, 'failed');
  assert.match(fourth.reason ?? '', /Delegation limit reached/);
  agents.endTurn('main');
  assert.match(
    (await agents.delegate('main', 'repository-explorer', 'Later')).reason ?? '',
    /only available while a request/,
  );
  assert.match(
    (await agents.run('planner', 'Plan', scope())).reason ?? '',
    /Unknown agent "planner"/,
  );
});

test('a read-only agent that changed the workspace is a policy violation', async () => {
  const { agents } = await managerWith((log) => scripted(log), { changed: ['src/a.ts'] });
  const result = await agents.run('repository-explorer', 'Explore', scope());
  assert.equal(result.status, 'failed');
  assert.match(result.reason ?? '', /Policy violation: repository-explorer is read-only/);
  assert.match(result.reason ?? '', /src\/a\.ts/);
});

test('the delegation message carries the objective, task and limits — and no transcript', () => {
  const message = delegationMessage(REPOSITORY_EXPLORER, 'Find X', 'Implement Y', '/ws');
  assert.match(message, /<parent_objective>[\s\S]*Implement Y[\s\S]*<\/parent_objective>/);
  assert.match(message, /<delegated_task>\nFind X\n<\/delegated_task>/);
  assert.match(message, /Workspace: \/ws/);
  assert.match(message, /cannot delegate/);
  // A manual run's objective is its task: said once.
  assert.doesNotMatch(
    delegationMessage(REPOSITORY_EXPLORER, 'Find X', 'Find X', '/ws'),
    /parent_objective/,
  );
});

// ------------------------------------------------------ the whole flow

async function appWith(provider: string, files: Record<string, string> = {}) {
  const repo = await makeRepo({
    'POLARIS.md': 'PROJECT-RULE\n',
    'auth.ts': 'export const issueToken = () => "CHILD-FILE-CONTENT";\n',
    '.polaris/skills/testing/SKILL.md':
      '---\nname: testing\ndescription: Write and run tests.\n---\nTESTING-BODY\n',
    ...files,
  });
  const home = await realpath(await mkdtemp(join(tmpdir(), 'polaris-home-')));
  const app = new PolarisApp({ cwd: repo, home, config: { provider, permissions: 'smart' } });
  const asked: string[] = [];
  await app.start();
  return { app, repo, asked };
}

/** Waits for a condition instead of a fixed time, so a loaded machine does not fail it. */
async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const lastAnswer = (app: PolarisApp) =>
  app.state.messages.findLast((message) => message.role === 'assistant')?.text ?? '';

test('main delegates, the explorer reads, and only the result comes back', async () => {
  const { app } = await appWith('mock');
  await app.submit(
    'Analiza la autenticación @delegate[repository-explorer :: Find the auth flow @read(auth.ts) @grep(issueToken)]',
  );
  const rows = app.state.messages
    .filter((message) => message.role === 'tool')
    .map(
      (message) =>
        `${message.depth ?? 0} ${message.tool?.name} ${message.tool?.target} · ${message.tool?.detail}`,
    );
  assert.deepEqual(rows, [
    '0 repository-explorer Find the auth flow @read(auth.ts) @grep(issueToken) · 1 file inspected · 2 findings',
    '1 Read auth.ts · 1 line',
    '1 Grep "issueToken" · 1 match in 1 file',
  ]);
  // The explorer's words are its result, not part of the transcript.
  assert.ok(!app.state.messages.some((message) => message.text.includes('Mock exploration')));

  // What the main "model" received: the result, not the file it came from.
  await app.submit('@context()');
  const received = lastAnswer(app);
  assert.match(received, /<delegation_result agent="repository-explorer" status="completed">/);
  assert.match(received, /Relevant files:\n- auth\.ts/);
  assert.doesNotMatch(received, /CHILD-FILE-CONTENT/);
  // Read-only: nothing changed, nothing to undo, nobody asked.
  assert.equal(app.state.workspace.changed, 0);
  assert.equal(app.state.activity.length, 0);
  assert.deepEqual(app.state.agents.running, []);
  await app.close();
});

test('the child receives the task and the project — never the earlier conversation', async () => {
  spied.inputs.length = 0;
  spied.instructions.length = 0;
  const { app } = await appWith('spy');
  await app.submit('Remember secret-parent-marker-123 for later');
  await app.loadSkill('testing');
  await app.submit(
    'Analiza auth @delegate[repository-explorer :: Find the token issuer @read(auth.ts)]',
  );
  const [input = ''] = spied.inputs;
  assert.match(input, /Find the token issuer/);
  assert.match(input, /Analiza auth/, 'the current request is the objective');
  assert.doesNotMatch(input, /secret-parent-marker-123/);
  const [instructions = ''] = spied.instructions;
  assert.match(instructions, /PROJECT-RULE/);
  assert.doesNotMatch(instructions, /secret-parent-marker-123|TESTING-BODY/);
  assert.deepEqual(spied.options[0]?.capabilities, ['read']);
  assert.equal(spied.options[0]?.permissions, 'read-only');
  assert.deepEqual(app.state.context.loaded, ['testing'], 'the main agent’s skills are its own');
  await app.close();
});

test('the explorer cannot write, edit or run — denied, never asked — and changes nothing', async () => {
  const { app, repo } = await appWith('mock');
  let asked = 0;
  const unsubscribe = app.subscribe((state) => {
    if (state.approval) asked += 1;
  });
  await app.submit(
    'Implementa esto @delegate[repository-explorer :: Try @write(evil.ts :: x) @edit(auth.ts :: issueToken :: hacked) @run(node -e "1")]',
  );
  unsubscribe();
  const children = app.state.messages.filter((message) => message.depth === 1);
  assert.equal(children.length, 3);
  for (const row of children) {
    assert.equal(row.state, 'error');
    assert.match(row.tool?.detail ?? '', /Unknown tool/);
  }
  assert.equal(asked, 0);
  assert.equal(existsSync(join(repo, 'evil.ts')), false);
  assert.equal(app.state.workspace.changed, 0);
  await app.close();
});

test('an explorer cannot delegate again: only one run, whatever it asks', async () => {
  const { app } = await appWith('mock');
  // The objective repeats the directive, so the child "asks" to delegate too.
  await app.submit('Explora @delegate[repository-explorer :: Look around @glob(*.ts)]');
  const agentRows = app.state.messages.filter(
    (message) => message.role === 'tool' && message.tool?.name === 'repository-explorer',
  );
  assert.equal(agentRows.length, 1);
  await app.close();
});

test('the per-request limit stops a model that keeps delegating', async () => {
  const { app } = await appWith('mock');
  const call = (n: number) => `@delegate[repository-explorer :: Look ${n} @glob(*.ts)]`;
  await app.submit(`Explora ${[1, 2, 3, 4].map(call).join(' ')}`);
  const agentRows = app.state.messages.filter(
    (message) => message.tool?.name === 'repository-explorer',
  );
  assert.equal(agentRows.length, 3);
  await app.submit('@context()');
  assert.match(lastAnswer(app), /Delegation limit reached/);
  await app.close();
});

test('activity: main waits on the agent, the agent’s tools sit under it', async () => {
  const { app } = await appWith('mock');
  const snapshots: string[][] = [];
  const unsubscribe = app.subscribe((state) => {
    const tree = state.activity.map((activity) => {
      const parent = state.activity.find((item) => item.id === activity.parentId);
      return `${activity.kind}:${activity.label}:${activity.state}<${parent?.kind ?? 'root'}`;
    });
    if (tree.some((row) => row.startsWith('tool:'))) snapshots.push(tree);
  });
  const turn = app.submit(
    'Explora @delegate[repository-explorer :: Slow @wait(400) @read(auth.ts)]',
  );
  await until(() => app.state.activity.some((activity) => activity.kind === 'agent'));
  const live = app.state.activity;
  const main = live.find((activity) => activity.kind === 'model');
  const agent = live.find((activity) => activity.kind === 'agent');
  assert.equal(main?.label, 'Main agent · Mock');
  assert.equal(main?.state, 'waiting-agent');
  assert.equal(agent?.label, 'repository-explorer');
  assert.equal(agent?.parentId, main?.id);
  assert.equal(app.state.status, 'delegating');
  await turn;
  unsubscribe();
  assert.ok(
    snapshots.some(
      (tree) =>
        tree.includes('tool:auth.ts:running<agent') &&
        tree.includes('agent:repository-explorer:waiting-tool<model'),
    ),
  );
  assert.deepEqual(app.state.activity, []);
  await app.close();
});

test('Ctrl+C during a delegation cancels the child and the turn; the session survives', async () => {
  const { app } = await appWith('mock');
  const turn = app.submit(
    'Explora @delegate[repository-explorer :: Slow @wait(5000) @read(auth.ts)]',
  );
  await until(() => app.state.agents.running.some((run) => run.status === 'running'));
  assert.equal(app.state.agents.running.length, 1);
  // A turn with an agent running cannot be replaced under it.
  await assert.rejects(app.newConversation(), /Wait for the current turn/);
  await assert.rejects(app.setProvider('mock'), /Wait for the current turn/);
  assert.equal(app.cancel(), true);
  await turn;
  const agentRow = app.state.messages.find(
    (message) => message.tool?.name === 'repository-explorer',
  );
  assert.equal(agentRow?.state, 'cancelled');
  assert.deepEqual(app.state.agents.running, []);
  assert.deepEqual(app.state.activity, []);
  assert.equal(app.state.status, 'cancelled');
  // The main session is alive: the next turn works.
  await app.submit('still here');
  assert.equal(lastAnswer(app), 'You said: still here');
  await app.newConversation();
  await app.close();
});

test('an unknown agent is a failed result the main agent reads; the turn goes on', async () => {
  const { app } = await appWith('mock');
  await app.submit('Explora @delegate[planner :: Plan it] then continue');
  assert.equal(app.state.status, 'ready');
  assert.match(lastAnswer(app), /You said: Explora/);
  await app.submit('@context()');
  assert.match(lastAnswer(app), /status="failed"[\s\S]*Unknown agent "planner"/);
  await app.close();
});

test('/agents lists them; /agent runs one by hand and keeps it out of the main context', async () => {
  const { app } = await appWith('mock');
  const registry = createRegistry(new CommandRegistry());
  const context: CommandContext = {
    app,
    canSelect: false,
    select: async () => null,
    confirm: async () => true,
    clearScreen: () => {},
    requestExit: () => {},
  };
  const command = async (line: string) => {
    const [name = '', ...args] = line.slice(1).split(' ');
    await registry.get(name)?.run(context, args);
    return app.state.messages.at(-1)?.text ?? '';
  };
  const listing = await command('/agents');
  assert.match(listing, /main\n {4}active · mock/);
  assert.match(listing, /repository-explorer\n {4}available · read-only/);
  assert.match(listing, /tools: Read, Glob, Grep · provider: inherit · model: inherit/);

  const report = await command('/agent repository-explorer Analyze auth @read(auth.ts)');
  assert.match(report, /repository-explorer · completed/);
  assert.match(report, /Relevant files\n {4}- auth\.ts/);
  assert.match(report, /the main agent did not receive this result/);
  assert.match(await command('/status'), /agents {4}1 available/);
  assert.match(await command('/help'), /\/agent /);

  await app.submit('@context()');
  assert.doesNotMatch(lastAnswer(app), /delegation_result/);
  assert.match(await command('/agent'), /Usage: \/agent <name> <task>/);
  await app.close();
});

test('project context reloaded later reaches the next agent run', async () => {
  spied.instructions.length = 0;
  const { app, repo } = await appWith('spy');
  await app.submit('Explora @delegate[repository-explorer :: One @glob(*.ts)]');
  await writeFiles(repo, { 'POLARIS.md': 'NEW-RULE\n' });
  await app.reloadContext();
  await app.submit('Explora @delegate[repository-explorer :: Two @glob(*.ts)]');
  assert.match(spied.instructions[0] ?? '', /PROJECT-RULE/);
  assert.match(spied.instructions.at(-1) ?? '', /NEW-RULE/);
  await app.close();
});

test('the transcript nests an agent’s tools, and the status bar says whose work it is', async () => {
  const { transcriptLines } = await import('../src/ui/layout.ts');
  const { activityRows, activitySummary } = await import('../src/ui/activity.ts');
  const { ActivityTracker } = await import('../src/core/activity.ts');
  const lines = transcriptLines(
    [
      {
        id: 'a',
        role: 'tool',
        text: '',
        state: 'complete',
        tool: {
          name: 'repository-explorer',
          target: 'Find auth',
          detail: '2 files inspected · 3 findings',
          duration: 16_200,
        },
      },
      {
        id: 'b',
        role: 'tool',
        text: '',
        state: 'complete',
        depth: 1,
        tool: { name: 'Read', target: 'auth.ts', detail: '3 lines' },
      },
    ],
    80,
  );
  assert.deepEqual(
    lines.map((line) => [line.kind, line.indent ?? 0, line.label ?? line.text]),
    [
      ['tool', 0, 'repository-explorer'],
      ['detail', 0, '2 files inspected · 3 findings'],
      ['tool', 1, 'Read'],
    ],
  );

  let now = 0;
  const tracker = new ActivityTracker(() => now);
  const main = tracker.start('model', 'Main agent · Codex', { state: 'waiting-agent' });
  const agent = tracker.start('agent', 'repository-explorer', {
    state: 'waiting-tool',
    parentId: main,
    ownerId: 'run-1',
  });
  tracker.start('tool', '"Authentication"', {
    state: 'running',
    parentId: agent,
    ownerId: 'run-1',
    tool: 'Grep',
  });
  now = 2_000;
  assert.equal(
    activitySummary(tracker.live(), now),
    'repository-explorer · Grep "Authentication" · 00:02',
  );
  assert.deepEqual(
    activityRows(tracker.live(), now).map((row) => `${row.depth}:${row.text}`),
    [
      '0:Main agent · Codex',
      '1:waiting for agent result',
      '1:repository-explorer',
      '2:running tools',
      '2:Grep "Authentication"',
      '3:searching repository',
    ],
  );
});
