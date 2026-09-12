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
 * Provider-agnostic stream of what the model is doing. Deliberately small:
 * `thinking-delta`, `tool-start`, `tool-result` and `usage` are the obvious
 * next members, and adding them cannot break existing consumers as long as
 * they switch on `type` and ignore what they don't know.
 *
 * Failures are thrown, not emitted — a stream that stops mid-answer is an
 * exception, and the REPL already has one error path.
 */
export type ModelEvent =
  | { readonly type: 'message-start' }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'message-end' };

export interface ModelSession {
  readonly model: string;
  /**
   * One conversational turn. The session keeps the conversation context, so
   * successive calls are multi-turn. `signal` cancels the turn (Ctrl+C).
   */
  send(input: string, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  close(): Promise<void>;
}

export interface ModelProvider {
  readonly id: string;
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
