import {
  DELEGATE_TASK,
  DELEGATE_TASK_DESCRIPTION,
  DELEGATE_TASK_SCHEMA,
  LOAD_SKILL,
  LOAD_SKILL_DESCRIPTION,
  READ_REFERENCE_DESCRIPTION,
  READ_SKILL_REFERENCE,
  type SessionContext,
} from '../../context/manager.ts';
import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import { COMPLETION_GUIDANCE } from '../../core/verification.ts';
import { AUTONOMY_GUIDANCE, PERMISSION_PROFILES } from '../../permissions/policy.ts';
import { VERSION } from '../../version.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { type Connect, connectToAppServer, type JsonObject } from './app-server.ts';
import { type FileChange, threadPolicy, toCard, toDecision } from './approvals.ts';
import { adminRestricted, notAuthenticated, toPolarisError, turnFailed } from './errors.ts';
import { codexAccess, isToolItem, itemCompleted, itemStarted } from './items.ts';
import { buildReport, type RateLimitsResponse, toTokens } from './usage.ts';

/**
 * Codex keeps its own agent loop and runs inside its own OS sandbox. Polaris
 * chooses which sandbox and which approval policy from the active profile —
 * never `danger-full-access` — and lets Codex enforce it. Web search is turned
 * off explicitly, whatever the user's Codex config says, because v0.6 has no
 * network capability. So are Codex's own subagents (`multi_agent`): agents
 * are Polaris's, defined, limited and isolated by Polaris — a thread Codex
 * spawned on its own would have no gate Polaris could route it to.
 */
const THREAD_DEFAULTS = {
  config: { web_search: 'disabled', 'features.multi_agent': false },
} as const;

/**
 * Codex streams far more than Polaris renders. Agent text and tool-like items
 * (commands, file changes, searches) are translated; reasoning deltas, plans,
 * command output streams, diffs, token usage and rate limits are ignored on
 * purpose, and an unknown notification never breaks a session.
 */
const RENDERED = 'item/agentMessage/delta';

/** One conversation on the App Server: the main agent's thread, or an agent's. */
interface ThreadHost {
  readonly options: ProviderSessionOptions;
  readonly turns: TurnRouter;
}

interface StartedThread {
  readonly id: string;
  readonly model: string;
  readonly effort: string | undefined;
}

