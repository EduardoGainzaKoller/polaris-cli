import { type PolarisConfig, saveConfig } from '../config/config.ts';
import { DEFAULT_PROFILE } from '../permissions/policy.ts';
import type { ProviderCheck } from '../providers/detect.ts';

/**
 * The first run: a short notice about what Polaris is, and one choice — the
 * provider. Nothing else is asked, no secret is ever requested, and the
 * permission profile starts at `smart`.
 */
export const PREVIEW_NOTICE = [
  'Polaris is an AI coding agent. It can inspect your repository, modify files,',
  'and run commands you approve, with Codex, Claude or the Anthropic API.',
  '',
  'This is a Developer Preview: it can modify files and execute commands in your',
  'workspace. Use it inside a Git repository while testing, and review the diff.',
] as const;

export interface OnboardingOption {
  readonly id: string;
  /** What the selector shows: `Codex — signed in`. */
  readonly label: string;
}

export interface OnboardingPlan {
  readonly options: readonly OnboardingOption[];
  /** The option to start on: the first provider that is ready. */
  readonly suggested: string;
}

/**
 * Ready providers first, in a fixed order; those that are not ready stay
 * choosable — a tester may be about to sign in — but say what they need. The
 * offline mock is always last and always available.
 */
export function planOnboarding(checks: readonly ProviderCheck[]): OnboardingPlan {
  const rank = (check: ProviderCheck) =>
    check.id === 'mock' ? 3 : check.status === 'available' ? 0 : check.status === 'unknown' ? 1 : 2;
  const ordered = [...checks].sort((a, b) => rank(a) - rank(b));
  const options = ordered.map((check) => ({
    id: check.id,
    label: `${check.label} — ${check.status === 'available' ? 'ready' : check.detail}`,
  }));
  return { options, suggested: ordered[0]?.id ?? 'mock' };
}

/** Saves the choice; from now on this is not a first run. */
export async function completeOnboarding(provider: string): Promise<PolarisConfig> {
  const config: PolarisConfig = { provider, permissions: DEFAULT_PROFILE };
  await saveConfig(config);
  return config;
}
