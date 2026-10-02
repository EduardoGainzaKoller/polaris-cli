import { debug } from '../core/logger.ts';
import { resolveInWorkspace } from '../tools/workspace.ts';
import {
  type Capability,
  evaluate,
  type Operation,
  type PermissionDecision,
  type PermissionProfile,
} from './policy.ts';
import { ANALYSIS, type TaskAuthorization } from './task.ts';

/**
 * A pending authorisation, provider-agnostic on purpose: the UI renders one of
 * these whether it came from a Polaris tool, the Claude runtime's `canUseTool`
 * or a Codex JSON-RPC approval request. Nothing here knows which.
 */
export interface ApprovalRequest {
  readonly id: string;
  readonly capability: Capability;
  /** Human title: "Write", "Edit", "Run command". */
  readonly title: string;
  /** What it acts on: a workspace-relative path, or the command itself. */
  readonly target: string;
  /** Why this needs a person: the boundary it crosses. */
  readonly reason?: string;
  /** Can lose work that cannot be recovered. */
  readonly high?: boolean;
  /** Unified diff for a file change; the UI renders it line by line. */
  readonly diff?: string;
  /** Extra rows shown under the title, e.g. `cwd: …` or `New file · 12 lines`. */
  readonly facts?: readonly string[];
}

/** Allow once, or deny. Standing rules ("always allow npm") do not exist. */
export type ApprovalDecision = 'allow' | 'deny';

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** What the caller should do, and why the policy said so. */
export type Verdict = (
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }
) & { readonly decision?: PermissionDecision };

export const DENIED_BY_USER = 'Permission denied by the user.';

/** What an agent's gate allows at most, whatever its profile would. */
export interface AgentCeiling {
  readonly name: string;
  readonly capabilities: readonly Capability[];
}

/** What a provider shows on the card, beyond what the operation says. */
export type ApprovalCard = Omit<ApprovalRequest, 'id' | 'capability' | 'high'>;

/**
 * The single place any operation is authorised, in a fixed order:
 *
 *   1. hard constraints — outside the workspace is denied, never asked;
 *   2. the task — what the user's request authorised;
 *   3. the operation's risk — what a command would cross;
 *   4. the profile.
 *
 * Only `ask` reaches a person. It is not a sandbox: the workspace boundary,
 * the process controls and a runtime's own sandbox still do their part; this
 * decides whether the call happens at all.
 */
export class PermissionGate {
  #profile: PermissionProfile;
  readonly #workspace: string | null;
  #handler: ApprovalHandler | null = null;
  #nextId = 0;
  #pending = 0;
  #task: TaskAuthorization = ANALYSIS;
  /** Operations the user refused in this task: asked once, not again. */
  readonly #refused = new Set<string>();
  /** Files this task has changed, for spotting an unexpectedly broad change. */
  readonly #edited = new Set<string>();
  #broadChangeApproved = false;
  /** An agent's gate: its capability ceiling, and nobody to ask. */
  readonly #agent: AgentCeiling | null;

  constructor(
    profile: PermissionProfile,
    options: { workspace?: string; agent?: AgentCeiling } = {},
  ) {
    this.#profile = profile;
    this.#workspace = options.workspace ?? null;
    this.#agent = options.agent ?? null;
  }

  get profile(): PermissionProfile {
    return this.#profile;
  }

  set profile(profile: PermissionProfile) {
    this.#profile = profile;
  }

  get busy(): boolean {
    return this.#pending > 0;
  }

  get task(): TaskAuthorization {
    return this.#task;
  }

  /**
   * The user sent a request: this is what it authorises until the next one.
   * Only Polaris calls this, from the user's own message.
   */
  beginTask(task: TaskAuthorization): void {
    if (!task.continued) {
      this.#refused.clear();
      this.#edited.clear();
      this.#broadChangeApproved = false;
    }
    this.#task = task;
    debug(
      'task',
      `intent=${task.intent}`,
      `modifyWorkspace=${task.modifyWorkspace}`,
      `createFiles=${task.createFiles}`,
      task.continued ? '(continued)' : '',
    );
  }

  /** The UI (or a test) registers the one thing that can answer an approval. */
  onApproval(handler: ApprovalHandler | null): void {
    this.#handler = handler;
  }