export function createCodexProvider(connect: Connect = connectToAppServer): ModelProvider {
  return {
    id: 'codex',
    supports: PERMISSION_PROFILES,
    async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
      const connection = await connect();
      // Every thread on this connection, by id. Notifications and requests
      // name their thread, so an agent's thread and the main one never mix:
      // an approval is put to the right gate, a delta reaches the right turn.
      const hosts = new Map<string, ThreadHost>();
      let mainId: string | null = null;
      /** The thread a message is about; a message naming no thread is the session's. */
      const hostOf = (params: JsonObject): ThreadHost | undefined => {
        if (typeof params.threadId === 'string') return hosts.get(params.threadId);
        return mainId ? hosts.get(mainId) : undefined;
      };

      // Both halves of the usage picture arrive unprompted: the thread pushes
      // its token totals, and the account pushes rate limits when they move.
      // Keeping the latest of each means /status can answer instantly and
      // still refresh from the server when it can. Tokens are the main
      // thread's: an agent's thread is accounted by Codex, not shown here.
      let tokens: ReturnType<typeof toTokens> = null;
      let rateLimits: RateLimitsResponse['rateLimits'] = null;

      connection.onNotification((method, params) => {
        if (method === 'account/rateLimits/updated') {
          rateLimits = (params as RateLimitsResponse).rateLimits ?? rateLimits;
        }
        const host = hostOf(params);
        // Any notification is the runtime being alive: reasoning, plans, token
        // counts — none of them rendered, all of them real.
        (host?.options.activity ?? options.activity)?.pulse();
        if (!host) return;
        if (method === 'thread/tokenUsage/updated' && host === hosts.get(mainId ?? '')) {
          tokens = toTokens(params) ?? tokens;
        }
        host.turns.handle(method, params);
      });
      connection.onRequest(async (method, params) => {
        const host = hostOf(params);
        // A model asking for a skill or an agent: answered by Polaris.
        if (method === 'item/tool/call') {
          const context = host?.options.context;
          const reply = context
            ? await answerToolCall(context, params)
            : { ok: false, text: 'No such tool.' };
          return { contentItems: [{ type: 'inputText', text: reply.text }], success: reply.ok };
        }
        const card = host
          ? toCard(method, params, (itemId) => host.turns.changesOf(itemId), host.options.cwd)
          : null;
        if (!host || !card) {
          // Anything Polaris cannot present is refused rather than guessed at:
          // a silent yes to an unknown request is the worst possible default.
          debug(
            'codex',
            'declining',
            host ? 'unsupported request' : 'request from a thread Polaris did not start',
            method,
            String(params.threadId),
            [...hosts.keys()].join(','),
          );
          return toDecision(method, false);
        }
        const { operation, ...request } = card;
        // Each thread's own gate: an agent's refuses what its ceiling excludes.
        const verdict = await host.options.gate.authorize(operation, request);
        return toDecision(method, verdict.allowed);
      });
      connection.onClose((error) => {
        for (const host of hosts.values()) host.turns.abortAll(error);
      });

      // Registering Polaris's own tools on a thread (`dynamicTools`) is an
      // experimental App Server field; opted into only when there is
      // something to offer: skills to load, or agents to delegate to.
      const wantsTools =
        options.context?.hasSkills === true || options.context?.canDelegate === true;
      let dynamicTools = wantsTools;
      let requirements: ConfigRequirementsResponse['requirements'] = null;

      /**
       * An administrator can restrict which sandboxes and approval policies
       * this install may use. Polaris asks first and reports the restriction
       * instead of trying a value it is not allowed to set — for an agent's
       * thread as for the main one.
       */
      const policyFor = (profile: ProviderSessionOptions['permissions']) => {
        const policy = threadPolicy(profile);
        const allowedSandboxes = requirements?.allowedSandboxModes ?? null;
        if (allowedSandboxes && !allowedSandboxes.includes(policy.sandbox)) {
          throw adminRestricted('sandbox', policy.sandbox, allowedSandboxes);
        }
        const allowedPolicies = requirements?.allowedApprovalPolicies ?? null;
        if (allowedPolicies && !allowedPolicies.includes(policy.approvalPolicy)) {
          throw adminRestricted('approval policy', policy.approvalPolicy, allowedPolicies);
        }
        return policy;
      };

      /**
       * A new thread with exactly the context Polaris gives it. Codex keeps
       * its own system prompt; Polaris adds how to finish, and the project's
       * context — or an agent's role and context — as developer instructions.
       * Never `thread/fork`: a fork copies the conversation, and an agent's
       * thread must start with nothing of it.
       */
      const startThread = async (
        thread: ProviderSessionOptions,
        extra: { ephemeral?: boolean; model?: string } = {},
      ): Promise<StartedThread> => {
        const policy = policyFor(thread.permissions);
        const context = thread.context;
        const start = (canLoad: boolean) => {
          const developerInstructions = [
            thread.permissions === 'read-only' ? '' : `${AUTONOMY_GUIDANCE} ${COMPLETION_GUIDANCE}`,
            context?.instructions({ canLoad }) ?? '',
          ]
            .filter(Boolean)
            .join('\n\n');
          const tools = canLoad && context ? polarisTools(context) : [];
          const model = extra.model ?? thread.model;
          return connection.request<ThreadStartResponse>('thread/start', {
            cwd: thread.cwd,
            ...THREAD_DEFAULTS,
            ...policy,
            ...(developerInstructions ? { developerInstructions } : {}),
            ...(tools.length > 0 ? { dynamicTools: tools } : {}),
            ...(model ? { model } : {}),
            // An agent's thread is one-shot: nothing of it is kept on disk.
            ...(extra.ephemeral ? { ephemeral: true } : {}),
          });
        };
        const canLoad =
          dynamicTools && (context?.hasSkills === true || context?.canDelegate === true);
        let started: ThreadStartResponse;
        try {
          started = await start(canLoad);
        } catch (error) {
          if (!canLoad) throw error;
          // A Codex without the experimental field still gets the context;
          // skills are then loaded by the user with /skill, the catalog says
          // so, and the main agent works without agents.
          debug('codex', 'dynamic tools refused, no model-loaded skills or delegation', error);
          dynamicTools = false;
          started = await start(false);
        }
        return {
          id: started.thread.id,
          // The runtime reports the model it actually resolved; Polaris never
          // invents one.
          model: started.model,
          effort: started.reasoningEffort ?? undefined,
        };
      };

      let main: StartedThread;
      try {
        await connection.request('initialize', {
          // Honest identification: Polaris is Polaris, not another client.
          clientInfo: { name: 'polaris', title: 'Polaris', version: VERSION },
          ...(wantsTools ? { capabilities: { experimentalApi: true } } : {}),
        });
        connection.notify('initialized', {});

        // Authentication belongs to Codex. Polaris only asks whether a method is
        // configured — never for the token itself — so a missing login is a
        // clean message instead of a failed turn.
        const auth = await connection.request<{ authMethod: string | null }>('getAuthStatus', {
          includeToken: false,
          refreshToken: false,
        });
        if (!auth?.authMethod) throw notAuthenticated();
        debug('codex', 'authenticated via', auth.authMethod);

        requirements =
          (await connection.request<ConfigRequirementsResponse>('configRequirements/read', {}))
            ?.requirements ?? null;
        main = await startThread(options);
        mainId = main.id;
        debug('codex', 'thread', main.id, 'model', main.model, 'effort', main.effort ?? 'default');
      } catch (error) {
        await connection.close();
        throw wrap(error);
      }

      const listModels = async () =>
        (await connection.request<ModelListResponse>('model/list', { limit: 50 })).data ?? [];

      /**
       * A ModelSession for one thread. The main thread owns the connection;
       * an agent's thread only borrows it, so closing it unsubscribes that
       * thread and leaves the process — and the main thread — running.
       */
      const sessionFor = (
        thread: ProviderSessionOptions,
        started: StartedThread,
        role: 'main' | 'agent',
      ): ModelSession => {
        const threadId = started.id;
        const turns = new TurnRouter(thread.cwd);
        hosts.set(threadId, { options: thread, turns });
        const context = thread.context;
        const model = started.model;
        // Sent with every turn once chosen: Codex takes effort per turn, so a
        // change never needs a new thread.
        let effort: string | undefined = thread.effort ?? started.effort;

        /** What the current model accepts, straight from Codex's model catalog. */
        const supportedEfforts = async () => {
          const entry = (await listModels()).find((candidate) =>
            [candidate.model, candidate.id].includes(model),
          );
          return (entry?.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort);
        };

        const session: ModelSession = {
          access: codexAccess(thread.permissions),
          get model() {
            return model;
          },
          get effort() {
            return effort;
          },
          efforts: supportedEfforts,
          async setEffort(level) {
            const supported = await supportedEfforts();
            if (supported.length > 0 && !supported.includes(level)) {
              throw new PolarisError(
                `${model} does not support effort "${level}". Use one of: ${supported.join(', ')}.`,
              );
            }
            effort = level;
          },
          async *send(input, signal): AsyncIterable<ModelEvent> {
            signal?.throwIfAborted();
            const turn = turns.open();
            let turnId: string;
            try {
              // A skill loaded with /skill after the thread started travels with
              // this message, once: developer instructions are fixed per thread.
              const pending = context?.pending();
              const response = await connection.request<TurnStartResponse>('turn/start', {
                threadId,
                input: [
                  ...(pending ? [{ type: 'text', text: pending, text_elements: [] }] : []),
                  { type: 'text', text: input, text_elements: [] },
                ],
                ...(effort ? { effort } : {}),
              });
              turnId = response.turn.id;
              turns.bind(turn, turnId);
            } catch (error) {
              turns.close(turn);
              throw wrap(error);
            }

            // Ctrl+C interrupts this thread's turn only; the thread stays alive
            // and the next prompt reuses it. An agent's interrupt never reaches
            // the main thread, nor the main's an agent's.
            const onAbort = () => {
              void connection
                .request('turn/interrupt', { threadId, turnId })
                .catch((error: unknown) => debug('codex', 'interrupt failed', String(error)));
            };
            signal?.addEventListener('abort', onAbort, { once: true });

            try {
              yield { type: 'message-start' };
              for await (const event of turn.drain()) {
                if (event.type === 'delta') {
                  yield { type: 'text-delta', text: event.text };
                  continue;
                }
                if (event.type === 'tool') {
                  yield event.event;
                  continue;
                }
                if (signal?.aborted) signal.throwIfAborted();
                if (event.type === 'failed') throw turnFailed(event.detail);
              }
              if (signal?.aborted) signal.throwIfAborted();
              yield { type: 'message-end' };
            } catch (error) {
              if (signal?.aborted) throw error;
              throw wrap(error);
            } finally {
              signal?.removeEventListener('abort', onAbort);
              turns.close(turn);
            }
          },
          async listModels() {
            return (await listModels())
              .filter((entry) => !entry.hidden)
              .map((entry) => entry.model ?? entry.id);
          },
          async close() {
            turns.abortAll(new Error('session closed'));
            hosts.delete(threadId);
            if (role === 'main') {
              for (const host of hosts.values()) host.turns.abortAll(new Error('session closed'));
              hosts.clear();
              await connection.close();
              return;
            }
            await connection
              .request('thread/unsubscribe', { threadId })
              .catch((error: unknown) => debug('codex', 'unsubscribe failed', String(error)));
            debug('codex', 'agent thread', threadId, 'released');
          },
        };
        if (role === 'agent') return session;

        return {
          ...session,
          // Spread copies values, not accessors: these stay live.
          get model() {
            return session.model;
          },
          get effort() {
            return session.effort;
          },
          async usage() {
            // Ask the account for the current windows, but never let a failed
            // read hide the tokens we already have: a usage view that refuses
            // to render because one number is missing is worse than a partial one.
            try {
              const fresh = await connection.request<RateLimitsResponse>(
                'account/rateLimits/read',
                {},
              );
              rateLimits = fresh?.rateLimits ?? rateLimits;
            } catch (error) {
              debug('codex', 'rate limits unavailable', String(error));
            }
            return buildReport(model, tokens, rateLimits);
          },
          /**
           * An agent's thread on this same App Server: a new, ephemeral thread
           * with only the context Polaris gives it — no second process to
           * start, and nothing of this conversation carried over.
           */
          async createChild(child) {
            const started = await startThread(child, {
              ephemeral: true,
              model: child.model ?? model,
            }).catch((error: unknown) => {
              throw wrap(error);
            });
            debug('codex', 'agent thread', started.id, 'on the main connection');
            const inherited = child.effort ?? effort;
            return sessionFor(
              inherited ? { ...child, effort: inherited } : child,
              started,
              'agent',
            );
          },
        };
      };

      return sessionFor(options, main, 'main');
    },
  };
}

