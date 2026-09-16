import { basename } from 'node:path';
import type { PolarisConfig } from '../config/config.ts';
import type { ModelEvent, ToolAccess } from '../providers/provider.ts';
import { PolarisError, toUserMessage } from './errors.ts';
import { debug } from './logger.ts';
import { Session } from './session.ts';

/**
 * What the UI is allowed to know. Every renderer — the Ink TUI today, a plain
 * line-based one for pipes, a future `polaris run` — reads this and nothing
 * else, so no provider detail can leak into a component.
 */
export type AppStatus =
  | 'ready'
  | 'thinking'
  | 'streaming'
  | 'reading'
  | 'searching'
  | 'working'
  | 'switching'
  | 'cancelled'
  | 'error';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
/** For a tool, `streaming` means still running. */
export type MessageState = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface ToolCall {
  /** Human name: Read, Glob, Grep… */
  readonly name: string;
  readonly target: string;
  /** Outcome once finished: a summary, or the error. */
  readonly detail?: string;
}

export interface UiMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly state: MessageState;
  readonly tool?: ToolCall;
}

export interface AppState {
  readonly cwd: string;
  readonly project: string;
  readonly provider: string;
  readonly model: string;
  readonly status: AppStatus;
  readonly busy: boolean;
  readonly messages: readonly UiMessage[];
  readonly turns: number;
  /** What the provider may do to the workspace; read-only in v0.5. */
  readonly access: ToolAccess | null;
}

/**
 * Headless session controller. It owns the *presentation* transcript, which is
 * never the source of truth for a provider: `anthropic-api` replays its own
 * message list, the Claude runtime keeps its session and Codex keeps its
 * thread. Clearing the transcript therefore clears pixels, not context.
 */
export class PolarisApp {
  readonly cwd: string;

  #config: PolarisConfig;
  #session: Session;
  #messages: UiMessage[] = [];
  #status: AppStatus = 'ready';
  #turn: AbortController | null = null;
  #listeners = new Set<(state: AppState) => void>();
  #nextId = 0;

  constructor(options: { cwd: string; config: PolarisConfig }) {
    this.cwd = options.cwd;
    this.#config = { ...options.config };
    this.#session = new Session({ cwd: this.cwd, config: this.#config });
  }

  get state(): AppState {
    return {
      cwd: this.cwd,
      project: basename(this.cwd) || this.cwd,
      provider: this.#session.providerId,
      model: this.#session.modelId,
      status: this.#status,
      busy: this.#turn !== null || this.#status === 'switching',
      messages: this.#messages,
      turns: this.#session.history.length,
      access: this.#session.access,
    };
  }

