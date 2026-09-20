import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { PolarisError } from '../src/core/errors.ts';
import {
  type ClaudeRun,
  claudeProvider,
  createClaudeProvider,
} from '../src/providers/claude/index.ts';
import { permissionBridge } from '../src/providers/claude/tools.ts';
import type { ModelEvent } from '../src/providers/provider.ts';
import { autoGate, testSession } from './helpers.ts';

const MODEL = 'claude-sonnet-5';

function init(model = MODEL): SDKMessage {
  return { type: 'system', subtype: 'init', model } as unknown as SDKMessage;
}

function delta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    ...overrides,
  } as unknown as SDKMessage;
}

interface FakeOptions {
  /** One reply (as chunks) per user turn. */
  replies?: string[][];
  /** Emitted instead of a success result for the matching turn. */
  failure?: Record<string, unknown>;
  /** Slows chunks down so a test can interrupt mid-answer. */
  delayMs?: number;
  /** Thrown when the session is started, like a missing runtime would. */
  startError?: Error;
  /** Runtime messages emitted before the text of each turn (tool calls and results). */
  frames?: SDKMessage[][];
}

function fakeClaude(options: FakeOptions = {}) {
  const seen = {
    starts: 0,
    prompts: [] as string[],
    interrupts: 0,
    closed: false,
    options: undefined as Options | undefined,
  };
  const replies = [...(options.replies ?? [['ok']])];
  const frames = [...(options.frames ?? [])];

  const run = ({
    prompt,
    options: passed,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options?: Options;
  }): ClaudeRun => {
    seen.starts += 1;
    seen.options = passed;
    if (options.startError) throw options.startError;
    let interrupted = false;

    return {
      interrupt: async () => {
        seen.interrupts += 1;
        interrupted = true;
      },
      return: async () => {
        seen.closed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield init();
        for await (const message of prompt) {
          seen.prompts.push(String(message.message.content));
          interrupted = false;
          for (const frame of frames.shift() ?? []) yield frame;
          for (const chunk of replies.shift() ?? ['ok']) {
            if (interrupted) break;
            if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
            yield delta(chunk);
          }
          yield options.failure ? result(options.failure) : result();
        }
      },
    };
  };

  return { run, seen };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: ModelEvent[]): string {
  return events.map((e) => (e.type === 'text-delta' ? e.text : '')).join('');
}

test('the claude provider is registered under its own id', () => {
  assert.equal(claudeProvider.id, 'claude');
  assert.equal(createClaudeProvider().id, 'claude');
});

test('runtime messages are translated into Polaris events', async () => {
  const { run } = fakeClaude({ replies: [['Hola', ' Eduardo']] });
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));

  const events = await collect(session.send('Me llamo Eduardo'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['message-start', 'text-delta', 'text-delta', 'message-end'],
  );
  assert.equal(textOf(events), 'Hola Eduardo');
  await session.close();
});

test('the model reported by the runtime reaches /status', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));

  assert.equal(session.model, 'default', 'before the first turn there is nothing to report');
  await collect(session.send('hola'));
  assert.equal(session.model, MODEL);
  assert.equal(seen.options?.model, undefined, 'no model is forced on the runtime by default');
  await session.close();
});

test('a configured model is passed through to the runtime', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession({
    ...testSession('/tmp'),
    model: 'claude-opus-5',
  });
  assert.equal(session.model, 'claude-opus-5');
  await collect(session.send('hola'));
  assert.equal(seen.options?.model, 'claude-opus-5');
  await session.close();
});

test('under read-only only the three inspection tools reach the runtime', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession(
    testSession('/work', { permissions: 'read-only' }),
  );
  await collect(session.send('hola'));

  assert.deepEqual(seen.options?.tools, ['Read', 'Glob', 'Grep']);
  for (const denied of ['NotebookEdit', 'WebFetch', 'WebSearch']) {
    assert.ok(seen.options?.disallowedTools?.includes(denied), `${denied} is denied`);
  }
  assert.ok(seen.options?.disallowedTools?.includes('mcp__*'), 'no MCP tools');
  assert.equal(seen.options?.hooks?.PreToolUse?.length, 1);
  assert.deepEqual(seen.options?.settingSources, [], 'no CLAUDE.md, settings, skills or plugins');
  assert.equal(seen.options?.cwd, '/work');
  assert.equal(seen.options?.includePartialMessages, true);
  await session.close();
});

