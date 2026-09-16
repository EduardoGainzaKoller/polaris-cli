/**
 * The only contract the CLI core knows about. Concrete providers
 * (anthropic/, openai/, ...) live in subfolders and never leak their SDK
 * types past this file.
 */
export interface ProviderSessionOptions {
  /** Directory Polaris was launched from; future tools operate inside it. */
  readonly cwd: string;
  readonly model?: string;
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
      /** Human name: Read, Glob, Grep, List, Shell… */
      readonly name: string;
      readonly target: string;
    }
  | { readonly type: 'tool-result'; readonly id: string; readonly summary: string }
  | { readonly type: 'tool-error'; readonly id: string; readonly error: string }
  | { readonly type: 'message-end' };

/**
 * What a provider can do to the workspace. In v0.5 every provider is
 * read-only; the type leaves room for more without making it configurable.
 */
export interface ToolAccess {
  readonly mode: 'read-only';
  /** Who executes the tools: Polaris itself, or the provider's own runtime. */
  readonly runtime: string;
  /** Human names of what is available. */
  readonly tools: readonly string[];
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
  close(): Promise<void>;
}

export interface ModelProvider {
  readonly id: string;
  readonly access: ToolAccess;
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
