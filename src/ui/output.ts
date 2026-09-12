import { homedir } from 'node:os';
import { theme } from './theme.ts';

/** Everything the *user* sees goes through here. Debug logging lives in core/logger.ts. */
export const ui = {
  write(text: string): void {
    process.stdout.write(text);
  },
  line(text = ''): void {
    process.stdout.write(`${text}\n`);
  },
  banner(cwd: string, provider: string, model: string): void {
    ui.line();
    ui.line(`  ${theme.accent('✦ Polaris')}`);
    ui.line();
    ui.line(`  ${theme.dim(shortenPath(cwd))}`);
    ui.line(`  ${theme.dim(`${provider} · ${model}`)}`);
    ui.line();
  },
  error(message: string): void {
    process.stderr.write(`${theme.error('✗')} ${message}\n`);
  },
  info(message: string): void {
    ui.line(theme.dim(message));
  },
  table(rows: Array<[string, string]>): void {
    const width = Math.max(0, ...rows.map(([key]) => key.length));
    for (const [key, value] of rows) {
      ui.line(`  ${theme.dim(key.padEnd(width))}  ${value}`);
    }
    ui.line();
  },
  clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  },
};

/** `/home/me/projects/x` -> `~/projects/x` */
export function shortenPath(absolute: string): string {
  const home = homedir();
  return absolute.startsWith(home) ? `~${absolute.slice(home.length)}` : absolute;
}
