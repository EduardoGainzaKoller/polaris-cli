import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';

/** Split into a few chunks so the mock exercises the same streaming path as a real provider. */
function chunks(input: string): string[] {
  return ['You ', 'said: ', input];
}

/**
 * Offline provider used to exercise the whole CLI without credentials or network.
 * It keeps the conversation so multi-turn behaviour is testable too.
 */
export const mockProvider: ModelProvider = {
  id: 'mock',
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    const history: string[] = [];
    return {
      model: options.model ?? 'echo',
      async *send(input, signal): AsyncIterable<ModelEvent> {
        signal?.throwIfAborted();
        history.push(input);
        yield { type: 'message-start' };
        for (const text of chunks(input)) {
          signal?.throwIfAborted();
          yield { type: 'text-delta', text };
        }
        yield { type: 'message-end' };
      },
      async close() {
        history.length = 0;
      },
    };
  },
};
