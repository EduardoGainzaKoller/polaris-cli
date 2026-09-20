import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { debug } from '../core/logger.ts';
import { polarisHome } from './config.ts';

/** Entries kept on disk; older ones fall off, like a shell history. */
export const MAX_HISTORY = 500;

export function historyPath(): string {
  return join(polarisHome(), 'history.json');
}

/**
 * Everything typed into the composer — prompts and slash commands — oldest
 * first, so ↑/↓ can walk back through previous sessions too. A missing or
 * corrupt file just means an empty history.
 */
export async function loadHistory(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(historyPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** The history with `entry` appended: blanks and immediate repeats are skipped. */
export function withEntry(history: readonly string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (trimmed.length === 0 || history.at(-1) === trimmed) return [...history];
  return [...history, trimmed].slice(-MAX_HISTORY);
}

/** Best effort: failing to remember a prompt must never interrupt the session. */
export async function saveHistory(history: readonly string[]): Promise<void> {
  try {
    const path = historyPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(history.slice(-MAX_HISTORY))}\n`, 'utf8');
  } catch (error) {
    debug('history', 'not saved:', (error as Error).message);
  }
}
