import type { PolarisConfig } from '../config/config.ts';
import { getProvider, type ModelSession } from '../providers/provider.ts';
import { PolarisError } from './errors.ts';
import { debug } from './logger.ts';

export type Role = 'user' | 'assistant';

export interface Turn {
  readonly role: Role;
  readonly text: string;
}

export interface SessionOptions {
  readonly cwd: string;
  readonly config: PolarisConfig;
}

/**
 * Owns everything that outlives a single prompt: working directory, provider
 * session and transcript. The REPL is just a thin I/O shell around this.
 */
export class Session {
  readonly cwd: string;
  readonly config: PolarisConfig;
  readonly startedAt = new Date();

  #history: Turn[] = [];
  #model: ModelSession | null = null;

  constructor(options: SessionOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
  }

  get history(): readonly Turn[] {
    return this.#history;
  }

  get providerId(): string {
    return this.config.provider;
  }

  get modelId(): string {
    return this.#model?.model ?? this.config.model ?? 'none';
  }

  get active(): boolean {
    return this.#model !== null;
  }

  async start(): Promise<void> {
    const provider = getProvider(this.config.provider);
    if (!provider) {
      throw new PolarisError(`Unknown provider "${this.config.provider}"`);
    }
    const options = this.config.model
      ? { cwd: this.cwd, model: this.config.model }
      : { cwd: this.cwd };
    this.#model = await provider.createSession(options);
    debug('session', 'started with', provider.id);
  }

  /** Sends a user message to the model and records both sides of the turn. */
  async prompt(input: string, signal?: AbortSignal): Promise<string> {
    if (!this.#model) throw new PolarisError('Session is not started');
    this.#history.push({ role: 'user', text: input });
    const reply = await this.#model.send(input, signal);
    this.#history.push({ role: 'assistant', text: reply.text });
    return reply.text;
  }

  clearHistory(): void {
    this.#history = [];
  }

  async close(): Promise<void> {
    await this.#model?.close();
    this.#model = null;
  }
}
