import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolarisError } from '../src/core/errors.ts';
import { Session } from '../src/core/session.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { getProvider, registerProvider } from '../src/providers/provider.ts';

registerProvider(mockProvider);

test('mock provider echoes input', async () => {
  const model = await mockProvider.createSession({ cwd: '/tmp' });
  assert.equal(model.model, 'echo');
  assert.deepEqual(await model.send('hola'), { text: 'You said: hola' });
  await model.close();
});

test('mock provider honours an abort signal', async () => {
  const model = await mockProvider.createSession({ cwd: '/tmp' });
  await assert.rejects(() => model.send('hola', AbortSignal.abort()));
});

test('session records both sides of each turn', async () => {
  const session = new Session({ cwd: '/tmp/project', config: { provider: 'mock' } });
  await session.start();

  assert.equal(session.active, true);
  assert.equal(await session.prompt('hola'), 'You said: hola');
  assert.deepEqual(session.history, [
    { role: 'user', text: 'hola' },
    { role: 'assistant', text: 'You said: hola' },
  ]);

  session.clearHistory();
  assert.equal(session.history.length, 0);

  await session.close();
  assert.equal(session.active, false);
});

test('prompting before start fails with a user-facing error', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'mock' } });
  await assert.rejects(() => session.prompt('hola'), PolarisError);
});

test('unknown provider fails with a user-facing error', async () => {
  const session = new Session({ cwd: '/tmp', config: { provider: 'ghost' } });
  await assert.rejects(() => session.start(), PolarisError);
  assert.equal(getProvider('ghost'), undefined);
});
