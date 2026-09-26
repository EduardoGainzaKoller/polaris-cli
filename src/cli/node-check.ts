/**
 * The oldest Node.js Polaris runs on. Ink 7, the terminal UI, needs 22; nothing
 * else in Polaris needs more.
 */
export const MIN_NODE_MAJOR = 22;

export function nodeSupported(version: string): boolean {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR;
}
