import { type Capability, decide, type PermissionProfile } from './policy.ts';

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
  /** Why the runtime asked, when it says. */
  readonly reason?: string;
  /** Unified diff for a file change; the UI renders it line by line. */
  readonly diff?: string;
  /** Extra rows shown under the title, e.g. `cwd: …` or `New file · 12 lines`. */
  readonly facts?: readonly string[];
}

/**
 * v0.6 keeps the decision set to two. "Always allow this command" is the kind
 * of standing rule that needs a rule store and a way to review it; both belong
 * to a later phase.
 */
export type ApprovalDecision = 'allow' | 'deny';

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** What the caller should do, once the profile and the user have both spoken. */
export type Verdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export const DENIED_BY_USER = 'Permission denied by the user.';

/**
 * The single place a mutation is authorised. It owns two things and no more:
 * the active profile, and the round-trip to whoever answers approvals.
 *
 * It is not a sandbox. Nothing here stops a tool from doing what it was asked
 * to do — the workspace boundary, the process controls and the runtime's own
 * sandbox do that. This decides *whether the call happens at all*.
 */
export class PermissionGate {
  #profile: PermissionProfile;
  #handler: ApprovalHandler | null = null;
  #nextId = 0;
  /** Requests waiting for an answer, so the UI can be told one is pending. */
  #pending = 0;

  constructor(profile: PermissionProfile) {
    this.#profile = profile;
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

  /** The UI (or a test) registers the one thing that can answer an approval. */
  onApproval(handler: ApprovalHandler | null): void {
    this.#handler = handler;
  }

  /**
   * Resolves one call against the profile. `allow` and `deny` never reach the
   * user; only `ask` does. With no handler registered — a pipe, a script —
   * an ask is a denial, because nobody can consent.
   */
  async authorize(
    capability: Capability,
    request: Omit<ApprovalRequest, 'id' | 'capability'>,
    signal?: AbortSignal,
  ): Promise<Verdict> {
    const decision = decide(this.#profile, capability);
    if (decision === 'allow') return { allowed: true };
    if (decision === 'deny') {
      return {
        allowed: false,
        reason: `Not permitted under the "${this.#profile}" permission profile.`,
      };
    }
    if (!this.#handler) {
      return { allowed: false, reason: 'No approval surface is available in this session.' };
    }

    signal?.throwIfAborted();
    this.#pending += 1;
    try {
      const answer = await this.#handler({
        ...request,
        id: `approval-${this.#nextId++}`,
        capability,
      });
      return answer === 'allow' ? { allowed: true } : { allowed: false, reason: DENIED_BY_USER };
    } finally {
      this.#pending -= 1;
    }
  }
}
