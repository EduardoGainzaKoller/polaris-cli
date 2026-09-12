import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolarisError } from '../src/core/errors.ts';
import { Session } from '../src/core/session.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { getProvider, type ModelEvent, registerProvider } from '../src/providers/provider.ts';

registerProvider(mockProvider);

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const seen: ModelEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function textOf(events: ModelEvent[]): string {
  return events.map((event) => (event.type === 'text-delta' ? event.text : '')).join('');
}

test('provider dispatch: registered providers resolve by id, unknown ones do not', () => {
  assert.equal(getProvider('mock')?.id, 'mock');
  assert.equal(getProvider('ghost'), undefined);
});

test('mock provider streams a turn as start / deltas / end', async () => {
  const model = await mockProvider.createSession({ cwd: '/tmp' });
  const events = await collect(model.send('hello'));

  assert.equal(events.at(0)?.type, 'message-start');
  assert.equal(events.at(-1)?.type, 'message-end');
  assert.ok(events.filter((e) => e.type === 'text-delta').length > 1, 'answer arrives in chunks');
  assert.equal(textOf(events), 'You said: hello');
  await model.close();
});

test('mock provider honours an abort signal', async () => {
  const model = await mockProvider.createSession({ cwd: '/tmp' });
  await assert.rejects(() => collect(model.send('hello', AbortSignal.abort())));
});

test('session records both sides of each turn and keeps the model id', async () => {
  const session = new Session({ cwd: '/tmp/project', config: { provider: 'mock' } });
  await session.start();

  assert.equal(session.active, true);
  assert.equal(session.providerId, 'mock');
  assert.equal(session.modelId, 'echo');
  assert.equal(textOf(await collect(session.send('hola'))), 'You said: hola');
  assert.deepEqual(session.history, [
    { role: 'user', text: 'hola' },
    { role: 'assistant', text: 'You said: hola' },
  ]);

  await collect(session.send('otra'));
  assert.equal(session.history.length, 4, 'the session is multi-turn');

  session.clearHistory();
  assert.equal(session.history.length, 0);

  await session.close();
  assert.equal(session.active, false);
});

test('a cancelled turn keeps the partial answer and leaves the session usable', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'mock' } });
  await session.start();

  const controller = new AbortController();
  await assert.rejects(async () => {
    for await (const event of session.send('hola', controller.signal)) {
      if (event.type === 'text-delta') controller.abort();
    }
  });

  assert.deepEqual(session.history, [
    { role: 'user', text: 'hola' },
    { role: 'assistant', text: 'You ' },
  ]);

  // The session survives the cancellation.
  assert.equal(textOf(await collect(session.send('sigues'))), 'You said: sigues');
  await session.close();
});

test('a model override is reported by the session', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'mock', model: 'fake-model' } });
  await session.start();
  assert.equal(session.modelId, 'fake-model');
  await session.close();
});

test('prompting before start fails with a user-facing error', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'mock' } });
  await assert.rejects(() => collect(session.send('hola')), PolarisError);
});

test('unknown provider fails with a user-facing error', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'ghost' } });
  await assert.rejects(() => session.start(), PolarisError);
});
