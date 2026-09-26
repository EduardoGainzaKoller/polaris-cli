import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_SNAPSHOT_FILE_BYTES } from '../src/tools/limits.ts';
import { ChangeTracker, CheckpointError } from '../src/workspace/changes.ts';
import { git, makeRepo, writeFiles } from './helpers.ts';

/**
 * A turn, as the app runs one: whatever changed while idle is the user's,
 * whatever changes during `work` is Polaris's.
 */
async function turn(tracker: ChangeTracker, work: () => Promise<void>): Promise<string[]> {
  await tracker.reconcile('user');
  await work();
  return tracker.reconcile('polaris');
}

const read = (dir: string, path: string) => readFile(join(dir, path), 'utf8');
const exists = async (dir: string, path: string) =>
  readFile(join(dir, path)).then(
    () => true,
    () => false,
  );

async function undoAll(tracker: ChangeTracker, id?: string) {
  const plan = await tracker.planUndo(id);
  return tracker.undo(plan);
}

// ------------------------------------------------------------- the baseline

test('a file the user modified before startup is theirs, not Polaris’s', async () => {
  const repo = await makeRepo({ 'src/foo.ts': 'foo\n', 'src/bar.ts': 'bar\n' });
  await writeFile(join(repo, 'src/foo.ts'), 'foo — user edit\n');

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'src/bar.ts': 'bar — polaris\n' }));

  assert.deepEqual(
    tracker.changes().map((change) => [change.path, change.kind]),
    [['src/bar.ts', 'modified']],
  );
  assert.deepEqual(tracker.preexisting(), [{ path: 'src/foo.ts', change: 'modified' }]);
  await tracker.dispose();
});

test('an untracked file that was already there is not confused with one Polaris creates', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n' });
  await writeFile(join(repo, 'notes.txt'), 'my notes\n');

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'src/new.ts': 'export {};\n' }));

  assert.deepEqual(
    tracker.changes().map((change) => [change.path, change.kind]),
    [['src/new.ts', 'created']],
  );
  assert.deepEqual(tracker.preexisting(), [{ path: 'notes.txt', change: 'untracked' }]);

  await undoAll(tracker);
  assert.equal(await exists(repo, 'src/new.ts'), false, 'the created file is gone');
  assert.equal(await read(repo, 'notes.txt'), 'my notes\n', 'the user’s untracked file stays');
  await tracker.dispose();
});

test('a change made between turns is the user’s, even to a file that was clean', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a — polaris\n' }));
  // The user, in their editor, while Polaris waits.
  await writeFile(join(repo, 'b.txt'), 'b — user\n');
  await turn(tracker, async () => {});

  assert.deepEqual(
    tracker.changes().map((change) => change.path),
    ['a.txt'],
  );
  assert.deepEqual(tracker.preexisting(), [{ path: 'b.txt', change: 'changed' }]);
  await undoAll(tracker);
  assert.equal(await read(repo, 'b.txt'), 'b — user\n');
  await tracker.dispose();
});

test('changes nobody announced are found and marked unexpected', async () => {
  const repo = await makeRepo({ 'src/a.ts': 'a\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, async () => {
    // An announced edit, as a file tool does it…
    await tracker.capture(['src/a.ts']);
    await writeFile(join(repo, 'src/a.ts'), 'a2\n');
    // …and a file a command or a native runtime wrote without saying so.
    await writeFiles(repo, { 'src/generated/foo.json': '{}\n' });
  });

  const byPath = Object.fromEntries(tracker.changes().map((change) => [change.path, change]));
  assert.equal(byPath['src/a.ts']?.unexpected, false);
  assert.equal(byPath['src/generated/foo.json']?.unexpected, true);
  await tracker.dispose();
});

// --------------------------------------------------------------------- undo

