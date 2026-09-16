import type { Dirent } from 'node:fs';
import { open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ALWAYS_IGNORED, BINARY_SNIFF_BYTES } from './limits.ts';
import { displayPath, isInside } from './workspace.ts';

export interface WalkedFile {
  /** Real absolute path, already proven to be inside the workspace. */
  readonly absolute: string;
  /** Workspace-relative path with forward slashes. */
  readonly relative: string;
}

/**
 * Yields every file in the workspace in a stable order, lazily, so a search
 * can stop at its limit without listing the whole tree first.
 *
 * - `.git` and `node_modules` are always skipped.
 * - The root `.gitignore` is honoured (nested `.gitignore` files are not, yet).
 * - Symlinks are followed only when their target is a file inside the
 *   workspace; linked directories are never descended, which also rules out
 *   cycles.
 * - Unreadable directories are skipped rather than failing the whole walk.
 */
export async function* walkFiles(root: string, signal?: AbortSignal): AsyncGenerator<WalkedFile> {
  const rules = await gitignore(root);
  const pending = [root];

  while (pending.length > 0) {
    signal?.throwIfAborted();
    const directory = pending.pop() as string;

    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirectories: string[] = [];
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relative = displayPath(root, absolute);

      if (entry.isDirectory()) {
        if ((ALWAYS_IGNORED as readonly string[]).includes(entry.name)) continue;
        if (rules.ignores(`${relative}/`)) continue;
        subdirectories.push(absolute);
        continue;
      }
      if (rules.ignores(relative)) continue;

      if (entry.isFile()) {
        yield { absolute, relative };
      } else if (entry.isSymbolicLink()) {
        const target = await linkedFile(root, absolute);
        if (target) yield { absolute: target, relative };
      }
    }
    // Pushed in reverse so directories are visited in name order.
    pending.push(...subdirectories.reverse());
  }
}

/** A symlink's target when it is a regular file inside the workspace; otherwise null. */
async function linkedFile(root: string, link: string): Promise<string | null> {
  try {
    const target = await realpath(link);
    if (!isInside(root, target)) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

async function gitignore(root: string): Promise<Ignore> {
  const rules = ignore();
  try {
    rules.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch {
    // No .gitignore is the common case, not an error.
  }
  return rules;
}

/**
 * Cheap binary check: a NUL byte in the first few kilobytes. Not perfect, but
 * it reliably keeps images, archives, class files and executables out of the
 * model's context.
 */
export async function isBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
