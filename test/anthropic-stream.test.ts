import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { anthropicProvider, DEFAULT_MODEL } from '../src/providers/anthropic/index.ts';
import type { ModelEvent } from '../src/providers/provider.ts';

/**
 * Exercises the real SDK against a local server that speaks the Messages
 * streaming protocol. No credentials, no network, no quota — but the whole
 * path (SSE -> SDK events -> ModelEvent) is the production one.
 */
let server: Server;
let requests: Array<Record<string, unknown>> = [];
/** Deltas the fake Claude will emit for the next turn. */
let reply = ['Hola', ' Eduardo'];
/** Milliseconds between deltas, so a test can cancel mid-answer. */
let delayMs = 0;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
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
      res.write(
        sse('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        }),
      );
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const seen: ModelEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

test('text deltas from the wire become Polaris text-delta events', async () => {
  requests = [];
  reply = ['Hola', ' Eduardo'];
  const session = await anthropicProvider.createSession({ cwd: '/tmp' });

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
  requests = [];
  const session = await anthropicProvider.createSession({ cwd: '/tmp', model: 'claude-test' });

  await collect(session.send('Me llamo Eduardo'));
  await collect(session.send('Como me llamo?'));

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'Me llamo Eduardo' },
    { role: 'assistant', content: 'Hola Eduardo' },
    { role: 'user', content: 'Como me llamo?' },
  ]);
  assert.equal(requests[1]?.model, 'claude-test', 'the model override reaches the wire');
  assert.equal(requests[1]?.stream, true, 'answers are always streamed');
  await session.close();
});

test('cancelling mid-answer keeps the partial turn and leaves the session usable', async () => {
  requests = [];
  reply = ['Spring ', 'Boot ', 'es ', 'un ', 'framework'];
  delayMs = 20;
  const session = await anthropicProvider.createSession({ cwd: '/tmp' });
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
