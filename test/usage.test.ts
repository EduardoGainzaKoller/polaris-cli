import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinCommands } from '../src/cli/commands/builtin.ts';
import { CommandRegistry } from '../src/cli/commands/registry.ts';
import type { CommandContext } from '../src/cli/commands/types.ts';
import { PolarisApp } from '../src/core/app.ts';
import {
  addTokens,
  bar,
  compact,
  totalTokens,
  type UsageReport,
  untilReset,
  usageLines,
} from '../src/core/usage.ts';
import { toUsageReport } from '../src/providers/claude/index.ts';
import { buildReport, toLimits, toTokens } from '../src/providers/codex/usage.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { type ModelEvent, registerProvider } from '../src/providers/provider.ts';
import { PERMISSION_PROFILES, TEST_ACCESS } from './helpers.ts';

registerProvider(mockProvider);

// ------------------------------------------------------------- the numbers

test('counts are compacted without pretending to more precision than they have', () => {
  assert.equal(compact(0), '0');
  assert.equal(compact(999), '999');
  assert.equal(compact(1000), '1.0k');
  assert.equal(compact(12_400), '12k');
  assert.equal(compact(1_250_000), '1.3M');
});

test('a reset time is stated as a wait, and never as a negative one', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(untilReset(new Date(now + 3 * 60_000), now), 'in 3m');
  assert.equal(untilReset(new Date(now + 90 * 60_000), now), 'in 1h 30m');
  assert.equal(untilReset(new Date(now + 50 * 3600_000), now), 'in 2d 2h');
  assert.equal(untilReset(new Date(now - 60_000), now), 'now');
});

test('the bar is clamped, so a percentage over 100 cannot overflow the row', () => {
  assert.equal(bar(0).length, 20);
  assert.equal(bar(250).length, 20);
  assert.equal(bar(250), '█'.repeat(20));
  assert.equal(bar(50), `${'█'.repeat(10)}${'░'.repeat(10)}`);
});

test('adding counts keeps optional fields optional', () => {
  const sum = addTokens({ input: 1, output: 2 }, { input: 3, output: 4, cacheRead: 5 });
  assert.deepEqual(sum, { input: 4, output: 6, cacheRead: 5 });
  // A field neither side reported stays absent rather than becoming a zero.
  assert.equal('reasoning' in sum, false);
  assert.equal(totalTokens(sum), 15);
});

// ------------------------------------------------------------- the layout

test('a report renders limits, models and the note it came with', () => {
  const report: UsageReport = {
    plan: 'plus',
    models: [
      {
        model: 'gpt-5.6-luna',
        tokens: { input: 12_000, output: 400, cacheRead: 8000 },
        contextWindow: 258_000,
        contextUsed: 12_400,
      },
    ],
    limits: [
      { name: '5h window', usedPercent: 25, resetsAt: new Date(Date.now() + 3600_000) },
      { name: 'requests', limit: 1000, remaining: 750, usedPercent: 25 },
    ],
    note: 'Reported by the runtime.',
  };
  const text = usageLines(report).join('\n');

  assert.match(text, /Limits/);
  assert.match(text, /5h window\s+█+░+ 25%\s+resets in 1h 0m/);
  assert.match(text, /requests\s+█+░+ 25%\s+750 \/ 1.0k left/);
  assert.match(text, /Tokens by model/);
  assert.match(text, /gpt-5\.6-luna\s+20k total · 12k in · 400 out · 8.0k cached/);
  assert.match(text, /context █+░+ 12k \/ 258k/);
  assert.match(text, /Reported by the runtime\./);
});

test('a context window with no measured usage draws no bar at all', () => {
  // An empty bar reads as "nothing used", which is a different claim from
  // "not measured" — so the row is omitted instead.
  const text = usageLines({
    models: [{ model: 'm', tokens: { input: 1, output: 1 }, contextWindow: 1000 }],
    limits: [],
  }).join('\n');
  assert.doesNotMatch(text, /context/);
});

test('cost is printed only when the provider actually reported one', () => {
  const without = usageLines({ models: [], limits: [], note: 'n' }).join('\n');
  assert.doesNotMatch(without, /cost/i);
  const with_ = usageLines({ models: [], limits: [], costUsd: 0.1234 }).join('\n');
  assert.match(with_, /Estimated cost\s+\$0\.1234/);
});

// ---------------------------------------------------------------- Codex

test('Codex rate-limit windows are named by their length', () => {
  const limits = toLimits({
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 3, windowDurationMins: 10_080 },
  });
  assert.equal(limits[0]?.name, '5h window');
  assert.equal(limits[0]?.usedPercent, 12.5);
  assert.equal(limits[0]?.resetsAt?.getTime(), 1_800_000_000_000, 'seconds become milliseconds');
  assert.equal(limits[1]?.name, 'weekly');
  assert.equal(limits[1]?.resetsAt, undefined);
});

test('a Codex window with no percentage is dropped rather than shown as zero', () => {
  assert.deepEqual(toLimits({ primary: { windowDurationMins: 300 } }), []);
  assert.deepEqual(toLimits(null), []);
});

