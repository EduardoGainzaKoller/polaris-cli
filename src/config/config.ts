import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../core/logger.ts';

export interface PolarisConfig {
  provider: string;
  model?: string;
}

const DEFAULTS: PolarisConfig = { provider: 'mock' };

export function configPath(): string {
  return join(process.env.POLARIS_HOME ?? join(homedir(), '.polaris'), 'config.json');
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
