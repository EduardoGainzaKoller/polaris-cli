import { basename } from 'node:path';
import { type PolarisConfig, polarisHome } from '../config/config.ts';
import { type ContextEvent, ContextManager } from '../context/manager.ts';
import type { ApprovalDecision, ApprovalRequest } from '../permissions/gate.ts';
import { PermissionGate } from '../permissions/gate.ts';
import { DEFAULT_PROFILE, type PermissionProfile } from '../permissions/policy.ts';
import type { ModelEvent, RuntimeActivity, ToolAccess } from '../providers/provider.ts';
import {
  ChangeTracker,
  type Checkpoint,
  type FileChange,
  type FileDiff,
  type PreexistingChange,
  type UndoPlan,
  type UndoResult,
} from '../workspace/changes.ts';
import { type Activity, ActivityTracker, type Outcome, took } from './activity.ts';
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
  /** How long it took, once finished. */
  readonly duration?: number;
  /** A command's last line of output, e.g. `BUILD SUCCESSFUL`. */
  readonly lastOutput?: string;
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
  readonly context: ContextState;
  /**
   * What is running right now, parents before children. Completed work is
   * not here: it is a transcript row with its duration.
   */
  readonly activity: readonly Activity[];
}

/** Project instructions and skills, as the UI shows them. */
export interface ContextState {
  /** POLARIS.md files in use, farthest first. */
  readonly sources: readonly string[];
  /** Skills that can be loaded. */
  readonly available: number;
  /** Skills loaded in this conversation, in load order. */
  readonly loaded: readonly string[];
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
  readonly #context: ContextManager;
  readonly #activity: ActivityTracker;
  /** The model activity of the running turn, which runtime signs of life belong to. */
  #turnActivity: string | null = null;
  /** What providers call when their runtime shows a sign of life. */
  readonly #runtimeActivity: RuntimeActivity = {
    pulse: () => this.#activity.touch(this.#turnActivity),
    waiting: (on) =>
      this.#activity.touch(
        this.#turnActivity,
        on === 'model' ? 'waiting-model' : 'waiting-runtime',
      ),
  };
  /** Transcript entries of skills still loading, by name. */
  readonly #loadingSkills = new Map<string, string>();

  constructor(options: {
    cwd: string;
    config: PolarisConfig;
    approvals?: boolean;
    /** Polaris's home, where user skills live; `~/.polaris` by default. */
    home?: string;
    /** The activity clock; tests pass their own. */
    clock?: () => number;
  }) {
    this.cwd = options.cwd;
    this.#activity = new ActivityTracker(options.clock);
    this.#activity.onChange(() => this.#emit());
    this.#context = new ContextManager({
      workspace: options.cwd,
      boundary: null,
      home: options.home ?? polarisHome(),
    });
    this.#context.onEvent((event) => this.#onContextEvent(event));
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
      this.#session = new Session({
        cwd: this.cwd,
        config: this.#config,
        gate: this.#gate,
        context: this.#context,
        activity: this.#runtimeActivity,
      });
      return;
    }
    // Every approval, from any runtime, arrives here and becomes one piece of
    // UI state. This is the whole seam between "a provider wants permission"
    // and "the user is looking at a card".
    this.#gate.onApproval(
      (request) =>
        new Promise<ApprovalDecision>((resolve) => {
          // Waiting on a person, on purpose: never reported as a silence.
          const waiting = this.#activity.start(
            'approval',
            `${request.title} ${request.target}`.trim(),
            {
              state: 'waiting-approval',
              ...(this.#turnActivity ? { parentId: this.#turnActivity } : {}),
            },
          );
          this.#approval = {
            request,
            answer: (decision) => {
              this.#activity.finish(waiting, decision === 'allow' ? 'completed' : 'cancelled');
              this.#activity.touch(this.#turnActivity);
              this.#approval = null;
              this.#set(this.#turn ? 'thinking' : 'ready');
              resolve(decision);
            },
          };
          this.#set('approving');
        }),
    );
    this.#session = new Session({
      cwd: this.cwd,
      config: this.#config,
      gate: this.#gate,
      context: this.#context,
    });
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
      activity: this.#activity.live(),
      context: {
        sources: this.#context.project.sources.map((source) => source.display),
        available: this.#context.skills.list().length,
        loaded: this.#context.loaded.map((skill) => skill.metadata.name),
      },
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

  /**
   * The workspace first — Git tells the project context where to stop
   * looking — then the context, which the provider session is started with.
   * A broken POLARIS.md or skill is reported, never fatal.
   */
  async start(): Promise<void> {
    this.#tracker = await ChangeTracker.start(this.cwd);
    this.#context.boundary = this.#tracker.git?.root ?? null;
    await this.#context.reloadProject();
    await this.#context.reloadSkills();
    await this.#session.start();
    for (const error of this.#context.project.errors) this.notice(error, 'error');
    const invalid = this.#context.skills.invalid().length;
    if (invalid > 0) {
      this.notice(
        `Warning: ${invalid} ${invalid === 1 ? 'skill' : 'skills'} could not be loaded. See /skills.`,
        'error',
      );
    }
    this.#emit();
  }

  /** The context manager, for commands that list or show it. */
  get context(): ContextManager {
    return this.#context;
  }

  /**
   * `/context reload`. A runtime that re-reads Polaris's instructions every
   * request just uses the new ones; the others were given them when the
   * session started, so a new session — a new conversation — is the only
   * honest way to apply them.
   */
  async reloadContext(): Promise<void> {
    this.#idle();
    const project = await this.#context.reloadProject();
    for (const error of project.errors) this.notice(error, 'error');
    if (this.#session.liveInstructions) {
      this.notice('Project context reloaded. It applies from the next message.');
      return;
    }
    await this.#swap(this.#config, 'context', 'Project context reloaded. Conversation reset.');
  }

  /** `/skills reload`: rediscovers skills; loads nothing. */
  async reloadSkills(): Promise<void> {
    this.#idle();
    await this.#context.reloadSkills();
    this.#emit();
  }

  /** `/skill <name>`: the user loads a skill for this conversation. */
  async loadSkill(name: string): Promise<boolean> {
    this.#idle();
    const { skill } = await this.#context.load(name);
    this.#emit();
    return skill !== null;
  }

  /**
   * `/skill unload <name>`. Only a runtime that is given its instructions
   * afresh every request can really forget one; for the others the text is
   * already part of the conversation, so unloading means starting a new one.
   */
  async unloadSkill(name: string): Promise<void> {
    this.#idle();
    if (!this.#context.loaded.some((skill) => skill.metadata.name === name)) {
      this.notice(`${name} is not loaded.`);
      return;
    }
    this.#context.unload(name);
    if (this.#session.liveInstructions) {
      this.notice(`Skill unloaded: ${name}. It no longer applies from the next message.`);
      this.#emit();
      return;
    }
    await this.#swap(
      this.#config,
      'conversation',
      `Skill unloaded: ${name}. Conversation reset — ${this.#session.providerId} keeps instructions it has already seen.`,
    );
  }

  /** Skill loads appear in the transcript under the skill's name, like a tool call. */
  #onContextEvent(event: ContextEvent): void {
    const entry = (name: string, target: string): string => {
      const message: UiMessage = {
        id: `m${this.#nextId++}`,
        role: 'tool',
        text: '',
        state: 'streaming',
        tool: { name, target },
      };
      this.#messages = [...this.#messages, message];
      return message.id;
    };
    const finish = (id: string, state: MessageState, detail: string) =>
      this.#update(id, (message) => ({
        ...message,
        state,
        tool: { ...(message.tool as ToolCall), detail },
      }));

    switch (event.type) {
      case 'skill-load-start':
        this.#loadingSkills.set(event.name, entry('Skill', event.name));
        break;
      case 'skill-loaded': {
        const id = this.#loadingSkills.get(event.name) ?? entry('Skill', event.name);
        this.#loadingSkills.delete(event.name);
        finish(id, 'complete', event.already ? 'already loaded' : 'loaded');
        break;
      }
      case 'skill-load-error': {
        const id = this.#loadingSkills.get(event.name) ?? entry('Skill', event.name);
        this.#loadingSkills.delete(event.name);
        finish(id, 'error', event.error);
        break;
      }
      case 'reference-loaded':
        finish(entry('Reference', `${event.skill}/${event.path}`), 'complete', 'loaded');
        break;
      case 'reference-error':
        finish(entry('Reference', `${event.skill}/${event.path}`), 'error', event.error);
        break;
    }
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

  async #run(text: string, report: boolean, parent?: string): Promise<void> {
    if (this.#turn) return;
    this.#append('user', text, 'complete');

    const controller = new AbortController();
    this.#turn = controller;
    this.#set('thinking');
    const startedAt = Date.now();
    const turnActivity = this.#activity.start('model', runtimeName(this.#session.providerId), {
      state: 'waiting-model',
      ...(parent ? { parentId: parent } : {}),
    });
    this.#turnActivity = turnActivity;
    // Whatever changed while Polaris was idle is the user's, and is set aside
    // before the turn can be blamed for it.
    await this.#observe('user');
    const revision = this.#verifier.revision;
    let checked = false;

    let answer: string | null = null;
    /** The last answer of the turn, which gets the model and timing footer. */
    let lastAnswer: string | null = null;
    /** Provider tool id → transcript entry and activity, for tools still running. */
    const running = new Map<string, { entry: string; name: string; activity: string }>();

    const seal = (state: MessageState) => {
      if (answer) this.#update(answer, (message) => ({ ...message, state }));
      answer = null;
    };
    // A skill load is shown where it happened: text after it starts a new
    // answer, exactly as it does after a tool call.
    const stopSealing = this.#context.onEvent(() => seal('complete'));

    try {
      for await (const event of this.#session.send(text, controller.signal)) {
        switch (event.type) {
          case 'text-delta': {
            answer ??= this.#append('assistant', '', 'streaming').id;
            lastAnswer = answer;
            this.#status = 'streaming';
            this.#activity.touch(turnActivity, 'streaming');
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
            const child = this.#activity.start(
              event.name === 'Run' ? 'command' : 'tool',
              event.target,
              {
                state: 'running',
                parentId: turnActivity,
                tool: event.name,
              },
            );
            this.#activity.touch(turnActivity, 'waiting-tool');
            running.set(event.id, { entry, name: event.name, activity: child });
            this.#set(activity(running));
            break;
          }
          case 'tool-output-delta': {
            // Only the activity keeps it, trimmed to a few lines: the UI is a
            // window, and what the model reads is the tool's own result.
            this.#activity.output(running.get(event.id)?.activity, event.text);
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
            // With every tool back, the next thing is the model again.
            this.#activity.touch(turnActivity, running.size > 0 ? 'waiting-tool' : 'waiting-model');
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
      this.#activity.finish(turnActivity, 'completed');
      this.#set('ready');
    } catch (error) {
      // Whatever was still running never finished.
      const outcome: Outcome = controller.signal.aborted ? 'cancelled' : 'failed';
      for (const call of running.values()) {
        const ended = this.#activity.finish(call.activity, 'cancelled');
        const duration = ended?.endedAt === undefined ? undefined : ended.endedAt - ended.startedAt;
        this.#update(call.entry, (message) => ({
          ...message,
          state: 'cancelled',
          tool: {
            ...(message.tool as ToolCall),
            ...(duration === undefined
              ? {}
              : { duration, detail: `cancelled after ${took(duration)}` }),
          },
        }));
      }
      this.#activity.finish(turnActivity, outcome);
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
      this.#turnActivity = null;
      stopSealing();
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
    const verification = this.#activity.start('verification', 'Verify changes', {
      state: 'running',
    });
    try {
      await this.#run(verifyPrompt(this.#tracker?.changes() ?? []), true, verification);
    } finally {
      this.#activity.finish(verification, 'completed');
    }
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
    // A new conversation starts with no skill loaded; the project's own
    // instructions stay, since they describe the project, not the chat.
    this.#context.clearLoaded();
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
    running: Map<string, { entry: string; name: string; activity: string }>,
    event: Extract<ModelEvent, { type: 'tool-result' | 'tool-error' }>,
  ): void {
    const call = running.get(event.id);
    if (!call) return;
    running.delete(event.id);
    const failed = event.type === 'tool-error';
    const denied = failed && event.denied === true;
    const exited = (event.exitCode ?? 0) !== 0;
    const ended = this.#activity.finish(
      call.activity,
      denied ? 'cancelled' : failed ? 'failed' : 'completed',
    );
    const duration = ended?.endedAt === undefined ? undefined : ended.endedAt - ended.startedAt;
    const lastOutput = ended?.tail.findLast((line) => line.trim().length > 0)?.trim();
    this.#update(call.entry, (message) => ({
      ...message,
      // A refusal is its own state: the model was stopped, nothing broke.
      state: denied ? 'cancelled' : failed || exited ? 'error' : 'complete',
      tool: {
        ...(message.tool as ToolCall),
        detail: failed ? event.error : event.summary,
        ...(denied ? { denied: true } : {}),
        ...(duration === undefined ? {} : { duration }),
        ...(lastOutput ? { lastOutput } : {}),
      },
    }));
  }

  /** Ctrl+C: cancels the running turn only. Returns false when nothing was running. */
  cancel(): boolean {
    if (!this.#turn) return false;
    // A second Ctrl+C while the first is still being honoured changes nothing.
    if (this.#turn.signal.aborted) return true;
    // Said until the runtime or process has actually stopped, not before.
    this.#activity.cancelling();
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
    const next = new Session({
      cwd: this.cwd,
      config,
      gate: this.#gate,
      context: this.#context,
      activity: this.#runtimeActivity,
    });
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

/** How a runtime is named in the activity view. */
function runtimeName(provider: string): string {
  const names: Record<string, string> = {
    codex: 'Codex',
    claude: 'Claude',
    'anthropic-api': 'Anthropic API',
    mock: 'Mock',
  };
  return names[provider] ?? provider;
}

/** A single word for the status bar, however many tools are running. */
function activity(running: ReadonlyMap<string, { name: string }>): AppStatus {
  if (running.size !== 1) return running.size === 0 ? 'thinking' : 'working';
  const [only] = running.values();
  if (only?.name === 'Read') return 'reading';
  if (only && ['Grep', 'Glob', 'List'].includes(only.name)) return 'searching';
  if (only?.name === 'Run') return 'running';
  return 'working';
}
