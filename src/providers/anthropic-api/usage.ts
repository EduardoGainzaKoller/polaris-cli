import type Anthropic from '@anthropic-ai/sdk';
import { addTokens, type TokenCounts, type UsageLimit } from '../../core/usage.ts';

/**
 * Consumption for the stateless Messages API, where Polaris owns the loop and
 * so must do its own counting: every request's `usage` is added to a per-model
 * total for the session.
 *
 * Summing is correct *here* and wrong for the Claude runtime, which reports a
 * running total of its own — the difference is why each provider keeps its own
 * accounting rather than sharing one accumulator.
 */
export class UsageTracker {
  readonly #byModel = new Map<string, TokenCounts>();
  #limits: UsageLimit[] = [];

  record(model: string, usage: Anthropic.Usage | undefined): void {
    if (!usage) return;
    const counts: TokenCounts = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      ...(usage.cache_read_input_tokens === null
        ? {}
        : { cacheRead: usage.cache_read_input_tokens }),
      ...(usage.cache_creation_input_tokens === null
        ? {}
        : { cacheWrite: usage.cache_creation_input_tokens }),
      ...(usage.output_tokens_details?.thinking_tokens == null
        ? {}
        : { reasoning: usage.output_tokens_details.thinking_tokens }),
    };
    this.#byModel.set(
      model,
      addTokens(this.#byModel.get(model) ?? { input: 0, output: 0 }, counts),
    );
  }

  /**
   * The API reports its ceilings in response headers rather than in a body, so
   * they are read from the last response of the session — which is also the
   * most recent truth about how much is left.
   */
  recordHeaders(response: Response | null | undefined): void {
    if (!response) return;
    const parsed = parseRateLimits(response.headers);
    if (parsed.length > 0) this.#limits = parsed;
  }

  get models(): Array<{ model: string; tokens: TokenCounts }> {
    return [...this.#byModel].map(([model, tokens]) => ({ model, tokens }));
  }

  get limits(): UsageLimit[] {
    return this.#limits;
  }
}

/**
 * `anthropic-ratelimit-<what>-<limit|remaining|reset>`. Read by shape rather
 * than from a hard-coded list, so a ceiling the API starts reporting tomorrow
 * shows up without a code change — and one it stops reporting simply
 * disappears instead of rendering as a zero.
 */
export function parseRateLimits(headers: Headers): UsageLimit[] {
  const found = new Map<string, { limit?: number; remaining?: number; resetsAt?: Date }>();

  headers.forEach((value, key) => {
    const match = /^anthropic-ratelimit-(.+)-(limit|remaining|reset)$/.exec(key.toLowerCase());
    if (!match) return;
    const [, what = '', field = ''] = match;
    const entry = found.get(what) ?? {};
    if (field === 'reset') {
      const at = new Date(value);
      if (!Number.isNaN(at.getTime())) entry.resetsAt = at;
    } else {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) entry[field === 'limit' ? 'limit' : 'remaining'] = parsed;
    }
    found.set(what, entry);
  });

  return [...found]
    .map(([what, entry]) => ({
      name: what.replace(/-/g, ' '),
      ...(entry.limit === undefined ? {} : { limit: entry.limit }),
      ...(entry.remaining === undefined ? {} : { remaining: entry.remaining }),
      ...(entry.resetsAt ? { resetsAt: entry.resetsAt } : {}),
      // A percentage is only meaningful with both ends of the range.
      ...(entry.limit !== undefined && entry.remaining !== undefined && entry.limit > 0
        ? { usedPercent: ((entry.limit - entry.remaining) / entry.limit) * 100 }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
