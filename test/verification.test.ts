import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCheck, Verifier } from '../src/core/verification.ts';
import { workspaceLabel } from '../src/ui/layout.ts';

test('edit, then a passing check: verified', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', 'npm test');
  assert.equal(verifier.state(true), 'verifying');
  verifier.finished('1', 'passed', 0);
  assert.equal(verifier.state(true), 'verified');
});

test('edit, pass, edit again: the pass is stale and nothing is verified', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', './gradlew test');
  verifier.finished('1', 'passed', 0);
  verifier.mutated();
  assert.equal(verifier.state(true), 'unverified');
  const { current, stale } = verifier.checks();
  assert.deepEqual(current, []);
  assert.deepEqual(
    stale.map((run) => run.command),
    ['./gradlew test'],
  );
});

test('a failing check fails verification, and a later pass of it recovers', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', 'pytest');
  verifier.finished('1', 'failed', 1);
  assert.equal(verifier.state(true), 'failed');
  verifier.started('2', 'pytest');
  verifier.finished('2', 'passed', 0);
  assert.equal(verifier.state(true), 'verified', 'the latest run of a command is what counts');
});

test('one failing check is enough, whatever else passed', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', 'npm test');
  verifier.finished('1', 'failed', 1);
  verifier.started('2', 'npm run lint');
  verifier.finished('2', 'passed', 0);
  assert.equal(verifier.state(true), 'failed');
});

test('a cancelled check leaves verification incomplete', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', 'cargo test');
  verifier.cancelRunning();
  assert.equal(verifier.state(true), 'incomplete');
});

test('a refused check never ran, so it is not a failure', () => {
  const verifier = new Verifier();
  verifier.mutated();
  verifier.started('1', 'go test ./...');
  verifier.finished('1', 'denied');
  assert.equal(verifier.state(true), 'unverified');
  assert.equal(verifier.state(false), 'none');
});

test('only commands that check something count as checks', () => {
  for (const command of [
    'npm test',
    'npm run typecheck',
    './gradlew test',
    'mvn verify',
    'pytest -q',
    'go test ./...',
    'cargo clippy',
    'npx tsc --noEmit',
    'npx biome check src',
  ]) {
    assert.equal(isCheck(command), true, command);
  }
  for (const command of ['git status', 'ls -la', 'node script.js', 'dir']) {
    assert.equal(isCheck(command), false, command);
  }
  const verifier = new Verifier();
  assert.equal(verifier.started('1', 'git status'), false);
  assert.deepEqual(verifier.checks().current, []);
});

// --------------------------------------------------------------- status bar

const workspace = (
  overrides: Partial<Parameters<typeof workspaceLabel>[0]> = {},
): Parameters<typeof workspaceLabel>[0] => ({
  git: { branch: 'main', head: 'abc' },
  changed: 0,
  preexisting: 0,
  verification: 'none',
  ...overrides,
});

test('the bar shows the branch, how many files changed, and the verification state', () => {
  assert.equal(workspaceLabel(workspace()), 'main');
  assert.equal(
    workspaceLabel(workspace({ changed: 2, verification: 'unverified' })),
    'main +2 · unverified',
  );
  assert.equal(
    workspaceLabel(workspace({ changed: 2, verification: 'verifying' })),
    'main +2 · verifying',
  );
  assert.equal(
    workspaceLabel(workspace({ changed: 2, verification: 'verified' })),
    'main +2 · verified',
  );
  assert.equal(
    workspaceLabel(workspace({ changed: 1, verification: 'failed' })),
    'main +1 · checks failed',
  );
  assert.equal(
    workspaceLabel(workspace({ git: { branch: null, head: 'abc' }, changed: 1 })),
    'detached +1',
  );
  assert.equal(workspaceLabel(workspace({ git: null })), '', 'nothing to say outside Git');
  assert.equal(
    workspaceLabel(workspace({ git: null, changed: 3, verification: 'unverified' })),
    '+3 · unverified',
  );
});
