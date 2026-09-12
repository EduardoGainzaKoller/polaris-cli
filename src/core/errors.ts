/** Errors whose message is safe (and intended) to show to the user. */
export class PolarisError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PolarisError';
  }
}

export function toUserMessage(error: unknown): string {
  if (error instanceof PolarisError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
