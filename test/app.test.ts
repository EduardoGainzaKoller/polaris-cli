import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AppState, PolarisApp } from '../src/core/app.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import type { ModelEvent, ModelProvider } from '../src/providers/provider.ts';
import { registerProvider } from '../src/providers/provider.ts';

registerProvider(mockProvider);

/** A provider that never starts, to exercise a failed switch. */
registerProvider({
  id: 'broken',
  async createSession() {
    throw new Error('runtime unavailable');
  },
});

/** A provider that streams slowly enough to be cancelled. */
registerProvider({
  id: 'slow',
  async createSession() {
    return {
      model: 'slow-1',
      async *send(_input, signal): AsyncIterable<ModelEvent> {
        yield { type: 'message-start' };
        for (const text of ['uno ', 'dos ', 'tres']) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          signal?.throwIfAborted();
          yield { type: 'text-delta', text };
        }
        yield { type: 'message-end' };
      },
      async close() {},
    };
  },
} satisfies ModelProvider);

async function started(provider = 'mock'): Promise<PolarisApp> {
  const app = new PolarisApp({ cwd: '/work/example', config: { provider } });
  await app.start();
  return app;
}

test('a turn streams into the transcript and ends ready', async () => {
  const app = await started();
  const seen: AppState['status'][] = [];
  app.subscribe((state) => {
    if (seen.at(-1) !== state.status) seen.push(state.status);
  });

  await app.submit('hola');

  const [user, assistant] = app.state.messages;
  assert.equal(user?.role, 'user');
  assert.equal(user?.text, 'hola');
  assert.equal(assistant?.role, 'assistant');
  assert.equal(assistant?.text, 'You said: hola');
  assert.equal(assistant?.state, 'complete');
  assert.deepEqual(seen, ['ready', 'thinking', 'streaming', 'ready']);
  await app.close();
});

test('the project name comes from the working directory', async () => {
  const app = await started();
  assert.equal(app.state.project, 'example');
  assert.equal(app.state.provider, 'mock');
  assert.equal(app.state.model, 'echo');
  await app.close();
});

test('cancelling marks the partial answer and leaves the app usable', async () => {
  const app = await started('slow');
  const turn = app.submit('cuenta');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(app.cancel(), true);
  await turn;

  const assistant = app.state.messages.at(-1);
  assert.equal(assistant?.state, 'cancelled');
  assert.ok((assistant?.text.length ?? 0) > 0, 'what arrived is kept on screen');
  assert.equal(app.state.status, 'cancelled');
  assert.equal(app.state.busy, false);

  assert.equal(app.cancel(), false, 'nothing to cancel when idle');
  await app.close();
});

test('a failed turn becomes an error notice, not a crash', async () => {
  registerProvider({
    id: 'exploding',
    async createSession() {
      return {
        model: 'boom-1',
        send(): AsyncIterable<ModelEvent> {
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.reject(new Error('provider exploded')),
            }),
          };
        },
        async close() {},
      };
    },
  });

  const app = await started('exploding');
  await app.submit('hola');

  assert.equal(app.state.status, 'error');
  assert.equal(app.state.messages.at(-1)?.role, 'system');
  assert.equal(app.state.messages.at(-1)?.state, 'error');
  assert.match(app.state.messages.at(-1)?.text ?? '', /provider exploded/);
  await app.close();
});

test('switching provider swaps the session and records it in the transcript', async () => {
  const app = await started();
  await app.submit('hola');
  await app.setProvider('slow');

  assert.equal(app.state.provider, 'slow');
  assert.equal(app.state.model, 'slow-1');
  assert.equal(app.state.status, 'ready');
  assert.match(app.state.messages.at(-1)?.text ?? '', /Switched to slow · slow-1/);
  assert.equal(app.state.turns, 0, 'the new provider starts with its own context');
  await app.close();
});

test('a failed switch keeps the working session alive', async () => {
  const app = await started();
  await assert.rejects(() => app.setProvider('broken'), /Failed to switch provider broken/);

  assert.equal(app.state.provider, 'mock', 'still on the provider that works');
  await app.submit('sigues');
  assert.equal(app.state.messages.at(-1)?.text, 'You said: sigues');
  await app.close();
});

test('switching model keeps the provider and drops nothing else', async () => {
  const app = await started();
  await app.setModel('echo-uppercase');
  assert.equal(app.state.provider, 'mock');
  assert.equal(app.state.model, 'echo-uppercase');
  assert.equal(app.config.model, 'echo-uppercase');
  await app.close();
});

test('switching provider drops a model override that belonged to the old one', async () => {
  const app = new PolarisApp({
    cwd: '/work/example',
    config: { provider: 'mock', model: 'echo-uppercase' },
  });
  await app.start();
  await app.setProvider('slow');
  assert.equal(app.config.model, undefined);
  await app.close();
});

test('model discovery is delegated to the provider', async () => {
  const app = await started();
  assert.deepEqual(await app.listModels(), ['echo', 'echo-uppercase']);

  const noDiscovery = await started('slow');
  assert.equal(await noDiscovery.listModels(), null);
  await app.close();
  await noDiscovery.close();
});

test('clearing the transcript is visual only', async () => {
  const app = await started();
  await app.submit('hola');
  assert.equal(app.state.turns, 2);

  app.clearTranscript();
  assert.equal(app.state.messages.length, 0);
  assert.equal(app.state.turns, 2, 'the provider still holds the conversation');
  await app.close();
});

test('subscribers are notified and can unsubscribe', async () => {
  const app = await started();
  let count = 0;
  const stop = app.subscribe(() => {
    count += 1;
  });
  app.notice('one');
  const after = count;
  assert.ok(after > 0);

  stop();
  app.notice('two');
  assert.equal(count, after, 'no more notifications after unsubscribing');
  await app.close();
});
