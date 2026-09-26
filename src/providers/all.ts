import { PERMISSION_PROFILES } from '../permissions/policy.ts';
import { type ModelProvider, registerProvider } from './provider.ts';

/**
 * Every provider Polaris ships, registered as a light stand-in that loads the
 * real one — and its SDK — only when a session with it starts. The SDKs are
 * the heaviest part of Polaris; a Codex user never pays for loading Claude's.
 */
const PROVIDERS: Record<string, () => Promise<ModelProvider>> = {
  mock: async () => (await import('./mock/index.ts')).mockProvider,
  'anthropic-api': async () => (await import('./anthropic-api/index.ts')).anthropicApiProvider,
  claude: async () => (await import('./claude/index.ts')).claudeProvider,
  codex: async () => (await import('./codex/index.ts')).codexProvider,
};

export async function registerProviders(): Promise<void> {
  for (const [id, load] of Object.entries(PROVIDERS)) {
    registerProvider({
      id,
      // All four honour every profile; the real provider still checks at start.
      supports: PERMISSION_PROFILES,
      createSession: async (options) => (await load()).createSession(options),
    });
  }
}
