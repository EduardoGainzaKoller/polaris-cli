import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppState, UiMessage } from '../src/core/app.ts';
import {
  clamp,
  completions,
  maxScroll,
  statusSegments,
  transcriptLines,
  viewport,
  wrapText,
} from '../src/ui/layout.ts';

function message(partial: Partial<UiMessage>): UiMessage {
  return { id: 'm1', role: 'assistant', text: '', state: 'complete', ...partial };
}

test('wrapText breaks on words and keeps explicit newlines', () => {
  assert.deepEqual(wrapText('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('a\nb', 10), ['a', 'b']);
  assert.deepEqual(wrapText('short', 40), ['short']);
});

test('wrapText never loses characters, even for unbreakable words', () => {
  const long = 'x'.repeat(25);
  const lines = wrapText(long, 10);
  assert.equal(lines.join(''), long);
  assert.ok(lines.every((line) => line.length <= 10));
});

test('your messages become a padded panel; answers end with a footer or "cancelled"', () => {
  const lines = transcriptLines(
    [
      message({ id: 'a', role: 'user', text: 'hola' }),
      message({ id: 'b', role: 'assistant', text: 'medio', state: 'cancelled' }),
      message({ id: 'c', role: 'user', text: 'otra' }),
      message({ id: 'd', role: 'assistant', text: 'bien', meta: 'echo · high · 1.2s' }),
    ],
    40,
  );
  assert.deepEqual(
    lines.map((line) => [line.kind, line.text]),
    [
      ['user', ''],
      ['user', 'hola'],
      ['user', ''],
      ['blank', ''],
      ['text', 'medio'],
      ['meta', 'cancelled'],
      ['blank', ''],
      ['user', ''],
      ['user', 'otra'],
      ['user', ''],
      ['blank', ''],
      ['text', 'bien'],
      ['meta', 'echo · high · 1.2s'],
    ],
  );
});

test('a streaming answer with nothing yet shows a placeholder instead of collapsing', () => {
  const lines = transcriptLines([message({ text: '', state: 'streaming' })], 40);
  assert.deepEqual(
    lines.map((line) => line.text),
    ['…'],
  );
});

test('system notices carry no speaker label', () => {
  const lines = transcriptLines([message({ role: 'system', text: 'Switched to mock' })], 40);
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Switched to mock'],
  );
});

test('viewport follows the newest lines and scrolls back on demand', () => {
  const lines = ['1', '2', '3', '4', '5'];
  assert.deepEqual(viewport(lines, 2, 0), ['4', '5'], 'offset 0 follows the stream');
  assert.deepEqual(viewport(lines, 2, 2), ['2', '3']);
  assert.deepEqual(viewport(lines, 2, 99), ['1', '2'], 'cannot scroll past the top');
  assert.deepEqual(viewport(lines, 10, 0), lines, 'a short transcript is shown whole');
  assert.equal(maxScroll(5, 2), 3);
  assert.equal(maxScroll(2, 5), 0);
  assert.equal(clamp(7, 0, 3), 3);
});

function state(partial: Partial<AppState> = {}): AppState {
  return {
    cwd: '/home/franc/projects/polaris',
    project: 'polaris',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    status: 'ready',
    busy: false,
    messages: [],
    turns: 0,
    access: null,
    effort: null,
    permissions: 'ask',
    approval: null,
    ...partial,
  };
}

test('the status bar drops context as the terminal narrows, never provider or state', () => {
  const wide = statusSegments(state(), 120);
  assert.match(wide.left, /codex · gpt-5\.6-luna/);
  assert.match(wide.left, /polaris/);
  // The profile sits beside the state: what Polaris may do is as important as
  // what it is doing.
  assert.equal(wide.right, 'ask · ready');

  const medium = statusSegments(state(), 40);
  assert.equal(medium.left, 'codex · gpt-5.6-luna');
  assert.equal(medium.right, 'ask · ready');

  const narrow = statusSegments(state({ status: 'streaming' }), 20);
  assert.equal(narrow.left, 'codex · ask · streaming');
  assert.equal(narrow.right, '');
});

test('slash completion filters by prefix and stops once an argument is typed', () => {
  const names = ['help', 'provider', 'model', 'config', 'clear', 'exit'];
  assert.deepEqual(completions('/', names), names);
  assert.deepEqual(completions('/c', names), ['config', 'clear']);
  assert.deepEqual(completions('/pro', names), ['provider']);
  assert.deepEqual(completions('/provider ', names), [], 'an argument ends completion');
  assert.deepEqual(completions('hola', names), []);
});
