import { basename } from 'node:path';
import type { PolarisConfig } from '../config/config.ts';
import type { ApprovalDecision, ApprovalRequest } from '../permissions/gate.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { DEFAULT_PROFILE, type PermissionProfile } from '../permissions/policy.ts';
import type { ModelEvent, ToolAccess } from '../providers/provider.ts';
import {
  ChangeTracker,
  type Checkpoint,
  type FileChange,
  type FileDiff,
  type PreexistingChange,
  type UndoPlan,
  type UndoResult,
} from '../workspace/changes.ts';
import { PolarisError, toUserMessage } from './errors.ts';
import { debug } from './logger.ts';
import { Session } from './session.ts';
import type { UsageReport } from './usage.ts';
import {
  RESULT_LABEL,
  type VerificationState,
  Verifier,
  verificationLines,
  verifyPrompt,
} from './verification.ts';

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
  | 'running'
  | 'switching'
  | 'approving'
  | 'cancelled'
  | 'error';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
/** For a tool, `streaming` means still running. */
export type MessageState = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface ToolCall {
  /** Human name: Read, Glob, Grep, Write, Edit, Run… */
  readonly name: string;
  readonly target: string;
  /** Outcome once finished: a summary, or the error. */
  readonly detail?: string;
  /** A person refused it, which reads differently from a failure. */
  readonly denied?: boolean;
  /** Live output while it runs; kept to the last few lines for the UI. */
  readonly output?: string;
}

export interface UiMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly state: MessageState;
  readonly tool?: ToolCall;
  /** Footer for a finished answer: model, effort and how long the turn took. */
  readonly meta?: string;
}

/** What the UI shows about the workspace itself, never about a provider. */
export interface WorkspaceState {
  /** null outside a Git repository. */
  readonly git: { readonly branch: string | null; readonly head: string | null } | null;
  /** Files Polaris has changed this session. */
  readonly changed: number;
  /** Files the user had changed, which Polaris leaves alone. */
  readonly preexisting: number;
  readonly verification: VerificationState;
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
  /** Reasoning effort in use; null when the provider has no notion of it. */
  readonly effort: string | null;
  readonly permissions: PermissionProfile;
  /**
   * The authorisation the user is being asked for right now, if any. The UI
   * renders this and answers with `resolveApproval`; it never learns which
   * runtime asked.
   */
  readonly approval: ApprovalRequest | null;
  readonly workspace: WorkspaceState;
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
  readonly #gate: PermissionGate;
  #approval: { request: ApprovalRequest; answer: (decision: ApprovalDecision) => void } | null =
    null;
  /** null until `start`. */
  #tracker: ChangeTracker | null = null;
  readonly #verifier = new Verifier();

