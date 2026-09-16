import Anthropic from '@anthropic-ai/sdk';
import { debug } from '../../core/logger.ts';
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
 * `medium` keeps time-to-first-token short for conversational use. Thinking is
 * left at the model default (adaptive) — Polaris cannot render thinking yet, so
 * asking for it would only add a silent pause.
 */
const EFFORT = 'medium';

const SYSTEM_PROMPT = [
  'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
  'Answer in plain text: the terminal does not render Markdown yet.',
  'Be concise and concrete. You have no tools and no access to the filesystem;',
  'if something would require reading files or running commands, say so.',
].join(' ');

export const anthropicApiProvider: ModelProvider = {
  id: 'anthropic-api',
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
    // The conversation lives here: the Messages API is stateless, so the full
    // history is replayed every turn. This is the only place in Polaris that
    // knows Anthropic's message shape.
    const messages: Anthropic.MessageParam[] = [];

    return {
      model,
      async *send(input, signal): AsyncIterable<ModelEvent> {
        signal?.throwIfAborted();
        messages.push({ role: 'user', content: input });

        let answer = '';
        try {
          const stream = client.messages.stream(
            {
              model,
              max_tokens: MAX_TOKENS,
              system: SYSTEM_PROMPT,
              output_config: { effort: EFFORT },
              messages,
            },
            signal ? { signal } : {},
          );

          yield { type: 'message-start' };
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              answer += event.delta.text;
              yield { type: 'text-delta', text: event.delta.text };
            }
          }
          yield { type: 'message-end' };
        } catch (error) {
          // Cancellation is the REPL's business, not a provider failure.
          if (signal?.aborted) throw error;
          throw toPolarisError(error);
        } finally {
          // Even a partial answer is a valid assistant turn; dropping it would
          // leave the next request without the context the user just read.
          if (answer.length > 0) messages.push({ role: 'assistant', content: answer });
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
