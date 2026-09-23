/**
 * What Polaris knows about consumption, in one shape every provider can fill
 * as far as it honestly can.
 *
 * The three runtimes meter completely different things: the Messages API
 * reports tokens per request and per-minute ceilings in its response headers,
 * the Claude runtime reports cumulative tokens and cost per model, and Codex
 * reports percentage windows against a plan. Rather than invent a common
 * denominator — which would mean inventing numbers — every field here is
 * optional, and `/status` prints what it was given and stays quiet about the
 * rest. A provider that cannot measure something says nothing instead of
 * guessing, and `note` is where it explains why.
 */

export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  /** Reasoning tokens, where the runtime separates them out. */
  readonly reasoning?: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly tokens: TokenCounts;
  readonly costUsd?: number;
  readonly contextWindow?: number;
  /** Tokens the live conversation is holding, when the runtime tracks it. */
  readonly contextUsed?: number;
}

/**
 * A ceiling and how close to it we are. Providers express these differently —
 * a percentage of a rolling window, or tokens remaining this minute — so both
 * are representable and neither is converted into the other.
 */
export interface UsageLimit {
  /** What is limited: "5h window", "input tokens/min". */
  readonly name: string;
  readonly usedPercent?: number;
  readonly remaining?: number;
  readonly limit?: number;
  readonly resetsAt?: Date;
}

export interface UsageReport {
  /** The account's plan, when the provider names one. */
  readonly plan?: string;
  readonly models: readonly ModelUsage[];
  readonly limits: readonly UsageLimit[];
  readonly costUsd?: number;
  /** Why something is missing, in one sentence. */
  readonly note?: string;
}

export function totalTokens(counts: TokenCounts): number {
  return counts.input + counts.output + (counts.cacheRead ?? 0) + (counts.cacheWrite ?? 0);
}

/** Adds a request's counts to a running total; used where Polaris owns the loop. */
export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    ...maybe('cacheRead', sum(a.cacheRead, b.cacheRead)),
    ...maybe('cacheWrite', sum(a.cacheWrite, b.cacheWrite)),
    ...maybe('reasoning', sum(a.reasoning, b.reasoning)),
  };
}

function maybe<K extends string>(key: K, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

export const NO_TOKENS: TokenCounts = { input: 0, output: 0 };

/** "12.4k", "1.2M" — a count you can read at a glance rather than count digits in. */
export function compact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** "in 4h 12m", "in 3m", or "now" once it has passed. */
export function untilReset(at: Date, now = Date.now()): string {
  const minutes = Math.round((at.getTime() - now) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** A twenty-cell bar; percentages are easier to compare as a shape than as digits. */
export function bar(percent: number, width = 20): string {
  const filled = Math.round((clampPercent(percent) / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Renders a report as the lines `/status` prints. Kept here, away from the
 * command, so the layout is testable without a session.
 */
export function usageLines(report: UsageReport, indent = '  '): string[] {
  const lines: string[] = [];

  if (report.limits.length > 0) {
    lines.push(`${indent}Limits`);
    const width = Math.max(...report.limits.map((limit) => limit.name.length));
    for (const limit of report.limits) {
      const parts: string[] = [];
      if (limit.usedPercent !== undefined) {
        parts.push(`${bar(limit.usedPercent)} ${Math.round(limit.usedPercent)}%`);
      }
      if (limit.remaining !== undefined) {
        parts.push(
          limit.limit === undefined
            ? `${compact(limit.remaining)} left`
            : `${compact(limit.remaining)} / ${compact(limit.limit)} left`,
        );
      }
      if (limit.resetsAt) parts.push(`resets ${untilReset(limit.resetsAt)}`);
      lines.push(`${indent}  ${limit.name.padEnd(width)}  ${parts.join('  ')}`);
    }
  }

  if (report.models.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`${indent}Tokens by model`);
    const width = Math.max(...report.models.map((entry) => entry.model.length));
    for (const model of report.models) {
      const { tokens } = model;
      const parts = [
        `${compact(totalTokens(tokens))} total`,
        `${compact(tokens.input)} in`,
        `${compact(tokens.output)} out`,
      ];
      if (tokens.cacheRead) parts.push(`${compact(tokens.cacheRead)} cached`);
      if (model.costUsd !== undefined) parts.push(`$${model.costUsd.toFixed(4)}`);
      lines.push(`${indent}  ${model.model.padEnd(width)}  ${parts.join(' · ')}`);

      // Only when both ends are known: a window with no usage figure would
      // draw an empty bar, which reads as "nothing used" rather than
      // "not measured".
      if (model.contextWindow && model.contextUsed !== undefined) {
        const used = model.contextUsed;
        const percent = (used / model.contextWindow) * 100;
        lines.push(
          `${indent}  ${' '.repeat(width)}  context ${bar(percent)} ${compact(used)} / ${compact(model.contextWindow)}`,
        );
      }
    }
  }

  if (report.costUsd !== undefined) {
    lines.push('');
    lines.push(`${indent}Estimated cost  $${report.costUsd.toFixed(4)}`);
  }
  if (report.note) {
    if (lines.length > 0) lines.push('');
    lines.push(`${indent}${report.note}`);
  }
  return lines;
}