  constructor(options: { cwd: string; config: PolarisConfig; approvals?: boolean }) {
    this.cwd = options.cwd;
    // A config that names no profile gets the default, never a wider one: the
    // safe fallback is the point of having a default at all.
    this.#config = {
      ...options.config,
      permissions: options.config.permissions ?? DEFAULT_PROFILE,
    };
    // The gate holds the live profile, so there is exactly one answer to
    // "what may Polaris do right now" and the UI reads the same one.
    this.#gate = new PermissionGate(options.config.permissions ?? DEFAULT_PROFILE);
    // Without a UI that can render an approval there is nobody to consent, and
    // the gate denies rather than waiting forever for an answer.
    if (options.approvals === false) {
      this.#session = new Session({ cwd: this.cwd, config: this.#config, gate: this.#gate });
      return;
    }
    // Every approval, from any runtime, arrives here and becomes one piece of
    // UI state. This is the whole seam between "a provider wants permission"
    // and "the user is looking at a card".
    this.#gate.onApproval(
      (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          this.#approval = {
            request,
            answer: (decision) => {
              this.#approval = null;
              this.#set(this.#turn ? 'thinking' : 'ready');
              resolve(decision);
            },
          };
          this.#set('approving');
        }),
    );
    this.#session = new Session({ cwd: this.cwd, config: this.#config, gate: this.#gate });
  }

  /** The pending approval, or null. The UI answers it with `resolveApproval`. */
  get approval(): ApprovalRequest | null {
    return this.#approval?.request ?? null;
  }

  /**
   * Answers the pending approval. Anything that is not an explicit allow is a
   * denial: there is no default acceptance, so a stray keystroke or a closed
   * UI can never authorise a mutation.
   */
  resolveApproval(decision: ApprovalDecision): void {
    this.#approval?.answer(decision === 'allow' ? 'allow' : 'deny');
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
      effort: this.#session.effortId,
      permissions: this.#gate.profile,
      approval: this.#approval?.request ?? null,
      workspace: this.#workspace(),
    };
  }

  #workspace(): WorkspaceState {
    const changes = this.#tracker?.changes() ?? [];
    const git = this.#tracker?.git;
    return {
      git: git ? { branch: git.branch, head: git.head } : null,
      changed: changes.length,
      preexisting: this.#tracker?.preexisting().length ?? 0,
      verification: this.#verifier.state(changes.length > 0),
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
    this.#tracker = await ChangeTracker.start(this.cwd);
    this.#emit();
  }

  /**
   * Runs one turn. Answer text streams into an assistant message; each tool
   * call becomes its own transcript entry that goes from running to finished.
   * Text that arrives after a tool starts a new assistant message, so the
   * transcript reads in the order things actually happened.
   */
  async submit(text: string): Promise<void> {
    await this.#run(text, false);
  }

  async #run(text: string, report: boolean): Promise<void> {
    if (this.#turn) return;
    this.#append('user', text, 'complete');

    const controller = new AbortController();
    this.#turn = controller;
    this.#set('thinking');
    const startedAt = Date.now();
    // Whatever changed while Polaris was idle is the user's, and is set aside
    // before the turn can be blamed for it.
    await this.#observe('user');
    const revision = this.#verifier.revision;
    let checked = false;

    let answer: string | null = null;
    /** The last answer of the turn, which gets the model and timing footer. */
    let lastAnswer: string | null = null;
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
            lastAnswer = answer;
            this.#status = 'streaming';
            const id = answer;
            this.#update(id, (message) => ({ ...message, text: message.text + event.text }));
            break;
          }
          case 'tool-start': {
            seal('complete');
            // Originals are kept before the change lands, which matters for
            // files Git does not track and outside Git altogether.
            if (event.paths) await this.#capture(event.paths);
            if (event.name === 'Run' && this.#verifier.started(event.id, event.target)) {
              checked = true;
            }
            const entry = this.#appendTool(event);
            running.set(event.id, { entry, name: event.name });
            this.#set(activity(running));
            break;
          }
          case 'tool-output-delta': {
            const call = running.get(event.id);
            if (call) this.#appendOutput(call.entry, event.text);
            break;
          }
          case 'tool-result':
          case 'tool-error': {
            const check = this.#verifier.isRunning(event.id);
            if (check) {
              const passed = event.type === 'tool-result' && (event.exitCode ?? 0) === 0;
              const denied = event.type === 'tool-error' && event.denied === true;
              this.#verifier.finished(
                event.id,
                passed ? 'passed' : denied ? 'denied' : 'failed',
                event.exitCode,
              );
            }
            const name = running.get(event.id)?.name ?? '';
            this.#finishTool(running, event);
            // What a check writes (snapshots, reports) is flagged as
            // unexpected, but does not make the check stale by existing.
            // Reads cannot change anything, so they cost no Git call.
            if (!READS.has(name)) await this.#observe('polaris', check);
            this.#set(running.size > 0 ? activity(running) : 'thinking');
            break;
          }
        }
      }
      seal('complete');
      if (lastAnswer) {
        const meta = this.#turnFooter(Date.now() - startedAt);
        this.#update(lastAnswer, (message) => ({ ...message, meta }));
      }
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
      this.#verifier.cancelRunning();
      await this.#observe('polaris');
      this.#turn = null;
      if (report || checked || this.#verifier.revision !== revision) {
        this.notice(['Verification', ...this.verificationLines()].join('\n'));
      }
      this.#emit();
    }
  }

  /** The verification block for the current state. */
  verificationLines(): string[] {
    const changes = this.#tracker?.changes() ?? [];
    return verificationLines(
      changes,
      this.#verifier.checks(),
      this.#verifier.state(changes.length > 0),
    );
  }

  /**
   * `/verify`: the model works out this project's checks and runs them —
   * through the same permission gate as any other command — and Polaris
   * reports what actually happened, whatever the answer says.
   */
  async verify(): Promise<void> {
    this.#idle();
    await this.#observe('user');
    await this.#run(verifyPrompt(this.#tracker?.changes() ?? []), true);
  }

  /** Session changes and the user's own, as of now. */
  async changes(): Promise<{ changes: FileChange[]; preexisting: PreexistingChange[] }> {
    if (!this.#turn) await this.#observe('user');
    return {
      changes: this.#tracker?.changes() ?? [],
      preexisting: this.#tracker?.preexisting() ?? [],
    };
  }

  async diff(change: FileChange): Promise<FileDiff> {
    return this.#requireTracker().diff(change);
  }

  get checkpoints(): readonly Checkpoint[] {
    return this.#tracker?.checkpoints ?? [];
  }

  async checkpoint(label?: string): Promise<Checkpoint> {
    this.#idle();
    const tracker = this.#requireTracker();
    await this.#observe('user');
    return tracker.checkpoint(label);
  }

  /** What `/undo` would restore and skip; touches nothing. */
  async planUndo(id?: string): Promise<UndoPlan> {
    this.#idle();
    const tracker = this.#requireTracker();
    await this.#observe('user');
    return tracker.planUndo(id);
  }

  async undo(plan: UndoPlan): Promise<UndoResult> {
    this.#idle();
    const result = await this.#requireTracker().undo(plan);
    if (result.restored.length > 0) this.#verifier.mutated();
    this.#emit();
    return result;
  }

  /**
   * `/new`: a fresh conversation on the same provider, model, effort and
   * profile. Files are not touched. The change baseline is retaken here, so
   * what the previous conversation changed is from now on treated like the
   * user's own pre-existing work: `/undo` in the new one cannot reach it.
   */
  async newConversation(): Promise<void> {
    this.#idle();
    await this.#swap(
      this.#config,
      'conversation',
      'New conversation. Same provider, model and permissions; files untouched.',
    );
    const previous = this.#tracker;
    this.#tracker = await ChangeTracker.start(this.cwd);
    this.#verifier.reset();
    await previous?.dispose();
    this.#emit();
  }

  /** A few lines for the terminal after exit, or null when Polaris changed nothing. */
  exitSummary(): string | null {
    const changes = this.#tracker?.changes() ?? [];
    if (changes.length === 0) return null;
    const state = this.#verifier.state(true);
    return [
      'Session ended.',
      `  Changes kept: ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`,
      `  Verification: ${RESULT_LABEL[state]}`,
    ].join('\n');
  }

  async #observe(owner: 'polaris' | 'user', fromCheck = false): Promise<void> {
    if (!this.#tracker) return;
    try {
      const changed = await this.#tracker.reconcile(owner);
      if (owner === 'polaris' && changed.length > 0 && !fromCheck) this.#verifier.mutated();
    } catch (error) {
      // Tracking is a safety net for undo; it must never break a turn.
      debug('app', 'workspace reconcile failed', error);
    }
    this.#emit();
  }

  async #capture(paths: readonly string[]): Promise<void> {
    try {
      await this.#tracker?.capture(paths);
    } catch (error) {
      debug('app', 'capture failed', error);
    }
  }

  #idle(): void {
    if (this.#turn) {
      throw new PolarisError('Wait for the current turn to finish, or press Ctrl+C to cancel it.');
    }
  }

  #requireTracker(): ChangeTracker {
    if (!this.#tracker) throw new PolarisError('The workspace is not being tracked.');
    return this.#tracker;
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
    const denied = failed && event.denied === true;
    this.#update(call.entry, (message) => ({
      ...message,
      // A refusal is its own state: the model was stopped, nothing broke.
      state: denied ? 'cancelled' : failed ? 'error' : 'complete',
      tool: {
        ...(message.tool as ToolCall),
        detail: failed ? event.error : event.summary,
        ...(denied ? { denied: true } : {}),
      },
    }));
  }

  /**
   * Live tool output, trimmed to the last few lines. The UI is a window, not a
   * log: keeping the whole stream here would grow the transcript without
   * bound, and what the model receives is the tool's result, not this.
   */
  #appendOutput(id: string, text: string): void {
    this.#update(id, (message) => {
      const combined = `${message.tool?.output ?? ''}${text}`;
      const lines = combined.split(/\r?\n/);
      return {
        ...message,
        tool: {
          ...(message.tool as ToolCall),
          output: lines.slice(-MAX_LIVE_OUTPUT_LINES).join('\n'),
        },
      };
    });
  }

  /** Ctrl+C: cancels the running turn only. Returns false when nothing was running. */
  cancel(): boolean {
    if (!this.#turn) return false;
    this.#turn.abort();
    return true;
  }

  /** "gpt-5.6-luna · high · 4.2s" — what answered, how hard it thought, how long it took. */
  #turnFooter(elapsedMs: number): string {
    const effort = this.#session.effortId;
    const seconds =
      elapsedMs < 10_000 ? (elapsedMs / 1000).toFixed(1) : Math.round(elapsedMs / 1000);
    return [this.#session.modelId, effort, `${seconds}s`].filter(Boolean).join(' · ');
  }

  /**
   * Changes the profile for the session that is already running. Every
   * provider takes it the same way — a fresh session configured for it —
   * because a sandbox and a native tool set are chosen when the runtime starts,
   * not per call. A failed switch leaves the working session untouched.
   */
  async setPermissions(profile: PermissionProfile): Promise<void> {
    if (profile === this.#gate.profile) {
      this.notice(`Already using the "${profile}" permission profile.`);
      return;
    }
    await this.#swap({ ...this.#config, permissions: profile }, `permissions ${profile}`);
    this.#gate.profile = profile;
  }

  async setProvider(id: string): Promise<void> {
    // Model ids and effort levels belong to the provider that offers them, so
    // both overrides are dropped and the new provider picks its own defaults.
    const { model: _model, effort: _effort, ...rest } = this.#config;
    await this.#swap({ ...rest, provider: id }, `provider ${id}`);
  }

  /** null when the provider does not let the effort be chosen. */
  async listEfforts(): Promise<string[] | null> {
    return this.#session.listEfforts();
  }

  /**
   * Every supported runtime changes effort live, so unlike a model switch this
   * keeps the conversation.
   */
  async setEffort(level: string): Promise<void> {
    await this.#session.setEffort(level);
    this.#config = { ...this.#config, effort: level };
    this.notice(`Effort set to ${level}. It applies from the next message.`);
  }

  async setModel(id: string): Promise<void> {
    await this.#swap({ ...this.#config, model: id }, `model ${id}`);
  }

  /**
   * Consumption as the active runtime measures it, or null when it measures
   * none. Never throws: /status has other things to say.
   */
  async usage(): Promise<UsageReport | null> {
    try {
      return await this.#session.usage();
    } catch (error) {
      debug('app', 'usage unavailable', error);
      return null;
    }
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
    await this.#tracker?.dispose();
  }

  /**
   * Starts a replacement session and only then retires the old one, so a failed
   * switch leaves the working session untouched.
   */
  async #swap(config: PolarisConfig, what: string, notice?: string): Promise<void> {
    const previous = this.#session;
    this.#set('switching');
    const next = new Session({ cwd: this.cwd, config, gate: this.#gate });
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
    this.notice(
      notice ??
        `Switched to ${next.providerId} · ${next.modelId} · ${config.permissions}. New conversation context.`,
    );
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

/** Tools that only look; the turn-end reconcile still catches anything they missed. */
const READS = new Set(['Read', 'Grep', 'Glob', 'List']);

/** Live tool output lines kept in the transcript while a command runs. */
const MAX_LIVE_OUTPUT_LINES = 8;

/** A single word for the status bar, however many tools are running. */
function activity(running: ReadonlyMap<string, { name: string }>): AppStatus {
  if (running.size !== 1) return running.size === 0 ? 'thinking' : 'working';
  const [only] = running.values();
  if (only?.name === 'Read') return 'reading';
  if (only && ['Grep', 'Glob', 'List'].includes(only.name)) return 'searching';
  if (only?.name === 'Run') return 'running';
  return 'working';
}
