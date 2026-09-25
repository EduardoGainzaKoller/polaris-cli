import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../core/logger.ts';
import { DEFAULT_PROFILE, type PermissionProfile, toProfile } from '../permissions/policy.ts';

export interface PolarisConfig {
  provider: string;
  model?: string;
  /** Reasoning effort, e.g. "high". Left to the model's default when omitted. */
  effort?: string;
  /**
   * What Polaris may do to the workspace. Only the profile name is ever
   * stored: standing rules like "always allow npm" would be a permission
   * system living in a file nobody reviews, and v0.6 has none.
   */
  permissions?: PermissionProfile;
}

const DEFAULTS: PolarisConfig = { provider: 'mock', permissions: DEFAULT_PROFILE };

export function polarisHome(): string {
  return process.env.POLARIS_HOME ?? join(homedir(), '.polaris');
}

export function configPath(): string {
  return join(polarisHome(), 'config.json');
}

/**
 * Optional `~/.polaris/config.json`. A missing or malformed file is never fatal:
 * Polaris warns in debug mode and falls back to defaults.
 */
export async function loadConfig(): Promise<PolarisConfig> {
  const path = configPath();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('expected an object');
    debug('config', 'loaded', path);
    const stored = parsed as Partial<PolarisConfig>;
    return {
      ...DEFAULTS,
      ...stored,
      // An unknown profile in the file falls back to the default rather than
      // to whatever it happens to spell: a typo must never widen access.
      // v0.6's `ask` became `smart`; an unknown name falls back to the default.
      permissions:
        (typeof stored.permissions === 'string' ? toProfile(stored.permissions) : null) ??
        DEFAULT_PROFILE,
    };
  } catch (error) {
    debug('config', 'using defaults:', (error as Error).message);
    return { ...DEFAULTS };
  }
}

/** Writes the config Polaris is currently running with, creating the directory if needed. */
export async function saveConfig(config: PolarisConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const stored: PolarisConfig = {
    provider: config.provider,
    permissions: config.permissions ?? DEFAULT_PROFILE,
  };
  if (config.model) stored.model = config.model;
  if (config.effort) stored.effort = config.effort;
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  debug('config', 'saved', path);
  return path;
}
