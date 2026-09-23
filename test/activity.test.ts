import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ACTIVITY_OUTPUT_LINES,
  type Activity,
  ActivityTracker,
  ago,
  clock,
  liveness,
  QUIET_AFTER_MS,
  SILENT_AFTER_MS,
  SLOW_AFTER_MS,
  took,
} from '../src/core/activity.ts';
import { PolarisApp } from '../src/core/app.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { mockProvider } from '../src/providers/mock/index.ts';
import { type ModelEvent, registerProvider } from '../src/providers/provider.ts';
import { activityRows, activitySummary, statusOf } from '../src/ui/activity.ts';
import { PERMISSION_PROFILES, TEST_ACCESS } from './helpers.ts';

registerProvider(mockProvider);

/** A clock the test moves by hand. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

// --------------------------------------------------------------- the tracker

test('an activity starts with its clock and last activity at the same moment', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('model', 'Codex', { state: 'waiting-model' });
  const activity = tracker.get(id);
  assert.equal(activity?.startedAt, time.now());
  assert.equal(activity?.lastActivityAt, time.now());
  assert.equal(activity?.state, 'waiting-model');
});

test('only real activity moves lastActivityAt; looking at the clock does not', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('model', 'Codex', { state: 'waiting-model' });
  const started = time.now();

  time.advance(20_000);
  // What the UI does every second: render. Nothing it does is activity.
  activityRows(tracker.live(), time.now());
  activitySummary(tracker.live(), time.now());
  liveness(tracker.get(id) as Activity, time.now());
  assert.equal(tracker.get(id)?.lastActivityAt, started);

  tracker.touch(id, 'streaming');
  assert.equal(tracker.get(id)?.lastActivityAt, time.now());
  assert.equal(tracker.get(id)?.state, 'streaming');
});

test('finishing reports the duration, removes it from live, and adds to the totals', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const done = tracker.start('tool', 'src/a.ts', { state: 'running', tool: 'Read' });
  const failed = tracker.start('command', 'npm test', { state: 'running' });
  const cancelled = tracker.start('command', 'npm run slow', { state: 'running' });
  time.advance(1500);

  const a = tracker.finish(done, 'completed');
  const b = tracker.finish(failed, 'failed');
  const c = tracker.finish(cancelled, 'cancelled');
  assert.equal(a?.state, 'completed');
  assert.equal(b?.state, 'failed');
  assert.equal(c?.state, 'cancelled');
  assert.equal((a?.endedAt ?? 0) - (a?.startedAt ?? 0), 1500);
  assert.deepEqual(tracker.live(), []);
  assert.equal(tracker.totals.tool, 1500);
  assert.equal(tracker.totals.command, 3000);
  assert.equal(tracker.finish(done, 'completed'), null, 'finishing twice is harmless');
});

test('command output keeps a short tail and counts as activity', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('command', './gradlew test', { state: 'running' });
  time.advance(5000);
  tracker.output(id, '> Task :compileJava\n> Task :classes\n');
  for (let index = 0; index < 10; index += 1) tracker.output(id, `line ${index}\n`);
  const activity = tracker.get(id) as Activity;
  assert.equal(activity.tail.length, ACTIVITY_OUTPUT_LINES);
  assert.equal(activity.tail.at(-1), 'line 9');
  assert.equal(activity.lastOutputAt, time.now());
  assert.equal(activity.lastActivityAt, time.now());
});

test('children hang under their parent, and a broken listener breaks nothing', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  tracker.onChange(() => {
    throw new Error('a renderer bug');
  });
  const turn = tracker.start('model', 'Codex', { state: 'waiting-tool' });
  const run = tracker.start('command', './gradlew test', { state: 'running', parentId: turn });
  time.advance(2000);
  tracker.output(run, '> Task :test\n');
  const rows = activityRows(tracker.live(), time.now());
  assert.deepEqual(
    rows.map((row) => [row.depth, row.kind, row.text, row.aside]),
    [
      [0, 'head', 'Codex', '00:02'],
      [1, 'status', 'running tools', undefined],
      [1, 'head', 'Run ./gradlew test', '00:02'],
      [2, 'status', 'last output 0s ago', undefined],
      [2, 'output', '> Task :test', undefined],
    ],
  );
});

test('cancelling is a state of its own until the work has really stopped', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('command', 'npm test', { state: 'running' });
  tracker.cancelling();
  assert.equal(tracker.get(id)?.state, 'cancelling');
  // Late output does not undo the cancellation.
  tracker.touch(id, 'running');
  assert.equal(tracker.get(id)?.state, 'cancelling');
  assert.equal(activitySummary(tracker.live(), time.now()), 'cancelling…');
  assert.equal(statusOf(tracker.get(id) as Activity, time.now()), 'cancelling…');
  assert.equal(tracker.finish(id, 'cancelled')?.state, 'cancelled');
});

// ----------------------------------------------------------------- liveness

test('silence is described, never diagnosed', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('command', './gradlew test', { state: 'running' });
  tracker.output(id, '> Task :test\n');
  const at = (ms: number) => {
    const now = time.now() + ms;
    return {
      level: liveness(tracker.get(id) as Activity, now),
      text: statusOf(tracker.get(id) as Activity, now),
    };
  };
  assert.deepEqual(at(5_000), { level: 'active', text: 'last output 5s ago' });
  assert.equal(at(QUIET_AFTER_MS).level, 'quiet');
  assert.equal(at(QUIET_AFTER_MS).text, 'last output 15s ago');
  const silent = at(SILENT_AFTER_MS + 13_000);
  assert.equal(silent.level, 'silent');
  assert.equal(silent.text, 'no new output for 43s · still active · ctrl+c to cancel');
  const slow = at(SLOW_AFTER_MS + 12_000);
  assert.equal(slow.level, 'slow');
  assert.match(slow.text, /no new output for 1m 12s .* may be slow or stalled/);
  for (const text of [silent.text, slow.text]) assert.doesNotMatch(text, /stuck|frozen|hung/i);
});

test('a model with nothing yet says so in terms of data, not of thinking', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('model', 'Anthropic API', { state: 'waiting-model' });
  const text = statusOf(tracker.get(id) as Activity, time.now() + 32_000);
  assert.equal(text, 'no response data for 32s · still active · ctrl+c to cancel');
  assert.doesNotMatch(text, /think/i);
  assert.equal(
    statusOf(tracker.get(id) as Activity, time.now() + 8_000),
    'waiting for model response · last activity 8s ago',
  );
});

test('waiting for approval is never reported as a silence', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const id = tracker.start('approval', 'Edit src/foo.ts', { state: 'waiting-approval' });
  const later = time.now() + 10 * 60_000;
  assert.equal(liveness(tracker.get(id) as Activity, later), 'active');
  assert.equal(statusOf(tracker.get(id) as Activity, later), 'waiting for approval');
  assert.equal(activitySummary(tracker.live(), later), 'waiting for approval');
  const [head] = activityRows(tracker.live(), later);
  assert.equal(head?.tone, 'approval');
  assert.equal(head?.aside, undefined, 'no clock running out on a person');
});

test('fast work is not drawn live; the status bar names the leaf being waited on', () => {
  const time = fakeClock();
  const tracker = new ActivityTracker(time.now);
  const turn = tracker.start('model', 'Codex', { state: 'waiting-tool' });
  tracker.start('tool', 'src/a.ts', { state: 'running', parentId: turn, tool: 'Read' });
  assert.deepEqual(
    activityRows(tracker.live(), time.now() + 50).map((row) => row.text),
    ['Codex', 'running tools'],
    'a 50 ms read never flashes by',
  );
  time.advance(47_000);
  assert.equal(
    activitySummary(tracker.live(), time.now()),
    'Read src/a.ts · 00:47 · no activity 47s',
  );
  tracker.touch(turn);
  assert.equal(
    activitySummary([tracker.live()[0] as Activity], time.now() + 1000),
    'waiting for model · 00:48',
  );
});

test('durations have one format per purpose', () => {
  assert.equal(clock(4_000), '00:04');
  assert.equal(clock(102_000), '01:42');
  assert.equal(clock(728_000), '12:08');
  assert.equal(clock(3_723_000), '1:02:03');
  assert.equal(took(80), '0.08s');
  assert.equal(took(400), '0.4s');
  assert.equal(took(42_800), '42.8s');
  assert.equal(took(134_000), '2m 14s');
  assert.equal(ago(8_000), '8s');
  assert.equal(ago(72_000), '1m 12s');
});

// ------------------------------------------------------------ in the app

async function workspace(files: Record<string, string> = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'polaris-activity-')));
  for (const [path, content] of Object.entries(files)) await writeFile(join(dir, path), content);
  return dir;
}

function open(cwd: string, provider = 'mock', permissions: PermissionProfile = 'workspace-write') {
  const app = new PolarisApp({ cwd, home: cwd, config: { provider, permissions } });
  // Every command is approved the moment it is asked, as a user pressing Enter.
  app.subscribe((state) => {
    if (state.approval) queueMicrotask(() => app.resolveApproval('allow'));
  });
  return app;
}

/** Every distinct snapshot of the live activities during a turn. */
function record(app: PolarisApp) {
  const seen: Activity[][] = [];
  const stop = app.subscribe((state) => {
    if (seen.at(-1) !== state.activity) seen.push([...state.activity]);
  });
  return { seen, stop };
}

