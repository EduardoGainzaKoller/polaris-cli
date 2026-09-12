import type { ModelProvider, ModelSession, ProviderSessionOptions } from '../provider.ts';

/**
 * Offline provider used to exercise the whole CLI without any API key.
 * Replaced, not extended, once real providers land.
 */
export const mockProvider: ModelProvider = {
  id: 'mock',
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    let turns = 0;
    return {
      model: options.model ?? 'echo',
      async send(input, signal) {
        signal?.throwIfAborted();
        turns += 1;
        return { text: `You said: ${input}` };
      },
      async close() {
        void turns;
      },
    };
  },
};
