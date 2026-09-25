import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Loaded before every test file: Polaris's home becomes a throwaway
 * directory, so no test can ever read or overwrite the real
 * ~/.polaris/config.json, history or skills.
 */
process.env.POLARIS_HOME = mkdtempSync(join(tmpdir(), 'polaris-test-home-'));
