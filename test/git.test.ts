import assert from 'node:assert/strict';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GitClient, parseStatus } from '../src/workspace/git.ts';
import { git, makeRepo } from './helpers.ts';

test('a repository is detected with its root, branch and HEAD', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n' });
  const client = await GitClient.open(repo);
  assert.ok(client);
  assert.equal((await realpath(client.root)).toLowerCase(), repo.toLowerCase());
  assert.equal(client.prefix, '');
  const status = await client.status();
  assert.equal(status.branch, 'main');
  assert.equal(status.head, git(repo, 'rev-parse', 'HEAD').trim());
  assert.deepEqual(status.entries, [], 'a fresh commit is clean');
});

test('a nested workspace knows the root but only sees its own files', async () => {
  const repo = await makeRepo({ 'backend/app.ts': 'a\n', 'frontend/ui.ts': 'b\n' });
  await writeFile(join(repo, 'backend/app.ts'), 'changed\n');
  await writeFile(join(repo, 'frontend/ui.ts'), 'changed\n');

  const client = await GitClient.open(join(repo, 'backend'));
  assert.equal(client?.prefix, 'backend/');
  const status = await client?.status();
  // Paths are relative to the workspace, and the sibling directory — same
  // repository, not the workspace — is not reported at all.
  assert.deepEqual(status?.entries, [{ path: 'app.ts', change: 'modified', staged: false }]);
});

test('a folder outside any repository has no Git, and that is not an error', async () => {
  const plain = await mkdtemp(join(tmpdir(), 'polaris-nogit-'));
  assert.equal(await GitClient.open(plain), null);
  assert.equal(await GitClient.open(join(plain, 'does-not-exist')), null);
});

test('modified, untracked, staged, deleted and renamed files are told apart', async () => {
  const repo = await makeRepo({
    'modified.txt': 'm\n',
    'staged.txt': 's\n',
    'deleted.txt': 'd\n',
    'old name.txt': 'r\n',
  });
  await writeFile(join(repo, 'modified.txt'), 'm2\n');
  await writeFile(join(repo, 'staged.txt'), 's2\n');
  git(repo, 'add', 'staged.txt');
  await rm(join(repo, 'deleted.txt'));
  await rename(join(repo, 'old name.txt'), join(repo, 'new name.txt'));
  git(repo, 'add', '-A', 'old name.txt', 'new name.txt');
  await writeFile(join(repo, 'untracked.txt'), 'u\n');

  const status = await (await GitClient.open(repo))?.status();
  const byPath = Object.fromEntries((status?.entries ?? []).map((entry) => [entry.path, entry]));
  assert.equal(byPath['modified.txt']?.change, 'modified');
  assert.equal(byPath['modified.txt']?.staged, false);
  assert.equal(byPath['staged.txt']?.change, 'modified');
  assert.equal(byPath['staged.txt']?.staged, true);
  assert.equal(byPath['deleted.txt']?.change, 'deleted');
  assert.equal(byPath['untracked.txt']?.change, 'untracked');
  assert.equal(byPath['new name.txt']?.change, 'renamed');
  assert.equal(byPath['new name.txt']?.from, 'old name.txt');
});

test('spaces and Unicode in paths survive, unquoted', async () => {
  const repo = await makeRepo({ 'docs/año nuevo.md': 'x\n' });
  await writeFile(join(repo, 'docs/año nuevo.md'), 'y\n');
  await writeFile(join(repo, "ñandú 'quoted'.txt"), 'z\n');
  const status = await (await GitClient.open(repo))?.status();
  assert.deepEqual(status?.entries.map((entry) => entry.path).sort(), [
    'docs/año nuevo.md',
    "ñandú 'quoted'.txt",
  ]);
});

test('a file is read back as it was at a commit, and absence is not an error', async () => {
  const repo = await makeRepo({ 'src/a.ts': 'original\n' });
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  await writeFile(join(repo, 'src/a.ts'), 'edited\n');
  const client = await GitClient.open(join(repo, 'src'));
  assert.equal((await client?.fileAt(head, 'a.ts'))?.toString('utf8'), 'original\n');
  assert.equal(await client?.fileAt(head, 'missing.ts'), null);
});

test('the porcelain v2 parser reads branch headers and every record kind', () => {
  const output = [
    '# branch.oid 1234567890abcdef',
    '# branch.head (detached)',
    '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
    'src/old.ts',
    'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts',
    '? notes.txt',
    '! ignored.log',
    '',
  ].join('\0');
  const status = parseStatus(output);
  assert.equal(status.branch, null, 'detached HEAD has no branch');
  assert.equal(status.head, '1234567890abcdef');
  assert.deepEqual(status.entries, [
    { path: 'src/a b.ts', change: 'modified', staged: false },
    { path: 'src/new.ts', change: 'renamed', staged: true, from: 'src/old.ts' },
    { path: 'src/conflict.ts', change: 'conflicted', staged: true },
    { path: 'notes.txt', change: 'untracked', staged: false },
  ]);
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head main\0').head, null);
});
