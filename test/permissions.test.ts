import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DENIED_BY_USER, PermissionGate } from '../src/permissions/gate.ts';
import {
  type Capability,
  DEFAULT_PROFILE,
  decide,
  isAvailable,
  isProfile,
  type PermissionProfile,
} from '../src/permissions/policy.ts';

const CAPABILITIES: Capability[] = ['read', 'write', 'edit', 'command'];

/**
 * The policy is a table, so the test is a table. Every cell is stated once,
 * here, and nowhere else: if a profile ever quietly widens, this fails.
 */
const EXPECTED: Record<PermissionProfile, Record<Capability, string>> = {
  'read-only': { read: 'allow', write: 'deny', edit: 'deny', command: 'deny' },
  ask: { read: 'allow', write: 'ask', edit: 'ask', command: 'ask' },
  'workspace-write': { read: 'allow', write: 'allow', edit: 'allow', command: 'ask' },
};

test('each profile decides every capability exactly as documented', () => {
  for (const [profile, row] of Object.entries(EXPECTED)) {
    for (const capability of CAPABILITIES) {
      assert.equal(
        decide(profile as PermissionProfile, capability),
        row[capability],
        `${profile} / ${capability}`,
      );
    }
  }
});

test('commands never run unasked, in any profile', () => {
  // The one rule v0.6 refuses to relax: a command is not bounded by the
  // workspace the way a file write is.
  for (const profile of Object.keys(EXPECTED) as PermissionProfile[]) {
    assert.notEqual(decide(profile, 'command'), 'allow', profile);
  }
});

test('the default profile asks rather than allowing', () => {
  assert.equal(DEFAULT_PROFILE, 'ask');
});

test('a denied capability is unavailable, an asked one is available', () => {
  assert.equal(isAvailable('read-only', 'write'), false);
  assert.equal(isAvailable('ask', 'write'), true);
  assert.equal(isAvailable('workspace-write', 'command'), true);
});

test('only the three known profiles are profiles', () => {
  assert.ok(isProfile('ask'));
  assert.ok(isProfile('read-only'));
  assert.ok(isProfile('workspace-write'));
  for (const wrong of ['full-access', 'yolo', 'ASK', '', 'workspace_write']) {
    assert.equal(isProfile(wrong), false, wrong);
  }
});

// ------------------------------------------------------------------- the gate

const CALL = { title: 'Edit', target: 'src/a.ts' };

test('an allowed capability never reaches the user', async () => {
  const gate = new PermissionGate('workspace-write');
  let asked = 0;
  gate.onApproval(async () => {
    asked += 1;
    return 'allow';
  });

  assert.deepEqual(await gate.authorize('edit', CALL), { allowed: true });
  assert.equal(asked, 0, 'an automatic allow is not a question');
});

test('a denied capability is refused without asking, and says why', async () => {
  const gate = new PermissionGate('read-only');
  gate.onApproval(async () => 'allow');

  const verdict = await gate.authorize('edit', CALL);
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /read-only/);
});

test('an ask is answered by the user, either way', async () => {
  const gate = new PermissionGate('ask');
  const seen: string[] = [];
  gate.onApproval(async (request) => {
    seen.push(`${request.capability}:${request.title}:${request.target}`);
    return request.capability === 'command' ? 'deny' : 'allow';
  });

  assert.deepEqual(await gate.authorize('edit', CALL), { allowed: true });
  const refused = await gate.authorize('command', { title: 'Run', target: 'npm test' });
  assert.equal(refused.allowed, false);
  assert.equal((refused as { reason: string }).reason, DENIED_BY_USER);
  assert.deepEqual(seen, ['edit:Edit:src/a.ts', 'command:Run:npm test']);
});

test('with nobody to ask, an ask is a denial rather than a wait', async () => {
  const gate = new PermissionGate('ask');
  const verdict = await gate.authorize('write', CALL);
  assert.equal(verdict.allowed, false);
  assert.match((verdict as { reason: string }).reason, /no approval surface/i);
});

test('changing the profile changes later decisions, not earlier ones', async () => {
  const gate = new PermissionGate('read-only');
  assert.equal((await gate.authorize('edit', CALL)).allowed, false);

  gate.profile = 'workspace-write';
  assert.equal((await gate.authorize('edit', CALL)).allowed, true);
});

test('several approvals can be open at once and are answered independently', async () => {
  const gate = new PermissionGate('ask');
  const pending: Array<(decision: 'allow' | 'deny') => void> = [];
  gate.onApproval(
    () =>
      new Promise<'allow' | 'deny'>((resolve) => {
        pending.push(resolve);
      }),
  );

  const first = gate.authorize('write', { title: 'Write', target: 'a.ts' });
  const second = gate.authorize('command', { title: 'Run', target: 'npm test' });
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(pending.length, 2);
  assert.equal(gate.busy, true);
  pending[1]?.('deny');
  pending[0]?.('allow');

  assert.equal((await first).allowed, true);
  assert.equal((await second).allowed, false);
  assert.equal(gate.busy, false);
});

test('each request carries its own id', async () => {
  const gate = new PermissionGate('ask');
  const ids: string[] = [];
  gate.onApproval(async (request) => {
    ids.push(request.id);
    return 'deny';
  });
  await gate.authorize('write', CALL);
  await gate.authorize('write', CALL);
  assert.equal(new Set(ids).size, 2);
});

test('an already cancelled turn never opens an approval', async () => {
  const gate = new PermissionGate('ask');
  let asked = false;
  gate.onApproval(async () => {
    asked = true;
    return 'allow';
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => gate.authorize('write', CALL, controller.signal));
  assert.equal(asked, false);
});
