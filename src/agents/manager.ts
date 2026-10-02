import type {
  ContextManager,
  ContextReply,
  DelegationPort,
  SessionContext,
} from '../context/manager.ts';
import { toUserMessage } from '../core/errors.ts';
import { debug } from '../core/logger.ts';
import { PermissionGate } from '../permissions/gate.ts';
import type { Capability, PermissionProfile } from '../permissions/policy.ts';
import { authorizeTask, type TaskAuthorization } from '../permissions/task.ts';
import type { ModelEvent, ModelSession, RuntimeActivity } from '../providers/provider.ts';
import {
  MAX_ACTIVE_CHILDREN,
  MAX_DELEGATED_TASK_CHARS,
  MAX_DELEGATION_DEPTH,
  MAX_DELEGATIONS_PER_TURN,
  MAX_OBJECTIVE_CHARS,
} from '../tools/limits.ts';
import type { AgentDefinition, AgentRegistry } from './registry.ts';
import {
  type DelegationResult,
  emptyResult,
  fromAnswer,
  RESULT_CONTRACT,
  renderResult,
} from './result.ts';

/**
 * Runs agents. Everything about an agent's life happens here — resolving its
 * definition, deciding what it may do and what it knows, creating its
 * session, watching it, stopping it and cleaning up — so neither the UI nor a
 * provider manages one.
 *
 * Runs are identified by id and grouped by the run that delegated them, not
 * held in a single "current agent": v0.9 allows one child at a time and no
 * grandchildren, but those are limits checked here, not shapes baked in.
 */
export type AgentRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled';

export interface AgentRun {
  readonly id: string;
  readonly agent: string;
  readonly status: AgentRunStatus;
  /** The run that delegated: `main`, or `user` for a run started with /agent. */
  readonly parentRunId: string;
  readonly task: string;
  readonly startedAt: number;
  readonly completedAt?: number;
}

/** The agent the user talks to: the root of every delegation. */
export const MAIN_AGENT = 'main';
/** The parent of a run the user started by hand with /agent. */
export const USER = 'user';

export type AgentEvent =
  | { readonly type: 'run-start'; readonly run: AgentRun }
  /** What the agent's session did. For the eye only: the parent never receives it. */
  | { readonly type: 'run-event'; readonly run: AgentRun; readonly event: ModelEvent }
  /** A sign of life from the agent's runtime, or a request it is now waiting on. */
  | {
      readonly type: 'run-activity';
      readonly run: AgentRun;
      readonly waiting?: 'model' | 'runtime';
    }
  | { readonly type: 'run-end'; readonly run: AgentRun; readonly result: DelegationResult };

/** What a delegating run is, while it is delegating. */
export interface ParentScope {
  readonly runId: string;
  /** Agents between this run and the user: 0 for the main agent and for /agent. */
  readonly depth: number;
  /** What the user asked for, so the agent understands why it is doing its task. */
  readonly objective: string;
  readonly profile: PermissionProfile;
  readonly task: TaskAuthorization;
  /** The parent's turn: cancelling it cancels the agent. */
  readonly signal: AbortSignal;
}

/** What the manager asks for when it needs an agent's session. */
export interface ChildSpec {
  readonly permissions: PermissionProfile;
  readonly gate: PermissionGate;
  readonly context: SessionContext;
  readonly capabilities: readonly Capability[];
  readonly activity: RuntimeActivity;
}

export type SpawnChild = (spec: ChildSpec) => Promise<ModelSession>;

/**
 * The workspace, seen around a run. An agent that can only read must leave
 * nothing changed; this is how the manager finds out if one did.
 */
export interface WorkspaceWatch {
  /** Attributes whatever changed so far to whoever was working before the run. */
  settle(): Promise<void>;
  /** Paths that changed since the last `settle`. */
  changed(): Promise<string[]>;
}

interface TurnState {
  readonly scope: ParentScope;
  delegations: number;
  readonly done: Map<string, DelegationResult>;
}

