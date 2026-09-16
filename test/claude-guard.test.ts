import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { workspaceGuard } from '../src/providers/claude/tools.ts';

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

async function decide(toolName: string, toolInput: unknown): Promise<string> {
  const output = (await workspaceGuard(workspace)(
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

test('anything that is not Read, Glob or Grep is denied', async () => {
  for (const tool of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'Agent', 'mcp__x__y']) {
    assert.equal(await decide(tool, {}), 'deny', `${tool} must be denied`);
  }
});
