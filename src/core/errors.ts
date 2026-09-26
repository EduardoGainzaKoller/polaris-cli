/**
 * Codes for the failures a tester is most likely to report, so a bug report
 * names the problem precisely. Only critical errors carry one.
 */
export type ErrorCode =
  | 'POLARIS_CONFIG_INVALID'
  | 'POLARIS_PROVIDER_START_FAILED'
  | 'POLARIS_NODE_UNSUPPORTED'
  | 'POLARIS_UNEXPECTED';

/** Errors whose message is safe (and intended) to show to the user. */
export class PolarisError extends Error {
  readonly code: ErrorCode | undefined;

  constructor(message: string, options?: { cause?: unknown; code?: ErrorCode }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PolarisError';
    this.code = options?.code;
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof PolarisError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** True for failures Polaris did not anticipate: bugs, not situations. */
export function isUnexpected(error: unknown): boolean {
  return !(error instanceof PolarisError);
}
