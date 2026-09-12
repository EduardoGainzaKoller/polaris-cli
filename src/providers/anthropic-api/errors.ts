import Anthropic from '@anthropic-ai/sdk';
import { PolarisError } from '../../core/errors.ts';

/**
 * Turns SDK failures into short, safe messages. Nothing here ever interpolates
 * request payloads or headers, so credentials cannot reach the terminal; the
 * original error is kept as `cause` and only printed under `--debug`.
 */
export function toPolarisError(error: unknown): PolarisError {
  return new PolarisError(describeError(error), { cause: error });
}

const AUTH_MESSAGE =
  'Claude authentication failed — set ANTHROPIC_API_KEY (see README) and try again.';

export function describeError(error: unknown): string {
  // The SDK throws a plain Error (no typed class) when it finds no credential
  // source at all, so this one has to be recognised by its message.
  if (error instanceof Error && /could not resolve authentication/i.test(error.message)) {
    return AUTH_MESSAGE;
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return AUTH_MESSAGE;
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'Claude denied this request — check your account permissions.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limit reached — wait a moment and try again.';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'Model not found — check the model id with --model.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Claude rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Unable to connect to Claude — check your network connection.';
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude API error${error.status ? ` (${error.status})` : ''}.`;
  }
  if (error instanceof Error) return error.message;
  return 'Unexpected provider failure.';
}
