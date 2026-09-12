/**
 * The only contract the CLI core knows about. Concrete providers
 * (openai/, anthropic/, ...) live in subfolders and never leak their SDK
 * types past this file.
 */
export interface ProviderSessionOptions {
  /** Directory Polaris was launched from; future tools operate inside it. */
  readonly cwd: string;
  readonly model?: string;
}

export interface ModelReply {
  readonly text: string;
}

export interface ModelSession {
  readonly model: string;
  /** `signal` lets the REPL cancel an in-flight turn with Ctrl+C. */
  send(input: string, signal?: AbortSignal): Promise<ModelReply>;
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
