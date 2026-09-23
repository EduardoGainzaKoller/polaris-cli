import type { AppState, AppStatus, UiMessage, WorkspaceState } from '../core/app.ts';
import { shortenPath } from './output.ts';

/** Pure layout maths — no ANSI, no Ink — so it can be unit-tested directly. */

export interface TranscriptLine {
  readonly kind: 'blank' | 'user' | 'text' | 'meta' | 'tool' | 'detail' | 'output' | 'notice';
  readonly role: UiMessage['role'];
  readonly state: UiMessage['state'];
  readonly text: string;
  /** Tool name, shown in bold before the target. */
  readonly label?: string;
  /** Short outcome shown at the right edge of a tool row. */
  readonly aside?: string;
}

/** Live command output rows kept under a running tool. */
const OUTPUT_ROWS = 6;

/** Wraps on word boundaries, keeps explicit newlines, never loses characters. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.length <= width) {
      lines.push(paragraph);
      continue;
    }
    let current = '';
    for (const word of paragraph.split(' ')) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
      // A single word longer than the viewport is cut rather than overflowing.
      while (current.length > width) {
        lines.push(current.slice(0, width));
        current = current.slice(width);
      }
    }
    lines.push(current);
  }
  return lines;
}

/**
 * Flattens the transcript into renderable rows:
 *
 * - your messages become a padded panel,
 * - answers are plain text with a quiet footer (model · effort · time),
 * - each tool call is one row — name, target, outcome on the right — and
 *   consecutive calls stay together,
 * - notices from commands are muted; errors say so.
 *
 * `width` is the usable text width; the renderer adds the panel bar and padding.
 */
