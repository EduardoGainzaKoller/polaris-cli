/**
 * Internal/debug logging. Always goes to stderr so it never pollutes the
 * conversation the user sees on stdout (and stays pipe-friendly).
 */
let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function isDebug(): boolean {
  return debugEnabled;
}

export function debug(scope: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  process.stderr.write(`[${new Date().toISOString()}] ${scope} ${format(args)}\n`);
}

function format(args: unknown[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}
