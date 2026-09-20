import { realpath } from 'node:fs/promises';
import { diffStat, truncateDiff, unifiedDiff } from './diff.ts';
import type { ToolDefinition } from './registry.ts';
import { displayPath, resolveInWorkspace, ToolError } from './workspace.ts';
import { countLines, hash, readIfExists, writeAtomically } from './write-file.ts';

export interface EditFileInput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly all: boolean;
}

export const editFileTool: ToolDefinition<EditFileInput> = {
  name: 'edit_file',
  title: 'Edit',
  capability: 'edit',
  description:
    'Replace an exact stretch of text in a workspace file. oldText must appear exactly once, ' +
    'so include enough surrounding lines to make it unique. Set all to true to replace every ' +
    'occurrence deliberately. Read the file first: oldText must match byte for byte.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      oldText: { type: 'string', description: 'The exact text to replace.' },
      newText: { type: 'string', description: 'The text to put in its place.' },
      all: {
        type: 'boolean',
        description: 'Replace every occurrence instead of failing on an ambiguous match.',
      },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },

  parse(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.path !== 'string' || value.path.trim() === '') {
      throw new ToolError('path must be a non-empty string.');
    }
    if (typeof value.oldText !== 'string' || value.oldText.length === 0) {
      throw new ToolError('oldText must be a non-empty string.');
    }
    if (typeof value.newText !== 'string') throw new ToolError('newText must be a string.');
    if (value.all !== undefined && typeof value.all !== 'boolean') {
      throw new ToolError('all must be a boolean.');
    }
    if (value.oldText === value.newText) {
      throw new ToolError('oldText and newText are identical; nothing would change.');
    }
    return {
      path: value.path,
      oldText: value.oldText,
      newText: value.newText,
      all: value.all === true,
    };
  },

  target: (input) => input.path,

  async preview(input, { cwd }) {
    const { path, before, after, count } = await plan(input, cwd);
    const { added, removed } = diffStat(before, after);
    return {
      facts: [
        count === 1 ? '1 occurrence' : `${count} occurrences`,
        `+${added} -${removed} · ${countLines(before)} lines in file`,
      ],
      diff: truncateDiff(unifiedDiff(path, before, after)),
      fingerprint: hash(before),
    };
  },

  async execute(input, { cwd, signal, fingerprint }) {
    signal?.throwIfAborted();
    const { file, path, before, after, count } = await plan(input, cwd);
    // Same guarantee as write_file: the approval was for this exact change to
    // this exact content. Re-reading is not enough on its own, because the new
    // read could already contain someone else's edit.
    if (fingerprint !== undefined && hash(before) !== fingerprint) {
      throw new ToolError(
        `${path} changed while the approval was open. Read it again and repeat the edit.`,
      );
    }

    await writeAtomically(file, after);
    signal?.throwIfAborted();
    const { added, removed } = diffStat(before, after);

    return {
      content: `Edited ${path}: replaced ${count} ${count === 1 ? 'occurrence' : 'occurrences'} (+${added} -${removed}).`,
      summary: `+${added} -${removed}`,
      metadata: { path, occurrences: count, linesAdded: added, linesRemoved: removed },
    };
  },
};

/**
 * Reads the file and works out the whole change without touching disk, so the
 * preview and the execution are computed by the same code and can never
 * disagree about what was approved.
 *
 * Matching is exact, never normalised: a file with CRLF line endings needs a
 * CRLF `oldText`, which the model gets for free because it read the file. A
 * tool that "helpfully" matched across line endings would silently rewrite
 * every line ending in the file.
 */
async function plan(
  input: EditFileInput,
  cwd: string,
): Promise<{ file: string; path: string; before: string; after: string; count: number }> {
  const file = await resolveInWorkspace(cwd, input.path);
  const root = await realpath(cwd);
  const path = displayPath(root, file);
  const before = await readIfExists(file);
  if (before === null) throw new ToolError(`${path} does not exist. Use write_file to create it.`);

  const count = occurrences(before, input.oldText);
  if (count === 0) {
    throw new ToolError(
      `oldText was not found in ${path}. Read the file and copy the exact text, including indentation and line endings.`,
    );
  }
  // The dangerous case is not zero matches — that is an obvious error — but a
  // model that meant one line and silently rewrote twenty-seven.
  if (count > 1 && !input.all) {
    throw new ToolError(
      `oldText matches ${count} times in ${path}. Include more surrounding context to make it unique, or pass all: true to replace every occurrence.`,
    );
  }

  const after = input.all
    ? before.split(input.oldText).join(input.newText)
    : before.replace(input.oldText, input.newText);
  return { file, path, before, after, count };
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
