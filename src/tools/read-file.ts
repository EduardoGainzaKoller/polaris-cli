import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { DEFAULT_READ_LINES, MAX_FILE_BYTES, MAX_LINE_CHARS, MAX_READ_LINES } from './limits.ts';
import type { ToolDefinition } from './registry.ts';
import { isBinary } from './walk.ts';
import { displayPath, resolveInWorkspace, ToolError } from './workspace.ts';

export interface ReadFileInput {
  readonly path: string;
  /** 1-based first line. */
  readonly offset: number;
  readonly limit: number;
  readonly ranged: boolean;
}

export const readFile: ToolDefinition<ReadFileInput> = {
  name: 'read_file',
  title: 'Read',
  capability: 'read',
  description:
    'Read a text file from the workspace. Returns numbered lines. Use offset and limit to read ' +
    `part of a large file (at most ${MAX_READ_LINES} lines per call).`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'integer', minimum: 1, description: 'First line to read (1-based).' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_READ_LINES,
        description: `Number of lines to read (default ${DEFAULT_READ_LINES}).`,
      },
    },
    required: ['path'],
    additionalProperties: false,
  },

  parse(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.path !== 'string' || value.path.trim() === '') {
      throw new ToolError('path must be a non-empty string.');
    }
    const offset = optionalInteger(value.offset, 'offset') ?? 1;
    const limit = optionalInteger(value.limit, 'limit') ?? DEFAULT_READ_LINES;
    return {
      path: value.path,
      offset: Math.max(1, offset),
      limit: Math.min(Math.max(1, limit), MAX_READ_LINES),
      ranged: value.offset !== undefined || value.limit !== undefined,
    };
  },

  target: (input) => input.path,

  async execute(input, { cwd, signal }) {
    const file = await resolveInWorkspace(cwd, input.path);
    const info = await stat(file);
    if (info.isDirectory()) throw new ToolError('Path is a directory; use glob_files to list it.');
    if (!info.isFile()) throw new ToolError('Path is not a regular file.');
    if (await isBinary(file)) throw new ToolError('Binary file cannot be read as text.');
    if (info.size > MAX_FILE_BYTES && !input.ranged) {
      throw new ToolError(
        `File is too large to read completely (${megabytes(info.size)} MB). Use offset and limit to read a line range.`,
      );
    }

    const first = input.offset;
    const last = input.offset + input.limit - 1;
    const numbered: string[] = [];
    let lineNumber = 0;
    let reachedEnd = true;

    // Streamed line by line, so a range deep inside a huge file never loads
    // the whole file. `crlfDelay: Infinity` treats \r\n as one line break.
    const lines = createInterface({
      input: createReadStream(file, { encoding: 'utf8', ...(signal ? { signal } : {}) }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber < first) continue;
      if (lineNumber > last) {
        reachedEnd = false;
        break;
      }
      numbered.push(format(lineNumber, line, last));
    }
    lines.close();

    const root = await realpath(cwd);
    const path = displayPath(root, file);
    const shown = numbered.length;
    const endLine = shown > 0 ? first + shown - 1 : 0;

    if (lineNumber > 0 && first > lineNumber) {
      throw new ToolError(`offset ${first} is past the end of the file (${lineNumber} lines).`);
    }

    const notes: string[] = [];
    if (!reachedEnd) {
      notes.push(
        `[Showing lines ${first}-${endLine}. More lines follow; use offset ${endLine + 1} to continue.]`,
      );
    }
    const body = shown === 0 ? '(empty file)' : numbered.join('\n');

    return {
      content: [body, ...notes].join('\n'),
      summary: shown === 1 ? '1 line' : `${shown} lines${reachedEnd ? '' : ' (partial)'}`,
      metadata: {
        path,
        startLine: shown > 0 ? first : 0,
        endLine,
        lines: shown,
        ...(reachedEnd ? { totalLines: lineNumber } : {}),
        truncated: !reachedEnd,
      },
    };
  },
};

function format(lineNumber: number, line: string, last: number): string {
  const width = String(last).length;
  const text =
    line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
  return `${String(lineNumber).padStart(width)} | ${text}`;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ToolError(`${name} must be an integer.`);
  }
  return value;
}

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