  async authorize(
    operation: Operation,
    card: ApprovalCard,
    signal?: AbortSignal,
  ): Promise<Verdict> {
    const decision = await this.#decide(operation);
    debug('permissions', operation.target, '→', decision.decision, 'reason:', decision.reason);

    // An agent's ceiling is not a question for anyone: what lies outside it
    // is unavailable, and an agent never puts an approval to the user.
    if (this.#agent && decision.decision !== 'deny') {
      const { name, capabilities } = this.#agent;
      if (!capabilities.includes(operation.capability)) {
        return {
          allowed: false,
          reason: `${operation.capability} is not available to ${name}.`,
          decision: { ...decision, decision: 'deny' },
        };
      }
      if (decision.decision === 'ask') {
        return {
          allowed: false,
          reason: `${name} cannot ask for approval, and this is outside what it may do on its own: ${decision.reason}`,
          decision: { ...decision, decision: 'deny' },
        };
      }
    }

    if (decision.decision === 'allow') {
      this.#record(operation);
      return { allowed: true, decision };
    }
    if (decision.decision === 'deny') return { allowed: false, reason: decision.reason, decision };

    const key = `${operation.capability}:${operation.target}`;
    // The same operation, refused once in this task, is not put to the user
    // again: the model is told, and has to try something else.
    if (this.#refused.has(key)) {
      return {
        allowed: false,
        reason: `${DENIED_BY_USER} (already refused for this task)`,
        decision,
      };
    }
    if (!this.#handler) {
      return {
        allowed: false,
        reason: 'No approval surface is available in this session.',
        decision,
      };
    }

    signal?.throwIfAborted();
    this.#pending += 1;
    try {
      const answer = await this.#handler({
        ...card,
        id: `approval-${this.#nextId++}`,
        capability: operation.capability,
        reason: decision.reason,
        ...(decision.high ? { high: true } : {}),
      });
      if (answer !== 'allow') {
        this.#refused.add(key);
        return { allowed: false, reason: DENIED_BY_USER, decision };
      }
      if (decision.category === 'broad-change') this.#broadChangeApproved = true;
      this.#record(operation);
      return { allowed: true, decision };
    } finally {
      this.#pending -= 1;
    }
  }

  async #decide(operation: Operation): Promise<PermissionDecision> {
    const outside = await this.#outside(operation);
    if (outside) {
      // A read that strays out is not forbidden outright: it is simply not
      // the routine kind, and a person decides.
      if (operation.capability === 'read') {
        return {
          decision: 'ask',
          risk: 'sensitive',
          reason: outside,
          category: 'outside-workspace',
        };
      }
      return {
        decision: 'deny',
        risk: 'forbidden',
        reason: outside,
        category: 'outside-workspace',
      };
    }
    const touched = (operation.paths ?? []).map((path) => this.#key(path));
    return evaluate(operation, this.#profile, this.#task, {
      editedFiles: this.#edited.size,
      touchesNewFile: touched.some((path) => !this.#edited.has(path)),
      broadChangeApproved: this.#broadChangeApproved,
    });
  }

  /** The hard constraint: a reason when anything reaches outside the workspace. */
  async #outside(operation: Operation): Promise<string | null> {
    if (!this.#workspace) return null;
    const checks: Array<[string, string]> = [
      ...(operation.paths ?? []).map((path): [string, string] => [
        path,
        'Path is outside the workspace.',
      ]),
      ...(operation.cwd
        ? [[operation.cwd, 'Runs outside the workspace.'] as [string, string]]
        : []),
      ...(operation.grantRoot
        ? [
            [operation.grantRoot, 'Asks for write access outside the workspace.'] as [
              string,
              string,
            ],
          ]
        : []),
    ];
    for (const [path, reason] of checks) {
      try {
        await resolveInWorkspace(this.#workspace, path);
      } catch {
        return reason;
      }
    }
    return null;
  }

  #record(operation: Operation): void {
    if (operation.capability !== 'write' && operation.capability !== 'edit') return;
    for (const path of operation.paths ?? []) this.#edited.add(this.#key(path));
  }

  #key(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
}
