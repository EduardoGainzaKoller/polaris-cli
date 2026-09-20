import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadHistory, MAX_HISTORY, saveHistory, withEntry } from '../src/config/history.ts';
import { footerHints, historyStep, inputRows, parseMouse } from '../src/ui/layout.ts';

// --------------------------------------------------------------- history

test('↑ walks back through history and ↓ returns to the draft', () => {
  // Three entries: indexes 0 (oldest) to 2 (newest); null is "not browsing".
  assert.equal(historyStep(3, null, 'older'), 2, 'first ↑ recalls the newest');
  assert.equal(historyStep(3, 2, 'older'), 1);
  assert.equal(historyStep(3, 0, 'older'), 0, 'stops at the oldest');
  assert.equal(historyStep(3, 1, 'newer'), 2);
  assert.equal(historyStep(3, 2, 'newer'), null, 'past the newest is the draft again');
  assert.equal(historyStep(3, null, 'newer'), null);
  assert.equal(historyStep(0, null, 'older'), null, 'nothing to recall');
});

test('history skips blanks and immediate repeats, and is capped', () => {
  assert.deepEqual(withEntry(['a'], '  '), ['a']);
  assert.deepEqual(withEntry(['a'], 'a'), ['a']);
  assert.deepEqual(withEntry(['a', 'b'], 'a'), ['a', 'b', 'a'], 'older repeats are kept');
  assert.deepEqual(withEntry([], '  /status '), ['/status']);

  const full = Array.from({ length: MAX_HISTORY }, (_, index) => `p${index}`);
  const next = withEntry(full, 'newest');
  assert.equal(next.length, MAX_HISTORY);
  assert.equal(next.at(-1), 'newest');
  assert.equal(next[0], 'p1', 'the oldest entry falls off');
});

test('history persists across sessions and tolerates a missing or corrupt file', async () => {
  const previous = process.env.POLARIS_HOME;
  process.env.POLARIS_HOME = await mkdtemp(join(tmpdir(), 'polaris-history-'));
  try {
    assert.deepEqual(await loadHistory(), [], 'no file yet');
    await saveHistory(['hola', '/effort high']);
    assert.deepEqual(await loadHistory(), ['hola', '/effort high']);
    const raw = await readFile(join(process.env.POLARIS_HOME, 'history.json'), 'utf8');
    assert.ok(raw.endsWith('\n'));
  } finally {
    if (previous === undefined) delete process.env.POLARIS_HOME;
    else process.env.POLARIS_HOME = previous;
  }
});

// ------------------------------------------------------------------ mouse

test('the mouse wheel scrolls and every mouse report is recognised', () => {
  const esc = String.fromCharCode(27);
  assert.deepEqual(parseMouse(`${esc}[<64;10;5M`), { isMouse: true, scroll: 3 });
  assert.deepEqual(parseMouse(`${esc}[<65;10;5M`), { isMouse: true, scroll: -3 });
  // Ink hands the sequence over without its escape byte.
  assert.deepEqual(parseMouse('[<64;1;1M'), { isMouse: true, scroll: 3 });
  // Several notches can arrive in one chunk.
  assert.deepEqual(parseMouse(`${esc}[<64;1;1M${esc}[<64;1;1M`), { isMouse: true, scroll: 6 });
  // A click is still mouse input — never text — but does not scroll.
  assert.deepEqual(parseMouse(`${esc}[<0;4;4M`), { isMouse: true, scroll: 0 });
  assert.deepEqual(parseMouse('hola'), { isMouse: false, scroll: 0 });
});

// ------------------------------------------------------------------ layout

test('footer hints drop from the end as the terminal narrows', () => {
  assert.equal(footerHints(200, false), '↑↓ history · pgup/pgdn scroll · / commands · ctrl+c exit');
  assert.equal(footerHints(30, false), '↑↓ history · pgup/pgdn scroll');
  assert.equal(footerHints(5, false), '');
  assert.match(footerHints(200, true), /^ctrl\+c cancel/, 'while busy, cancelling comes first');
});

test('the input grows with long text but never takes over the screen', () => {
  assert.equal(inputRows('', 40), 1);
  assert.equal(inputRows('x'.repeat(100), 40), 3);
  assert.equal(inputRows('x'.repeat(10_000), 40), 6);
});