test('a mutating profile adds the runtime tools and the official permission callback', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession(
    testSession('/work', { permissions: 'ask' }),
  );
  await collect(session.send('hola'));

  assert.deepEqual(seen.options?.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']);
  // `default` is what routes prompts to canUseTool. `dontAsk` would deny them
  // and `bypassPermissions` would take the decision away from the user.
  assert.equal(seen.options?.permissionMode, 'default');
  assert.equal(typeof seen.options?.canUseTool, 'function');
  assert.notEqual(seen.options?.permissionMode, 'bypassPermissions');
  assert.equal(seen.options?.allowDangerouslySkipPermissions, undefined);
  await session.close();
});

test('the permission callback asks the gate and answers in the runtime vocabulary', async () => {
  const allowed = autoGate('ask', 'allow');
  const refused = autoGate('ask', 'deny');

  const yes = permissionBridge('/work', allowed.gate);
  const no = permissionBridge('/work', refused.gate);
  const options = {
    signal: new AbortController().signal,
    toolUseID: 't1',
    requestId: 'r1',
  } as never;

  assert.deepEqual(await yes('Read', { file_path: '/work/a.ts' }, options), {
    behavior: 'allow',
    updatedInput: { file_path: '/work/a.ts' },
  });
  assert.deepEqual(allowed.asked, [], 'a read is never an ask');

  const run = await yes('Bash', { command: 'npm test' }, options);
  assert.equal(run.behavior, 'allow');
  assert.deepEqual(allowed.asked, ['Run command npm test']);

  const denied = await no('Bash', { command: 'npm test' }, options);
  assert.equal(denied.behavior, 'deny');
  assert.match((denied as { message: string }).message, /denied by the user/i);

  // A tool Polaris does not map is refused, never guessed at.
  const unknown = await yes('WebFetch', {}, options);
  assert.equal(unknown.behavior, 'deny');
});

test('the runtime keeps the conversation: one session, many turns', async () => {
  const { run, seen } = fakeClaude({ replies: [['Hola Eduardo'], ['Te llamas Eduardo']] });
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));

  assert.equal(textOf(await collect(session.send('Me llamo Eduardo'))), 'Hola Eduardo');
  assert.equal(textOf(await collect(session.send('Como me llamo'))), 'Te llamas Eduardo');

  assert.equal(seen.starts, 1, 'a single runtime session serves every turn');
  assert.deepEqual(seen.prompts, ['Me llamo Eduardo', 'Como me llamo']);
  await session.close();
});

test('Ctrl+C interrupts the turn and the session survives it', async () => {
  const { run, seen } = fakeClaude({
    replies: [['Spring ', 'Boot ', 'es ', 'un ', 'framework'], ['Si']],
    delayMs: 15,
  });
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));
  const controller = new AbortController();

  let seenText = '';
  await assert.rejects(async () => {
    for await (const event of session.send('Explicame Spring Boot', controller.signal)) {
      if (event.type !== 'text-delta') continue;
      seenText += event.text;
      if (seenText.includes('Boot')) controller.abort();
    }
  });

  assert.equal(seen.interrupts, 1, 'the runtime is interrupted, not torn down');
  assert.ok(seenText.startsWith('Spring Boot'));
  assert.ok(seenText.length < 'Spring Boot es un framework'.length, 'the answer was cut short');

  assert.equal(textOf(await collect(session.send('Sigues ahi'))), 'Si');
  assert.equal(seen.starts, 1, 'the same runtime session answers afterwards');
  await session.close();
});

test('an already aborted signal never reaches the runtime', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));
  await assert.rejects(() => collect(session.send('hola', AbortSignal.abort())));
  assert.equal(seen.starts, 0);
});

test('a failed turn is reported cleanly, without SDK internals', async () => {
  const { run } = fakeClaude({
    failure: { subtype: 'error_during_execution', is_error: true, result: 'Invalid API key' },
  });
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));

  await assert.rejects(
    () => collect(session.send('hola')),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /not authenticated/i);
      assert.doesNotMatch(error.message, /Invalid API key/);
      return true;
    },
  );
  await session.close();
});

test('a runtime that cannot start produces a one-line explanation', async () => {
  const { run } = fakeClaude({ startError: new Error('spawn claude ENOENT') });
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));

  await assert.rejects(
    () => collect(session.send('hola')),
    (error: unknown) => {
      assert.ok(error instanceof PolarisError);
      assert.match(error.message, /runtime was not found/i);
      return true;
    },
  );
});

test('closing the session shuts the runtime down', async () => {
  const { run, seen } = fakeClaude();
  const session = await createClaudeProvider(run).createSession(testSession('/tmp'));
  await collect(session.send('hola'));
  await session.close();
  assert.equal(seen.closed, true);
});
