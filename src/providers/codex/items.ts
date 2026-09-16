import type { ModelEvent, ToolAccess } from '../provider.ts';
import type { JsonObject } from './app-server.ts';

/**
 * Codex runs its own agent loop: it reads the workspace through shell commands
 * inside a read-only sandbox, not through Polaris's tools. Each such command is
 * a thread item, and the App Server already classifies what it does
 * (`commandActions`: read / listFiles / search). This module turns those items
 * into the shared tool events, so the UI shows "Read src/main.ts" rather than
 * a raw shell command.
 */

export const CODEX_TOOL_ACCESS: ToolAccess = {
  mode: 'read-only',
  runtime: 'Codex runtime',
  tools: ['read-only sandbox: read, list, search'],
};

interface CommandAction {
  type?: string;
  path?: string | null;
  query?: string | null;
  command?: string;
}

interface Item extends JsonObject {
  id?: string;
  type?: string;
}

/** Tool-like item types; agent messages, reasoning and plans are not tools. */
const TOOL_ITEMS = new Set([
  'commandExecution',
  'fileChange',
  'webSearch',
  'mcpToolCall',
  'dynamicToolCall',
]);

export function isToolItem(item: unknown): item is Item {
  const candidate = item as Item | undefined;
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.type === 'string' &&
    TOOL_ITEMS.has(candidate.type)
  );
}

export function itemStarted(item: Item, cwd: string): ModelEvent {
  const { name, target } = describe(item, cwd);
  return { type: 'tool-start', id: item.id as string, name, target };
}

export function itemCompleted(item: Item): ModelEvent {
  const id = item.id as string;
  const status = String(item.status ?? '');

  if (item.type === 'fileChange') {
    // The sandbox is read-only; a change that reached this point was refused.
    return { type: 'tool-error', id, error: 'Writes are disabled: Polaris is read-only.' };
  }
  if (status === 'declined')
    return { type: 'tool-error', id, error: 'Declined: Polaris is read-only.' };
  if (status === 'failed') return { type: 'tool-error', id, error: failure(item) };

  if (item.type === 'commandExecution') {
    const exitCode = item.exitCode;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      return { type: 'tool-error', id, error: `exit code ${exitCode}` };
    }
    return { type: 'tool-result', id, summary: commandSummary(item) };
  }
  return { type: 'tool-result', id, summary: 'done' };
}

function describe(item: Item, cwd: string): { name: string; target: string } {
  switch (item.type) {
    case 'commandExecution': {
      const { action, more } = effectiveAction(item);
      const extra = more > 0 ? ` +${more}` : '';
      if (action?.type === 'read') {
        return { name: 'Read', target: `${relative(cwd, action.path)}${extra}` };
      }
      if (action?.type === 'listFiles') {
        return { name: 'List', target: `${relative(cwd, action.path) || '.'}${extra}` };
      }
      if (action?.type === 'search') {
        const where = action.path && action.path !== '.' ? ` in ${relative(cwd, action.path)}` : '';
        return {
          name: 'Grep',
          target: `${action.query ? `"${action.query}"` : ''}${where}${extra}`,
        };
      }
      // The inner command when Codex reported one, never the shell wrapper around it.
      return { name: 'Shell', target: shorten(action?.command ?? String(item.command ?? '')) };
    }
    case 'fileChange':
      return { name: 'Edit', target: changedPaths(item, cwd) };
    case 'webSearch':
      return { name: 'Web', target: String(item.query ?? '') };
    case 'mcpToolCall':
      return { name: 'Tool', target: `${String(item.server ?? '')}/${String(item.tool ?? '')}` };
    default:
      return { name: 'Tool', target: String(item.tool ?? '') };
  }
}

