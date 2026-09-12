import { PolarisError } from '../../core/errors.ts';

/**
 * Codex reports failures as JSON-RPC errors, spawn errors and turn statuses, so
 * they are recognised by shape rather than by error class. The original is kept
 * as `cause` for --debug; nothing here can print a token, because the provider
 * never asks the runtime for one.
 */
export function toPolarisError(error: unknown): PolarisError {
  return new PolarisError(describeError(error), { cause: error });
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/enoent|not recognized|no such file|spawn .*not found/i.test(message)) {
    return 'Codex CLI was not found in PATH — install Codex (see README) or set POLARIS_CODEX_EXECUTABLE.';
  }
  if (/not logged in|unauthor|401|sign in|auth/i.test(message)) {
    return notAuthenticated().message;
  }
  if (/rate limit|429|quota/i.test(message)) {
    return 'Codex rate limit reached — wait a moment and try again.';
  }
  if (/econnrefused|enotfound|etimedout|network|offline/i.test(message)) {
    return 'Unable to reach Codex — check your network connection.';
  }
  return 'Failed to start Codex runtime.';
}

export function notAuthenticated(): PolarisError {
  return new PolarisError('Codex is not authenticated — run `codex` and sign in with ChatGPT.');
}

/** An intentional shutdown, so it is never reported as a crash. */
export function sessionClosed(): PolarisError {
  return new PolarisError('Codex session closed.');
}

export function runtimeStopped(): PolarisError {
  return new PolarisError('Codex runtime stopped unexpectedly.');
}

/** A turn that ends in `failed`; `detail` comes from the runtime, never from a payload we hold. */
export function turnFailed(detail?: string): PolarisError {
  if (detail && /unauthor|not logged in|sign in|401/i.test(detail)) return notAuthenticated();
  return new PolarisError('Codex turn failed.', { cause: detail });
}