export class AgentManager {
  readonly registry: AgentRegistry;
  readonly #context: ContextManager;
  readonly #workspace: string;
  readonly #spawn: SpawnChild;
  readonly #watch: WorkspaceWatch | undefined;
  readonly #now: () => number;
  readonly #runs = new Map<string, AgentRun>();
  readonly #turns = new Map<string, TurnState>();
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #next = 0;

  constructor(options: {
    registry: AgentRegistry;
    context: ContextManager;
    workspace: string;
    spawn: SpawnChild;
    watch?: WorkspaceWatch;
    clock?: () => number;
  }) {
    this.registry = options.registry;
    this.#context = options.context;
    this.#workspace = options.workspace;
    this.#spawn = options.spawn;
    this.#watch = options.watch;
    this.#now = options.clock ?? Date.now;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Runs still going, oldest first. */
  live(): AgentRun[] {
    return [...this.#runs.values()];
  }

  /**
   * A parent's user turn begins: what it may delegate is counted from here.
   * Only Polaris calls this, from the user's own request.
   */
  beginTurn(scope: ParentScope): void {
    this.#turns.set(scope.runId, { scope, delegations: 0, done: new Map() });
  }

  endTurn(runId: string): void {
    this.#turns.delete(runId);
  }

  /** How a parent's session delegates: see `DelegationPort`. */
  port(runId: string): DelegationPort {
    return {
      agents: this.registry.list().map(({ name, description }) => ({ name, description })),
      delegate: async (agent, task): Promise<ContextReply> => {
        const result = await this.delegate(runId, agent, task);
        return {
          ok: result.status === 'completed' || result.status === 'partial',
          text: renderResult(result),
        };
      },
    };
  }

  /**
   * A model asks to delegate. The turn's limits are checked here, in code:
   * how many delegations, and the same task twice. A refusal is a result the
   * model can read and work around, not an error.
   */
  async delegate(parentRunId: string, agent: string, task: string): Promise<DelegationResult> {
    const turn = this.#turns.get(parentRunId);
    if (!turn)
      return refused(agent, 'Delegation is only available while a request is being answered.');
    const key = `${agent}\n${task.trim().toLowerCase().replace(/\s+/g, ' ')}`;
    if (turn.done.has(key)) {
      return refused(
        agent,
        'This exact task was already delegated in this request; use the result you received.',
      );
    }
    if (turn.delegations >= MAX_DELEGATIONS_PER_TURN) {
      return refused(
        agent,
        `Delegation limit reached: at most ${MAX_DELEGATIONS_PER_TURN} per request. Continue with what you have.`,
      );
    }
    turn.delegations += 1;
    const result = await this.run(agent, task, turn.scope);
    turn.done.set(key, result);
    return result;
  }

  /**
   * One run, start to finish: one-shot, blocking for its parent, and always
   * cleaned up. Every way it can end — an answer, a budget, a failure, a
   * cancellation — becomes a `DelegationResult`; only the parent's own
   * cancellation is then the parent's to act on.
   */
  async run(name: string, task: string, scope: ParentScope): Promise<DelegationResult> {
    const definition = this.registry.get(name);
    if (!definition) {
      const known = this.registry
        .list()
        .map((agent) => agent.name)
        .join(', ');
      return refused(name, `Unknown agent "${name}". Available: ${known || 'none'}.`);
    }
    if (scope.depth + 1 > MAX_DELEGATION_DEPTH) {
      return refused(name, 'Agents cannot delegate to other agents.');
    }
    const siblings = this.live().filter((run) => run.parentRunId === scope.runId);
    if (siblings.length >= MAX_ACTIVE_CHILDREN) {
      return refused(
        name,
        'Another agent is already running for this request; wait for its result.',
      );
    }
    const delegated = task.trim();
    if (!delegated) return refused(name, 'The delegated task is empty.');

    let run: AgentRun = {
      id: `run-${++this.#next}`,
      agent: definition.name,
      status: 'pending',
      parentRunId: scope.runId,
      task: headline(delegated),
      startedAt: this.#now(),
    };
    this.#runs.set(run.id, run);
    debug(
      'agents',
      'run created',
      run.id,
      'agent',
      run.agent,
      'parent',
      run.parentRunId,
      `task ${delegated.length} chars`,
    );
    this.#emit({ type: 'run-start', run });

    const { budget } = definition;
    // The agent's own stop, for a budget; the parent's signal still cancels it.
    const stopper = new AbortController();
    const signal = AbortSignal.any([scope.signal, stopper.signal]);
    let stopped: string | null = null;
    const stop = (why: string) => {
      stopped ??= why;
      stopper.abort(new Error(why));
    };
    const timer = setTimeout(
      () => stop(`time budget of ${Math.round(budget.maxRuntimeMs / 1000)}s reached`),
      budget.maxRuntimeMs,
    );
    timer.unref?.();

    let session: ModelSession | null = null;
    let answer = '';
    let toolCalls = 0;
    const read = new Set<string>();
    const stats = () => ({
      durationMs: this.#now() - run.startedAt,
      toolCalls,
      filesRead: read.size,
    });
    let result: DelegationResult;

    try {
      // Whatever changed before this run is not the agent's doing.
      await this.#watch?.settle();
      signal.throwIfAborted();
      run = this.#update(run, { status: 'running' });

      const context = this.#context.scoped(definition.context);
      for (const skill of definition.context.skills) await context.load(skill);
      const permissions = narrower(scope.profile, definition.permissions);
      const gate = new PermissionGate(permissions, {
        workspace: this.#workspace,
        agent: { name: definition.name, capabilities: definition.capabilities },
      });
      gate.beginTask(childTask(definition, delegated, scope.task));

      session = await this.#spawn({
        permissions,
        gate,
        // No delegation port: an agent's session has no delegate_task to call.
        context: context.session({ role: definition.instructions }),
        capabilities: definition.capabilities,
        activity: {
          pulse: () => this.#emit({ type: 'run-activity', run }),
          waiting: (on) => this.#emit({ type: 'run-activity', run, waiting: on }),
        },
      });
      debug('agents', run.id, 'session created', session.model, permissions);

      const input = delegationMessage(definition, delegated, scope.objective, this.#workspace);
      for await (const event of session.send(input, signal)) {
        // The agent's words are its result, collected; they are never shown
        // as they stream — the parent's answer is what the user reads.
        if (event.type === 'text-delta') answer += event.text;
        if (event.type === 'tool-start') {
          toolCalls += 1;
          if (event.name === 'Read' && event.target) read.add(event.target);
          if (toolCalls > budget.maxToolCalls)
            stop(`tool budget of ${budget.maxToolCalls} calls reached`);
        }
        this.#emit({ type: 'run-event', run, event });
      }
      result = fromAnswer(definition.name, answer, stats());
    } catch (error) {
      if (scope.signal.aborted) {
        result = emptyResult(definition.name, 'cancelled', 'Cancelled.', stats(), [...read]);
      } else if (stopped) {
        result = answer.trim()
          ? fromAnswer(definition.name, answer, stats(), 'partial', stopped)
          : emptyResult(definition.name, 'partial', `Stopped: ${stopped}.`, stats(), [...read]);
      } else {
        debug('agents', run.id, 'failed', error);
        result = emptyResult(definition.name, 'failed', toUserMessage(error), stats(), [...read]);
      }
    } finally {
      clearTimeout(timer);
      // The child's session only: whatever it shares with its parent — a
      // Codex connection — stays open for the parent.
      await session
        ?.close()
        .catch((error: unknown) => debug('agents', run.id, 'close failed', error));
      debug('agents', run.id, 'cleaned up');
    }

    result = await this.#audit(definition, result);
    run = this.#update(run, { status: result.status, completedAt: this.#now() });
    this.#runs.delete(run.id);
    debug(
      'agents',
      run.id,
      'completed',
      result.status,
      `${(run.completedAt ?? run.startedAt) - run.startedAt}ms`,
    );
    this.#emit({ type: 'run-end', run, result });
    return result;
  }

  /**
   * An agent that may not change the workspace must not have changed it. If
   * it did — a runtime bug, a tool that misreported itself — that is a policy
   * violation, reported as a failure rather than folded into the result.
   */
  async #audit(definition: AgentDefinition, result: DelegationResult): Promise<DelegationResult> {
    const mutates = definition.capabilities.some((capability) => capability !== 'read');
    if (mutates || !this.#watch) return result;
    let changed: string[];
    try {
      changed = await this.#watch.changed();
    } catch (error) {
      debug('agents', 'workspace check failed', error);
      return result;
    }
    if (changed.length === 0) return result;
    const reason = `Policy violation: ${definition.name} is read-only, but the workspace changed during its run (${changed.slice(0, 10).join(', ')}).`;
    debug('agents', reason);
    return { ...result, status: 'failed', reason };
  }

  #update(run: AgentRun, change: Partial<AgentRun>): AgentRun {
    const next = { ...run, ...change };
    this.#runs.set(run.id, next);
    return next;
  }

