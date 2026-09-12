import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { PolarisError } from '../src/core/errors.ts';
import { describeError, toPolarisError } from '../src/providers/anthropic/errors.ts';

/** Builds a real SDK error object without touching the network. */
function apiError(status: number, type: string): Anthropic.APIError {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type, message: `sk-ant-secret-should-not-leak (${type})` } },
    'request failed',
    new Headers(),
  );
}

test('auth, rate limit and connection failures get clean one-line messages', () => {
  assert.match(describeError(apiError(401, 'authentication_error')), /authentication failed/i);
  assert.match(describeError(apiError(429, 'rate_limit_error')), /rate limit/i);
  assert.match(describeError(apiError(403, 'permission_error')), /denied/i);
  assert.match(describeError(apiError(404, 'not_found_error')), /model not found/i);
  assert.match(describeError(apiError(500, 'api_error')), /^Claude API error \(500\)\.$/);
  assert.match(
    describeError(new Anthropic.APIConnectionError({ message: 'fetch failed' })),
    /Unable to connect/i,
  );
});

test('clean messages never echo the underlying payload', () => {
  for (const status of [401, 403, 429, 404, 500]) {
    assert.doesNotMatch(describeError(apiError(status, 'error')), /sk-ant/);
  }
});

test('unknown failures degrade gracefully', () => {
  assert.equal(describeError(new Error('plain failure')), 'plain failure');
  assert.equal(describeError('not an error'), 'Unexpected provider failure.');
});

test('toPolarisError keeps the original error for --debug', () => {
  const original = apiError(401, 'authentication_error');
  const wrapped = toPolarisError(original);
  assert.ok(wrapped instanceof PolarisError);
  assert.equal(wrapped.cause, original);
});

test('a missing credential source is reported as an auth failure, not raw SDK text', () => {
  const raw = new Error(
    'Could not resolve authentication method. Expected one of apiKey, authToken, ...',
  );
  assert.match(describeError(raw), /authentication failed/i);
  assert.doesNotMatch(describeError(raw), /apiKey/);
});
