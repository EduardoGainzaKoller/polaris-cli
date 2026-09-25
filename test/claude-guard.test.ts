import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { PermissionGate } from '../src/permissions/gate.ts';
import type { PermissionProfile } from '../src/permissions/policy.ts';
import { authorizeTask } from '../src/permissions/task.ts';
import {
  type ClaudeDecisions,
  permissionBridge,
  workspaceGuard,
} from '../src/providers/claude/tools.ts';

let workspace: string;
let outside: string;

before(async () => {
  const base = await mkdtemp(join(tmpdir(), 'polaris-guard-'));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'src', 'main.ts'), 'x\n');
  await writeFile(join(outside, 'secret.txt'), 'secret\n');
  await symlink(
    outside,
    join(workspace, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
});

async function decide(
  toolName: string,
  toolInput: unknown,
  profile: PermissionProfile = 'read-only',
): Promise<string> {
  const output = (await workspaceGuard(workspace, profile)(
    {
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'toolu_x',
      session_id: 'session',
      transcript_path: '',
      cwd: workspace,
    } as never,
    'toolu_x',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return output.hookSpecificOutput?.permissionDecision ?? 'pass';
}

test('reads inside the workspace pass through to the runtime', async () => {
  assert.equal(await decide('Read', { file_path: join(workspace, 'src', 'main.ts') }), 'pass');
  assert.equal(await decide('Read', { file_path: 'src/main.ts' }), 'pass');
  assert.equal(await decide('Glob', { pattern: '**/*.ts' }), 'pass');
  assert.equal(await decide('Grep', { pattern: 'x', path: 'src' }), 'pass');
});

test('paths outside the workspace are denied, symlinks and junctions included', async () => {
  assert.equal(await decide('Read', { file_path: join(outside, 'secret.txt') }), 'deny');
  assert.equal(await decide('Read', { file_path: '../outside/secret.txt' }), 'deny');
  assert.equal(await decide('Read', { file_path: 'external/secret.txt' }), 'deny');
  assert.equal(await decide('Grep', { pattern: 'x', path: outside }), 'deny');
  assert.equal(await decide('Glob', { pattern: join(outside, '*') }), 'deny');
});

test('under read-only, no file change exists; Bash reaches the policy, which allows only inspection', async () => {
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Agent', 'mcp__x__y']) {
    assert.equal(await decide(tool, {}), 'deny', `${tool} must be denied`);
  }
  // Safe Git inspection is reading; the permission callback denies the rest.
  assert.equal(await decide('Bash', { command: 'git status' }), 'pass');
});

test('the profile decides which mutating tools reach the runtime at all', async () => {
  // Under ask the tools exist (the approval, not the hook, is what gates them);
  // under read-only the hook removes them outright.
  for (const tool of ['Write', 'Edit', 'Bash']) {
    assert.equal(await decide(tool, {}, 'smart'), 'pass', `${tool} must exist under smart`);
  }
  for (const tool of ['Write', 'Edit']) {
    assert.equal(await decide(tool, {}, 'read-only'), 'deny', `${tool} must not exist read-only`);
  }
  // Out of scope for v0.6 whatever the profile says.
  for (const tool of ['NotebookEdit', 'WebFetch', 'Agent', 'mcp__x__y']) {
    assert.equal(await decide(tool, {}, 'workspace-write'), 'deny', `${tool} must be denied`);
  }
});

test('a write outside the workspace is denied even under workspace-write', async () => {
  assert.equal(
    await decide('Write', { file_path: join(outside, 'x.txt') }, 'workspace-write'),
    'deny',
  );
  assert.equal(await decide('Write', { file_path: '../outside/x.txt' }, 'workspace-write'), 'deny');
  assert.equal(
    await decide('Edit', { file_path: 'external/secret.txt' }, 'workspace-write'),
    'deny',
  );
});

test('only Polaris’s own skill tools pass as MCP; any other server’s tool is denied', async () => {
  assert.equal(await decide('mcp__polaris__load_skill', { name: 'testing' }), 'pass');
  assert.equal(
    await decide('mcp__polaris__read_skill_reference', { skill: 'x', path: 'references/y.md' }),
    'pass',
  );
  assert.equal(await decide('mcp__filesystem__write_file', { path: '/etc/passwd' }), 'deny');
  assert.equal(await decide('mcp__polaris__something_else', {}), 'deny');
});

// ----------------------------------------------- the policy, in the hook

/**
 * The runtime approves some commands itself (`ls`, `find`, even compound
 * `git status && …`) without calling canUseTool — so the hook, which runs for
 * every call, is where Polaris's policy must decide.
 */
async function hooked(
  command: string,
  answer: 'allow' | 'deny',
  decisions: ClaudeDecisions = new Map(),
) {
  const gate = new PermissionGate('smart', { workspace });
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(request.target);
    return answer;
  });
  gate.beginTask(authorizeTask('Analyze the project.', null));
  const output = (await workspaceGuard(
    workspace,
    'smart',
    gate,
    decisions,
  )(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'toolu_1',
      session_id: 'session',
      transcript_path: '',
      cwd: workspace,
    } as never,
    'toolu_1',
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  return { decision: output.hookSpecificOutput?.permissionDecision, asked, gate, decisions };
}

test('commands the runtime would auto-approve still go through Polaris’s policy', async () => {
  for (const command of [
    'find src -type f',
    'git status && echo x && git diff',
    'cat ../outside/secret.txt',
  ]) {
    const { decision, asked } = await hooked(command, 'deny');
    assert.equal(decision, 'deny', command);
    assert.deepEqual(asked, [command], `${command} was put to the user`);
  }
  const safe = await hooked('ls -la', 'deny');
  assert.equal(safe.decision, 'allow');
  assert.deepEqual(safe.asked, [], 'safe inspection is not a question');
});

test('the permission callback reuses the hook’s decision instead of asking again', async () => {
  const { decision, asked, gate, decisions } = await hooked('npm test', 'allow');
  assert.equal(decision, 'allow');
  const bridge = permissionBridge(workspace, gate, decisions);
  const result = await bridge('Bash', { command: 'npm test' }, {
    signal: new AbortController().signal,
    toolUseID: 'toolu_1',
  } as never);
  assert.equal(result.behavior, 'allow');
  assert.deepEqual(asked, ['npm test'], 'asked once, not twice');
});
