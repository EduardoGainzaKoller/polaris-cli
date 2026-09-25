import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { PermissionGate } from '../src/permissions/gate.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { createRegistry, type ToolCallResult } from '../src/tools/registry.ts';
import { autoGate } from './helpers.ts';

/**
 * Every test gets its own workspace, because these tools actually write. The
 * fixture is disposable; nothing here ever touches the Polaris repository.
 */
let workspace: string;
let outside: string;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), 'polaris-write-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'src', 'user.ts'), 'export function createUser() {}\n');
  await writeFile(join(outside, 'secret.txt'), 'secret\n');
  await symlink(
    outside,
    join(workspace, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});

async function run(
  name: string,
  input: unknown,
  options: {
    profile?: PermissionProfile;
    answer?: 'allow' | 'deny';
    gate?: PermissionGate;
    signal?: AbortSignal;
    onOutput?: (text: string) => void;
  } = {},
): Promise<ToolCallResult> {
  const profile = options.profile ?? 'smart';
  const gate = options.gate ?? autoGate(profile, options.answer ?? 'allow').gate;
  return createRegistry(profile, gate).execute(name, input, {
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

// ------------------------------------------------------------------ write_file

test('write_file creates a file and reports what it wrote', async () => {
  const result = ok(
    await run('write_file', { path: 'hello.ts', content: 'export const a = 1;\n' }),
  );
  assert.equal(await readFile(join(workspace, 'hello.ts'), 'utf8'), 'export const a = 1;\n');
  assert.deepEqual(result.output.metadata, {
    path: 'hello.ts',
    created: true,
    bytes: 20,
    lines: 1,
    linesAdded: 1,
    linesRemoved: 0,
  });
});

test('write_file replaces an existing file and counts the change', async () => {
  const result = ok(
    await run('write_file', { path: 'src/user.ts', content: 'export function createUser(n) {}\n' }),
  );
  assert.equal(result.output.metadata.created, false);
  assert.equal(result.output.metadata.linesAdded, 1);
  assert.equal(result.output.metadata.linesRemoved, 1);
});

test('write_file creates missing parent directories', async () => {
  ok(await run('write_file', { path: 'src/new/module/File.ts', content: 'export {};\n' }));
  assert.equal(await readFile(join(workspace, 'src/new/module/File.ts'), 'utf8'), 'export {};\n');
});

test('the approval shows a diff for a replacement and the whole file for a new one', async () => {
  const seen: Array<{ facts?: readonly string[]; diff?: string }> = [];
  const gate = new PermissionGate('smart');
  gate.onApproval(async (request) => {
    seen.push(request);
    return 'allow';
  });

  await run('write_file', { path: 'brand-new.ts', content: 'a\nb\n' }, { gate });
  assert.match(seen[0]?.facts?.[0] ?? '', /New file . 2 lines/);
  assert.equal(seen[0]?.diff, '+a\n+b');

  await run('write_file', { path: 'src/user.ts', content: 'changed\n' }, { gate });
  assert.match(seen[1]?.diff ?? '', /-export function createUser\(\) \{\}/);
  assert.match(seen[1]?.diff ?? '', /\+changed/);
});

test('nothing is written when the user denies', async () => {
  const before = await readFile(join(workspace, 'src', 'user.ts'), 'utf8');
  const result = failed(
    await run('write_file', { path: 'src/user.ts', content: 'wiped\n' }, { answer: 'deny' }),
  );
  assert.equal(result.denied, true);
  assert.match(result.error, /denied by the user/i);
  assert.equal(await readFile(join(workspace, 'src', 'user.ts'), 'utf8'), before);
});

test('read-only makes write_file not exist at all', async () => {
  const result = failed(
    await run('write_file', { path: 'x.ts', content: 'a\n' }, { profile: 'read-only' }),
  );
  // Not "you may not": the tool is absent from the registry the model is given.
  assert.match(result.error, /Unknown tool/);
  assert.equal((await readdir(workspace)).includes('x.ts'), false);
});

test('workspace-write writes without asking', async () => {
  const { gate, asked } = autoGate('workspace-write', 'deny');
  ok(
    await run(
      'write_file',
      { path: 'auto.ts', content: 'a\n' },
      { profile: 'workspace-write', gate },
    ),
  );
  assert.deepEqual(asked, [], 'no question was put to the user');
});

test('a write outside the workspace is refused, symlinks and junctions included', async () => {
  for (const path of ['../outside/x.txt', join(outside, 'x.txt'), 'external/x.txt']) {
    const result = failed(
      await run('write_file', { path, content: 'x\n' }, { profile: 'workspace-write' }),
    );
    assert.match(result.error, /outside the workspace/i, path);
  }
  assert.deepEqual(await readdir(outside), ['secret.txt']);
});

test('a file changed while the approval was open is not overwritten', async () => {
  const gate = new PermissionGate('smart');
  gate.onApproval(async () => {
    // Exactly the race the fingerprint exists for: an editor saving, or
    // another agent, between the preview and the write.
    await writeFile(join(workspace, 'src', 'user.ts'), 'someone else got here first\n');
    return 'allow';
  });

  const result = failed(
    await run('write_file', { path: 'src/user.ts', content: 'mine\n' }, { gate }),
  );
  assert.match(result.error, /changed while the approval was open/i);
  assert.equal(
    await readFile(join(workspace, 'src', 'user.ts'), 'utf8'),
    'someone else got here first\n',
  );
});

test('a cancelled turn leaves no file and no temporary behind', async () => {
  const controller = new AbortController();
  const gate = new PermissionGate('smart');
  gate.onApproval(async () => {
    controller.abort();
    return 'allow';
  });

  await assert.rejects(() =>
    run('write_file', { path: 'never.ts', content: 'a\n' }, { gate, signal: controller.signal }),
  );
  assert.equal(
    (await readdir(workspace)).some((name) => name.includes('polaris-')),
    false,
  );
});

test('write_file refuses input it cannot trust', async () => {
  assert.match(failed(await run('write_file', { path: '', content: 'a' })).error, /non-empty/);
  assert.match(failed(await run('write_file', { path: 'a.ts' })).error, /content must be a string/);
});

// ------------------------------------------------------------------- edit_file

test('edit_file replaces a single match and reports the counts', async () => {
  const result = ok(
    await run('edit_file', {
      path: 'src/user.ts',
      oldText: 'createUser() {}',
      newText: 'createUser(name) {\n  if (!name) throw new Error("name");\n}',
    }),
  );
  const after = await readFile(join(workspace, 'src', 'user.ts'), 'utf8');
  assert.match(after, /throw new Error\("name"\)/);
  assert.equal(result.output.metadata.occurrences, 1);
  assert.equal(result.output.summary, '+3 -1');
});

test('edit_file says so when the text is not there', async () => {
  const result = failed(
    await run('edit_file', { path: 'src/user.ts', oldText: 'nowhere', newText: 'x' }),
  );
  assert.match(result.error, /was not found/);
});

test('an ambiguous match is refused rather than applied 27 times', async () => {
  await writeFile(join(workspace, 'many.ts'), 'const a = 1;\nconst a = 1;\nconst a = 1;\n');
  const result = failed(
    await run('edit_file', { path: 'many.ts', oldText: 'const a = 1;', newText: 'const b = 2;' }),
  );
  assert.match(result.error, /matches 3 times/);
  assert.equal(await readFile(join(workspace, 'many.ts'), 'utf8'), 'const a = 1;\n'.repeat(3));

  // Only an explicit `all` replaces every occurrence.
  const every = ok(
    await run('edit_file', {
      path: 'many.ts',
      oldText: 'const a = 1;',
      newText: 'const b = 2;',
      all: true,
    }),
  );
  assert.equal(every.output.metadata.occurrences, 3);
});

test('CRLF files keep their line endings and match exactly', async () => {
  await writeFile(join(workspace, 'crlf.ts'), 'line one\r\nline two\r\nline three\r\n');
  ok(await run('edit_file', { path: 'crlf.ts', oldText: 'line two', newText: 'line dos' }));
  const after = await readFile(join(workspace, 'crlf.ts'), 'utf8');
  assert.equal(after, 'line one\r\nline dos\r\nline three\r\n');
  assert.equal(after.includes('\n\n'), false, 'no line ending was rewritten');
});

test('unicode is matched and written back byte for byte', async () => {
  await writeFile(join(workspace, 'uni.ts'), 'const saludo = "hasta mañana 🌙";\n', 'utf8');
  ok(
    await run('edit_file', {
      path: 'uni.ts',
      oldText: 'hasta mañana 🌙',
      newText: 'buenos días ☀',
    }),
  );
  assert.equal(
    await readFile(join(workspace, 'uni.ts'), 'utf8'),
    'const saludo = "buenos días ☀";\n',
  );
});

test('edit_file cannot reach outside the workspace', async () => {
  for (const path of ['../outside/secret.txt', 'external/secret.txt']) {
    const result = failed(
      await run(
        'edit_file',
        { path, oldText: 'secret', newText: 'leaked' },
        { profile: 'workspace-write' },
      ),
    );
    assert.match(result.error, /outside the workspace/i, path);
  }
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret\n');
});

test('a denied edit changes nothing', async () => {
  const before = await readFile(join(workspace, 'src', 'user.ts'), 'utf8');
  const result = failed(
    await run(
      'edit_file',
      { path: 'src/user.ts', oldText: 'createUser', newText: 'makeUser' },
      { answer: 'deny' },
    ),
  );
  assert.equal(result.denied, true);
  assert.equal(await readFile(join(workspace, 'src', 'user.ts'), 'utf8'), before);
});

test('the edit approval carries the diff the user is actually agreeing to', async () => {
  const gate = new PermissionGate('smart');
  let diff = '';
  gate.onApproval(async (request) => {
    diff = request.diff ?? '';
    return 'allow';
  });
  await run(
    'edit_file',
    { path: 'src/user.ts', oldText: 'createUser', newText: 'makeUser' },
    { gate },
  );
  assert.match(diff, /-export function createUser\(\) \{\}/);
  assert.match(diff, /\+export function makeUser\(\) \{\}/);
});

test('an edit is abandoned when the file moves under the approval', async () => {
  const gate = new PermissionGate('smart');
  gate.onApproval(async () => {
    await writeFile(
      join(workspace, 'src', 'user.ts'),
      'export function createUser() { /* x */ }\n',
    );
    return 'allow';
  });
  const result = failed(
    await run(
      'edit_file',
      { path: 'src/user.ts', oldText: 'createUser', newText: 'makeUser' },
      { gate },
    ),
  );
  assert.match(result.error, /changed while the approval was open/i);
});

test('edit_file rejects a no-op and a missing file', async () => {
  assert.match(
    failed(await run('edit_file', { path: 'src/user.ts', oldText: 'a', newText: 'a' })).error,
    /identical/,
  );
  assert.match(
    failed(await run('edit_file', { path: 'ghost.ts', oldText: 'a', newText: 'b' })).error,
    /does not exist/,
  );
});
