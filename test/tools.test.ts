import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_FILE_BYTES, MAX_GLOB_RESULTS, MAX_GREP_RESULTS } from '../src/tools/limits.ts';
import { createRegistry, type ToolCallResult } from '../src/tools/registry.ts';
import { resolveInWorkspace } from '../src/tools/workspace.ts';

const registry = createRegistry('read-only');
let workspace: string;
let outside: string;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'polaris-tools-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(workspace, 'src', 'nested'), { recursive: true });
  await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true });
  await mkdir(join(workspace, '.git'), { recursive: true });
  await mkdir(join(workspace, 'dist'), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(workspace, 'package.json'), '{\n  "name": "demo"\n}\n');
  await writeFile(
    join(workspace, 'src', 'main.ts'),
    'import x from "y";\nexport const ModelProvider = 1;\n',
  );
  await writeFile(join(workspace, 'src', 'nested', 'deep.ts'), 'const modelprovider = 2;\n');
  await writeFile(join(workspace, 'src', 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
  await writeFile(
    join(workspace, 'node_modules', 'dep', 'index.ts'),
    'ModelProvider in a dependency\n',
  );
  await writeFile(join(workspace, '.git', 'config'), 'ModelProvider in git internals\n');
  await writeFile(join(workspace, 'dist', 'bundle.ts'), 'ModelProvider in build output\n');
  await writeFile(join(workspace, '.gitignore'), 'dist/\n');
  await writeFile(
    join(workspace, 'image.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]),
  );
  await writeFile(join(outside, 'secret.txt'), 'TOP SECRET\n');
});

async function run(name: string, input: unknown, signal?: AbortSignal): Promise<ToolCallResult> {
  return registry.execute(name, input, { cwd: workspace, ...(signal ? { signal } : {}) });
}

function ok(result: ToolCallResult) {
  assert.ok(result.ok, result.ok ? '' : `expected success, got: ${result.error}`);
  return result.output;
}

function failed(result: ToolCallResult): string {
  assert.equal(result.ok, false, 'expected a tool error');
  return result.ok ? '' : result.error;
}

// ---------------------------------------------------------------- read_file

test('read_file returns numbered lines and metadata for the UI', async () => {
  const output = ok(await run('read_file', { path: 'package.json' }));
  assert.match(output.content, /1 \| \{/);
  assert.match(output.content, /2 \| {3}"name": "demo"/);
  assert.equal(output.summary, '3 lines');
  assert.equal(output.metadata.path, 'package.json');
  assert.equal(output.metadata.truncated, false);
});

test('read_file honours a line range and says when more lines follow', async () => {
  const output = ok(await run('read_file', { path: 'src/crlf.txt', offset: 2, limit: 1 }));
  assert.match(output.content, /2 \| two/);
  assert.doesNotMatch(output.content, /one|three\s*$/m);
  assert.equal(output.metadata.startLine, 2);
  assert.equal(output.metadata.truncated, true);
  assert.match(output.content, /use offset 3 to continue/);
});

test('read_file treats CRLF like LF', async () => {
  const output = ok(await run('read_file', { path: 'src/crlf.txt' }));
  assert.equal(output.metadata.lines, 3);
  assert.doesNotMatch(output.content, /\r/);
});

test('read_file reports a missing file as a recoverable error', async () => {
  assert.equal(failed(await run('read_file', { path: 'src/nope.ts' })), 'File not found.');
});

test('read_file refuses binary files', async () => {
  assert.match(failed(await run('read_file', { path: 'image.png' })), /Binary file/);
});

test('read_file refuses a huge file unless a range is given', async () => {
  const big = join(workspace, 'big.log');
  await writeFile(big, `${'x'.repeat(99)}\n`.repeat(Math.ceil((MAX_FILE_BYTES + 1) / 100)));
  assert.match(failed(await run('read_file', { path: 'big.log' })), /too large.*line range/);
  const partial = ok(await run('read_file', { path: 'big.log', offset: 10, limit: 5 }));
  assert.equal(partial.metadata.lines, 5);
});

test('read_file rejects `..` escapes', async () => {
  assert.match(
    failed(await run('read_file', { path: '../outside/secret.txt' })),
    /outside the workspace/,
  );
});

test('read_file allows `..` that stays inside the workspace', async () => {
  ok(await run('read_file', { path: 'src/../package.json' }));
});

test('read_file rejects absolute paths outside the workspace', async () => {
  const absolute = join(outside, 'secret.txt');
  assert.match(failed(await run('read_file', { path: absolute })), /outside the workspace/);
  const system = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
  assert.match(failed(await run('read_file', { path: system })), /outside the workspace/);
});

test('read_file blocks a symlink or junction that escapes the workspace', async () => {
  const link = join(workspace, 'external');
  // Junctions need no elevated rights on Windows; elsewhere a directory symlink.
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

  const error = failed(await run('read_file', { path: 'external/secret.txt' }));
  assert.match(error, /outside the workspace/);
  await assert.rejects(
    () => resolveInWorkspace(workspace, 'external/not-there-yet.txt'),
    /outside/,
  );
});

test('read_file stops when the turn is cancelled', async () => {
  await assert.rejects(() => run('read_file', { path: 'package.json' }, AbortSignal.abort()));
});

test('read_file rejects malformed input', async () => {
  assert.match(failed(await run('read_file', {})), /path must be/);
  assert.match(
    failed(await run('read_file', { path: 'a', offset: 'x' })),
    /offset must be an integer/,
  );
});

// --------------------------------------------------------------- glob_files

test('glob_files matches recursively and returns workspace-relative paths', async () => {
  const output = ok(await run('glob_files', { pattern: '**/*.ts' }));
  assert.deepEqual(output.content.split('\n'), ['src/main.ts', 'src/nested/deep.ts']);
  assert.equal(output.summary, '2 files');
});

test('glob_files matches a simple root pattern', async () => {
  const output = ok(await run('glob_files', { pattern: '*.json' }));
  assert.deepEqual(output.content.split('\n'), ['package.json']);
});

test('glob_files skips .git, node_modules and .gitignore entries', async () => {
  const output = ok(await run('glob_files', { pattern: '**/*' }));
  assert.doesNotMatch(output.content, /node_modules/);
  assert.doesNotMatch(output.content, /\.git\//);
  assert.doesNotMatch(output.content, /dist\//);
});

test('glob_files refuses patterns that point outside the workspace', async () => {
  assert.match(failed(await run('glob_files', { pattern: '../**/*' })), /outside the workspace/);
  assert.match(failed(await run('glob_files', { pattern: '/etc/*' })), /outside the workspace/);
  assert.match(
    failed(await run('glob_files', { pattern: 'C:/Windows/*' })),
    /outside the workspace/,
  );
});

test('glob_files truncates large results and says so', async () => {
  const many = join(workspace, 'many');
  await mkdir(many, { recursive: true });
  await Promise.all(
    Array.from({ length: MAX_GLOB_RESULTS + 5 }, (_, index) =>
      writeFile(join(many, `f${String(index).padStart(4, '0')}.txt`), ''),
    ),
  );
  const output = ok(await run('glob_files', { pattern: 'many/*.txt' }));
  assert.equal(output.metadata.files, MAX_GLOB_RESULTS);
  assert.equal(output.metadata.truncated, true);
  assert.match(output.content, /Result truncated/);
  assert.equal(output.summary, `${MAX_GLOB_RESULTS}+ files`);
});

// ---------------------------------------------------------------- grep_text

test('grep_text finds matches across files with path:line output', async () => {
  const output = ok(await run('grep_text', { pattern: 'ModelProvider' }));
  assert.equal(output.content.split('\n')[0], 'src/main.ts:2: export const ModelProvider = 1;');
  assert.equal(output.metadata.matches, 1);
  assert.equal(output.summary, '1 match in 1 file');
});

test('grep_text is case sensitive by default and can ignore case', async () => {
  const insensitive = ok(
    await run('grep_text', { pattern: 'modelprovider', caseSensitive: false }),
  );
  assert.equal(insensitive.metadata.matches, 2);
  assert.equal(insensitive.metadata.files, 2);
});

test('grep_text never searches ignored directories', async () => {
  const output = ok(await run('grep_text', { pattern: 'ModelProvider in' }));
  assert.equal(output.metadata.matches, 0);
  assert.equal(output.summary, 'no matches');
});

test('grep_text filters files by glob and supports regex', async () => {
  const output = ok(
    await run('grep_text', { pattern: 'const \\w+ = \\d', regex: true, glob: 'src/nested/**' }),
  );
  assert.deepEqual(output.content.split('\n'), ['src/nested/deep.ts:1: const modelprovider = 2;']);
  assert.match(
    failed(await run('grep_text', { pattern: '(', regex: true })),
    /Invalid regular expression/,
  );
});

test('grep_text skips binary files', async () => {
  const output = ok(await run('grep_text', { pattern: 'PNG' }));
  assert.equal(output.metadata.matches, 0);
});

test('grep_text truncates large results and says so', async () => {
  const noisy = join(workspace, 'noisy.txt');
  await writeFile(noisy, 'needle\n'.repeat(MAX_GREP_RESULTS + 10));
  const output = ok(await run('grep_text', { pattern: 'needle' }));
  assert.equal(output.metadata.matches, MAX_GREP_RESULTS);
  assert.equal(output.metadata.truncated, true);
  assert.match(output.content, /Result truncated/);
});

test('grep_text stops when the turn is cancelled', async () => {
  await assert.rejects(() => run('grep_text', { pattern: 'x' }, AbortSignal.abort()));
});

// ------------------------------------------------------------------ no writes

async function fingerprint(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (current: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(current, entry.name);
      const info = await stat(path).catch(() => null);
      hash.update(`${path}|${entry.isDirectory()}|${info?.mode}|${info?.mtimeMs}\n`);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
      else if (entry.isFile()) hash.update(await readFile(path));
    }
  };
  await walk(directory);
  return hash.digest('hex');
}

test('no Polaris tool creates, modifies, moves, deletes or re-permissions anything', async () => {
  const before = await fingerprint(workspace);
  const beforeOutside = await fingerprint(outside);

  const calls: Array<[string, unknown]> = [
    ['read_file', { path: 'package.json' }],
    ['read_file', { path: 'new-file.txt' }],
    ['read_file', { path: '../outside/secret.txt' }],
    ['read_file', { path: 'external/secret.txt' }],
    ['glob_files', { pattern: '**/*' }],
    ['glob_files', { pattern: '../**' }],
    ['grep_text', { pattern: 'ModelProvider' }],
    ['grep_text', { pattern: 'x', glob: '**/*.ts', regex: true }],
  ];
  for (const [name, input] of calls) await run(name, input);

  assert.equal(await fingerprint(workspace), before, 'the workspace is byte-for-byte unchanged');
  assert.equal(await fingerprint(outside), beforeOutside, 'nothing outside was touched either');
});

test('read-only exposes the three read tools and run_command, never a file change', () => {
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ['read_file', 'glob_files', 'grep_text', 'run_command'],
  );
});

after(() => {
  // Temp directories are left for the OS to clean; nothing here is in the repo.
});
