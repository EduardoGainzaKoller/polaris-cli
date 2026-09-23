import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, isToolItem, itemCompleted, itemStarted } from '../src/providers/codex/items.ts';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const FILE = process.platform === 'win32' ? 'C:\\work\\src\\main.ts' : '/work/src/main.ts';

function command(actions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: 'commandExecution',
    id: 'call_1',
    command: 'cat src/main.ts',
    cwd: CWD,
    status: 'completed',
    commandActions: actions,
    aggregatedOutput: 'line one\nline two\n',
    exitCode: 0,
    ...extra,
  };
}

test('only tool-like items are treated as tools', () => {
  assert.equal(isToolItem(command([])), true);
  assert.equal(isToolItem({ type: 'agentMessage', id: 'a' }), false);
  assert.equal(isToolItem({ type: 'reasoning', id: 'r' }), false);
  assert.equal(isToolItem({ type: 'commandExecution' }), false, 'an item needs an id');
});

test('a read command is shown as Read with a workspace-relative path', () => {
  const item = command([{ type: 'read', command: 'cat', name: 'main.ts', path: FILE }]);
  assert.deepEqual(itemStarted(item, CWD), {
    type: 'tool-start',
    id: 'call_1',
    name: 'Read',
    target: 'src/main.ts',
  });
  assert.deepEqual(itemCompleted(item), {
    type: 'tool-result',
    id: 'call_1',
    summary: '2 lines',
    exitCode: 0,
  });
});

test('search and listing commands are shown as Grep and List', () => {
  const search = command([{ type: 'search', command: 'rg', query: 'ModelProvider', path: null }], {
    aggregatedOutput: 'a.ts:1: x\nb.ts:2: y\nc.ts:3: z',
  });
  assert.deepEqual(itemStarted(search, CWD), {
    type: 'tool-start',
    id: 'call_1',
    name: 'Grep',
    target: '"ModelProvider"',
  });
  assert.deepEqual(itemCompleted(search), {
    type: 'tool-result',
    id: 'call_1',
    summary: '3 matches',
    exitCode: 0,
  });

  const list = command([{ type: 'listFiles', command: 'ls', path: null }]);
  assert.equal((itemStarted(list, CWD) as { name: string }).name, 'List');
});

test('an unclassified command is shown as Run, shortened', () => {
  const item = command([{ type: 'unknown', command: 'x' }], {
    command: `node -e "${'x'.repeat(120)}"`,
  });
  const started = itemStarted(item, CWD) as { name: string; target: string };
  assert.equal(started.name, 'Run');
  assert.ok(started.target.length <= 80);
});

test('failures, declines and non-zero exits become tool errors', () => {
  assert.equal(itemCompleted(command([], { status: 'declined' })).type, 'tool-error');
  assert.equal(itemCompleted(command([], { status: 'failed', exitCode: 1 })).type, 'tool-error');
  assert.deepEqual(itemCompleted(command([], { exitCode: 2 })), {
    type: 'tool-error',
    id: 'call_1',
    error: 'exit code 2',
    exitCode: 2,
  });
});

test('an applied file change reports the paths and how much moved', () => {
  const change = {
    type: 'fileChange',
    id: 'patch_1',
    status: 'completed',
    changes: [{ path: FILE, diff: '@@\n-old\n+new\n+more\n' }],
  };
  assert.deepEqual(itemStarted(change, CWD), {
    type: 'tool-start',
    id: 'patch_1',
    name: 'Edit',
    target: 'src/main.ts',
    // Announced up front, so Polaris keeps the original before the patch lands.
    paths: [FILE],
  });
  assert.deepEqual(itemCompleted(change), {
    type: 'tool-result',
    id: 'patch_1',
    summary: '+2 -1',
  });
});

test('a declined change is a refusal, not a failure', () => {
  const change = {
    type: 'fileChange',
    id: 'patch_2',
    status: 'declined',
    changes: [{ path: FILE, diff: '' }],
  };
  assert.deepEqual(itemCompleted(change), {
    type: 'tool-error',
    id: 'patch_2',
    error: 'Declined by the user.',
    denied: true,
  });
});

/**
 * Captured from a real Codex App Server on Windows: every command runs inside a
 * PowerShell wrapper, and all but Get-Content come back classified `unknown`
 * with the unwrapped command attached.
 */
const WRAPPER =
  '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command';

test('an unclassified rg search on Windows is still shown as Grep', () => {
  const item = command(
    [{ type: 'unknown', command: `rg -n --hidden --glob '!node_modules' "ModelProvider" .` }],
    { command: `${WRAPPER} "rg -n ..."` },
  );
  assert.deepEqual(itemStarted(item, CWD), {
    type: 'tool-start',
    id: 'call_1',
    name: 'Grep',
    target: '"ModelProvider"',
  });
});

test('an unclassified Get-ChildItem on Windows is shown as List, not as the wrapper', () => {
  const item = command([{ type: 'unknown', command: 'Get-ChildItem -LiteralPath src' }], {
    command: `${WRAPPER} 'Get-ChildItem -LiteralPath src'`,
    aggregatedOutput: 'a\nb\nc\n',
  });
  assert.deepEqual(itemStarted(item, CWD), {
    type: 'tool-start',
    id: 'call_1',
    name: 'List',
    target: 'src',
  });
  assert.deepEqual(itemCompleted(item), {
    type: 'tool-result',
    id: 'call_1',
    summary: '3 entries',
    exitCode: 0,
  });
});

test('classify recognises common read, list and search commands', () => {
  assert.equal(classify('rg --files src')?.type, 'listFiles');
  assert.deepEqual(classify('rg -e "a|b" src'), {
    type: 'search',
    command: 'rg -e "a|b" src',
    query: 'a|b',
    path: 'src',
  });
  assert.equal(classify('Select-String -Pattern Foo -Path src/*.ts')?.query, 'Foo');
  assert.equal(classify('cat src/main.ts')?.path, 'src/main.ts');
  assert.equal(classify('Get-Content -Path package.json -TotalCount 20')?.path, 'package.json');
  assert.equal(classify('npm test'), undefined, 'anything else stays a plain shell command');
});

test('classify ignores the rest of a pipeline and count arguments', () => {
  // Both shapes showed up as "List |" and "Read 80" in a real Windows session.
  assert.deepEqual(classify('rg --files | Select-Object -First 80'), {
    type: 'listFiles',
    command: 'rg --files | Select-Object -First 80',
    path: null,
  });
  assert.equal(classify('Get-Content src/main.ts -TotalCount 80')?.path, 'src/main.ts');
  assert.equal(classify('Get-Content src/main.ts | Select-Object -First 80')?.path, 'src/main.ts');
  assert.equal(classify('head -n 80 src/main.ts')?.path, 'src/main.ts');
  assert.equal(classify('rg -a ModelProvider src')?.query, 'ModelProvider', 'rg -a takes no value');
});

test('a command nobody can classify shows the inner command, never the wrapper', () => {
  const item = command([{ type: 'unknown', command: 'node --version' }], {
    command: `${WRAPPER} 'node --version'`,
  });
  assert.deepEqual(itemStarted(item, CWD), {
    type: 'tool-start',
    id: 'call_1',
    name: 'Run',
    target: 'node --version',
  });
});

test('rg line-number and count flags take no value', () => {
  assert.equal(classify('rg -n ModelProvider src')?.query, 'ModelProvider');
  assert.equal(classify('rg -c ModelProvider src')?.path, 'src');
});
