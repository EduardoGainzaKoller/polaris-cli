import { readFileSync } from 'node:fs';

/**
 * Single source of truth for the version: package.json sits one directory above
 * both `src/` and the compiled `dist/`, so the same path works either way.
 */
export const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
