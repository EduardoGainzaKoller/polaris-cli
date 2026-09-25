import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { createRegistry, type ToolCallResult } from '../src/tools/registry.ts';
import { truncateOutput } from '../src/tools/run-command.ts';
import { autoGate } from './helpers.ts';

/**
 * Commands are exercised with `node -e`, which exists wherever these tests can
 * run and is the same on Windows, Linux and macOS. Nothing destructive is ever
 * executed: the fixtures are a temporary directory and a few prints.
 */
let workspace: string;
let outside: string;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'polaris-run-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(workspace, 'sub'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'marker.txt'), 'inside\n');
  await symlink(
    outside,
    join(workspace, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});

async function run(
  input: unknown,
  options: { answer?: 'allow' | 'deny'; signal?: AbortSignal; onOutput?: (t: string) => void } = {},
): Promise<ToolCallResult> {
  const { gate } = autoGate('smart', options.answer ?? 'allow');
  return createRegistry('smart', gate).execute('run_command', input, {
    cwd: workspace,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {}),
  });
}

function ok(result: ToolCallResult): Extract<ToolCallResult, { ok: true }> {
  assert.equal(result.ok, true, result.ok ? '' : result.error);
  return result as Extract<ToolCallResult, { ok: true }>;
}

function failed(result: ToolCallResult): Extract<ToolCallResult, { ok: false }> {
  assert.equal(result.ok, false, 'expected the call to fail');
  return result as Extract<ToolCallResult, { ok: false }>;
}

test('a successful command returns its output and exit code 0', async () => {
  const result = ok(await run({ command: 'node -e "console.log(2+2)"' }));
  assert.match(result.output.content, /^4$/m);
  assert.equal(result.output.metadata.exitCode, 0);
  assert.equal(result.output.metadata.command, 'node -e "console.log(2+2)"');
});

test('a non-zero exit code is a result the model reads, not a crash', async () => {
  const result = ok(await run({ command: 'node -e "console.log(\'nope\'); process.exit(1)"' }));
  // The distinction the whole agent loop depends on: the command failed, the
  // tool did not. The model has to see the output to be able to fix anything.
  assert.equal(result.output.metadata.exitCode, 1);
  assert.match(result.output.content, /nope/);
  assert.match(result.output.content, /failed with exit code 1/);
  assert.match(result.output.summary, /exit 1/);
});

test('stdout and stderr both reach the model and are counted apart', async () => {
  const result = ok(
    await run({
      command: "node -e \"console.log('to out'); console.error('to err')\"",
    }),
  );
  assert.match(result.output.content, /to out/);
  assert.match(result.output.content, /to err/);
  assert.ok((result.output.metadata.stdout as number) > 0);
  assert.ok((result.output.metadata.stderr as number) > 0);
});

test('output streams while the command runs, before it finishes', async () => {
  const chunks: string[] = [];
  ok(
    await run(
      {
        command: "node -e \"console.log('first'); setTimeout(() => console.log('second'), 60)\"",
      },
      { onOutput: (text) => chunks.push(text) },
    ),
  );
  assert.ok(chunks.length >= 1, 'the UI saw output as it arrived');
  assert.match(chunks.join(''), /first/);
  assert.match(chunks.join(''), /second/);
});

test('huge output is cut for the model but the real size is stated', async () => {
  const result = ok(
    await run({
      command: 'node -e "for (let i = 0; i < 20000; i++) console.log(\'line \' + i)"',
    }),
  );
  assert.equal(result.output.metadata.truncated, true);
  assert.ok((result.output.metadata.lines as number) > 19000);
  assert.match(result.output.content, /output truncated/);
  // Head and tail survive: the start says what ran, the end says how it went.
  assert.match(result.output.content, /line 0/);
  assert.match(result.output.content, /line 19999/);
  assert.match(result.output.content, /lines omitted/);
});

