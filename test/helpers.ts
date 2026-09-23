import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ContextManager, type SessionContext } from '../src/context/manager.ts';
import { PermissionGate } from '../src/permissions/gate.ts';
import { DEFAULT_PROFILE, type PermissionProfile } from '../src/permissions/policy.ts';
import type { ProviderSessionOptions, ToolAccess } from '../src/providers/provider.ts';

/**
 * The two options every provider session now needs, filled in for tests that
 * are about something else. Pass a handler to answer approvals, or leave it
 * out and every `ask` is a denial — the gate's own behaviour with no UI.
 */
export function testSession(
  cwd: string,
  options: {
    permissions?: PermissionProfile;
    gate?: PermissionGate;
    model?: string;
    effort?: string;
  } = {},
): ProviderSessionOptions {
  const permissions = options.permissions ?? DEFAULT_PROFILE;
  return {
    cwd,
    permissions,
    gate: options.gate ?? new PermissionGate(permissions),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}

/** A gate that answers every approval the same way, without a UI. */
export function autoGate(
  profile: PermissionProfile,
  answer: 'allow' | 'deny',
): { gate: PermissionGate; asked: string[] } {
  const gate = new PermissionGate(profile);
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(`${request.title} ${request.target}`);
    return answer;
  });
  return { gate, asked };
}

export const TEST_ACCESS: ToolAccess = {
  mode: 'read-only',
  runtime: 'Test runtime',
  tools: ['Read'],
};

export { PERMISSION_PROFILES } from '../src/permissions/policy.ts';

/** Runs Git in a test fixture. Tests only ever point it at throwaway directories. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * A throwaway repository on branch `main` with one commit holding `files`.
 * Line-ending conversion is off so the bytes on disk are the bytes committed.
 */
export async function makeRepo(files: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'polaris-git-')));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'polaris@example.invalid');
  git(dir, 'config', 'user.name', 'Polaris Test');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'commit.gpgsign', 'false');
  await writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/**
 * A project with POLARIS.md ("PROJECT-RULE") and one skill, `testing`, whose
 * body is "TESTING-BODY" — for checking what reaches each provider.
 */
export async function skillContext(): Promise<{
  manager: ContextManager;
  session: SessionContext;
  workspace: string;
}> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'polaris-skills-')));
  await writeFiles(workspace, {
    'POLARIS.md': 'PROJECT-RULE\n',
    '.polaris/skills/testing/SKILL.md':
      '---\nname: testing\ndescription: Write and run tests.\n---\nTESTING-BODY\n',
    '.polaris/skills/testing/references/patterns.md': 'PATTERNS-REFERENCE\n',
  });
  const manager = new ContextManager({
    workspace,
    boundary: null,
    home: join(workspace, 'no-home'),
  });
  await manager.reloadProject();
  await manager.reloadSkills();
  return { manager, session: manager.session(), workspace };
}
