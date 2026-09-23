import type { UsageReport } from '../core/usage.ts';
import type { PermissionGate } from '../permissions/gate.ts';
import type { PermissionProfile } from '../permissions/policy.ts';

/**
 * The only contract the CLI core knows about. Concrete providers
 * (anthropic/, openai/, ...) live in subfolders and never leak their SDK
 * types past this file.
 */
export interface ProviderSessionOptions {
  /** Workspace root: the directory Polaris was launched from. */
  readonly cwd: string;
  readonly model?: string;
  /** Reasoning effort to start with; the runtime's default when omitted. */
  readonly effort?: string;
  /** What Polaris may do to the workspace, and when it must ask first. */
  readonly permissions: PermissionProfile;
  /**
   * The one thing that can authorise a mutation. Providers whose runtime owns
   * the agent loop route their own approval requests through it, so a Codex
   * command and a Polaris `write_file` reach the user the same way.
   */
  readonly gate: PermissionGate;
}

/**
 * Provider-agnostic stream of what the model is doing.
 *
 * Tool events describe *observed* activity, whoever executed it: Polaris's own
 * registry (anthropic-api, mock) or a runtime's native tools (Claude, Codex).
 * They carry what a person needs to follow along — a human tool name, what it
 * targeted, a one-line outcome — and never the raw content the model read.
 *
 * `id` is stable within a turn and comes from the provider when it has one.
 * Several tools may be running at once. Failures of the turn itself are still
 * thrown; `tool-error` is a tool the model can recover from.
 */
export type ModelEvent =
  | { readonly type: 'message-start' }
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-start';
      readonly id: string;
      /** Human name: Read, Glob, Grep, Write, Edit, Run… */
      readonly name: string;
      readonly target: string;
    }
  | {
      /**
       * Live output from a running tool — a test suite printing as it goes.
       * This is for the person watching: what the model finally receives is
       * the tool's result, which may be truncated.
       */
      readonly type: 'tool-output-delta';
      readonly id: string;
      readonly text: string;
    }
  | { readonly type: 'tool-result'; readonly id: string; readonly summary: string }
  | {
      readonly type: 'tool-error';
      readonly id: string;
      readonly error: string;
      /** A person refused it, rather than it going wrong. */
      readonly denied?: boolean;
    }
  | { readonly type: 'message-end' };

/**
 * What a provider may do to the workspace under the active profile, and who
 * enforces it. `mode` is the profile itself, so the UI never has to translate
 * between a provider's vocabulary and Polaris's.
 */
export interface ToolAccess {
  readonly mode: PermissionProfile;
  /** Who executes the tools: Polaris itself, or the provider's own runtime. */
  readonly runtime: string;
  /** Wire or human names of what is available. */
  readonly tools: readonly string[];
  /**
   * True when the runtime confines the tools with an OS sandbox as well as
   * asking. Polaris's own `run_command` has approvals, a pinned directory and
   * a timeout — but no isolation — and says so rather than implying otherwise.
   */
  readonly sandboxed?: boolean;
}

export interface ModelSession {
  readonly model: string;
  /**
   * One conversational turn. The session keeps the conversation context, so
   * successive calls are multi-turn. `signal` cancels the turn (Ctrl+C).
   */
  send(input: string, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  /**
   * Model ids this session can switch to. Optional: a provider that offers no
   * discovery simply omits it, and Polaris says so instead of guessing.
   */
  listModels?(): Promise<string[]>;
  /** Reasoning effort in use, when the runtime reports or accepts one. */
  readonly effort?: string | undefined;
  /**
   * Effort levels the current model accepts. Together with `setEffort`, it is
   * optional: a provider without a notion of effort omits both.
   */
  efforts?(): Promise<string[]>;
  /**
   * Changes the effort for the following turns without starting a new
   * conversation. Every runtime Polaris supports can do this live.
   */
  setEffort?(effort: string): Promise<void>;
  /** What this session may do, once the runtime has been configured for it. */
  readonly access: ToolAccess;
  /**
   * Tokens, limits and cost as this runtime measures them. Optional, and may
   * return null: a provider that cannot report consumption says so rather
   * than returning zeroes that look like real measurements.
   */
  usage?(): Promise<UsageReport | null>;
  close(): Promise<void>;
}

export interface ModelProvider {
  readonly id: string;
  /**
   * Profiles this provider can actually honour. A provider that cannot enforce
   * one says so here rather than accepting it and quietly doing something
   * else; Polaris refuses the switch instead of misreporting it.
   */
  readonly supports: readonly PermissionProfile[];
  createSession(options: ProviderSessionOptions): Promise<ModelSession>;
}

const providers = new Map<string, ModelProvider>();

export function registerProvider(provider: ModelProvider): void {
  providers.set(provider.id, provider);
}

export function getProvider(id: string): ModelProvider | undefined {
  return providers.get(id);
}

export function listProviders(): ModelProvider[] {
  return [...providers.values()];
}