test('truncateOutput keeps both ends and never silently drops everything', () => {
  const small = truncateOutput('one\ntwo\n');
  assert.equal(small.truncated, false);
  assert.equal(small.text, 'one\ntwo');

  const big = truncateOutput(Array.from({ length: 5000 }, (_, i) => `row ${i}`).join('\n'));
  assert.equal(big.truncated, true);
  assert.equal(big.lines, 5000);
  assert.match(big.text, /row 0/);
  assert.match(big.text, /row 4999/);
});

test('a command that outlives its timeout is terminated and says so', async () => {
  const result = failed(
    await run({ command: 'node -e "setTimeout(() => {}, 30000)"', timeoutMs: 1000 }),
  );
  assert.match(result.error, /timed out after 1s/);
});

test('cancelling the turn ends the command instead of leaving it running', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => run({ command: 'node -e "setTimeout(() => {}, 30000)"' }, { signal: controller.signal }),
    'cancellation ends the turn rather than becoming a tool result',
  );
});

test('a child of the command is killed too, not orphaned', async () => {
  // The shell starts a parent script, which starts a child; the child keeps
  // touching a file. Killing only the shell would leave the grandchild
  // running and still writing into the workspace.
  const beat = join(workspace, 'beat.txt');
  await writeFile(
    join(workspace, 'child.js'),
    `const fs = require('fs');\nsetInterval(() => fs.writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 50);\n`,
  );
  await writeFile(
    join(workspace, 'parent.js'),
    "require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' });\n" +
      'setInterval(() => {}, 1000);\n',
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);
  await assert.rejects(() => run({ command: 'node parent.js' }, { signal: controller.signal }));

  await new Promise((resolve) => setTimeout(resolve, 200));
  const first = await readFile(beat, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await readFile(beat, 'utf8'), first, 'the grandchild is no longer running');
});

test('a denied command never starts', async () => {
  const marker = join(workspace, 'should-not-exist.txt').replaceAll('\\', '/');
  const result = failed(
    await run(
      { command: `node -e "require('fs').writeFileSync('${marker}', 'x')"` },
      { answer: 'deny' },
    ),
  );
  assert.equal(result.denied, true);
  const check = ok(
    await run({ command: `node -e "console.log(require('fs').existsSync('${marker}'))"` }),
  );
  assert.match(check.output.content, /false/);
});

test('the approval shows the command in full and where it will run', async () => {
  const { gate, asked } = autoGate('smart', 'allow');
  const seen: Array<{ facts?: readonly string[] }> = [];
  gate.onApproval(async (request) => {
    seen.push(request);
    asked.push(request.target);
    return 'allow';
  });
  await createRegistry('smart', gate).execute(
    'run_command',
    { command: 'node -e "console.log(1)"' },
    { cwd: workspace },
  );
  // Never abbreviated: a shortened command cannot be judged.
  assert.deepEqual(asked, ['node -e "console.log(1)"']);
  assert.match(seen[0]?.facts?.[0] ?? '', /^cwd: /);
  assert.match(seen[0]?.facts?.[1] ?? '', /^timeout: \d+s/);
});

test('a cwd inside the workspace is honoured', async () => {
  const result = ok(await run({ command: 'node -e "console.log(process.cwd())"', cwd: 'sub' }));
  assert.match(result.output.content.toLowerCase(), /sub/);
  assert.equal(result.output.metadata.cwd, 'sub');
});

test('a cwd outside the workspace is refused, symlinks included', async () => {
  for (const cwd of ['..', outside, 'external']) {
    const result = failed(await run({ command: 'node -e "console.log(1)"', cwd }));
    assert.match(result.error, /outside the workspace/i, cwd);
  }
});

test('run_command refuses input it cannot trust and clamps the timeout', async () => {
  assert.match(failed(await run({ command: '   ' })).error, /non-empty/);
  assert.match(failed(await run({ command: 'x', timeoutMs: 1.5 })).error, /integer/);

  const { gate } = autoGate('smart', 'allow');
  const tool = createRegistry('smart', gate).get('run_command');
  const parsed = tool?.parse({ command: 'x', timeoutMs: 99_999_999 }) as { timeoutMs: number };
  assert.equal(parsed.timeoutMs, 600_000);
});
