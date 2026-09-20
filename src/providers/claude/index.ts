import {
  type EffortLevel,
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
import {
  CLAUDE_TOOL_ACCESS,
  ClaudeToolTranslator,
  DENIED_TOOLS,
  READ_ONLY_TOOLS,
  workspaceGuard,
} from './tools.ts';

/**
 * The slice of the SDK's `Query` that Polaris actually uses. Narrowing it here
 * is what makes the provider testable: a fake run is a handful of lines instead
 * of a full `AsyncGenerator` implementation, and the translation below is the
 * real one either way.
 */
export interface ClaudeRun extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>;
  supportedModels(): Promise<Array<{ value: string }>>;
  applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void>;
  return(value?: unknown): Promise<unknown>;
}

/** The runtime's `EffortLevel` values. */
const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[];

function asEffort(level: string): EffortLevel {
  if ((EFFORT_LEVELS as readonly string[]).includes(level)) return level as EffortLevel;
  throw new PolarisError(`Unknown effort "${level}". Use one of: ${EFFORT_LEVELS.join(', ')}.`);
}

export type QueryFn = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeRun;

const SYSTEM_PROMPT = [
  'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
  'Answer in plain text: the terminal does not render Markdown yet.',
  'You can inspect the workspace with Read, Glob and Grep; look at the code before',
  'answering questions about it. Your access is read-only: you cannot create, edit,',
  'move or delete files, or run commands. If asked to change something, say so and',
  'describe the change instead.',
].join(' ');

/**
 * v0.5 gives the runtime exactly three read-only tools, four locks deep:
 * `tools` defines the only built-ins that exist, `disallowedTools` strips the
 * mutating ones from the request, `dontAsk` turns any prompt into a denial, and
 * a PreToolUse hook enforces the workspace boundary on every call. Settings,
 * skills, plugins and CLAUDE.md stay unloaded (`settingSources: []`), so
 * nothing on disk can widen that surface.
 */
const BASE_OPTIONS: Options = {
  systemPrompt: SYSTEM_PROMPT,
  tools: [...READ_ONLY_TOOLS],
  disallowedTools: DENIED_TOOLS,
  permissionMode: 'dontAsk',
  settingSources: [],
  includePartialMessages: true,
  persistSession: false,
};

/** Escape hatch documented in the SDK for installs without the bundled binary. */
const EXECUTABLE = process.env.POLARIS_CLAUDE_EXECUTABLE;

export function createClaudeProvider(run: QueryFn = query): ModelProvider {
  return {
    id: 'claude',
    access: CLAUDE_TOOL_ACCESS,
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
      let effort: EffortLevel | undefined =
        session.effort === undefined ? undefined : asEffort(session.effort);
      const translator = new ClaudeToolTranslator(session.cwd);

      function start(): ClaudeRun {
        if (active) return active;
        try {
          active = run({
            prompt: queue,
            options: {
              ...BASE_OPTIONS,
              cwd: session.cwd,
              hooks: { PreToolUse: [{ hooks: [workspaceGuard(session.cwd)] }] },
              ...(session.model ? { model: session.model } : {}),
              ...(effort ? { effort } : {}),
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
        get effort() {
          return effort;
        },
        async efforts() {
          return [...EFFORT_LEVELS];
        },
        async setEffort(level) {
          const next = asEffort(level);
          // A running session takes the change live through the runtime's own
          // flag layer; before the first turn it is simply passed at start.
          if (active) await active.applyFlagSettings({ effortLevel: next });
          effort = next;
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
              // Tool calls arrive in assistant messages, their results in user
              // messages; both are normalized into the shared event protocol.
              if (message.type === 'assistant' || message.type === 'user') {
                for (const event of translator.translate(message)) yield event;
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
