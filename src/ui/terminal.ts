/**
 * Puts the terminal back the way a shell expects it: mouse reporting off,
 * the normal screen, a visible cursor, cooked input. Safe to call any number
 * of times, and a no-op when there is no terminal — used on every way out,
 * including crashes the UI never saw coming.
 */
const MOUSE_OFF = '\u001b[?1000l\u001b[?1006l';
const NORMAL_SCREEN = '\u001b[?1049l';
const SHOW_CURSOR = '\u001b[?25h';

export function restoreTerminal(): void {
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {
    // Already closed.
  }
  if (!process.stdout.isTTY) return;
  try {
    process.stdout.write(MOUSE_OFF + NORMAL_SCREEN + SHOW_CURSOR);
  } catch {
    // The terminal is gone; there is nothing left to restore.
  }
}
