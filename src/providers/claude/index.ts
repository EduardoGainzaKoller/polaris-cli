import {
  createSdkMcpServer,
  type EffortLevel,
  type Options,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  LOAD_SKILL,
  LOAD_SKILL_DESCRIPTION,
  READ_REFERENCE_DESCRIPTION,
  READ_SKILL_REFERENCE,
  type SessionContext,
} from '../../context/manager.ts';
import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import type { ModelUsage, UsageReport } from '../../core/usage.ts';
import { COMPLETION_GUIDANCE } from '../../core/verification.ts';
import { PERMISSION_PROFILES, type PermissionProfile } from '../../permissions/policy.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { toPolarisError, turnFailure } from './errors.ts';
import {
  ClaudeToolTranslator,
  claudeAccess,
  DENIED_TOOLS,
  permissionBridge,
  SKILL_SERVER,
  toolsFor,
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

function systemPrompt(profile: PermissionProfile): string {
  const shared = [
    'You are Polaris, a coding assistant running inside an interactive terminal CLI.',
    'Answer in plain text: the terminal does not render Markdown yet.',
    'You can inspect the workspace with Read, Glob and Grep; look at the code before',
    'answering questions about it.',
  ];
  if (profile === 'read-only') {
    return [
      ...shared,
      'Your access is read-only: you cannot create, edit, move or delete files, or run',
      'commands. If asked to change something, say so and describe the change instead.',
    ].join(' ');
  }
  return [
    ...shared,
    'You can change files with Write and Edit and run commands with Bash, always inside',
    'the workspace root.',
    profile === 'ask'
      ? 'The user approves every write, edit and command individually.'
      : 'The user approves every command individually; workspace edits apply directly.',
    'If the user refuses an operation, do not repeat it: explain what you wanted to do or',
    'suggest an alternative.',
    COMPLETION_GUIDANCE,
  ].join(' ');
}

/**
 * v0.5 gives the runtime exactly three read-only tools, four locks deep:
 * `tools` defines the only built-ins that exist, `disallowedTools` strips the
 * mutating ones from the request, `dontAsk` turns any prompt into a denial, and
 * a PreToolUse hook enforces the workspace boundary on every call. Settings,
 * skills, plugins and CLAUDE.md stay unloaded (`settingSources: []`), so
 * nothing on disk can widen that surface.
 */
const BASE_OPTIONS: Options = {
  disallowedTools: DENIED_TOOLS,
  // `default` is what routes prompts to `canUseTool`; the profile decides what
  // that callback does with them. `dontAsk` would deny instead of asking, and
  // `acceptEdits`/`bypassPermissions` would take the decision away from the
  // user — the one thing v0.6 exists to prevent.
  permissionMode: 'default',
  settingSources: [],
  // Only the MCP servers Polaris passes exist: no project `.mcp.json`, no
  // user settings, no plugins.
  strictMcpConfig: true,
  includePartialMessages: true,
  persistSession: false,
};

/** Escape hatch documented in the SDK for installs without the bundled binary. */
const EXECUTABLE = process.env.POLARIS_CLAUDE_EXECUTABLE;

export function createClaudeProvider(run: QueryFn = query): ModelProvider {
  return {
    id: 'claude',
    supports: PERMISSION_PROFILES,
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
      // The runtime reports a *running total* on every result, not a delta, so
      // this is replaced each turn. Summing them would multiply the session's
      // usage by the number of turns — the opposite mistake to the one the
      // Messages API's per-request counts require.
      let latest: UsageReport | null = null;
      let effort: EffortLevel | undefined =
        session.effort === undefined ? undefined : asEffort(session.effort);
      const translator = new ClaudeToolTranslator(session.cwd);
      const context = session.context;

      function start(): ClaudeRun {
        if (active) return active;
        try {
          active = run({
            prompt: queue,
            options: {
              ...BASE_OPTIONS,
              cwd: session.cwd,
              // Fixed for the life of the runtime session: the SDK takes the
              // system prompt when `query()` starts.
              systemPrompt: [
                systemPrompt(session.permissions),
                context?.instructions({ canLoad: true }),
              ]
                .filter(Boolean)
                .join('\n\n'),
              ...(context?.hasSkills
                ? // The permission bridge allows these two itself; `allowedTools`
                  // would bypass it and makes the SDK warn on stderr.
                  { mcpServers: { [SKILL_SERVER]: skillServer(context) } }
                : {}),
              tools: toolsFor(session.permissions),
              canUseTool: permissionBridge(session.cwd, session.gate),
              hooks: {
                PreToolUse: [{ hooks: [workspaceGuard(session.cwd, session.permissions)] }],
              },
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
        access: claudeAccess(session.permissions),
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
          // A skill the user loaded after the session started cannot join the
          // system prompt, so it travels with this message instead, once.
          const pending = context?.pending();
          queue.push({
            type: 'user',
            message: {
              role: 'user',
              content: pending
                ? [
                    { type: 'text', text: pending },
                    { type: 'text', text: input },
                  ]
                : input,
            },
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
                latest = toUsageReport(message);
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
        async usage() {
          return latest;
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
 * Skill loading through the Agent SDK's own custom-tool mechanism: an
 * in-process MCP server. The reply carries the skill's instructions, which is
 * how they enter a conversation whose system prompt is already fixed.
 */
function skillServer(context: SessionContext) {
  const reply = ({ ok, text }: { ok: boolean; text: string }) => ({
    content: [{ type: 'text' as const, text }],
    ...(ok ? {} : { isError: true }),
  });
  return createSdkMcpServer({
    name: SKILL_SERVER,
    tools: [
      tool(LOAD_SKILL, LOAD_SKILL_DESCRIPTION, { name: z.string() }, async ({ name }) =>
        reply(await context.loadSkill(name, { inline: true })),
      ),
      tool(
        READ_SKILL_REFERENCE,
        READ_REFERENCE_DESCRIPTION,
        { skill: z.string(), path: z.string() },
        async ({ skill, path }) => reply(await context.readReference(skill, path)),
      ),
    ],
  });
}

/**
 * The runtime's own accounting, translated. `modelUsage` is keyed by the model
 * string it served, and carries the context window and the price it was
 * charged at, so Polaris neither counts tokens nor prices them itself here.
 */
export function toUsageReport(message: SDKMessage & { type: 'result' }): UsageReport | null {
  const byModel = (message as { modelUsage?: Record<string, RuntimeModelUsage> }).modelUsage ?? {};
  const models: ModelUsage[] = Object.entries(byModel).map(([id, usage]) => ({
    model: usage.canonicalModel ?? id,
    tokens: {
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      ...(usage.cacheReadInputTokens === undefined
        ? {}
        : { cacheRead: usage.cacheReadInputTokens }),
      ...(usage.cacheCreationInputTokens === undefined
        ? {}
        : { cacheWrite: usage.cacheCreationInputTokens }),
      ...(usage.thinkingTokens === undefined ? {} : { reasoning: usage.thinkingTokens }),
    },
    ...(usage.costUSD === undefined ? {} : { costUsd: usage.costUSD }),
    ...(usage.contextWindow ? { contextWindow: usage.contextWindow } : {}),
  }));

  const cost = (message as { total_cost_usd?: number }).total_cost_usd;
  if (models.length === 0 && cost === undefined) return null;
  return {
    models,
    limits: [],
    ...(cost === undefined ? {} : { costUsd: cost }),
    note: 'Reported by the Claude runtime for this session; cost is an estimate, not a bill.',
  };
}

/** The slice of the SDK's `ModelUsage` Polaris reads. */
interface RuntimeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
  canonicalModel?: string;
}

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
