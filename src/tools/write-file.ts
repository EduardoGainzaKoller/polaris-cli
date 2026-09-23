import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { diffStat, newFileDiff, truncateDiff, unifiedDiff } from './diff.ts';
import { MAX_WRITE_BYTES } from './limits.ts';
import type { ToolDefinition } from './registry.ts';
import { displayPath, resolveInWorkspace, ToolError } from './workspace.ts';

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
}

export const writeFileTool: ToolDefinition<WriteFileInput> = {
  name: 'write_file',
  title: 'Write',
  capability: 'write',
  description:
    'Create a file, or replace an existing file, inside the workspace. Writes UTF-8 text and ' +
    'creates missing parent directories. To change part of a file, prefer edit_file.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },

  parse(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.path !== 'string' || value.path.trim() === '') {
      throw new ToolError('path must be a non-empty string.');
    }
    if (typeof value.content !== 'string') throw new ToolError('content must be a string.');
    if (Buffer.byteLength(value.content, 'utf8') > MAX_WRITE_BYTES) {
      throw new ToolError(`content is larger than the ${MAX_WRITE_BYTES} byte write limit.`);
    }
    return { path: value.path, content: value.content };
  },

  target: (input) => input.path,

  /**
   * What the user is asked to approve: the diff against what is on disk, or
   * the whole file when it is new. Reading here — before the approval — is
   * also what makes the re-check in `execute` meaningful.
   */
  async preview(input, { cwd }) {
    const file = await resolveInWorkspace(cwd, input.path);
    const root = await realpath(cwd);
    const path = displayPath(root, file);
    const before = await readIfExists(file);
    const lines = countLines(input.content);

    if (before === null) {
      const parents = relative(dirname(root), dirname(file)).split(/[\\/]/).length > 1;
      return {
        facts: [
          `New file · ${lines} ${lines === 1 ? 'line' : 'lines'}`,
          ...(parents && !(await exists(dirname(file))) ? ['Creates parent directories'] : []),
        ],
        diff: truncateDiff(newFileDiff(input.content)),
        // "Absent" is a state like any other: approving the creation of a new
        // file is not approval to overwrite one that appeared meanwhile.
        fingerprint: hash(null),
      };
    }
    const { added, removed } = diffStat(before, input.content);
    return {
      facts: [`Replaces ${countLines(before)} lines · +${added} -${removed}`],
      diff: truncateDiff(unifiedDiff(path, before, input.content)),
      fingerprint: hash(before),
    };
  },

  async execute(input, { cwd, signal, fingerprint }) {
    signal?.throwIfAborted();
    const file = await resolveInWorkspace(cwd, input.path);
    const root = await realpath(cwd);
    const path = displayPath(root, file);

    const before = await readIfExists(file);
    // The file may have moved under us while the approval was open — an IDE
    // saving, another agent, the user. What was approved is a specific change
    // to specific content, so a change here voids it.
    if (fingerprint !== undefined && hash(before) !== fingerprint) {
      throw new ToolError(
        `${path} changed while the approval was open. Read it again and repeat the write.`,
      );
    }

    await mkdir(dirname(file), { recursive: true });
    await writeAtomically(file, input.content);
    signal?.throwIfAborted();

    const created = before === null;
    const lines = countLines(input.content);
    const bytes = Buffer.byteLength(input.content, 'utf8');
    const { added, removed } = created
      ? { added: lines, removed: 0 }
      : diffStat(before, input.content);

    return {
      content: created
        ? `Created ${path} (${lines} lines).`
        : `Wrote ${path} (${lines} lines, +${added} -${removed}).`,
      summary: created ? `created · ${lines} lines` : `+${added} -${removed}`,
      metadata: { path, created, bytes, lines, linesAdded: added, linesRemoved: removed },
    };
  },
};

/**
 * Write to a sibling temp file and rename over the target, so a crash or a
 * full disk never leaves a half-written source file behind. The rename is
 * atomic on POSIX; on Windows it fails when the target exists, so the target
 * is removed first — a smaller window than writing in place, which is all
 * this is meant to buy. Anything more is a transaction log.
 */
export async function writeAtomically(file: string, content: string | Uint8Array): Promise<void> {
  const temporary = `${file}.polaris-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    if (process.platform === 'win32' && (await exists(file))) await unlink(file);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** null hashes to a distinct value, so "absent" and "empty" are not the same state. */
export function hash(content: string | null): string {
  if (content === null) return 'absent';
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}
