import {
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { toPolarisError, turnFailure } from './errors.ts';

/**
 * The slice of the SDK's `Query` that Polaris actually uses. Narrowing it here
 * is what makes the provider testable: a fake run is a handful of lines instead
 * of a full `AsyncGenerator` implementation, and the translation below is the
 * real one either way.
 */
export interface ClaudeRun extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<Array<{ value: string }>>;
  return(value?: unknown): Promise<unknown>;
}

export type QueryFn = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeRun;

const SYSTEM_PROMPT = [
  'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
  'Answer in plain text: the terminal does not render Markdown yet.',
  'Be concise and concrete. You have no tools in this session;',
  'if something would require reading files or running commands, say so.',
].join(' ');

/**
 * v0.2.1 integrates the runtime, not its capabilities: every built-in tool is
 * off and no settings, skills or CLAUDE.md files are loaded from disk, so this
 * provider is a plain conversation like the other two.
 */
const BASE_OPTIONS: Options = {
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  settingSources: [],
  includePartialMessages: true,
  persistSession: false,
};

/** Escape hatch documented in the SDK for installs without the bundled binary. */
const EXECUTABLE = process.env.POLARIS_CLAUDE_EXECUTABLE;

export function createClaudeProvider(run: QueryFn = query): ModelProvider {
  return {
    id: 'claude',
    async createSession(session: ProviderSessionOptions): Promise<ModelSession> {
      const queue = createMessageQueue();
      // The runtime owns the conversation: one `query()` spans the whole Polaris
      // session and every turn is pushed into its prompt stream, so Polaris
      // never replays a history of its own (unlike the stateless Messages API).
      let active: ClaudeRun | null = null;
      // Pulled by hand rather than with `for await`: leaving a `for await` early
      // calls `return()` on the generator, which would end the whole session
      // after the first turn.
      let frames: AsyncIterator<SDKMessage> | null = null;
      let model = session.model ?? 'default';

      function start(): ClaudeRun {
        if (active) return active;
        try {
          active = run({
            prompt: queue,
            options: {
              ...BASE_OPTIONS,
              cwd: session.cwd,
              ...(session.model ? { model: session.model } : {}),
              ...(EXECUTABLE ? { pathToClaudeCodeExecutable: EXECUTABLE } : {}),
            },
          });
        } catch (error) {
          throw toPolarisError(error);
        }
        return active;
      }

      return {
        get model() {
          return model;
        },
        async *send(input, signal): AsyncIterable<ModelEvent> {
          signal?.throwIfAborted();
          const claude = start();
          queue.push({
            type: 'user',
            message: { role: 'user', content: input },
            parent_tool_use_id: null,
          });

          // Ctrl+C interrupts the turn through the runtime's own control
          // channel. Aborting the AbortController instead would tear down the
          // whole session, which is exactly what we do not want.
          const onAbort = () => {
            void claude.interrupt().catch((error: unknown) => debug('claude', 'interrupt', error));
          };
          signal?.addEventListener('abort', onAbort, { once: true });

          try {
            yield { type: 'message-start' };
            frames ??= claude[Symbol.asyncIterator]();
            while (true) {
              const frame = await frames.next();
              if (frame.done) break;
              const message = frame.value;
              if (message.type === 'system' && message.subtype === 'init') {
                model = message.model;
                continue;
              }
              if (message.type === 'stream_event') {
                const { event } = message;
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                  yield { type: 'text-delta', text: event.delta.text };
                }
                continue;
              }
              // A `result` message closes the turn — success, failure or
              // interruption alike — and leaves the session ready for the next.
              if (message.type === 'result') {
                if (signal?.aborted) signal.throwIfAborted();
                if (message.is_error) {
                  throw turnFailure(
                    message.subtype,
                    'result' in message ? message.result : undefined,
                  );
                }
                break;
              }
            }
            yield { type: 'message-end' };
          } catch (error) {
            if (signal?.aborted || error instanceof PolarisError) throw error;
            throw toPolarisError(error);
          } finally {
            signal?.removeEventListener('abort', onAbort);
            debug('claude', 'turn finished, model', model);
          }
        },
        async listModels() {
          const models = await start().supportedModels();
          return models.map((entry) => entry.value);
        },
        async close() {
          queue.close();
          await active?.return(undefined).catch(() => undefined);
          active = null;
          frames = null;
        },
      };
    },
  };
}

export const claudeProvider: ModelProvider = createClaudeProvider();

/**
 * Turns the REPL's one-prompt-at-a-time loop into the single `AsyncIterable`
 * the SDK wants for a persistent (streaming input) session.
 */
function createMessageQueue(): AsyncIterable<SDKUserMessage> & {
  push(message: SDKUserMessage): void;
  close(): void;
} {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(message) {
      pending.push(message);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
