import type { TokenCounts, UsageLimit, UsageReport } from '../../core/usage.ts';
import type { JsonObject } from './app-server.ts';

/**
 * Codex is the one runtime that meters against a plan rather than per request:
 * `account/rateLimits/read` returns rolling windows as percentages, and the
 * thread reports its own token totals and context window as it goes. Both are
 * translated here; nothing is computed that Codex did not state.
 *
 * Verified against `codex app-server generate-ts` (codex-cli 0.153.4):
 * `RateLimitWindow { usedPercent, windowDurationMins, resetsAt }` and
 * `ThreadTokenUsage { total, last, modelContextWindow }`.
 */

export interface RateLimitsResponse {
  rateLimits?: RateLimitSnapshot | null;
}

interface RateLimitSnapshot {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  planType?: string | null;
  credits?: { balance?: string | null; unlimited?: boolean } | null;
}

interface RateLimitWindow {
  usedPercent?: number;
  /** Length of the rolling window; what makes "23%" mean something. */
  windowDurationMins?: number | null;
  /** Unix seconds. */
  resetsAt?: number | null;
}

export function toLimits(snapshot: RateLimitSnapshot | null | undefined): UsageLimit[] {
  if (!snapshot) return [];
  return [window(snapshot.primary, 'primary'), window(snapshot.secondary, 'secondary')].filter(
    (limit): limit is UsageLimit => limit !== null,
  );
}

function window(value: RateLimitWindow | null | undefined, fallback: string): UsageLimit | null {
  if (!value || value.usedPercent === undefined) return null;
  return {
    // Codex names a window by its length, which says far more than "primary".
    name: value.windowDurationMins ? describeWindow(value.windowDurationMins) : fallback,
    usedPercent: value.usedPercent,
    ...(value.resetsAt ? { resetsAt: new Date(value.resetsAt * 1000) } : {}),
  };
}

function describeWindow(minutes: number): string {
  if (minutes % (60 * 24 * 7) === 0) {
    const weeks = minutes / (60 * 24 * 7);
    return weeks === 1 ? 'weekly' : `${weeks}-week window`;
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? 'daily' : `${days}-day window`;
  }
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

/** `thread/tokenUsage/updated`; the running total for this thread. */
export function toTokens(params: JsonObject): {
  tokens: TokenCounts;
  contextWindow?: number;
  contextUsed?: number;
} | null {
  const usage = params.tokenUsage as
    | { total?: Breakdown; last?: Breakdown; modelContextWindow?: number | null }
    | undefined;
  const total = usage?.total;
  if (!total) return null;
  return {
    tokens: {
      input: total.inputTokens ?? 0,
      output: total.outputTokens ?? 0,
      ...(total.cachedInputTokens === undefined ? {} : { cacheRead: total.cachedInputTokens }),
      ...(total.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWrite: total.cacheWriteInputTokens }),
      ...(total.reasoningOutputTokens === undefined
        ? {}
        : { reasoning: total.reasoningOutputTokens }),
    },
    ...(usage?.modelContextWindow ? { contextWindow: usage.modelContextWindow } : {}),
    // What the *conversation* currently holds is the last turn's input, not
    // the session total: the total counts every turn's context again.
    ...(usage?.last?.inputTokens === undefined
      ? {}
      : {
          contextUsed:
            (usage.last.inputTokens ?? 0) +
            (usage.last.cachedInputTokens ?? 0) +
            (usage.last.outputTokens ?? 0),
        }),
  };
}

interface Breakdown {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export function buildReport(
  model: string,
  thread: ReturnType<typeof toTokens>,
  snapshot: RateLimitSnapshot | null | undefined,
): UsageReport | null {
  const limits = toLimits(snapshot);
  if (!thread && limits.length === 0) return null;
  const plan =
    snapshot?.planType && snapshot.planType !== 'unknown' ? snapshot.planType : undefined;
  return {
    ...(plan ? { plan } : {}),
    models: thread
      ? [
          {
            model,
            tokens: thread.tokens,
            ...(thread.contextWindow ? { contextWindow: thread.contextWindow } : {}),
            ...(thread.contextUsed === undefined ? {} : { contextUsed: thread.contextUsed }),
          },
        ]
      : [],
    limits,
    note:
      limits.length > 0
        ? 'Limits are your ChatGPT plan’s, reported by Codex. Tokens are this thread’s.'
        : 'Tokens are this thread’s, reported by Codex.',
  };
}