function commandSummary(item: Item): string {
  const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  switch (effectiveAction(item).action?.type) {
    case 'read':
      return `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    case 'listFiles':
      return `${lines} ${lines === 1 ? 'entry' : 'entries'}`;
    case 'search':
      return lines === 0 ? 'no matches' : `${lines} ${lines === 1 ? 'match' : 'matches'}`;
    default:
      return 'done';
  }
}

/**
 * Codex's own classification when it has one. When it reports `unknown` — which
 * on Windows happens for most commands, because they run inside a PowerShell
 * wrapper — the unwrapped command it still provides is classified here. This
 * only chooses a label for the UI; the sandbox decides what may actually run.
 */
function effectiveAction(item: Item): { action: CommandAction | undefined; more: number } {
  const actions = (
    Array.isArray(item.commandActions) ? item.commandActions : []
  ) as CommandAction[];
  const [first] = actions;
  const more = Math.max(0, actions.length - 1);
  if (first?.type !== 'unknown' || !first.command) return { action: first, more };
  return { action: classify(first.command) ?? first, more };
}

/**
 * Flags that consume the following token, so it is not mistaken for a path or
 * pattern. Unix-style flags are case-sensitive (`-A` is not `-a` in rg);
 * PowerShell parameters are not, so they are kept lower-case.
 */
const UNIX_VALUE_FLAGS = new Set([
  '-g',
  '--glob',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-m',
  '--max-count',
  '-A',
  '-B',
  '-C',
  '--context',
  '--encoding',
]);
const POWERSHELL_VALUE_FLAGS = new Set([
  '-encoding',
  '-filter',
  '-include',
  '-exclude',
  '-depth',
  '-totalcount',
  '-tail',
  '-head',
  '-first',
  '-last',
  '-skip',
  '-readcount',
]);

function consumesValue(flag: string): boolean {
  const isPowerShell = flag.length > 2 && !flag.startsWith('--');
  return isPowerShell ? POWERSHELL_VALUE_FLAGS.has(flag.toLowerCase()) : UNIX_VALUE_FLAGS.has(flag);
}

/** Only the first command of a pipeline or sequence says what is being read. */
const SEPARATORS = new Set(['|', '||', '&&', ';']);

export function classify(command: string): CommandAction | undefined {
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  const end = tokens.findIndex((token) => SEPARATORS.has(token));
  if (end >= 0) tokens.length = end;

  const [program = '', ...args] = tokens;
  const named = (...names: string[]) => {
    const index = args.findIndex((arg) => names.includes(arg.toLowerCase()));
    return index >= 0 ? args[index + 1] : undefined;
  };
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg.startsWith('-')) {
      if (consumesValue(arg)) index += 1;
      continue;
    }
    positional.push(arg);
  }

  switch (program.toLowerCase().replace(/\.exe$/, '')) {
    case 'rg':
      if (args.includes('--files'))
        return { type: 'listFiles', command, path: positional[0] ?? null };
      return {
        type: 'search',
        command,
        query: named('-e', '--regexp') ?? positional[0] ?? null,
        path: positional[1] ?? null,
      };
    case 'grep':
    case 'findstr':
      return { type: 'search', command, query: positional[0] ?? null, path: positional[1] ?? null };
    case 'select-string':
    case 'sls':
      return {
        type: 'search',
        command,
        query: named('-pattern') ?? positional[0] ?? null,
        path: named('-path', '-literalpath') ?? positional[1] ?? null,
      };
    case 'get-content':
    case 'gc':
    case 'cat':
    case 'type':
    case 'head':
    case 'tail':
      return {
        type: 'read',
        command,
        path: named('-path', '-literalpath') ?? positional.at(-1) ?? null,
      };
    case 'get-childitem':
    case 'gci':
    case 'ls':
    case 'dir':
    case 'tree':
    case 'find':
      return {
        type: 'listFiles',
        command,
        path: named('-path', '-literalpath') ?? positional[0] ?? null,
      };
    default:
      return undefined;
  }
}

function failure(item: Item): string {
  const error = item.error as { message?: unknown } | undefined;
  if (typeof error?.message === 'string') return error.message.slice(0, 200);
  if (typeof item.exitCode === 'number') return `exit code ${item.exitCode}`;
  return 'Failed.';
}

function changedPaths(item: Item, cwd: string): string {
  const changes = (Array.isArray(item.changes) ? item.changes : []) as Array<{ path?: string }>;
  return changes.map((change) => relative(cwd, change.path)).join(', ');
}

function relative(cwd: string, path: string | null | undefined): string {
  if (!path) return '';
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  const normalized = path.replaceAll('\\', '/');
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

function shorten(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
}
