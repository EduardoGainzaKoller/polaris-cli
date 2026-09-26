import { readFileSync } from 'node:fs';

/**
 * Single source of truth for the version: package.json sits one directory above
 * both `src/` and the compiled `dist/`, so the same path works either way — in
 * the repository and in an installed package alike.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
  bugs?: { url?: string };
};

export const VERSION: string = manifest.version;

/** Where testers report problems and ideas; nothing is ever sent automatically. */
export const FEEDBACK_URL: string | null = manifest.bugs?.url ?? null;
