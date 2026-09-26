import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PolarisError } from '../core/errors.ts';
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
   * system living in a file nobody reviews.
   */
  permissions?: PermissionProfile;
}

/**
 * The shape of the file on disk. `version` exists so a future change can be
 * migrated deliberately; today there is only one, and v0.6's `ask` profile is
 * read as `smart`. Fields Polaris does not know are kept, never dropped.
 */
export const CONFIG_VERSION = 1;

const DEFAULTS: PolarisConfig = { provider: 'mock', permissions: DEFAULT_PROFILE };

export function polarisHome(): string {
  return process.env.POLARIS_HOME ?? join(homedir(), '.polaris');
}

export function configPath(): string {
  return join(polarisHome(), 'config.json');
}

/** True when no configuration has ever been saved: the first run. */
export async function configExists(): Promise<boolean> {
  try {
    await access(configPath());
    return true;
  } catch {
    return false;
  }
}

/**
 * `~/.polaris/config.json`, or the defaults when there is none. A file that
 * exists but cannot be read as a configuration stops Polaris with the path
 * and what to do — it is never silently ignored, and never overwritten.
 */
export async function loadConfig(): Promise<PolarisConfig> {
  const stored = await readStored();
  if (!stored) return { ...DEFAULTS };
  const config: PolarisConfig = {
    ...DEFAULTS,
    ...(typeof stored.provider === 'string' ? { provider: stored.provider } : {}),
    ...(typeof stored.model === 'string' ? { model: stored.model } : {}),
    ...(typeof stored.effort === 'string' ? { effort: stored.effort } : {}),
    // `ask` became `smart`; an unknown name falls back to the default rather
    // than to whatever it happens to spell — a typo must never widen access.
    permissions:
      (typeof stored.permissions === 'string' ? toProfile(stored.permissions) : null) ??
      DEFAULT_PROFILE,
  };
  debug('config', 'loaded', configPath());
  return config;
}

/**
 * Writes the settings Polaris manages, keeping any other field already in the
 * file. The directory is created on first save.
 */
export async function saveConfig(config: PolarisConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = (await readStored()) ?? {};
  } catch {
    // An unreadable file is being replaced on purpose by an explicit save.
  }
  const { model: _model, effort: _effort, ...kept } = existing;
  const stored: Record<string, unknown> = {
    ...kept,
    version: CONFIG_VERSION,
    provider: config.provider,
    permissions: config.permissions ?? DEFAULT_PROFILE,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
  };
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  debug('config', 'saved', path);
  return path;
}

async function readStored(): Promise<Record<string, unknown> | null> {
  const path = configPath();
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalidConfig(path, (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw invalidConfig(path, (error as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalidConfig(path, 'expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function invalidConfig(path: string, detail: string): PolarisError {
  return new PolarisError(
    [
      'Invalid Polaris configuration.',
      '',
      `  File:   ${path}`,
      `  Reason: ${detail}`,
      '',
      'Fix the file or delete it to start the setup again. Polaris will not overwrite it.',
      'For details, run: polaris doctor',
    ].join('\n'),
    { code: 'POLARIS_CONFIG_INVALID' },
  );
}