  get config(): PolarisConfig {
    return { ...this.#config };
  }

  subscribe(listener: (state: AppState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    await this.#session.start();
    this.#emit();
  }

  /**
   * Runs one turn. Answer text streams into an assistant message; each tool
   * call becomes its own transcript entry that goes from running to finished.
   * Text that arrives after a tool starts a new assistant message, so the
   * transcript reads in the order things actually happened.
   */
  async submit(text: string): Promise<void> {
    if (this.#turn) return;
    this.#append('user', text, 'complete');

    const controller = new AbortController();
    this.#turn = controller;
    this.#set('thinking');

    let answer: string | null = null;
    /** Provider tool id → transcript entry, for tools still running. */
    const running = new Map<string, { entry: string; name: string }>();

    const seal = (state: MessageState) => {
      if (answer) this.#update(answer, (message) => ({ ...message, state }));
      answer = null;
    };

    try {
      for await (const event of this.#session.send(text, controller.signal)) {
        switch (event.type) {
          case 'text-delta': {
            answer ??= this.#append('assistant', '', 'streaming').id;
            this.#status = 'streaming';
            const id = answer;
            this.#update(id, (message) => ({ ...message, text: message.text + event.text }));
            break;
          }
          case 'tool-start': {
            seal('complete');
            const entry = this.#appendTool(event);
            running.set(event.id, { entry, name: event.name });
            this.#set(activity(running));
            break;
          }
          case 'tool-result':
          case 'tool-error':
            this.#finishTool(running, event);
            this.#set(running.size > 0 ? activity(running) : 'thinking');
            break;
        }
      }
      seal('complete');
      this.#set('ready');
    } catch (error) {
      // Whatever was still running never finished.
      for (const { entry } of running.values()) {
        this.#update(entry, (message) => ({ ...message, state: 'cancelled' }));
      }
      if (controller.signal.aborted) {
        if (answer) seal('cancelled');
        else this.notice('Cancelled.');
        this.#set('cancelled');
      } else {
        seal('error');
        this.notice(toUserMessage(error), 'error');
        this.#set('error');
      }
    } finally {
      this.#turn = null;
      this.#emit();
    }
  }

  #appendTool(event: Extract<ModelEvent, { type: 'tool-start' }>): string {
    const message: UiMessage = {
      id: `m${this.#nextId++}`,
      role: 'tool',
      text: '',
      state: 'streaming',
      tool: { name: event.name, target: event.target },
    };
    this.#messages = [...this.#messages, message];
    this.#emit();
    return message.id;
  }

  #finishTool(
    running: Map<string, { entry: string; name: string }>,
    event: Extract<ModelEvent, { type: 'tool-result' | 'tool-error' }>,
  ): void {
    const call = running.get(event.id);
    if (!call) return;
    running.delete(event.id);
    const failed = event.type === 'tool-error';
    this.#update(call.entry, (message) => ({
      ...message,
      state: failed ? 'error' : 'complete',
      tool: {
        ...(message.tool as ToolCall),
        detail: failed ? event.error : event.summary,
      },
    }));
  }

  /** Ctrl+C: cancels the running turn only. Returns false when nothing was running. */
  cancel(): boolean {
    if (!this.#turn) return false;
    this.#turn.abort();
    return true;
  }

  async setProvider(id: string): Promise<void> {
    // A model id belongs to the provider that offers it, so the override is
    // dropped and the new provider picks its own default.
    const { model: _dropped, ...rest } = this.#config;
    await this.#swap({ ...rest, provider: id }, `provider ${id}`);
  }

  async setModel(id: string): Promise<void> {
    await this.#swap({ ...this.#config, model: id }, `model ${id}`);
  }

  /** null when the provider offers no discovery. */
  async listModels(): Promise<string[] | null> {
    return this.#session.listModels();
  }

  /** Visual only: the provider keeps whatever conversation state it owns. */
  clearTranscript(): void {
    this.#messages = [];
    this.#emit();
  }

  notice(text: string, kind: 'system' | 'error' = 'system'): void {
    this.#append('system', text, kind === 'error' ? 'error' : 'complete');
  }

  async close(): Promise<void> {
    this.#turn?.abort();
    await this.#session.close();
  }

  /**
   * Starts a replacement session and only then retires the old one, so a failed
   * switch leaves the working session untouched.
   */
  async #swap(config: PolarisConfig, what: string): Promise<void> {
    const previous = this.#session;
    this.#set('switching');
    const next = new Session({ cwd: this.cwd, config });
    try {
      await next.start();
    } catch (error) {
      this.#set('error');
      throw new PolarisError(
        `Failed to switch ${what} — the ${previous.providerId} session is still active.`,
        { cause: error },
      );
    }
    this.#config = config;
    this.#session = next;
    await previous.close().catch((error: unknown) => debug('app', 'closing old session', error));
    this.notice(`Switched to ${next.providerId} · ${next.modelId}. New conversation context.`);
    this.#set('ready');
  }

  #append(role: MessageRole, text: string, state: MessageState): UiMessage {
    const message: UiMessage = { id: `m${this.#nextId++}`, role, text, state };
    this.#messages = [...this.#messages, message];
    this.#emit();
    return message;
  }

  #update(id: string, change: (message: UiMessage) => UiMessage): void {
    this.#messages = this.#messages.map((message) =>
      message.id === id ? change(message) : message,
    );
    this.#emit();
  }

  #set(status: AppStatus): void {
    this.#status = status;
    this.#emit();
  }

  #emit(): void {
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }
}

/** A single word for the status bar, however many tools are running. */
function activity(running: ReadonlyMap<string, { name: string }>): AppStatus {
  if (running.size !== 1) return running.size === 0 ? 'thinking' : 'working';
  const [only] = running.values();
  if (only?.name === 'Read') return 'reading';
  if (only && ['Grep', 'Glob', 'List'].includes(only.name)) return 'searching';
  return 'working';
}