test('a command streams into its activity, then becomes a row with its duration', async () => {
  const cwd = await workspace({
    'slow.js': [
      "console.log('> Task :compileJava');",
      "setTimeout(() => console.error('warning: deprecated'), 300);",
      "setTimeout(() => console.log('BUILD SUCCESSFUL'), 600);",
    ].join('\n'),
  });
  const app = open(cwd);
  await app.start();
  const { seen, stop } = record(app);
  await app.submit('@run(node slow.js) go');
  stop();

  const commands = seen.flat().filter((activity) => activity.kind === 'command');
  assert.ok(commands.length > 0, 'the command was live');
  const tails = commands.map((activity) => activity.tail.join('|'));
  assert.ok(
    tails.some((tail) => tail.includes('> Task :compileJava')),
    'stdout seen live',
  );
  assert.ok(
    tails.some((tail) => tail.includes('warning: deprecated')),
    'stderr seen live',
  );
  const times = commands.map((activity) => activity.lastActivityAt);
  assert.ok((times.at(-1) ?? 0) > (times[0] ?? 0), 'output moved lastActivityAt');

  assert.deepEqual(app.state.activity, [], 'nothing left live');
  const row = app.state.messages.find((message) => message.role === 'tool');
  assert.equal(row?.state, 'complete');
  assert.ok((row?.tool?.duration ?? 0) >= 500);
  assert.equal(row?.tool?.lastOutput, 'BUILD SUCCESSFUL');
  assert.equal(row?.tool?.detail, 'exit 0');
  await app.close();
});

