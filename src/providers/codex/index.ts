import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import { PERMISSION_PROFILES } from '../../permissions/policy.ts';
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
 * network capability.
 */
const THREAD_DEFAULTS = { config: { web_search: 'disabled' } } as const;

/**
 * Codex streams far more than Polaris renders. Agent text and tool-like items
 * (commands, file changes, searches) are translated; reasoning deltas, plans,
 * command output streams, diffs, token usage and rate limits are ignored on
 * purpose, and an unknown notification never breaks a session.
 */
const RENDERED = 'item/agentMessage/delta';

export function createCodexProvider(connect: Connect = connectToAppServer): ModelProvider {
  return {
    id: 'codex',
    supports: PERMISSION_PROFILES,
    async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
      const connection = await connect();
      const turns = new TurnRouter(options.cwd);
      connection.onNotification((method, params) => {
        if (method === 'thread/tokenUsage/updated') tokens = toTokens(params) ?? tokens;
        else if (method === 'account/rateLimits/updated') {
          rateLimits = (params as RateLimitsResponse).rateLimits ?? rateLimits;
        }
        turns.handle(method, params);
      });
      connection.onRequest(async (method, params) => {
        const card = toCard(method, params, (itemId) => turns.changesOf(itemId), options.cwd);
        if (!card) {
          // Anything Polaris cannot present is refused rather than guessed at:
          // a silent yes to an unknown request is the worst possible default.
          debug('codex', 'declining unsupported request', method);
          return toDecision(method, false);
        }
        const { capability, ...request } = card;
        const verdict = await options.gate.authorize(capability, request);
        return toDecision(method, verdict.allowed);
      });
      connection.onClose((error) => turns.abortAll(error));

      let threadId: string;
      let model: string;
      // Sent with every turn once chosen: Codex takes effort per turn, so a
      // change never needs a new thread.
      let effort: string | undefined = options.effort;
      // Both halves of the usage picture arrive unprompted: the thread pushes
      // its token totals, and the account pushes rate limits when they move.
      // Keeping the latest of each means /status can answer instantly and
      // still refresh from the server when it can.
      let tokens: ReturnType<typeof toTokens> = null;
      let rateLimits: RateLimitsResponse['rateLimits'] = null;
      try {
        await connection.request('initialize', {
          // Honest identification: Polaris is Polaris, not another client.
          clientInfo: { name: 'polaris', title: 'Polaris', version: VERSION },
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

        // An administrator can restrict which sandboxes and approval policies
        // this install may use. Polaris asks first and reports the restriction
        // instead of trying a value it is not allowed to set.
        const policy = threadPolicy(options.permissions);
        const requirements = (
          await connection.request<ConfigRequirementsResponse>('configRequirements/read', {})
        )?.requirements;
        const allowedSandboxes = requirements?.allowedSandboxModes ?? null;
        if (allowedSandboxes && !allowedSandboxes.includes(policy.sandbox)) {
          throw adminRestricted('sandbox', policy.sandbox, allowedSandboxes);
        }
        const allowedPolicies = requirements?.allowedApprovalPolicies ?? null;
        if (allowedPolicies && !allowedPolicies.includes(policy.approvalPolicy)) {
          throw adminRestricted('approval policy', policy.approvalPolicy, allowedPolicies);
        }

        const thread = await connection.request<ThreadStartResponse>('thread/start', {
          cwd: options.cwd,
          ...THREAD_DEFAULTS,
          ...policy,
          ...(options.model ? { model: options.model } : {}),
        });
        threadId = thread.thread.id;
        // The runtime reports the model it actually resolved; Polaris never
        // invents one.
        model = thread.model;
        effort ??= thread.reasoningEffort ?? undefined;
        debug('codex', 'thread', threadId, 'model', model, 'effort', effort ?? 'default');
      } catch (error) {
        await connection.close();
        throw wrap(error);
      }

      const listModels = async () =>
        (await connection.request<ModelListResponse>('model/list', { limit: 50 })).data ?? [];

      /** What the current model accepts, straight from Codex's model catalog. */
      const supportedEfforts = async () => {
        const entry = (await listModels()).find((candidate) =>
          [candidate.model, candidate.id].includes(model),
        );
        return (entry?.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort);
      };

      return {
        access: codexAccess(options.permissions),
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
            const started = await connection.request<TurnStartResponse>('turn/start', {
              threadId,
              input: [{ type: 'text', text: input, text_elements: [] }],
              ...(effort ? { effort } : {}),
            });
            turnId = started.turn.id;
            turns.bind(turn, turnId);
          } catch (error) {
            turns.close(turn);
            throw wrap(error);
          }

          // Ctrl+C interrupts this turn only; the thread stays alive and the
          // next prompt reuses it. Codex owns whatever its transcript keeps of
          // the interrupted answer — Polaris adds no rules of its own.
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
        async listModels() {
          return (await listModels())
            .filter((entry) => !entry.hidden)
            .map((entry) => entry.model ?? entry.id);
        },
        async close() {
          turns.abortAll(new Error('session closed'));
          await connection.close();
        },
      };
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
      target.push(
        turn?.status === 'failed'
          ? { type: 'failed', detail: detailOf(turn?.error) }
          : { type: 'completed' },
      );
      return;
    }
    if (method === 'error') {
      this.#route(turnId)?.push({ type: 'failed', detail: detailOf(params) });
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
      if (item.type === 'fileChange') this.#changes.set(item.id as string, fileChanges(item));
      if (method === 'item/fileChange/patchUpdated') return;
      const event = method === 'item/started' ? itemStarted(item, this.#cwd) : itemCompleted(item);
      this.#route(turnId)?.push({ type: 'tool', event });
      return;
    }
    debug('codex', 'ignoring', method);
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
