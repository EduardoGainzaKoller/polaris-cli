import Anthropic from '@anthropic-ai/sdk';
import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import { toolFinished, toolResultText, toolStarted } from '../../tools/events.ts';
import { MAX_TOOL_ROUNDS } from '../../tools/limits.ts';
import { createReadOnlyRegistry, POLARIS_TOOL_ACCESS } from '../../tools/registry.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { toPolarisError } from './errors.ts';

/** Single place to change what Polaris talks to by default. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Answers are streamed, so a long one never hits the SDK's HTTP timeout. */
const MAX_TOKENS = 32_000;

/**
 * `medium` keeps time-to-first-token short for conversational use; /effort
 * changes it per request, so a switch never costs the conversation. Thinking is
 * left at the model default (adaptive) — Polaris cannot render thinking yet.
 */
const DEFAULT_EFFORT = 'medium';

/** The `output_config.effort` levels of current Claude models. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = (typeof EFFORTS)[number];

const SYSTEM_PROMPT = [
  'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
  'Answer in plain text: the terminal does not render Markdown yet.',
  'You can inspect the workspace with read_file, glob_files and grep_text. Paths are',
  'relative to the workspace root. Look at the code before answering questions about it.',
  'Your access is read-only: you cannot create, edit, move or delete files, or run commands.',
  'If asked to change something, say so and describe the change instead.',
].join(' ');

/**
 * Polaris owns the agent loop here, because the Messages API is stateless:
 * stream a response, run the tools it asks for, send the results back, repeat.
 * The SDK's Tool Runner would hide the per-call events the UI renders, so the
 * loop is written out — it is short.
 */
export const anthropicApiProvider: ModelProvider = {
  id: 'anthropic-api',
  access: POLARIS_TOOL_ACCESS,
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    // Credentials are resolved by the SDK itself (ANTHROPIC_API_KEY,
    // ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile). Polaris never
    // reads credential files or reuses another tool's tokens.
    let client: Anthropic;
    try {
      client = new Anthropic();
    } catch (error) {
      throw toPolarisError(error);
    }

    const model = options.model ?? DEFAULT_MODEL;
    const registry = createReadOnlyRegistry();
    const tools: Anthropic.Tool[] = registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, required: [...tool.inputSchema.required] },
    }));
    // The conversation lives here and is replayed every request. This is the
    // only place in Polaris that knows Anthropic's message shape.
    const messages: Anthropic.MessageParam[] = [];
    let effort: Effort = asEffort(options.effort ?? DEFAULT_EFFORT);

    return {
      model,
      get effort() {
        return effort;
      },
      async efforts() {
        return [...EFFORTS];
      },
      async setEffort(level) {
        effort = asEffort(level);
      },
      async *send(input, signal): AsyncIterable<ModelEvent> {
        signal?.throwIfAborted();
        messages.push({ role: 'user', content: input });

        let settled = false;
        let partial = '';
        try {
          yield { type: 'message-start' };

          for (let round = 1; ; round += 1) {
            if (round > MAX_TOOL_ROUNDS) {
              throw new PolarisError(
                `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`,
              );
            }

            partial = '';
            const stream = client.messages.stream(
              {
                model,
                max_tokens: MAX_TOKENS,
                system: SYSTEM_PROMPT,
                output_config: { effort },
                tools,
                messages,
              },
              signal ? { signal } : {},
            );
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                partial += event.delta.text;
                yield { type: 'text-delta', text: event.delta.text };
              }
            }
            const message = await stream.finalMessage();
            // The full content goes back into history — tool_use blocks included —
            // so the next request sees exactly what the model produced.
            messages.push({ role: 'assistant', content: message.content });
            partial = '';

            const calls = message.content.filter(
              (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
            );
            if (message.stop_reason !== 'tool_use' || calls.length === 0) break;

            for (const call of calls) yield toolStarted(registry, call.id, call.name, call.input);
            // Read-only calls are independent, so parallel requests run in parallel.
            const results = await Promise.all(
              calls.map((call) =>
                registry.execute(call.name, call.input, {
                  cwd: options.cwd,
                  ...(signal ? { signal } : {}),
                }),
              ),
            );
            for (const [index, result] of results.entries()) {
              const call = calls[index] as Anthropic.ToolUseBlock;
              yield toolFinished(call.id, result);
            }
            // Every result in a single user message, errors included: splitting
            // them, or dropping failures, degrades the model's tool use.
            messages.push({
              role: 'user',
              content: results.map((result, index) => ({
                type: 'tool_result',
                tool_use_id: (calls[index] as Anthropic.ToolUseBlock).id,
                content: toolResultText(result),
                ...(result.ok ? {} : { is_error: true }),
              })),
            });
          }

          settled = true;
          yield { type: 'message-end' };
        } catch (error) {
          if (signal?.aborted || error instanceof PolarisError) throw error;
          throw toPolarisError(error);
        } finally {
          if (!settled) repairHistory(messages, partial);
          debug('anthropic', 'turn finished, history entries', messages.length);
        }
      },
      async listModels() {
        const page = await client.models.list({ limit: 50 });
        return page.data.map((entry) => entry.id);
      },
      async close() {
        messages.length = 0;
      },
    };
  },
};

/**
 * A turn that stopped early must still leave a history the API accepts on the
 * next request. A `tool_use` without its `tool_result` is rejected, so pending
 * calls are answered as cancelled; a partially streamed answer is kept, because
 * the user already read it.
 */
function repairHistory(messages: Anthropic.MessageParam[], partial: string): void {
  const last = messages.at(-1);
  if (last?.role === 'assistant' && Array.isArray(last.content)) {
    const pending = last.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (pending.length > 0) {
      messages.push({
        role: 'user',
        content: pending.map((block) => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Cancelled before the tool finished.',
          is_error: true,
        })),
      });
      return;
    }
  }
  if (partial.length > 0) messages.push({ role: 'assistant', content: partial });
}

function asEffort(level: string): Effort {
  if ((EFFORTS as readonly string[]).includes(level)) return level as Effort;
  throw new PolarisError(`Unknown effort "${level}". Use one of: ${EFFORTS.join(', ')}.`);
}
