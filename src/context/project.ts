import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { MAX_PROJECT_CONTEXT_BYTES } from '../tools/limits.ts';
import { isInside } from '../tools/workspace.ts';

/**
 * Persistent instructions that belong to the project, not to a conversation:
 * the `POLARIS.md` files between the workspace and the root of the Git
 * repository it lives in.
 *
 * The search stops at the repository root — never the drive root, never the
 * home directory — and outside a repository it looks at the workspace alone.
 * In a monorepo, launching in `repo/backend` reads `repo/POLARIS.md` and then
 * `repo/backend/POLARIS.md`; the nearer file comes later and takes precedence.
 *
 * Nothing else is read: not CLAUDE.md, not AGENTS.md, not any runtime's own
 * configuration. Polaris's context is explicit.
 */
export const PROJECT_FILE = 'POLARIS.md';

export interface InstructionSource {
  /** Absolute path. */
  readonly path: string;
  /** Relative to the workspace, e.g. `POLARIS.md` or `../POLARIS.md`. */
  readonly display: string;
  readonly content: string;
  readonly bytes: number;
  readonly lines: number;
  /** Higher wins: the workspace's own file has the highest. */
  readonly priority: number;
}

export interface ProjectContext {
  /** Farthest first, nearest last — the order the model reads them in. */
  readonly sources: readonly InstructionSource[];
  /** Files that exist but could not be used, with the reason. */
  readonly errors: readonly string[];
}

export const EMPTY_PROJECT: ProjectContext = { sources: [], errors: [] };

/** Reads every POLARIS.md from the workspace up to `boundary` (the Git root). */
export async function loadProjectContext(
  workspace: string,
  boundary: string | null,
): Promise<ProjectContext> {
  const directories = searchPath(workspace, boundary);
  const sources: InstructionSource[] = [];
  const errors: string[] = [];

  for (const [index, directory] of directories.entries()) {
    const path = join(directory, PROJECT_FILE);
    const display = relative(workspace, path).split(sep).join('/') || PROJECT_FILE;
    try {
      const info = await lstat(path);
      if (!info.isFile()) {
        errors.push(`${display} is not a regular file.`);
        continue;
      }
      if (info.size > MAX_PROJECT_CONTEXT_BYTES) {
        errors.push(
          `${display} exceeds the maximum supported size (${MAX_PROJECT_CONTEXT_BYTES / 1024} KB) and was not loaded.`,
        );
        continue;
      }
      const content = (await readFile(path, 'utf8')).replace(/^﻿/, '').trimEnd();
      if (content.length === 0) continue;
      sources.push({
        path,
        display,
        content,
        bytes: info.size,
        lines: content.split('\n').length,
        priority: index,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      errors.push(`${display} could not be read: ${(error as Error).message}`);
    }
  }
  return { sources, errors };
}

/**
 * The directories searched, farthest first: from the Git root down to the
 * workspace when the workspace is inside it, otherwise the workspace alone.
 */
export function searchPath(workspace: string, boundary: string | null): string[] {
  const start = resolve(workspace);
  const stop = boundary ? resolve(boundary) : null;
  if (!stop || !isInside(stop, start)) return [start];
  const directories = [start];
  let current = start;
  while (!samePath(current, stop)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    directories.push(current);
  }
  return directories.reverse();
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