test('undo restores a modified file and never touches the user’s own changes', async () => {
  const repo = await makeRepo({ 'README.md': 'readme\n', 'src/bar.ts': 'bar\n' });
  await writeFile(join(repo, 'README.md'), 'readme — the user was here\n');
  const before = await readFile(join(repo, 'README.md'));

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'src/bar.ts': 'bar — polaris\n' }));
  const result = await undoAll(tracker);

  assert.deepEqual(result.restored, ['src/bar.ts']);
  assert.equal(await read(repo, 'src/bar.ts'), 'bar\n');
  assert.deepEqual(await readFile(join(repo, 'README.md')), before, 'byte for byte');
  assert.deepEqual(tracker.changes(), []);
  await tracker.dispose();
});

test('a file the user had changed goes back to their version, not to HEAD', async () => {
  const repo = await makeRepo({ 'config.ts': 'head\n' });
  await writeFile(join(repo, 'config.ts'), 'user draft\n');

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'config.ts': 'polaris rewrite\n' }));
  assert.equal(tracker.changes()[0]?.preexisting, true);

  await undoAll(tracker);
  assert.equal(await read(repo, 'config.ts'), 'user draft\n');
  await tracker.dispose();
});

test('undo covers several files, created and modified, and keeps exact bytes', async () => {
  const repo = await makeRepo({ 'win.txt': 'one\r\ntwo\r\n', 'b.txt': 'b\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () =>
    writeFiles(repo, { 'win.txt': 'one\ntwo\n', 'b.txt': 'b2\n', 'c/d.txt': 'new\n' }),
  );
  assert.equal(tracker.changes().length, 3);

  const result = await undoAll(tracker);
  assert.equal(result.restored.length, 3);
  assert.equal(await read(repo, 'win.txt'), 'one\r\ntwo\r\n', 'CRLF comes back as CRLF');
  assert.equal(await read(repo, 'b.txt'), 'b\n');
  assert.equal(await exists(repo, 'c/d.txt'), false);
  await tracker.dispose();
});

test('undo goes back to the latest checkpoint, then to the one before', async () => {
  const repo = await makeRepo({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a1\n' }));
  const checkpoint = await tracker.checkpoint('before validation');
  assert.equal(checkpoint.id, 'cp-2');
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a2\n', 'b.txt': 'b1\n' }));

  const first = await undoAll(tracker);
  assert.equal(first.checkpoint.id, 'cp-2');
  assert.equal(await read(repo, 'a.txt'), 'a1\n', 'only what came after the checkpoint');
  assert.equal(await read(repo, 'b.txt'), 'b0\n');

  // Nothing left since cp-2, so the next undo falls back to the session start.
  const second = await undoAll(tracker);
  assert.equal(second.checkpoint.id, 'cp-1');
  assert.equal(await read(repo, 'a.txt'), 'a0\n');
  assert.deepEqual(
    tracker.checkpoints.map((item) => item.id),
    ['cp-1'],
  );
  await tracker.dispose();
});

test('undo to a named checkpoint drops the later ones', async () => {
  const repo = await makeRepo({ 'a.txt': 'a0\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a1\n' }));
  await tracker.checkpoint();
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a2\n' }));
  await tracker.checkpoint();
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a3\n' }));

  await undoAll(tracker, 'cp-2');
  assert.equal(await read(repo, 'a.txt'), 'a1\n');
  assert.deepEqual(
    tracker.checkpoints.map((item) => item.id),
    ['cp-1', 'cp-2'],
  );
  await assert.rejects(tracker.planUndo('cp-9'), CheckpointError);
  await tracker.dispose();
});

test('with nothing changed there is nothing to undo', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n' });
  const tracker = await ChangeTracker.start(repo);
  const plan = await tracker.planUndo();
  assert.equal(plan.checkpoint.id, 'cp-1');
  assert.deepEqual(plan.restore, []);
  assert.deepEqual(plan.skipped, []);
  await tracker.dispose();
});

test('a file the user edited after Polaris is never overwritten by undo', async () => {
  const repo = await makeRepo({ 'foo.ts': 'foo\n', 'bar.ts': 'bar\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'foo.ts': 'polaris\n', 'bar.ts': 'polaris\n' }));
  // The user opens foo.ts in the IDE and keeps working on it.
  await writeFile(join(repo, 'foo.ts'), 'polaris + user work\n');

  await tracker.reconcile('user');
  const plan = await tracker.planUndo();
  assert.deepEqual(
    plan.restore.map((item) => item.path),
    ['bar.ts'],
  );
  assert.deepEqual(
    plan.skipped.map((item) => item.path),
    ['foo.ts'],
  );
  assert.match(plan.skipped[0]?.reason ?? '', /changed outside Polaris/);

  await tracker.undo(plan);
  assert.equal(await read(repo, 'foo.ts'), 'polaris + user work\n');
  assert.equal(await read(repo, 'bar.ts'), 'bar\n');
  await tracker.dispose();
});

test('a file that changes while the undo is being confirmed is skipped', async () => {
  const repo = await makeRepo({ 'a.txt': 'a\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'a.txt': 'polaris\n' }));
  const plan = await tracker.planUndo();
  await writeFile(join(repo, 'a.txt'), 'saved while the prompt was open\n');

  const result = await tracker.undo(plan);
  assert.deepEqual(result.restored, []);
  assert.match(result.skipped[0]?.reason ?? '', /while the undo was being confirmed/);
  assert.equal(await read(repo, 'a.txt'), 'saved while the prompt was open\n');
  await tracker.dispose();
});

test('undo never follows a link out of the workspace', async () => {
  const repo = await makeRepo({ 'keep.txt': 'k\n' });
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'polaris-outside-')));
  await writeFile(join(outside, 'a.txt'), 'same\n');

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () => writeFiles(repo, { 'sub/a.txt': 'same\n' }));
  // The directory Polaris wrote into is swapped for a link to somewhere else
  // holding a file with identical content, so no hash gives it away.
  await rm(join(repo, 'sub'), { recursive: true });
  await symlink(outside, join(repo, 'sub'), process.platform === 'win32' ? 'junction' : 'dir');

  const result = await undoAll(tracker);
  assert.deepEqual(result.restored, []);
  assert.match(result.skipped[0]?.reason ?? '', /outside the workspace/);
  assert.equal(await readFile(join(outside, 'a.txt'), 'utf8'), 'same\n', 'outside file intact');
  await tracker.dispose();
});

test('a restore that fails leaves the file as it was and says why', async () => {
  const scratch = await useScratchTemp();
  try {
    const repo = await makeRepo({ 'a.txt': 'a0\n' });
    const tracker = await ChangeTracker.start(repo);
    await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a1\n' }));
    await tracker.checkpoint();
    await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a2\n' }));
    // The checkpoint's copy of a.txt vanishes (a temp cleaner, a full disk).
    for (const store of await stores(scratch.dir)) {
      await rm(join(scratch.dir, store), { recursive: true, force: true });
    }

    const result = await undoAll(tracker);
    assert.deepEqual(result.restored, []);
    assert.equal(result.skipped[0]?.path, 'a.txt');
    assert.equal(await read(repo, 'a.txt'), 'a2\n', 'untouched, not half-restored');
    assert.equal(tracker.changes().length, 1, 'still reported as changed');
    await tracker.dispose();
  } finally {
    scratch.restore();
  }
});

async function stores(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('polaris-checkpoints-'));
}

