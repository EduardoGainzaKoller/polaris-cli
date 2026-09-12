import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelEvent } from '../src/providers/provider.ts';
import { renderStream } from '../src/ui/stream.ts';

async function* streamOf(...events: ModelEvent[]): AsyncIterable<ModelEvent> {
  for (const event of events) yield event;
}

function capture(): { write: (text: string) => void; chunks: string[]; text(): string } {
  const chunks: string[] = [];
  return {
    chunks,
    write: (text) => {
      chunks.push(text);
    },
    text: () => chunks.join(''),
  };
}

test('chunks are written as continuous text, not one line per chunk', async () => {
  const out = capture();
  const rendered = await renderStream(
    streamOf(
      { type: 'message-start' },
      { type: 'text-delta', text: 'Una ' },
      { type: 'text-delta', text: 'stream ' },
      { type: 'text-delta', text: 'en Java' },
      { type: 'message-end' },
    ),
    out.write,
  );

  assert.equal(rendered, 'Una stream en Java');
  assert.equal(out.text(), 'Una stream en Java\n');
  assert.equal(out.chunks.length, 4, 'three deltas plus the closing newline');
});

test('leading blank space from the model is dropped and embedded newlines survive', async () => {
  const out = capture();
  await renderStream(
    streamOf(
      { type: 'text-delta', text: '\n\n  Line one\n' },
      { type: 'text-delta', text: 'Line two\n' },
    ),
    out.write,
  );
  assert.equal(out.text(), 'Line one\nLine two\n');
});

test('an empty answer writes nothing at all', async () => {
  const out = capture();
  assert.equal(await renderStream(streamOf({ type: 'message-start' }), out.write), '');
  assert.equal(out.chunks.length, 0);
});

test('a failed or cancelled turn still leaves the cursor on a fresh line', async () => {
  const out = capture();
  async function* failing(): AsyncIterable<ModelEvent> {
    yield { type: 'text-delta', text: 'partial' };
    throw new Error('boom');
  }

  await assert.rejects(() => renderStream(failing(), out.write), /boom/);
  assert.equal(out.text(), 'partial\n');
});
