import type { ChildSpec } from '../agents/manager.ts';
import type { PolarisConfig } from '../config/config.ts';
import type { ContextManager, DelegationPort } from '../context/manager.ts';
import type { PermissionGate } from '../permissions/gate.ts';
import { DEFAULT_PROFILE, type PermissionProfile } from '../permissions/policy.ts';
import type { RuntimeActivity } from '../providers/provider.ts';
import {
  getProvider,
  type ModelEvent,
  type ModelSession,
  type ProviderSessionOptions,
  type ToolAccess,
} from '../providers/provider.ts';
import { PolarisError } from './errors.ts';
import { debug } from './logger.ts';
import type { UsageReport } from './usage.ts';

export type Role = 'user' | 'assistant';

export interface Turn {
  readonly role: Role;
  readonly text: string;
}

export interface SessionOptions {
  readonly cwd: string;
  readonly config: PolarisConfig;
  /** The one gate every mutation in this session is authorised through. */
  readonly gate: PermissionGate;
  /** Project instructions and skills; each session gets its own view of them. */
  readonly context?: ContextManager;
  readonly activity?: RuntimeActivity;
  /** How the main agent hands tasks to agents; absent, it cannot. */
  readonly delegation?: DelegationPort;
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
  #access: ToolAccess | null = null;
  readonly #gate: PermissionGate;
  readonly #context: ContextManager | undefined;
  readonly #activity: RuntimeActivity | undefined;
  readonly #delegation: DelegationPort | undefined;

  constructor(options: SessionOptions) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.#gate = options.gate;
    this.#context = options.context;
    this.#activity = options.activity;
    this.#delegation = options.delegation;
  }

  /** See `ModelSession.liveInstructions`. */
  get liveInstructions(): boolean {
    return this.#model?.liveInstructions === true;
  }

  get permissions(): PermissionProfile {
    return this.config.permissions ?? DEFAULT_PROFILE;
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

  /** What the provider may do to the workspace; null before the session starts. */
  get access(): ToolAccess | null {
    return this.#access;
  }

  get active(): boolean {
    return this.#model !== null;
  }

  async start(): Promise<void> {
    const provider = getProvider(this.config.provider);
    if (!provider) {
      throw new PolarisError(`Unknown provider "${this.config.provider}"`);
    }
    // A provider that cannot honour the profile says so rather than accepting
    // it and doing something else — misreporting a permission is worse than
    // refusing to switch.
    if (!provider.supports.includes(this.permissions)) {
      throw new PolarisError(
        `${provider.id} cannot enforce the "${this.permissions}" permission profile.`,
      );
    }
    this.#model = await provider.createSession({
      cwd: this.cwd,
      permissions: this.permissions,
      gate: this.#gate,
      ...(this.#context
        ? {
            context: this.#context.session(
              this.#delegation ? { delegation: this.#delegation } : {},
            ),
          }
        : {}),
      ...(this.#activity ? { activity: this.#activity } : {}),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.effort ? { effort: this.config.effort } : {}),
    });
    this.#access = this.#model.access;
    debug('session', 'started with', provider.id);
  }

  /**
   * Runs one turn and re-emits the provider's events. The transcript is filled
   * in as the answer arrives, so a turn cancelled half-way still records what
   * the user actually saw.
   */
  async *send(input: string, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    if (!this.#model) throw new PolarisError('Session is not started');
    this.#history.push({ role: 'user', text: input });

    let answer = '';
    try {
      for await (const event of this.#model.send(input, signal)) {
        if (event.type === 'text-delta') answer += event.text;
        yield event;
      }
    } finally {
      if (answer.length > 0) this.#history.push({ role: 'assistant', text: answer });
    }
  }

  /**
   * An agent's session: the same provider, model and effort as this one, and
   * a conversation of its own. A runtime that can host it beside this session
   * (a Codex thread on the same App Server) does; otherwise the provider
   * starts a new session. Either way the child is the caller's to close, and
   * closing it leaves this session running.
   */
  async spawnChild(spec: ChildSpec): Promise<ModelSession> {
    const provider = getProvider(this.config.provider);
    if (!this.#model || !provider) throw new PolarisError('Session is not started');
    const effort = this.#model.effort;
    const options: ProviderSessionOptions = {
      cwd: this.cwd,
      permissions: spec.permissions,
      gate: spec.gate,
      context: spec.context,
      activity: spec.activity,
      capabilities: spec.capabilities,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(effort ? { effort } : {}),
    };
    return this.#model.createChild
      ? this.#model.createChild(options)
      : provider.createSession(options);
  }

  /** null when this provider cannot report consumption. */
  async usage(): Promise<UsageReport | null> {
    if (!this.#model?.usage) return null;
    return this.#model.usage();
  }

  /** null when this provider cannot enumerate models. */
  async listModels(): Promise<string[] | null> {
    if (!this.#model?.listModels) return null;
    return this.#model.listModels();
  }

  /** The effort in use, or null when the provider has no notion of it. */
  get effortId(): string | null {
    return this.#model?.effort ?? null;
  }

  /** null when this provider does not let the effort be chosen. */
  async listEfforts(): Promise<string[] | null> {
    if (!this.#model?.efforts || !this.#model.setEffort) return null;
    return this.#model.efforts();
  }

  async setEffort(effort: string): Promise<void> {
    if (!this.#model?.setEffort) {
      throw new PolarisError(`${this.providerId} does not let the effort be changed.`);
    }
    await this.#model.setEffort(effort);
  }

  clearHistory(): void {
    this.#history = [];
  }

  async close(): Promise<void> {
    await this.#model?.close();
    this.#model = null;
  }
}
