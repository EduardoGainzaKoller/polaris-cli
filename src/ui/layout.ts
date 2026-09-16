import type { AppState, AppStatus, UiMessage } from '../core/app.ts';
import { shortenPath } from './output.ts';

/** Pure layout maths — no ANSI, no Ink — so it can be unit-tested directly. */

export interface TranscriptLine {
  readonly kind: 'label' | 'text' | 'blank' | 'tool' | 'detail';
  readonly role: UiMessage['role'];
  readonly text: string;
  readonly state: UiMessage['state'];
}

const LABELS: Record<UiMessage['role'], string> = {
  user: 'You',
  assistant: 'Polaris',
  system: '',
  tool: '',
};

/**
 * One glyph per tool state. All four are in the basic Unicode geometric and
 * math blocks, which Windows Terminal, conhost with a TrueType font, and every
 * common macOS/Linux terminal font render.
 */
const TOOL_MARKERS: Record<UiMessage['state'], string> = {
  streaming: '◌',
  complete: '●',
  error: '×',
  cancelled: '◌',
};

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
 * Flattens the transcript into renderable lines: a role label then the body for
 * messages, and a compact one- or two-line entry for each tool call. Consecutive
 * tool calls stay together without blank lines between them.
 */
export function transcriptLines(messages: readonly UiMessage[], width: number): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  let previous: UiMessage | undefined;

  for (const message of messages) {
    const bothTools = previous?.role === 'tool' && message.role === 'tool';
    if (lines.length > 0 && !bothTools) {
      lines.push({ kind: 'blank', role: message.role, text: '', state: message.state });
    }
    previous = message;

    if (message.role === 'tool' && message.tool) {
      const { name, target, detail } = message.tool;
      const head = `${TOOL_MARKERS[message.state]} ${name}${target ? ` ${target}` : ''}`;
      for (const text of wrapText(head, width)) {
        lines.push({ kind: 'tool', role: 'tool', text, state: message.state });
      }
      const outcome = message.state === 'cancelled' ? 'cancelled' : detail;
      if (outcome) {
        for (const text of wrapText(outcome, Math.max(1, width - 2))) {
          lines.push({ kind: 'detail', role: 'tool', text: `  ${text}`, state: message.state });
        }
      }
      continue;
    }

    const label = LABELS[message.role];
    if (label) {
      lines.push({ kind: 'label', role: message.role, text: label, state: message.state });
    }
    const body = message.text.length === 0 && message.state === 'streaming' ? '…' : message.text;
    for (const text of wrapText(body, width)) {
      lines.push({ kind: 'text', role: message.role, text, state: message.state });
    }
    if (message.state === 'cancelled') {
      lines.push({ kind: 'text', role: 'system', text: '⌁ cancelled', state: 'cancelled' });
    }
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
  switching: 'switching',
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
  const mode = state.access ? `${state.access.mode} · ` : '';
  const status = `${mode}${statusLabel(state.status)}`;

  if (width >= full.length + where.length + status.length + 8) {
    return { left: `${full}    ${where}`, right: status };
  }
  if (width >= full.length + status.length + 4) {
    return { left: full, right: status };
  }
  return { left: `${state.provider} · ${status}`, right: '' };
}

/** Commands offered while the composer holds a `/…` prefix. */
export function completions(input: string, names: readonly string[]): string[] {
  if (!input.startsWith('/')) return [];
  const typed = input.slice(1).split(/\s/)[0] ?? '';
  if (input.slice(1).includes(' ')) return [];
  return names.filter((name) => name.startsWith(typed.toLowerCase()));
}