export function transcriptLines(messages: readonly UiMessage[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let previous: UiMessage | undefined;
  const push = (line: TranscriptLine) => lines.push(line);

  for (const message of messages) {
    const { role, state } = message;
    const bothTools = previous?.role === 'tool' && role === 'tool';
    if (lines.length > 0 && !bothTools) push({ kind: 'blank', role, state, text: '' });
    previous = message;

    if (role === 'tool' && message.tool) {
      const { name, target, detail, denied, output } = message.tool;
      const outcome = denied ? 'denied' : state === 'cancelled' ? 'cancelled' : detail;
      // A short success fits beside the row; errors and long outcomes go below.
      const beside = state === 'complete' && outcome && outcome.length <= 24 ? outcome : undefined;
      const room = Math.max(8, width - name.length - 4 - (beside ? beside.length + 2 : 0));
      const [first = '', ...rest] = wrapText(target, room);
      push({
        kind: 'tool',
        role,
        state,
        label: name,
        text: first,
        ...(beside ? { aside: beside } : {}),
      });
      for (const text of rest) push({ kind: 'detail', role, state, text });
      // A command's own output while it runs, so a long test suite is not a
      // blank screen. It is replaced by the outcome once the tool finishes.
      if (output && state === 'streaming') {
        for (const line of output.split('\n').slice(-OUTPUT_ROWS)) {
          push({ kind: 'output', role, state, text: line.slice(0, Math.max(8, width - 4)) });
        }
      }
      if (outcome && !beside) {
        for (const text of wrapText(outcome, Math.max(8, width - 4))) {
          push({ kind: 'detail', role, state, text });
        }
      }
      continue;
    }

    if (role === 'user') {
      push({ kind: 'user', role, state, text: '' });
      for (const text of wrapText(message.text, width)) push({ kind: 'user', role, state, text });
      push({ kind: 'user', role, state, text: '' });
      continue;
    }

    if (role === 'system') {
      const body = state === 'error' ? `✗ ${message.text}` : message.text;
      for (const text of wrapText(body, width)) push({ kind: 'notice', role, state, text });
      continue;
    }

    const body = message.text.length === 0 && state === 'streaming' ? '…' : message.text;
    for (const text of wrapText(body, width)) push({ kind: 'text', role, state, text });
    if (state === 'cancelled') push({ kind: 'meta', role, state, text: 'cancelled' });
    else if (message.meta) push({ kind: 'meta', role, state, text: message.meta });
  }
  return lines;
}

/**
 * The slice of lines to draw. `offset` counts lines scrolled up from the
 * bottom, so 0 always means "following the latest output".
 */
export function viewport<T>(lines: readonly T[], height: number, offset: number): T[] {
  if (height <= 0) return [];
  const maxOffset = Math.max(0, lines.length - height);
  const from = Math.max(0, lines.length - height - clamp(offset, 0, maxOffset));
  return lines.slice(from, from + height);
}

export function maxScroll(total: number, height: number): number {
  return Math.max(0, total - Math.max(height, 0));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const STATUS_LABELS: Record<AppStatus, string> = {
  ready: 'ready',
  thinking: 'thinking',
  streaming: 'streaming',
  reading: 'reading',
  searching: 'searching',
  working: 'working',
  running: 'running command',
  switching: 'switching',
  approving: 'approval required',
  cancelled: 'cancelled',
  error: 'error',
};

export function statusLabel(status: AppStatus): string {
  return STATUS_LABELS[status];
}

/**
 * Status bar contents for the terminal we actually have: the narrower it gets,
 * the less context is shown, but provider, model and state never disappear.
 */
export function statusSegments(state: AppState, width: number): { left: string; right: string } {
  const where = shortenPath(state.cwd);
  const model = state.model;
  const full = `${state.provider} · ${model}`;
  const status = `${state.permissions} · ${statusLabel(state.status)}`;

  if (width >= full.length + where.length + status.length + 8) {
    return { left: `${full}    ${where}`, right: status };
  }
  if (width >= full.length + status.length + 4) {
    return { left: full, right: status };
  }
  return { left: `${state.provider} · ${status}`, right: '' };
}

/**
 * The workspace in a few characters: branch and how many files Polaris has
 * changed, then whether those changes are verified. `main +2 · unverified`.
 * Empty when there is nothing worth a glance.
 */
export function workspaceLabel(workspace: WorkspaceState, skills = 0): string {
  const changed = workspace.changed > 0 ? `+${workspace.changed}` : '';
  const where = workspace.git
    ? [workspace.git.branch ?? 'detached', changed].filter(Boolean).join(' ')
    : changed;
  const verification =
    workspace.verification === 'none'
      ? ''
      : workspace.verification === 'failed'
        ? 'checks failed'
        : workspace.verification;
  return [where, verification, skills > 0 ? `skills:${skills}` : ''].filter(Boolean).join(' · ');
}

/** Commands offered while the composer holds a `/…` prefix. */
export function completions(input: string, names: readonly string[]): string[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1).split(/\s/)[0] ?? '';
  if (input.slice(1).includes(' ')) return [];
  return names.filter((name) => name.startsWith(typed.toLowerCase()));
}

/**
 * Terminals report the mouse, once asked to, as SGR sequences that reach the
 * input stream as text: `ESC [ < button ; x ; y M`. Buttons 64 and 65 are the
 * wheel. Every sequence is recognised so none of it is ever typed into the
 * composer; the wheel becomes a scroll of `lines` rows per notch.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the protocol
const MOUSE = /?\[<(\d+);\d+;\d+[Mm]/g;

export function parseMouse(input: string, lines = 3): { isMouse: boolean; scroll: number } {
  let scroll = 0;
  let matched = false;
  for (const [, button] of input.matchAll(MOUSE)) {
    matched = true;
    if (button === '64') scroll += lines;
    if (button === '65') scroll -= lines;
  }
  return { isMouse: matched, scroll };
}

/**
 * Walks the prompt history like a shell: `null` is "not browsing". Moving
 * older from the newest entry starts browsing; moving newer past it stops.
 */
export function historyStep(
  length: number,
  index: number | null,
  direction: 'older' | 'newer',
): number | null {
  if (length === 0) return null;
  if (direction === 'older') return index === null ? length - 1 : Math.max(0, index - 1);
  if (index === null) return null;
  return index >= length - 1 ? null : index + 1;
}

/** Keyboard hints for the footer, dropped from the end as the terminal narrows. */
export function footerHints(width: number, busy: boolean, approving = false): string {
  const hints = approving
    ? ['enter allow', 'd deny', 'ctrl+c cancel turn']
    : busy
      ? ['ctrl+c cancel', 'pgup/pgdn scroll', '/help']
      : ['↑↓ history', 'pgup/pgdn scroll', '/ commands', 'ctrl+c exit'];
  const shown: string[] = [];
  let used = 0;
  for (const hint of hints) {
    const cost = hint.length + (shown.length > 0 ? 3 : 0);
    if (used + cost > width) break;
    shown.push(hint);
    used += cost;
  }
  return shown.join(' · ');
}

/** Rows the input takes inside the composer, capped so the transcript keeps its space. */
export function inputRows(value: string, width: number, max = 6): number {
  if (width <= 0) return 1;
  const rows = Math.ceil(Math.max(1, value.length + 3) / width);
  return clamp(rows, 1, max);
}

/** Half-block lettering for the start screen: "POLAR" and "IS", coloured apart. */
export const LOGO = [
  ['█▀█ █▀█ █   █▀█ █▀█ ', '█ █▀▀'],
  ['█▀▀ █ █ █   █▀█ █▀▄ ', '█ ▀▀█'],
  ['▀   ▀▀▀ ▀▀▀ ▀ ▀ ▀ ▀ ', '▀ ▀▀▀'],
] as const;

export const LOGO_WIDTH = LOGO[0][0].length + LOGO[0][1].length;
