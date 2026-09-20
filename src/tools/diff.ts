import { createTwoFilesPatch } from 'diff';
import { MAX_DIFF_LINES } from './limits.ts';

/**
 * Change previews. The diff exists so a person can decide, not so a patch can
 * be applied — Polaris always writes the new content directly — so it is
 * produced by `diff` (jsdiff) rather than a hand-rolled LCS, and truncated for
 * the eye rather than for a parser.
 */

export interface DiffStat {
  readonly added: number;
  readonly removed: number;
}

/** Unified diff of a change to an existing file, without the file headers. */
export function unifiedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(path, path, before, after, undefined, undefined, {
    context: 3,
  });
  // The first four lines are the `===`/`---`/`+++` preamble, which repeats the
  // path the UI already shows.
  return patch.split('\n').slice(4).join('\n').trimEnd();
}

/** A new file shown as all-additions, in the same shape as a diff. */
export function newFileDiff(content: string): string {
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line) => `+${line}`).join('\n');
}

export function diffStat(before: string, after: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff('f', before, after).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return { added, removed };
}

/**
 * Cuts a preview to something a terminal can show, keeping the head — where a
 * change usually starts — and saying plainly how much was left out, so nobody
 * approves a change believing they saw all of it.
 */
export function truncateDiff(diff: string, max = MAX_DIFF_LINES): string {
  const lines = diff.split('\n');
  if (lines.length <= max) return diff;
  const hidden = lines.length - max;
  return [...lines.slice(0, max), `… preview truncated, ${hidden} more diff lines`].join('\n');
}
