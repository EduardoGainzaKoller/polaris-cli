import { PolarisError } from '../../core/errors.ts';

/**
 * The Agent SDK reports failures as plain messages (from the CLI runtime it
 * drives), so they are recognised by shape rather than by error class. Nothing
 * here interpolates more than a short, known-safe hint — credentials and
 * headers never reach the terminal.
 */
export function toPolarisError(error: unknown): PolarisError {
  return new PolarisError(describeError(error), { cause: error });
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/not logged in|invalid api key|authentication|unauthorized|401/i.test(message)) {
    return 'Claude is not authenticated — set ANTHROPIC_API_KEY (see README) and try again.';
  }
  if (/enoent|spawn|could not find|not found.*claude|executable/i.test(message)) {
    return 'Claude Code runtime was not found — reinstall dependencies without --omit=optional, or install Claude Code and set POLARIS_CLAUDE_EXECUTABLE.';
  }
  if (/rate limit|429/i.test(message)) {
    return 'Rate limit reached — wait a moment and try again.';
  }
  if (/econnrefused|enotfound|etimedout|network|fetch failed/i.test(message)) {
    return 'Unable to connect to Claude — check your network connection.';
  }
  return 'Claude session could not be started.';
}

/** A turn that ended with `is_error` never carries a usable answer. */
export function turnFailure(subtype: string, detail?: string): PolarisError {
  const message =
    detail && /not logged in|invalid api key|authentication|401/i.test(detail)
      ? describeError(new Error(detail))
      : subtype === 'error_max_turns'
        ? 'Claude stopped: the turn limit was reached.'
        : 'Claude could not complete this turn.';
  return new PolarisError(message, { cause: detail ?? subtype });
}
