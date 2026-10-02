import { debug } from './logger.ts';

/**
 * What Polaris is doing right now, how long it has been doing it and when
 * something real last happened.
 *
 * This is observability, not model output: `ModelEvent` says what the model
 * produced; an activity says what is running, what it is waiting for and how
 * recently it showed a sign of life. `lastActivityAt` moves only when an event
 * arrives — a delta, a runtime notification, a line of output, an answer to an
 * approval — never on a timer. The UI's once-a-second repaint reads the clock;
 * it does not write it.
 *
 * One tracker per Polaris session, not a global: a future team of agents gets
 * one tree per owner.
 */
export type ActivityKind = 'model' | 'tool' | 'command' | 'approval' | 'verification' | 'agent';

export type ActivityState =
  | 'waiting-model'
  | 'waiting-runtime'
  | 'waiting-tool'
  | 'waiting-approval'
  /** A turn whose model handed a task to an agent and is waiting for its result. */
  | 'waiting-agent'
  | 'streaming'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type Outcome = 'completed' | 'failed' | 'cancelled';

export interface Activity {
  readonly id: string;
  readonly kind: ActivityKind;
  /** What it is: `Codex`, `./gradlew test`, `src/foo.ts`. */
  readonly label: string;
  /** The tool name for tool and command activities: `Run`, `Read`, `Grep`. */
  readonly tool?: string;
  readonly state: ActivityState;
  readonly startedAt: number;
  /** Last real event. Never moved by a timer. */
  readonly lastActivityAt: number;
  /** Last line of output, for commands. */
  readonly lastOutputAt?: number;
  readonly parentId?: string;
  /** Whose work this is: an agent run's id, for the agent and everything under it. */
  readonly ownerId?: string;
  /** The last few lines of output, for the eye only; the model gets the tool result. */
  readonly tail: readonly string[];
  readonly endedAt?: number;
}

/** Output lines kept per activity for the live view. */
export const ACTIVITY_OUTPUT_LINES = 6;

/**
 * Liveness, all in one place. None of these cancels anything: they change
 * what is *said*, from nothing to "no activity for 43s" to "may be slow or
 * stalled" — never "stuck", which Polaris cannot know.
 */
export const QUIET_AFTER_MS = 15_000;
export const SILENT_AFTER_MS = 30_000;
export const SLOW_AFTER_MS = 60_000;
/** Younger activities are not drawn live: a 40 ms read is just a finished row. */
export const SHOW_AFTER_MS = 300;

export type Liveness = 'active' | 'quiet' | 'silent' | 'slow';

export class ActivityTracker {
  readonly #now: () => number;
  #live = new Map<string, Activity>();
  #next = 0;
  readonly #listeners = new Set<() => void>();
  /** Milliseconds spent per kind, for future session statistics. */
  readonly totals: Record<ActivityKind, number> = {
    model: 0,
    tool: 0,
    command: 0,
    approval: 0,
    verification: 0,
    agent: 0,
  };

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  now(): number {
    return this.#now();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  start(
    kind: ActivityKind,
    label: string,
    options: { state: ActivityState; parentId?: string; ownerId?: string; tool?: string },
  ): string {
    const id = `a${++this.#next}`;
    const now = this.#now();
    this.#live.set(id, {
      id,
      kind,
      label,
      state: options.state,
      startedAt: now,
      lastActivityAt: now,
      tail: [],
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(options.tool ? { tool: options.tool } : {}),
    });
    debug('activity', 'start', id, kind, options.state, label);
    this.#changed();
    return id;
  }

  /** Something real happened. Optionally the state changed with it. */
  touch(id: string | null | undefined, state?: ActivityState): void {
    const activity = id ? this.#live.get(id) : undefined;
    if (!activity || activity.state === 'cancelling') return;
    if (state && state !== activity.state) debug('activity', id, activity.state, '→', state);
    this.#live.set(activity.id, {
      ...activity,
      lastActivityAt: this.#now(),
      ...(state ? { state } : {}),
    });
    this.#changed();
  }

  /** Output from a running command: it is activity, and its last lines are kept. */
  output(id: string | null | undefined, text: string): void {
    const activity = id ? this.#live.get(id) : undefined;
    if (!activity) return;
    const now = this.#now();
    const lines = [...activity.tail, ...text.split(/\r?\n/)].filter((line, index, all) =>
      // Keep blank lines inside the stream, drop the trailing one a newline leaves.
      index < all.length - 1 ? true : line.length > 0,
    );
    this.#live.set(activity.id, {
      ...activity,
      lastActivityAt: now,
      lastOutputAt: now,
      tail: lines.slice(-ACTIVITY_OUTPUT_LINES),
    });
    this.#changed();
  }

  /** Ctrl+C was pressed: everything under way is now being cancelled, not cancelled yet. */
  cancelling(): void {
    for (const activity of this.#live.values()) {
      this.#live.set(activity.id, { ...activity, state: 'cancelling' });
    }
    this.#changed();
  }

  /** Ends an activity and returns it, with its duration, for the transcript. */
  finish(id: string | null | undefined, outcome: Outcome): Activity | null {
    const activity = id ? this.#live.get(id) : undefined;
    if (!activity) return null;
    const endedAt = this.#now();
    this.#live.delete(activity.id);
    this.totals[activity.kind] += endedAt - activity.startedAt;
    debug('activity', 'end', activity.id, outcome, `${endedAt - activity.startedAt}ms`);
    this.#changed();
    return { ...activity, state: outcome, endedAt };
  }

  /** Ends everything still live, e.g. when a turn ends by an error. */
  finishAll(outcome: Outcome): void {
    for (const id of [...this.#live.keys()]) this.finish(id, outcome);
  }

  get(id: string | null | undefined): Activity | undefined {
    return id ? this.#live.get(id) : undefined;
  }

  /** Live activities, oldest first — parents before their children. */
  live(): Activity[] {
    return [...this.#live.values()];
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        // Observability must never break the work it observes.
        debug('activity', 'listener failed', error);
      }
    }
  }
}

/** How long since the last real event, in words the UI can rely on. */
export function liveness(activity: Activity, now: number): Liveness {
  // Waiting for a person is intentional, and a cancellation is already in hand.
  if (activity.state === 'waiting-approval' || activity.state === 'cancelling') return 'active';
  const silent = now - activity.lastActivityAt;
  if (silent >= SLOW_AFTER_MS) return 'slow';
  if (silent >= SILENT_AFTER_MS) return 'silent';
  if (silent >= QUIET_AFTER_MS) return 'quiet';
  return 'active';
}

/** A running clock: `00:04`, `01:42`, `12:08`, `1:02:03`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** A finished duration: `0.08s`, `0.4s`, `42.8s`, `2m 14s`. */
export function took(ms: number): string {
  if (ms < 100) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return ago(ms);
}

/** A wait: `8s`, `1m 12s`, `1h 3m`. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
