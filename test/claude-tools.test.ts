import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ClaudeRun, createClaudeProvider } from '../src/providers/claude/index.ts';
import { ClaudeToolTranslator } from '../src/providers/claude/tools.ts';
import type { ModelEvent } from '../src/providers/provider.ts';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const MAIN = process.platform === 'win32' ? 'C:\\work\\src\\main.ts' : '/work/src/main.ts';

function toolUse(id: string, name: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  } as unknown as SDKMessage;
}

function toolResult(id: string, content: unknown, isError = false): SDKMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
    },
  } as unknown as SDKMessage;
}

test('tool calls and results translate into Polaris tool events', () => {
  const translator = new ClaudeToolTranslator(CWD);
  const events = [
    toolUse('toolu_read', 'Read', { file_path: MAIN }),
    toolResult('toolu_read', '1\timport x\n2\texport y\n3\tconst z'),
    toolUse('toolu_glob', 'Glob', { pattern: '**/*.ts' }),
    toolResult('toolu_glob', 'No files found'),
    toolUse('toolu_bad', 'Read', { file_path: 'missing.ts' }),
    toolResult('toolu_bad', [{ type: 'text', text: 'File does not exist.' }], true),
  ].flatMap((message) => translator.translate(message));

  assert.deepEqual(events, [
    { type: 'tool-start', id: 'toolu_read', name: 'Read', target: 'src/main.ts' },
    { type: 'tool-result', id: 'toolu_read', summary: '3 lines' },
    { type: 'tool-start', id: 'toolu_glob', name: 'Glob', target: '**/*.ts' },
    { type: 'tool-result', id: 'toolu_glob', summary: '0 files' },
    { type: 'tool-start', id: 'toolu_bad', name: 'Read', target: 'missing.ts' },
    { type: 'tool-error', id: 'toolu_bad', error: 'File does not exist.' },
  ]);
});

test('a tool_use repeated by the runtime is reported once, and orphans are ignored', () => {
  const translator = new ClaudeToolTranslator(CWD);
  const events = [
    toolUse('toolu_1', 'Grep', { pattern: 'x' }),
    toolUse('toolu_1', 'Grep', { pattern: 'x' }),
    toolResult('toolu_unknown', 'nothing'),
  ].flatMap((message) => translator.translate(message));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'tool-start');
});

test('the provider streams tool events from the runtime in order', async () => {
  const run = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }): ClaudeRun => ({
    interrupt: async () => {},
    supportedModels: async () => [],
    return: async () => {},
    async *[Symbol.asyncIterator]() {
      for await (const _ of prompt) {
        yield toolUse('toolu_1', 'Grep', { pattern: 'ModelProvider' });
        yield toolResult('toolu_1', 'src/providers/provider.ts');
        yield {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Found it.' } },
        } as unknown as SDKMessage;
        yield { type: 'result', subtype: 'success', is_error: false } as unknown as SDKMessage;
      }
    },
  });

  const session = await createClaudeProvider(run).createSession({ cwd: CWD });
  const events: ModelEvent[] = [];
  for await (const event of session.send('Where is ModelProvider?')) events.push(event);

  assert.deepEqual(
    events.map((event) => event.type),
    ['message-start', 'tool-start', 'tool-result', 'text-delta', 'message-end'],
  );
  await session.close();
});