test('a cancelled command goes running → cancelling → cancelled, and the session goes on', async () => {
  const cwd = await workspace({
    'forever.js': "console.log('started'); setInterval(() => {}, 1000);",
  });
  const app = open(cwd);
  await app.start();
  const { seen, stop } = record(app);
  const cancel = app.subscribe((state) => {
    if (
      state.activity.some((activity) => activity.kind === 'command' && activity.tail.length > 0)
    ) {
      queueMicrotask(() => app.cancel());
    }
  });
  await app.submit('@run(node forever.js) never');
  cancel();
  stop();

  const states = seen
    .flat()
    .filter((activity) => activity.kind === 'command')
    .map((activity) => activity.state);
  assert.deepEqual([...new Set(states)], ['running', 'cancelling']);
  const row = app.state.messages.find((message) => message.role === 'tool');
  assert.equal(row?.state, 'cancelled');
  assert.match(row?.tool?.detail ?? '', /^cancelled after \d/);
  assert.deepEqual(app.state.activity, []);

  await app.submit('still here?');
  assert.equal(app.state.status, 'ready');
  await app.close();
});

test('model activity follows the runtime: waiting, a sign of life, tools, waiting again, streaming', async () => {
  const cwd = await workspace();
  registerProvider({
    id: 'observable',
    supports: PERMISSION_PROFILES,
    async createSession({ activity }) {
      return {
        access: TEST_ACCESS,
        model: 'observable-1',
        async *send(): AsyncIterable<ModelEvent> {
          activity?.waiting('model');
          await new Promise((resolve) => setTimeout(resolve, 20));
          activity?.pulse();
          yield { type: 'tool-start', id: 't1', name: 'Grep', target: '"ModelProvider"' };
          yield { type: 'tool-result', id: 't1', summary: '8 matches' };
          activity?.waiting('model');
          yield { type: 'text-delta', text: 'done' };
        },
        async close() {},
      };
    },
  });
  const app = open(cwd, 'observable');
  await app.start();
  const { seen, stop } = record(app);
  await app.submit('go');
  stop();

  const states = seen
    .flat()
    .filter((activity) => activity.kind === 'model')
    .map((activity) => activity.state);
  const transitions = states.filter((state, index) => state !== states[index - 1]);
  assert.deepEqual(transitions, ['waiting-model', 'waiting-tool', 'waiting-model', 'streaming']);
  const pulses = seen
    .flat()
    .filter((activity) => activity.kind === 'model' && activity.state === 'waiting-model')
    .map((activity) => activity.lastActivityAt);
  assert.ok((pulses.at(-1) ?? 0) >= (pulses[0] ?? 0));
  assert.equal(
    app.state.messages.find((message) => message.role === 'tool')?.tool?.detail,
    '8 matches',
  );
  await app.close();
});

test('an approval is its own activity under the turn, waiting on a person', async () => {
  const cwd = await workspace({ 'a.txt': 'a\n' });
  const app = new PolarisApp({ cwd, home: cwd, config: { provider: 'mock', permissions: 'ask' } });
  let during: readonly Activity[] = [];
  app.subscribe((state) => {
    if (state.approval && during.length === 0) {
      during = state.activity;
      queueMicrotask(() => app.resolveApproval('deny'));
    }
  });
  await app.start();
  await app.submit('@write(a.txt :: b) edit');
  const approval = during.find((activity) => activity.kind === 'approval');
  const turn = during.find((activity) => activity.kind === 'model');
  assert.equal(approval?.state, 'waiting-approval');
  assert.equal(approval?.parentId, turn?.id);
  assert.deepEqual(app.state.activity, []);
  await app.close();
});

test('/verify runs as a verification with the model under it', async () => {
  const cwd = await workspace();
  const app = open(cwd);
  await app.start();
  const { seen, stop } = record(app);
  await app.verify();
  stop();
  const snapshot = seen.find((activities) => activities.some((a) => a.kind === 'model')) ?? [];
  const verification = snapshot.find((activity) => activity.kind === 'verification');
  assert.equal(verification?.label, 'Verify changes');
  assert.equal(snapshot.find((activity) => activity.kind === 'model')?.parentId, verification?.id);
  assert.deepEqual(app.state.activity, []);
  await app.close();
});
