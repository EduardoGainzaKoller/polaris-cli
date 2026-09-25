import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Internal/debug logging, kept away from the conversation. It goes to stderr
 * normally, but a full-screen UI owns the terminal, so the TUI redirects it to
 * a file instead of letting it tear the layout apart.
 */
let debugEnabled = false;
let logFile: string | null = null;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

/** Sends debug output to `path` instead of stderr. Returns the path in use. */
export function setLogFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
  return path;
}

export function debug(scope: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  const line = `[${new Date().toISOString()}] ${scope} ${format(args)}\n`;
  if (!logFile) {
    process.stderr.write(line);
    return;
  }
  try {
    appendFileSync(logFile, line);
  } catch {
    // Logging must never take the session down with it.
  }
}

function format(args: unknown[]): string {
  return redact(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
}

/**
 * Credentials never reach a log, even partly masked by the runtime that
 * reported them: API keys (`sk-…`), GitHub and Slack tokens, bearer headers.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9*._-]{6,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_*]{6,}/g, '$1_[redacted]')
    .replace(/\bxox[abprs]-[A-Za-z0-9*-]{6,}/g, 'xox-[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9*._~+/=-]{6,}/gi, '$1 [redacted]');
}
