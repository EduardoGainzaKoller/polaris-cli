import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { anthropicApiProvider, DEFAULT_MODEL } from '../src/providers/anthropic-api/index.ts';
import type { ModelEvent } from '../src/providers/provider.ts';
import { autoGate, testSession } from './helpers.ts';

/**
 * Exercises the real SDK against a local server that speaks the Messages
 * streaming protocol. No credentials, no network, no quota — but the whole
 * path (SSE -> SDK events -> ModelEvent) is the production one, tool calls
 * included.
 */
let server: Server;
let requests: Array<Record<string, unknown>> = [];
/** Deltas the fake Claude will emit for a text response. */
let reply = ['Hola', ' Eduardo'];
/** Milliseconds between deltas, so a test can cancel mid-answer. */
let delayMs = 0;
/** Rate-limit headers the fake API returns, as the real one does. */
let rateLimitHeaders: Record<string, string> = {};
/** Each entry makes one response a tool_use turn instead of text. */
let toolTurns: Array<Array<{ id: string; name: string; input: unknown }>> = [];
let workspace: string;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'polaris-anthropic-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), '{\n  "name": "demo"\n}\n');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream', ...rateLimitHeaders });
      res.write(
        sse('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: DEFAULT_MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      );

      const calls = toolTurns.shift();
      if (calls) {
        for (const [index, call] of calls.entries()) {
          res.write(
            sse('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} },
            }),
          );
          res.write(
            sse('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
            }),
          );
          res.write(sse('content_block_stop', { type: 'content_block_stop', index }));
        }
        finish(res, 'tool_use');
        return;
      }

      res.write(
        sse('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      for (const text of reply) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (res.writableEnded) return;
        res.write(
          sse('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          }),
        );
      }
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      finish(res, 'end_turn');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
});

function finish(res: import('node:http').ServerResponse, stopReason: string): void {
  res.write(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 2 },
    }),
  );
  res.write(sse('message_stop', { type: 'message_stop' }));
  res.end();
}

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const seen: ModelEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

/** The tool_result blocks sent as the last message of request `index`. */
function toolResultsIn(index: number): Array<Record<string, unknown>> {
  const messages = (requests[index]?.messages ?? []) as Array<{ content: unknown }>;
  return (messages.at(-1)?.content ?? []) as Array<Record<string, unknown>>;
}

function reset(): void {
  requests = [];
  rateLimitHeaders = {};
  reply = ['Hola', ' Eduardo'];
  delayMs = 0;
  toolTurns = [];
}

test('text deltas from the wire become Polaris text-delta events', async () => {
  reset();
  const session = await anthropicApiProvider.createSession(testSession(workspace));

  const events = await collect(session.send('Me llamo Eduardo'));
  assert.equal(events.at(0)?.type, 'message-start');
  assert.equal(events.at(-1)?.type, 'message-end');
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['Hola', ' Eduardo'],
  );
  assert.equal(session.model, DEFAULT_MODEL);
  await session.close();
});

test('the conversation is replayed, so the session is multi-turn', async () => {
  reset();
  const session = await anthropicApiProvider.createSession({
    ...testSession(workspace),
    model: 'claude-test',
  });

  await collect(session.send('Me llamo Eduardo'));
  await collect(session.send('Como me llamo?'));

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'Me llamo Eduardo' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hola Eduardo' }] },
    { role: 'user', content: 'Como me llamo?' },
  ]);
  assert.equal(requests[1]?.model, 'claude-test', 'the model override reaches the wire');
  assert.equal(requests[1]?.stream, true, 'answers are always streamed');
  await session.close();
});

test('the profile decides which tools the model is even offered', async () => {
  reset();
  const readOnly = await anthropicApiProvider.createSession(
    testSession(workspace, { permissions: 'read-only' }),
  );
  await collect(readOnly.send('hola'));

  const tools = requests[0]?.tools as Array<{ name: string; input_schema: unknown }>;
  // A denied capability is not a tool the model is told not to use: it is a
  // tool that does not exist in the request at all.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['read_file', 'glob_files', 'grep_text'],
  );
  assert.ok(tools.every((tool) => typeof tool.input_schema === 'object'));
  await readOnly.close();

  reset();
  const ask = await anthropicApiProvider.createSession(
    testSession(workspace, { permissions: 'ask' }),
  );
  await collect(ask.send('hola'));
  const offered = requests[0]?.tools as Array<{ name: string }>;
  assert.deepEqual(
    offered.map((tool) => tool.name),
    ['read_file', 'glob_files', 'grep_text', 'write_file', 'edit_file', 'run_command'],
  );
  await ask.close();
});

