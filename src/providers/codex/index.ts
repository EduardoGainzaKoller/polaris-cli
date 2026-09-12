import { PolarisError } from '../../core/errors.ts';
import { debug } from '../../core/logger.ts';
import { VERSION } from '../../version.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';
import { type Connect, connectToAppServer, type JsonObject } from './app-server.ts';
import { notAuthenticated, toPolarisError, turnFailed } from './errors.ts';

/**
 * v0.3 integrates the Codex runtime, not its capabilities: the thread runs
 * read-only and never asks for approvals, and any approval request that reaches
 * us anyway is declined. Polaris has no approval UI yet, and silently accepting
 * would be the wrong default.
 */
const THREAD_DEFAULTS = { sandbox: 'read-only', approvalPolicy: 'never' } as const;

/**
 * Codex streams far more than Polaris renders today — reasoning deltas, plans,
 * command output, file diffs, token usage, rate limits. They are ignored on
 * purpose: `ModelEvent` grows in a later phase, and an unknown notification must
 * never break a session.
 */
const RENDERED = 'item/agentMessage/delta';

export function createCodexProvider(connect: Connect = connectToAppServer): ModelProvider {
  return {
    id: 'codex',
    async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
      const connection = await connect();
      const turns = new TurnRouter();
      connection.onNotification((method, params) => turns.handle(method, params));
      connection.onRequest(decline);
      connection.onClose((error) => turns.abortAll(error));

      let threadId: string;
      let model: string;
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

        const thread = await connection.request<ThreadStartResponse>('thread/start', {
          cwd: options.cwd,
          ...THREAD_DEFAULTS,
          ...(options.model ? { model: options.model } : {}),
        });
        threadId = thread.thread.id;
        // The runtime reports the model it actually resolved; Polaris never
        // invents one.
        model = thread.model;
        debug('codex', 'thread', threadId, 'model', model);
      } catch (error) {
        await connection.close();
        throw wrap(error);
      }

      return {
        get model() {
          return model;
        },
        async *send(input, signal): AsyncIterable<ModelEvent> {
          signal?.throwIfAborted();
          const turn = turns.open();
          let turnId: string;
          try {
            const started = await connection.request<TurnStartResponse>('turn/start', {
              threadId,
              input: [{ type: 'text', text: input, text_elements: [] }],
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

/**
 * Polaris never grants tool approvals yet, so every approval request is
 * declined explicitly. Answering (instead of ignoring) matters: an unanswered
 * request would stall the turn forever.
 */
function decline(method: string): unknown {
  if (method.endsWith('requestApproval')) return { decision: 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: { denied: { rejection: 'Polaris does not grant approvals.' } } };
  }
  throw new Error(`unsupported request ${method}`);
}

type TurnEvent =
  | { type: 'delta'; text: string }
  | { type: 'completed' }
  | { type: 'failed'; detail: string | undefined };

/** Routes the App Server's turn-scoped notifications to the turn awaiting them. */
class TurnRouter {
  #open = new Set<Turn>();
  #byId = new Map<string, Turn>();

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
      if (text.length > 0) this.#route(turnId)?.push({ type: 'delta', text });
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

function detailOf(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return undefined;
}

interface ThreadStartResponse {
  thread: { id: string };
  model: string;
}

interface TurnStartResponse {
  turn: { id: string };
}
