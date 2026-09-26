// Removes the previous build, so a file deleted from src/ can never ship from a stale dist/.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