export const codexProvider: ModelProvider = createCodexProvider();

function wrap(error: unknown): Error {
  return error instanceof PolarisError ? error : toPolarisError(error);
}

type TurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; event: ModelEvent }
  | { type: 'completed' }
  | { type: 'failed'; detail: string | undefined };

/** Routes the App Server's turn-scoped notifications to the turn awaiting them. */
class TurnRouter {
  #open = new Set<Turn>();
  #byId = new Map<string, Turn>();
  /**
   * The proposed changes of each fileChange item, kept from `item/started`.
   * The approval request that follows carries only ids, so without this the
   * card would have no diff to show — and a change nobody can see is a change
   * nobody can consent to.
   */
  #changes = new Map<string, FileChange[]>();
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  changesOf(itemId: string): FileChange[] | undefined {
    return this.#changes.get(itemId);
  }

  open(): Turn {
    const turn = new Turn();
    this.#open.add(turn);
    return turn;
  }

  bind(turn: Turn, id: string): void {
    turn.id = id;
    this.#byId.set(id, turn);
  }

  close(turn: Turn): void {
    this.#open.delete(turn);
    if (turn.id) this.#byId.delete(turn.id);
    turn.end();
  }

  abortAll(error: Error): void {
    for (const turn of this.#open) turn.fail(error);
  }

  handle(method: string, params: JsonObject): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;

    if (method === RENDERED) {
      const text = typeof params.delta === 'string' ? params.delta : '';
      const turn = this.#route(turnId);
      if (!turn || text.length === 0) return;
      // Codex may answer in several agent messages; keep them as paragraphs
      // instead of running the second one into the first.
      const itemId = typeof params.itemId === 'string' ? params.itemId : undefined;
      if (itemId && turn.lastItem && turn.lastItem !== itemId) {
        turn.push({ type: 'delta', text: '\n\n' });
      }
      if (itemId) turn.lastItem = itemId;
      turn.push({ type: 'delta', text });
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn as { id?: string; status?: string; error?: unknown } | undefined;
      const target = this.#route(turn?.id);
      if (!target) return;
      if (turn?.status === 'failed') debug('codex', 'turn failed', JSON.stringify(turn.error));
      target.push(
        turn?.status === 'failed'
          ? { type: 'failed', detail: detailOf(turn?.error) }
          : { type: 'completed' },
      );
      return;
    }
    if (method === 'error') {
      debug('codex', 'error notification', JSON.stringify(params));
      // "Reconnecting… 2/5": Codex is retrying on its own. The turn is still
      // alive — only an error it will not retry ends it.
      if (params.willRetry === true) return;
      // The reason is under `error`: `{ error: { message }, willRetry }`.
      this.#route(turnId)?.push({ type: 'failed', detail: detailOf(params.error ?? params) });
      return;
    }
    // Long commands print as they go; the UI shows it live, and what the model
    // finally reads is Codex's own item result.
    if (method === 'item/commandExecution/outputDelta') {
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (itemId && delta) {
        this.#route(turnId)?.push({
          type: 'tool',
          event: { type: 'tool-output-delta', id: itemId, text: delta },
        });
      }
      return;
    }
    if (
      (method === 'item/started' ||
        method === 'item/completed' ||
        method === 'item/fileChange/patchUpdated') &&
      isToolItem(params.item)
    ) {
      const item = params.item;
      // Skill loads and delegations are shown by Polaris, not as tools.
      if (item.type === 'dynamicToolCall' && SKILL_TOOL_NAMES.has(String(item.tool ?? ''))) return;
      if (item.type === 'fileChange') this.#changes.set(item.id as string, fileChanges(item));
      if (method === 'item/fileChange/patchUpdated') return;
      const event = method === 'item/started' ? itemStarted(item, this.#cwd) : itemCompleted(item);
      this.#route(turnId)?.push({ type: 'tool', event });
      return;
    }
    debug('codex', 'ignoring', method, String((params.item as JsonObject | undefined)?.type ?? ''));
  }

  /** Before `turn/start` answers we do not know the id yet, so a lone open turn claims it. */
  #route(id: string | undefined): Turn | undefined {
    if (id && this.#byId.has(id)) return this.#byId.get(id);
    if (this.#open.size === 1) return [...this.#open][0];
    return undefined;
  }
}

