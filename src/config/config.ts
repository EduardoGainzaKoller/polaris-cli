import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../core/logger.ts';

export interface PolarisConfig {
  provider: string;
  model?: string;
}

const DEFAULTS: PolarisConfig = { provider: 'mock' };

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
    return { ...DEFAULTS, ...(parsed as Partial<PolarisConfig>) };
  } catch (error) {
    debug('config', 'using defaults:', (error as Error).message);
    return { ...DEFAULTS };
  }
}

/** Writes the config Polaris is currently running with, creating the directory if needed. */
export async function saveConfig(config: PolarisConfig): Promise<string> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  const stored: PolarisConfig = { provider: config.provider };
  if (config.model) stored.model = config.model;
  await writeFile(
    path,
    `${JSON.stringify(stored, null, 2)}
`,
    'utf8',
  );
  debug('config', 'saved', path);
  return path;
}
