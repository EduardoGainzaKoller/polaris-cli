import type { ModelEvent } from '../providers/provider.ts';

export type Write = (text: string) => void;

const defaultWrite: Write = (text) => {
  process.stdout.write(text);
};

/**
 * Renders a model stream as continuous text: deltas are written exactly as they
 * arrive (no newline per chunk), leading blank space from the model is dropped,
 * and the answer always ends on its own line — including when the turn throws
 * or is cancelled, so whatever prints next starts cleanly.
 *
 * Returns the text that was actually rendered.
 */
export async function renderStream(
  events: AsyncIterable<ModelEvent>,
  write: Write = defaultWrite,
): Promise<string> {
  let rendered = '';
  try {
    for await (const event of events) {
      if (event.type !== 'text-delta') continue;
      const text = rendered.length === 0 ? event.text.replace(/^\s+/, '') : event.text;
      if (text.length === 0) continue;
      rendered += text;
      write(text);
    }
  } finally {
    if (rendered.length > 0 && !rendered.endsWith('\n')) write('\n');
  }
  return rendered;
}