test('a mutating tool is authorised before it runs, and its result goes back', async () => {
  reset();
  toolTurns = [
    [
      {
        id: 'toolu_w',
        name: 'write_file',
        input: { path: 'created.ts', content: 'export const a = 1;\n' },
      },
    ],
  ];
  reply = ['Done.'];
  const approved = autoGate('ask', 'allow');
  const session = await anthropicApiProvider.createSession(
    testSession(workspace, { permissions: 'ask', gate: approved.gate }),
  );

  const events = await collect(session.send('crea el archivo'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['message-start', 'tool-start', 'tool-result', 'text-delta', 'message-end'],
  );
  assert.deepEqual(approved.asked, ['Write created.ts']);
  assert.equal(await readFile(join(workspace, 'created.ts'), 'utf8'), 'export const a = 1;\n');

  const sent = requests[1]?.messages as Array<{ content: unknown }>;
  const results = sent.at(-1)?.content as Array<Record<string, unknown>>;
  assert.equal(results[0]?.tool_use_id, 'toolu_w');
  assert.match(String(results[0]?.content), /Created created\.ts/);
  await session.close();
});

test('a refused tool writes nothing and tells the model a person said no', async () => {
  reset();
  toolTurns = [
    [
      {
        id: 'toolu_d',
        name: 'write_file',
        input: { path: 'refused.ts', content: 'nope\n' },
      },
    ],
  ];
  reply = ['Understood.'];
  const refused = autoGate('ask', 'deny');
  const session = await anthropicApiProvider.createSession(
    testSession(workspace, { permissions: 'ask', gate: refused.gate }),
  );

  const events = await collect(session.send('crea el archivo'));
  const error = events.find((event) => event.type === 'tool-error');
  assert.ok(error, 'the refusal is reported as a tool event');
  assert.equal((error as { denied?: boolean }).denied, true);
  assert.equal(existsSync(join(workspace, 'refused.ts')), false);

  // The model is told it was refused, in the same turn, so it can offer
  // something else instead of asking for the identical thing again.
  const sent = requests[1]?.messages as Array<{ content: unknown }>;
  const results = sent.at(-1)?.content as Array<Record<string, unknown>>;
  assert.match(String(results[0]?.content), /denied by the user/i);
  assert.equal(results[0]?.is_error, true);
  await session.close();
});

test('a tool call runs in Polaris, is reported as events, and its result goes back', async () => {
  reset();
  toolTurns = [[{ id: 'toolu_1', name: 'read_file', input: { path: 'package.json' } }]];
  reply = ['The package is demo.'];
  const session = await anthropicApiProvider.createSession(testSession(workspace));

  const events = await collect(session.send('What is the package name?'));
  assert.deepEqual(
    events.map((e) => e.type),
    ['message-start', 'tool-start', 'tool-result', 'text-delta', 'message-end'],
  );
  assert.deepEqual(events[1], {
    type: 'tool-start',
    id: 'toolu_1',
    name: 'Read',
    target: 'package.json',
  });
  assert.deepEqual(events[2], { type: 'tool-result', id: 'toolu_1', summary: '3 lines' });

  const followUp = requests[1]?.messages as Array<{ role: string; content: unknown }>;
  const results = followUp.at(-1)?.content as Array<Record<string, unknown>>;
  assert.equal(results[0]?.type, 'tool_result');
  assert.equal(results[0]?.tool_use_id, 'toolu_1');
  assert.match(String(results[0]?.content), /"name": "demo"/);
  assert.equal(results[0]?.is_error, undefined);
  await session.close();
});

test('a failing tool is an error the model reads, not a failed turn', async () => {
  reset();
  toolTurns = [[{ id: 'toolu_2', name: 'read_file', input: { path: '../../etc/passwd' } }]];
  reply = ['I cannot read outside the workspace.'];
  const session = await anthropicApiProvider.createSession(testSession(workspace));

  const events = await collect(session.send('Read /etc/passwd'));
  assert.deepEqual(
    events.find((e) => e.type === 'tool-error'),
    { type: 'tool-error', id: 'toolu_2', error: 'Path is outside the workspace.' },
  );
  assert.equal(events.at(-1)?.type, 'message-end', 'the turn still finishes');

  const results = toolResultsIn(1);
  assert.equal(results[0]?.is_error, true);
  await session.close();
});

test('parallel tool calls all come back in one user message', async () => {
  reset();
  toolTurns = [
    [
      { id: 'toolu_a', name: 'glob_files', input: { pattern: '**/*.json' } },
      { id: 'toolu_b', name: 'grep_text', input: { pattern: 'demo' } },
    ],
  ];
  reply = ['Done.'];
  const session = await anthropicApiProvider.createSession(testSession(workspace));

  const events = await collect(session.send('Look around'));
  assert.equal(events.filter((e) => e.type === 'tool-start').length, 2);
  assert.equal(events.filter((e) => e.type === 'tool-result').length, 2);

  const results = toolResultsIn(1);
  assert.deepEqual(
    results.map((result) => result.tool_use_id),
    ['toolu_a', 'toolu_b'],
  );
  await session.close();
});

test('cancelling mid-answer keeps the partial turn and leaves the session usable', async () => {
  reset();
  reply = ['Spring ', 'Boot ', 'es ', 'un ', 'framework'];
  delayMs = 20;
  const session = await anthropicApiProvider.createSession(testSession(workspace));
  const controller = new AbortController();

  let seen = '';
  await assert.rejects(async () => {
    for await (const event of session.send('Explicame Spring Boot', controller.signal)) {
      if (event.type !== 'text-delta') continue;
      seen += event.text;
      if (seen.includes('Boot')) controller.abort();
    }
  });
  assert.equal(seen, 'Spring Boot ');

  delayMs = 0;
  reply = ['Si'];
  assert.equal(
    (await collect(session.send('Sigues ahi?')))
      .map((e) => (e.type === 'text-delta' ? e.text : ''))
      .join(''),
    'Si',
    'the next turn still works after a cancellation',
  );
  assert.deepEqual(requests.at(-1)?.messages, [
    { role: 'user', content: 'Explicame Spring Boot' },
    { role: 'assistant', content: 'Spring Boot ' },
    { role: 'user', content: 'Sigues ahi?' },
  ]);
  await session.close();
});

test('cancelling while a tool runs leaves a history the API still accepts', async () => {
  reset();
  toolTurns = [[{ id: 'toolu_c', name: 'grep_text', input: { pattern: 'demo' } }]];
  const session = await anthropicApiProvider.createSession(testSession(workspace));
  const controller = new AbortController();

  await assert.rejects(async () => {
    for await (const event of session.send('Search', controller.signal)) {
      if (event.type === 'tool-start') controller.abort();
    }
  });

  reply = ['OK'];
  await collect(session.send('Responde OK'));
  const history = requests.at(-1)?.messages as Array<{ role: string; content: unknown }>;
  // user, assistant(tool_use), user(tool_result: cancelled), user(new prompt)
  const repaired = history[2]?.content as Array<Record<string, unknown>>;
  assert.equal(repaired[0]?.type, 'tool_result');
  assert.equal(repaired[0]?.tool_use_id, 'toolu_c');
  assert.equal(repaired[0]?.is_error, true);
  await session.close();
});

// -------------------------------------------------------------------- usage

test('tokens are counted per model across the whole session', async () => {
  reset();
  const session = await anthropicApiProvider.createSession(testSession(workspace));
  await collect(session.send('una'));
  await collect(session.send('dos'));

  const report = await session.usage?.();
  assert.ok(report, 'the provider reports usage');
  assert.equal(report.models.length, 1);
  const [entry] = report.models;
  assert.equal(entry?.model, DEFAULT_MODEL);
  // 1 in / 2 out per request, and Polaris owns the loop here, so two turns
  // must add up rather than replace each other.
  assert.equal(entry?.tokens.input, 2);
  assert.equal(entry?.tokens.output, 4);
  assert.match(report.note ?? '', /no cost/i);
  assert.equal(report.costUsd, undefined, 'a cost the API never sent is never invented');
  await session.close();
});

test('the ceilings come from the response headers, whatever they are named', async () => {
  reset();
  const resetsAt = new Date(Date.now() + 90 * 60_000).toISOString();
  rateLimitHeaders = {
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '900',
    'anthropic-ratelimit-requests-reset': resetsAt,
    'anthropic-ratelimit-input-tokens-limit': '80000',
    'anthropic-ratelimit-input-tokens-remaining': '20000',
    // A ceiling Polaris has never heard of still shows up, because the
    // headers are read by shape rather than from a hard-coded list.
    'anthropic-ratelimit-future-thing-limit': '10',
    'anthropic-ratelimit-future-thing-remaining': '4',
  };
  const session = await anthropicApiProvider.createSession(testSession(workspace));
  await collect(session.send('hola'));

  const report = await session.usage?.();
  const limits = Object.fromEntries((report?.limits ?? []).map((limit) => [limit.name, limit]));

  assert.deepEqual(Object.keys(limits).sort(), ['future thing', 'input tokens', 'requests']);
  assert.equal(limits.requests?.limit, 1000);
  assert.equal(limits.requests?.remaining, 900);
  assert.equal(Math.round(limits.requests?.usedPercent ?? 0), 10);
  assert.equal(limits.requests?.resetsAt?.toISOString(), resetsAt);
  assert.equal(Math.round(limits['input tokens']?.usedPercent ?? 0), 75);
  assert.equal(limits['input tokens']?.resetsAt, undefined, 'no reset header, no reset claim');
  await session.close();
});

test('a session that never ran a turn reports nothing rather than zeroes', async () => {
  reset();
  const session = await anthropicApiProvider.createSession(testSession(workspace));
  assert.equal(await session.usage?.(), null);
  await session.close();
});
