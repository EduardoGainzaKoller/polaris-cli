import { realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { MAX_GLOB_RESULTS, MAX_PATTERN_LENGTH } from './limits.ts';
import type { ToolDefinition } from './registry.ts';
import { walkFiles } from './walk.ts';
import { OUTSIDE_WORKSPACE, ToolError } from './workspace.ts';

export interface GlobInput {
  readonly pattern: string;
}

export const globFiles: ToolDefinition<GlobInput> = {
  name: 'glob_files',
  title: 'Glob',
  description:
    'List workspace files matching a glob pattern such as "**/*.ts" or "src/**/*.java". ' +
    'Paths are relative to the workspace root. .git, node_modules and anything in the root ' +
    `.gitignore are skipped. At most ${MAX_GLOB_RESULTS} results are returned.`,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern relative to the workspace root.' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },

  parse(input) {
    const pattern = (input as { pattern?: unknown } | undefined)?.pattern;
    return { pattern: validPattern(pattern) };
  },

  target: (input) => input.pattern,

  async execute({ pattern }, { cwd, signal }) {
    const root = await realpath(cwd);
    const files: string[] = [];
    let truncated = false;

    for await (const file of walkFiles(root, signal)) {
      if (!posix.matchesGlob(file.relative, pattern)) continue;
      if (files.length === MAX_GLOB_RESULTS) {
        truncated = true;
        break;
      }
      files.push(file.relative);
    }

    const lines = files.length === 0 ? ['No files matched.'] : [...files];
    if (truncated) lines.push(`[Showing first ${MAX_GLOB_RESULTS} results. Result truncated.]`);

    return {
      content: lines.join('\n'),
      summary: `${files.length}${truncated ? '+' : ''} ${files.length === 1 ? 'file' : 'files'}`,
      metadata: { pattern, files: files.length, truncated },
    };
  },
};

/**
 * Patterns are always matched against workspace-relative paths, so absolute
 * patterns and `..` segments can only mean "somewhere else" and are refused.
 */
export function validPattern(pattern: unknown): string {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new ToolError('pattern must be a non-empty string.');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new ToolError(`pattern is longer than ${MAX_PATTERN_LENGTH} characters.`);
  }
  const normalized = pattern.replaceAll('\\', '/');
  if (
    posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new ToolError(OUTSIDE_WORKSPACE);
  }
  return normalized.replace(/^\.\//, '');
}