  #emit(event: AgentEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        // Showing an agent's work must never break the agent.
        debug('agents', 'listener failed', error);
      }
    }
  }
}

/** A delegation refused before any run started. */
function refused(agent: string, reason: string): DelegationResult {
  return emptyResult(agent, 'failed', reason, { durationMs: 0, toolCalls: 0, filesRead: 0 });
}

const RANK: Record<PermissionProfile, number> = { 'read-only': 0, smart: 1, 'workspace-write': 2 };

/** The narrower of two profiles: a child never runs wider than its parent. */
export function narrower(a: PermissionProfile, b: PermissionProfile): PermissionProfile {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * What the delegated task authorises, read from the task as from any request,
 * and then capped twice: by what the agent may ever do, and by what the
 * parent's own request authorised.
 */
export function childTask(
  definition: AgentDefinition,
  task: string,
  parent: TaskAuthorization,
): TaskAuthorization {
  const own = authorizeTask(task, null);
  const canChange = definition.capabilities.some(
    (capability) => capability === 'write' || capability === 'edit',
  );
  const modify = canChange && own.modifyWorkspace && parent.modifyWorkspace;
  return {
    ...own,
    modifyWorkspace: modify,
    createFiles: modify && parent.createFiles,
    continued: false,
  };
}

/**
 * The DelegationContext, as the agent receives it: why (the user's request,
 * for context), what (its task) and within which limits. Nothing else of the
 * parent's conversation is in it.
 */
export function delegationMessage(
  definition: AgentDefinition,
  task: string,
  objective: string,
  workspace: string,
): string {
  const allowed = definition.capabilities.includes('read')
    ? 'read, list and search files'
    : 'nothing in the workspace';
  const goal = objective.trim();
  return [
    'The main agent of Polaris has delegated a task to you.',
    ...(goal && goal !== task
      ? [
          '',
          '<parent_objective>',
          'What the user asked the main agent — context only; your task is below.',
          clip(goal, MAX_OBJECTIVE_CHARS),
          '</parent_objective>',
        ]
      : []),
    '',
    '<delegated_task>',
    clip(task, MAX_DELEGATED_TASK_CHARS),
    '</delegated_task>',
    '',
    '<constraints>',
    `- Workspace: ${workspace}. Use paths relative to it.`,
    `- You may ${allowed}. Anything else is unavailable and will be refused, not asked about.`,
    `- At most ${definition.budget.maxToolCalls} tool calls and ${Math.round(definition.budget.maxRuntimeMs / 60_000)} minutes.`,
    '- You cannot delegate to other agents.',
    '</constraints>',
    '',
    RESULT_CONTRACT,
  ].join('\n');
}

/** The task as one short line, for the agent's row. */
function headline(task: string): string {
  const line = task.replace(/\s+/g, ' ').trim();
  return line.length <= 100 ? line : `${line.slice(0, 99)}…`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated by Polaris]`;
}