test('Codex thread tokens separate the total from what the context holds', () => {
  const usage = toTokens({
    tokenUsage: {
      total: {
        inputTokens: 12_000,
        cachedInputTokens: 9000,
        outputTokens: 500,
        reasoningOutputTokens: 300,
      },
      last: { inputTokens: 4000, cachedInputTokens: 3000, outputTokens: 100 },
      modelContextWindow: 258_000,
    },
  });
  assert.deepEqual(usage?.tokens, {
    input: 12_000,
    output: 500,
    cacheRead: 9000,
    reasoning: 300,
  });
  assert.equal(usage?.contextWindow, 258_000);
  // The session total counts every turn's context again; what the
  // conversation is holding right now is the last turn's.
  assert.equal(usage?.contextUsed, 7100);
});

test('a Codex report survives having only one of its two halves', () => {
  const tokensOnly = buildReport(
    'm',
    toTokens({ tokenUsage: { total: { inputTokens: 5 } } }),
    null,
  );
  assert.equal(tokensOnly?.limits.length, 0);
  assert.equal(tokensOnly?.models[0]?.tokens.input, 5);

  const limitsOnly = buildReport('m', null, {
    primary: { usedPercent: 1, windowDurationMins: 60 },
    planType: 'pro',
  });
  assert.equal(limitsOnly?.plan, 'pro');
  assert.equal(limitsOnly?.models.length, 0);

  assert.equal(buildReport('m', null, null), null, 'nothing measured, nothing claimed');
  assert.equal(
    buildReport('m', null, { planType: 'unknown' })?.plan,
    undefined,
    'an unknown plan is not a plan',
  );
});

// ---------------------------------------------------------------- Claude

test('the Claude runtime report is read per model, cost included', () => {
  const report = toUsageReport({
    type: 'result',
    total_cost_usd: 0.4211,
    modelUsage: {
      'claude-opus-5[1m]': {
        inputTokens: 1200,
        outputTokens: 800,
        thinkingTokens: 300,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 100,
        costUSD: 0.4211,
        contextWindow: 200_000,
        canonicalModel: 'claude-opus-5',
      },
    },
  } as never);

  assert.equal(report?.models[0]?.model, 'claude-opus-5', 'the canonical id, not the raw key');
  assert.deepEqual(report?.models[0]?.tokens, {
    input: 1200,
    output: 800,
    cacheRead: 5000,
    cacheWrite: 100,
    reasoning: 300,
  });
  assert.equal(report?.models[0]?.costUsd, 0.4211);
  assert.equal(report?.costUsd, 0.4211);
  assert.match(report?.note ?? '', /estimate, not a bill/i);
});

test('a Claude result with no usage reports nothing', () => {
  assert.equal(toUsageReport({ type: 'result', modelUsage: {} } as never), null);
});

// ---------------------------------------------------------------- /status

async function status(provider = 'mock'): Promise<string> {
  const registry = new CommandRegistry();
  registry.register(...builtinCommands(registry));
  const app = new PolarisApp({ cwd: '/work', config: { provider, permissions: 'ask' } });
  await app.start();
  await app.submit('hola');
  const context: CommandContext = {
    app,
    canSelect: false,
    select: async () => null,
    clearScreen: () => {},
    requestExit: () => {},
  };
  await registry.get('status')?.run(context, []);
  const text = app.state.messages.at(-1)?.text ?? '';
  await app.close();
  return text;
}

test('/status shows the session and what it has consumed', async () => {
  const text = await status();
  assert.match(text, /provider\s+mock/);
  assert.match(text, /perms\s+ask/);
  assert.match(text, /plan\s+offline/);
  assert.match(text, /Limits/);
  assert.match(text, /Tokens by model/);
  assert.match(text, /echo\s+\d+ total/);
});

test('/status says so plainly when a provider measures nothing', async () => {
  registerProvider({
    id: 'unmetered',
    supports: PERMISSION_PROFILES,
    async createSession() {
      return {
        access: TEST_ACCESS,
        model: 'quiet-1',
        async *send(): AsyncIterable<ModelEvent> {
          yield { type: 'text-delta', text: 'ok' };
        },
        async close() {},
      };
    },
  });

  const text = await status('unmetered');
  assert.match(text, /unmetered does not report token usage/);
  // And it is still a status: the session facts never depend on usage.
  assert.match(text, /model\s+quiet-1/);
  assert.doesNotMatch(text, /Tokens by model/);
});

test('/status still works when the provider throws while reporting usage', async () => {
  registerProvider({
    id: 'broken-usage',
    supports: PERMISSION_PROFILES,
    async createSession() {
      return {
        access: TEST_ACCESS,
        model: 'broken-1',
        async *send(): AsyncIterable<ModelEvent> {
          yield { type: 'text-delta', text: 'ok' };
        },
        async usage(): Promise<never> {
          throw new Error('rate limit endpoint exploded');
        },
        async close() {},
      };
    },
  });

  const text = await status('broken-usage');
  assert.match(text, /model\s+broken-1/, 'the status survives a usage failure');
  assert.match(text, /does not report token usage/);
});