/** Points the OS temp directory at a private one, so the store can be inspected. */
async function useScratchTemp(): Promise<{ dir: string; restore: () => void }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'polaris-store-')));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: dir, TMP: dir, TMPDIR: dir });
  return {
    dir,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// -------------------------------------------------------------- checkpoints

test('a file too large to copy refuses the checkpoint instead of faking it', async () => {
  const repo = await makeRepo({ 'small.txt': 's\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, () =>
    writeFiles(repo, { 'huge.bin': 'x'.repeat(MAX_SNAPSHOT_FILE_BYTES + 1) }),
  );
  await assert.rejects(tracker.checkpoint(), /Cannot checkpoint huge\.bin/);
  assert.deepEqual(
    tracker.checkpoints.map((item) => item.id),
    ['cp-1'],
  );
  // It is still known and still undoable: its original was "no file".
  await undoAll(tracker);
  assert.equal(await exists(repo, 'huge.bin'), false);
  await tracker.dispose();
});

test('checkpoint copies live in a temporary store that is removed at the end', async () => {
  const scratch = await useScratchTemp();
  try {
    const repo = await makeRepo({ 'a.txt': 'a\n' });
    const tracker = await ChangeTracker.start(repo);
    await turn(tracker, () => writeFiles(repo, { 'a.txt': 'a2\n' }));
    await tracker.checkpoint();
    const found = await stores(scratch.dir);
    assert.equal(found.length, 1, 'one store for the session');
    // a.txt's original is the commit, so only the checkpoint's version is copied.
    assert.equal((await readdir(join(scratch.dir, found[0] as string))).length, 1);

    await tracker.dispose();
    assert.deepEqual(await stores(scratch.dir), []);
    // The repository never saw any of it: no stash, no new commit.
    assert.equal(await exists(repo, '.git/refs/stash'), false);
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '1');
  } finally {
    scratch.restore();
  }
});

// ------------------------------------------------------------ outside Git

test('outside Git, files announced by tools are still tracked and undoable', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'polaris-plain-')));
  await writeFiles(dir, { 'a.txt': 'a\n', 'mine.txt': 'user\n' });
  const tracker = await ChangeTracker.start(dir);
  assert.equal(tracker.git, null);

  await turn(tracker, async () => {
    await tracker.capture(['a.txt', join(dir, 'b.txt')]);
    await writeFiles(dir, { 'a.txt': 'a2\n', 'b.txt': 'b\n' });
  });
  assert.deepEqual(
    tracker.changes().map((change) => [change.path, change.kind]),
    [
      ['a.txt', 'modified'],
      ['b.txt', 'created'],
    ],
  );
  await undoAll(tracker);
  assert.equal(await read(dir, 'a.txt'), 'a\n');
  assert.equal(await exists(dir, 'b.txt'), false);
  assert.equal(await read(dir, 'mine.txt'), 'user\n');
  await tracker.dispose();
});

