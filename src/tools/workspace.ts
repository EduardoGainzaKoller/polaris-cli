import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * A failure the model should see and can recover from (a missing file, a path
 * outside the workspace). Unlike a provider failure, it never ends the turn.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export const OUTSIDE_WORKSPACE = 'Path is outside the workspace.';

/** True when `target` is `root` or lies beneath it. Both must be absolute. */
export function isInside(root: string, target: string): boolean {
  const a = process.platform === 'win32' ? root.toLowerCase() : root;
  const b = process.platform === 'win32' ? target.toLowerCase() : target;
  const rel = relative(a, b);
  if (rel === '') return true;
  // `..foo` is a legitimate file name; only a `..` segment means escaping.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves `input` against the workspace and proves the result stays inside
 * it. The check runs twice: lexically, which rejects `..` escapes and foreign
 * absolute paths, and on the real path, which rejects symlinks and Windows
 * junctions that point out of the workspace. A string-prefix check alone
 * would pass both of the latter.
 *
 * Returns the real absolute path.
 */
export async function resolveInWorkspace(workspace: string, input: string): Promise<string> {
  const root = await realpath(workspace);
  const candidate = resolve(root, input);
  if (!isInside(root, candidate)) throw new ToolError(OUTSIDE_WORKSPACE);

  const real = await realPathOfExisting(candidate);
  if (!isInside(root, real)) throw new ToolError(OUTSIDE_WORKSPACE);
  return real;
}

/**
 * The real path of `target`, or — when it does not exist yet — of its nearest
 * existing ancestor with the remainder re-attached, so a link hidden higher up
 * the path is still resolved before the boundary check.
 */
async function realPathOfExisting(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(target);
    if (parent === target) return target;
    const realParent = await realPathOfExisting(parent);
    return resolve(realParent, relative(parent, target));
  }
}

/** Workspace-relative path with forward slashes, for model and UI alike. */
export function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === '' ? '.' : rel.split(sep).join('/');
}
