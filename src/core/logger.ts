import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two kinds of lines, kept away from the conversation:
 *
 * - `info`: startup facts, lifecycle and errors. Written to the session log
 *   file whenever one is open, so a tester can attach it to a bug report even
 *   if they did not think of `--debug` first.
 * - `debug`: everything else, only with `--debug`.
 *
 * Without a log file, debug lines go to stderr. The full-screen UI owns the
 * terminal, so it always logs to a file. Every line is redacted first.
 */
let debugEnabled = false;
let logFile: string | null = null;
let written = 0;

/** Session logs kept in the logs directory; older ones are deleted. */
export const MAX_LOG_FILES = 10;
/** A session log stops growing here, with a line saying so. */
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

/** The session log in use, or null. */
export function logPath(): string | null {
  return logFile;
}

/**
 * Starts a new session log in `directory`, keeping only the most recent
 * ones. Returns its path, or null when the directory cannot be written —
 * logging must never stop Polaris from starting.
 */
export function openSessionLog(directory: string, now = new Date()): string | null {
  try {
    mkdirSync(directory, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const path = join(directory, `polaris-${stamp}-${process.pid}.log`);
    logFile = path;
    written = 0;
    prune(directory);
    return path;
  } catch {
    logFile = null;
    return null;
  }
}

/** Stops writing to the session log. */
export function closeSessionLog(): void {
  logFile = null;
}

function prune(directory: string): void {
  const logs = readdirSync(directory)
    .filter((name) => /^polaris-.*\.log$/.test(name))
    .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const old of logs.slice(MAX_LOG_FILES - 1)) {
    try {
      unlinkSync(join(directory, old.name));
    } catch {
      // In use by another Polaris, or already gone.
    }
  }
}

/** Facts worth having in every session log: always written to the file. */
export function info(scope: string, ...args: unknown[]): void {
  write(scope, args, false);
}

export function debug(scope: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  write(scope, args, true);
}

function write(scope: string, args: unknown[], toStderr: boolean): void {
  const line = `[${new Date().toISOString()}] ${scope} ${format(args)}\n`;
  if (!logFile) {
    if (toStderr) process.stderr.write(line);
    return;
  }
  if (written > MAX_LOG_BYTES) return;
  try {
    written += Buffer.byteLength(line);
    appendFileSync(
      logFile,
      written > MAX_LOG_BYTES ? '[log truncated: size limit reached]\n' : line,
    );
  } catch {
    // Logging must never take the session down with it.
  }
}

function format(args: unknown[]): string {
  return redact(
    args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' '),
  );
}

/**
 * Credentials never reach a log, even partly masked by the runtime that
 * reported them: API keys (`sk-…`), GitHub and Slack tokens, bearer and
 * basic authorization, cookies, and anything assigned to a variable whose
 * name says it is a key, token, secret or password.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk)-[A-Za-z0-9*._-]{6,}/g, '$1-[redacted]')
    .replace(/\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_*]{6,}/g, '$1_[redacted]')
    .replace(/\bxox[abprs]-[A-Za-z0-9*-]{6,}/g, 'xox-[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9*._~+/=-]{6,}/gi, '$1 [redacted]')
    .replace(/\b(cookie|set-cookie)(["']?\s*[:=]\s*)[^\n]+/gi, '$1$2[redacted]')
    .replace(
      /\b([A-Z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Z0-9_]*)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1$2[redacted]',
    );
}