test('a gitignored file a tool announced is tracked through its capture', async () => {
  const repo = await makeRepo({ '.gitignore': 'dist/\n' });
  await mkdir(join(repo, 'dist'));
  await writeFile(join(repo, 'dist/out.js'), 'old build\n');
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, async () => {
    await tracker.capture(['dist/out.js']);
    await writeFile(join(repo, 'dist/out.js'), 'new build\n');
  });
  assert.deepEqual(
    tracker.changes().map((change) => change.path),
    ['dist/out.js'],
  );
  await undoAll(tracker);
  assert.equal(await read(repo, 'dist/out.js'), 'old build\n');
  await tracker.dispose();
});

test('the session diff is against the original, and binaries are not printed', async () => {
  const repo = await makeRepo({ 'a.ts': 'one\ntwo\n' });
  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, async () => {
    await writeFiles(repo, { 'a.ts': 'one\nTWO\nthree\n' });
    await writeFile(join(repo, 'image.png'), Buffer.from([0x89, 0x50, 0, 1, 2]));
  });
  const [text, binary] = await Promise.all(tracker.changes().map((change) => tracker.diff(change)));
  assert.equal(text?.path, 'a.ts');
  assert.equal(text?.added, 2);
  assert.equal(text?.removed, 1);
  assert.match(text?.text ?? '', /-two\n\+TWO\n\+three/);
  assert.equal(binary?.text, 'Binary file changed.');
  await tracker.dispose();
});

test('undo restores the exact bytes on disk, even when checkout would write other line endings', async () => {
  const repo = await makeRepo({ 'README.md': 'readme\n' });
  git(repo, 'config', 'core.autocrlf', 'true');
  // Written with LF, committed; a checkout here would produce CRLF.
  await writeFile(join(repo, 'greet.txt'), 'hello world\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'greet');
  const before = await readFile(join(repo, 'greet.txt'));

  const tracker = await ChangeTracker.start(repo);
  await turn(tracker, async () => {
    await tracker.capture(['greet.txt']);
    await writeFile(join(repo, 'greet.txt'), 'hola world\n');
  });
  await undoAll(tracker);
  assert.deepEqual(await readFile(join(repo, 'greet.txt')), before, 'byte for byte');
  await tracker.dispose();
});
