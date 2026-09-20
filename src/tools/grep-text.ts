import { readFile as readFileContents, realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { validPattern } from './glob-files.ts';
import { MAX_FILE_BYTES, MAX_GREP_RESULTS, MAX_LINE_CHARS, MAX_PATTERN_LENGTH } from './limits.ts';
import type { ToolDefinition } from './registry.ts';
import { isBinary, walkFiles } from './walk.ts';
import { ToolError } from './workspace.ts';

export interface GrepInput {
  readonly pattern: string;
  readonly glob: string | undefined;
  readonly caseSensitive: boolean;
  readonly regex: boolean;
}

export const grepText: ToolDefinition<GrepInput> = {
  name: 'grep_text',
  title: 'Grep',
  capability: 'read',
  description:
    'Search file contents in the workspace. Literal text by default; set regex to true for a ' +
    'JavaScript regular expression. Optionally restrict files with a glob. Returns ' +
    `"path:line: text" for at most ${MAX_GREP_RESULTS} matching lines. Binary files and files ` +
    `over ${MAX_FILE_BYTES / (1024 * 1024)} MB are skipped.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text (or regular expression) to search for.' },
      glob: {
        type: 'string',
        description: 'Only search files matching this glob, e.g. "src/**/*.ts".',
      },
      caseSensitive: { type: 'boolean', description: 'Match case exactly (default true).' },
      regex: {
        type: 'boolean',
        description: 'Treat pattern as a regular expression (default false).',
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  parse(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.pattern !== 'string' || value.pattern === '') {
      throw new ToolError('pattern must be a non-empty string.');
    }
    if (value.pattern.length > MAX_PATTERN_LENGTH) {
      throw new ToolError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters.`);
    }
    return {
      pattern: value.pattern,
      glob: value.glob === undefined ? undefined : validPattern(value.glob),
      caseSensitive: value.caseSensitive !== false,
      regex: value.regex === true,
    };
  },

  target: (input) => `"${input.pattern}"${input.glob ? ` in ${input.glob}` : ''}`,

  async execute(input, { cwd, signal }) {
    const matches = matcher(input);
    const root = await realpath(cwd);
    const results: string[] = [];
    const filesWithMatches = new Set<string>();
    let skippedLarge = 0;
    let truncated = false;

    search: for await (const file of walkFiles(root, signal)) {
      if (input.glob && !posix.matchesGlob(file.relative, input.glob)) continue;

      const info = await stat(file.absolute).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      if (info.size === 0 || (await isBinary(file.absolute).catch(() => true))) continue;

      // One file in memory at a time, never the whole repository.
      const text = await readFileContents(file.absolute, {
        encoding: 'utf8',
        ...(signal ? { signal } : {}),
      }).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (text === null) continue;

      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        // Bounding the searched text bounds the worst case of a bad regex.
        const line = (lines[index] ?? '').slice(0, MAX_LINE_CHARS);
        if (!matches(line)) continue;
        if (results.length === MAX_GREP_RESULTS) {
          truncated = true;
          break search;
        }
        results.push(`${file.relative}:${index + 1}: ${line.trim()}`);
        filesWithMatches.add(file.relative);
      }
      signal?.throwIfAborted();
    }

    const lines = results.length === 0 ? ['No matches found.'] : [...results];
    if (truncated) lines.push(`[Showing first ${MAX_GREP_RESULTS} matches. Result truncated.]`);
    if (skippedLarge > 0) lines.push(`[${skippedLarge} large file(s) skipped.]`);

    const count = `${results.length}${truncated ? '+' : ''}`;
    return {
      content: lines.join('\n'),
      summary:
        results.length === 0
          ? 'no matches'
          : `${count} ${results.length === 1 ? 'match' : 'matches'} in ${filesWithMatches.size} ${filesWithMatches.size === 1 ? 'file' : 'files'}`,
      metadata: {
        pattern: input.pattern,
        matches: results.length,
        files: filesWithMatches.size,
        truncated,
        skippedLarge,
      },
    };
  },
};

/**
 * Literal search never touches the regex engine. A regex is compiled once and
 * only ever run against lines capped at MAX_LINE_CHARS, which limits — but does
 * not eliminate — catastrophic backtracking from a pathological pattern.
 */
function matcher(input: GrepInput): (line: string) => boolean {
  if (input.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(input.pattern, input.caseSensitive ? 'u' : 'iu');
    } catch (error) {
      throw new ToolError(`Invalid regular expression: ${(error as Error).message}`);
    }
    return (line) => expression.test(line);
  }
  if (input.caseSensitive) return (line) => line.includes(input.pattern);
  const needle = input.pattern.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}
