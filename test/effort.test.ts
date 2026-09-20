import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp } from '../src/core/app.ts';
import { type ClaudeRun, createClaudeProvider } from '../src/providers/claude/index.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { type ModelEvent, registerProvider } from '../src/providers/provider.ts';
import { PERMISSION_PROFILES, TEST_ACCESS, testSession } from './helpers.ts';

registerProvider(mockProvider);
registerProvider({
  id: 'no-effort',
  supports: PERMISSION_PROFILES,
  async createSession() {
    return {
      access: TEST_ACCESS,
      model: 'plain-1',
      async *send(): AsyncIterable<ModelEvent> {
        yield { type: 'text-delta', text: 'ok' };
      },
      async close() {},
    };
  },
});

async function app(provider = 'mock', effort?: string): Promise<PolarisApp> {
  const created = new PolarisApp({
    cwd: '/work',
    config: { provider, ...(effort ? { effort } : {}) },
  });
  await created.start();
  return created;
}

function context(polaris: PolarisApp, choose: (options: string[]) => string | null = () => null) {
  const offered: Array<{ options: string[]; current: string | null | undefined }> = [];
  const ctx: CommandContext = {
    app: polaris,
    canSelect: true,
    select: async (_title, options, current) => {
      offered.push({ options, current });
      return choose(options);
    },
    clearScreen: () => {},
    requestExit: () => {},
  };
  return { ctx, offered };
}

const effort = (() => {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  return registry.get('effort');
})();

test('effort changes live and keeps the conversation', async () => {
  const polaris = await app();
  await polaris.submit('hola');
  assert.equal(polaris.state.effort, 'medium');

  await polaris.setEffort('high');
  assert.equal(polaris.state.effort, 'high');
  assert.equal(polaris.config.effort, 'high');
  assert.equal(polaris.state.turns, 2, 'no new session was started');
  assert.match(polaris.state.messages.at(-1)?.text ?? '', /Effort set to high/);
  await polaris.close();
});

test('a configured effort is used from the first turn', async () => {
  const polaris = await app('mock', 'low');
  assert.equal(polaris.state.effort, 'low');
  await polaris.close();
});

test('an unsupported level is refused and nothing changes', async () => {
  const polaris = await app();
  await assert.rejects(() => polaris.setEffort('ludicrous'), /Unknown effort/);
  assert.equal(polaris.state.effort, 'medium');
  await polaris.close();
});

test('/effort offers the levels with the current one marked', async () => {
  const polaris = await app();
  const { ctx, offered } = context(polaris, (options) => options[2] ?? null);
  await effort?.run(ctx, []);
  assert.deepEqual(offered[0], { options: ['low', 'medium', 'high'], current: 'medium' });
  assert.equal(polaris.state.effort, 'high');
  await polaris.close();
});

test('/effort <level> sets it directly, and explains an unknown one', async () => {
  const polaris = await app();
  const { ctx } = context(polaris);
  await effort?.run(ctx, ['low']);
  assert.equal(polaris.state.effort, 'low');
  await effort?.run(ctx, ['max']);
  assert.match(polaris.state.messages.at(-1)?.text ?? '', /Unknown effort "max"/);
  await polaris.close();
});

test('/effort says so when the provider has no notion of effort', async () => {
  const polaris = await app('no-effort');
  const { ctx } = context(polaris);
  await effort?.run(ctx, []);
  assert.match(
    polaris.state.messages.at(-1)?.text ?? '',
    /does not let the reasoning effort be chosen/,
  );
  assert.equal(polaris.state.effort, null);
  await polaris.close();
});

test('switching provider drops the effort, which belongs to the old provider', async () => {
  const polaris = await app('mock', 'high');
  await polaris.setProvider('no-effort');
  assert.equal(polaris.config.effort, undefined);
  await polaris.close();
});

test('an answer ends with a footer naming the model, the effort and the time', async () => {
  const polaris = await app('mock', 'high');
  await polaris.submit('hola');
  assert.match(polaris.state.messages.at(-1)?.meta ?? '', /^echo · high · \d+(\.\d)?s$/);
  await polaris.close();
});

test('Claude applies a new effort to a running session through the runtime flags', async () => {
  const applied: unknown[] = [];
  let started: Record<string, unknown> | undefined;
  const run = ({
    prompt,
    options,
  }: {
    prompt: AsyncIterable<SDKUserMessage>;
    options?: unknown;
  }): ClaudeRun => {
    started = options as Record<string, unknown>;
    return {
      interrupt: async () => {},
      supportedModels: async () => [],
      applyFlagSettings: async (settings) => {
        applied.push(settings);
      },
      return: async () => {},
      async *[Symbol.asyncIterator]() {
        for await (const _ of prompt) {
          yield { type: 'result', subtype: 'success', is_error: false } as never;
        }
      },
    };
  };

  const session = await createClaudeProvider(run).createSession(
    testSession('/work', { effort: 'low' }),
  );
  assert.equal(session.effort, 'low');
  for await (const _ of session.send('hola')) {
    // drain
  }
  assert.equal(started?.effort, 'low', 'the starting effort is passed to the runtime');

  await session.setEffort?.('xhigh');
  assert.deepEqual(applied, [{ effortLevel: 'xhigh' }], 'changed live, no new session');
  assert.equal(session.effort, 'xhigh');
  await assert.rejects(() => session.setEffort?.('turbo') ?? Promise.resolve(), /Unknown effort/);
  await session.close();
});