class Turn {
  id: string | undefined;
  /** The agent message the latest text delta belonged to. */
  lastItem: string | undefined;
  #queue: TurnEvent[] = [];
  #wake: (() => void) | null = null;
  #done = false;
  #error: Error | null = null;

  push(event: TurnEvent): void {
    this.#queue.push(event);
    this.#wake?.();
    this.#wake = null;
  }

  fail(error: Error): void {
    this.#error = error;
    this.end();
  }

  end(): void {
    this.#done = true;
    this.#wake?.();
    this.#wake = null;
  }

  async *drain(): AsyncIterable<TurnEvent> {
    while (true) {
      const next = this.#queue.shift();
      if (next) {
        yield next;
        if (next.type === 'completed' || next.type === 'failed') return;
        continue;
      }
      if (this.#error) throw this.#error;
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

const SKILL_TOOL_NAMES = new Set<string>([LOAD_SKILL, READ_SKILL_REFERENCE, DELEGATE_TASK]);

/** `dynamicTools` entries for thread/start. */
const SKILL_TOOLS = [
  {
    type: 'function',
    name: LOAD_SKILL,
    description: LOAD_SKILL_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: READ_SKILL_REFERENCE,
    description: READ_REFERENCE_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string' }, path: { type: 'string' } },
      required: ['skill', 'path'],
      additionalProperties: false,
    },
  },
];

const DELEGATE_TOOL = {
  type: 'function',
  name: DELEGATE_TASK,
  description: DELEGATE_TASK_DESCRIPTION,
  inputSchema: DELEGATE_TASK_SCHEMA,
};

/** What Polaris offers a thread: skill loading, and delegation for the main agent. */
function polarisTools(context: SessionContext): object[] {
  return [
    ...(context.hasSkills ? SKILL_TOOLS : []),
    ...(context.canDelegate ? [DELEGATE_TOOL] : []),
  ];
}

/**
 * `item/tool/call`: the reply carries a skill's text, or an agent's result,
 * into the thread. A delegation answers once the agent's run has ended.
 */
async function answerToolCall(
  context: SessionContext,
  params: JsonObject,
): Promise<{ ok: boolean; text: string }> {
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if (params.tool === DELEGATE_TASK) {
    return context.delegate(String(args.agent ?? ''), String(args.task ?? ''));
  }
  if (params.tool === LOAD_SKILL) {
    return context.loadSkill(String(args.name ?? ''), { inline: true });
  }
  if (params.tool === READ_SKILL_REFERENCE) {
    return context.readReference(String(args.skill ?? ''), String(args.path ?? ''));
  }
  return { ok: false, text: `No tool named ${String(params.tool)}.` };
}

function fileChanges(item: JsonObject): FileChange[] {
  const changes = (Array.isArray(item.changes) ? item.changes : []) as Array<{
    path?: string;
    diff?: string;
  }>;
  return changes.map((change) => ({ path: change.path ?? '', diff: change.diff ?? '' }));
}

function detailOf(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return undefined;
}

/** `configRequirements/read`; null when no administrator policy applies. */
interface ConfigRequirementsResponse {
  requirements?: {
    allowedSandboxModes?: string[] | null;
    allowedApprovalPolicies?: string[] | null;
  } | null;
}

interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  reasoningEffort?: string | null;
}

interface TurnStartResponse {
  turn: { id: string };
}

/** `model/list`, as generated by `codex app-server generate-ts`. */
interface ModelListResponse {
  data?: Array<{
    id: string;
    model?: string;
    hidden?: boolean;
    supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  }>;
}
