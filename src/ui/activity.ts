import {
  type Activity,
  ago,
  clock,
  type Liveness,
  liveness,
  SHOW_AFTER_MS,
} from '../core/activity.ts';

/**
 * Turning live activities into rows, without Ink, so every wording and every
 * threshold can be tested as plain data. Everything said here comes from an
 * event that actually happened; nothing guesses at what a model is "thinking".
 */
export interface ActivityRow {
  readonly depth: number;
  readonly kind: 'head' | 'status' | 'output';
  readonly text: string;
  /** Right-aligned on a head row: the running clock. */
  readonly aside?: string;
  /** How the row should read: normal, quiet (a long silence), waiting on a person. */
  readonly tone: 'active' | 'quiet' | 'approval' | 'cancelling';
}

/** Rows the live panel may take, whatever is running. */
export const MAX_ACTIVITY_ROWS = 10;

/**
 * The live panel: each activity as a head row with its clock, then what it is
 * waiting for, then — for a command — its last lines of output. Children sit
 * under their parent. Activities younger than a blink are left out, so a
 * 40 ms read never flashes by.
 */
export function activityRows(
  live: readonly Activity[],
  now: number,
  max = MAX_ACTIVITY_ROWS,
): ActivityRow[] {
  const shown = live.filter(
    (activity) =>
      activity.kind === 'approval' ||
      activity.kind === 'model' ||
      activity.kind === 'verification' ||
      now - activity.startedAt >= SHOW_AFTER_MS,
  );
  const ids = new Set(shown.map((activity) => activity.id));
  const rows: ActivityRow[] = [];

  const visit = (activity: Activity, depth: number) => {
    const children = shown.filter((child) => child.parentId === activity.id);
    const leaf = children.length === 0;
    const level = leaf ? liveness(activity, now) : 'active';
    const tone =
      activity.state === 'waiting-approval'
        ? 'approval'
        : activity.state === 'cancelling'
          ? 'cancelling'
          : level === 'active'
            ? 'active'
            : 'quiet';
    rows.push({
      depth,
      kind: 'head',
      text: headOf(activity),
      // A person deciding is not a clock running out.
      ...(activity.kind === 'approval' ? {} : { aside: clock(now - activity.startedAt) }),
      tone,
    });
    const status = statusOf(activity, now, leaf, level);
    if (status) rows.push({ depth: depth + 1, kind: 'status', text: status, tone });
    if (activity.kind === 'command' && leaf) {
      for (const line of activity.tail) {
        rows.push({ depth: depth + 1, kind: 'output', text: line, tone });
      }
    }
    for (const child of children) visit(child, depth + 1);
  };

  for (const root of shown.filter(
    (activity) => !activity.parentId || !ids.has(activity.parentId),
  )) {
    visit(root, 0);
  }
  return rows.slice(0, max);
}

/** What the activity is, as the head row says it. */
function headOf(activity: Activity): string {
  if (activity.kind === 'command') return `Run ${activity.label}`;
  if (activity.kind === 'tool' && activity.tool) return `${activity.tool} ${activity.label}`;
  return activity.label;
}

/**
 * The second row: what it is waiting for and, for the one actually waiting,
 * how long since anything happened. Parents waiting on a child say nothing
 * about silence — the child is where the waiting is.
 */
export function statusOf(activity: Activity, now: number, leaf = true, level?: Liveness): string {
  if (activity.state === 'cancelling') return 'cancelling…';
  if (activity.state === 'waiting-approval') return 'waiting for approval';
  const doing = doingOf(activity);
  if (!leaf) return doing;

  const silent = now - activity.lastActivityAt;
  const state = level ?? liveness(activity, now);
  const isCommand = activity.kind === 'command';
  const quietWord = isCommand
    ? activity.lastOutputAt
      ? 'no new output'
      : 'no output yet'
    : activity.kind === 'model'
      ? 'no response data'
      : 'no activity';

  if (state === 'active') {
    if (isCommand && activity.lastOutputAt)
      return `last output ${ago(now - activity.lastOutputAt)} ago`;
    return [doing, silent >= 3000 ? `last activity ${ago(silent)} ago` : '']
      .filter(Boolean)
      .join(' · ');
  }
  if (state === 'quiet') {
    const since = isCommand
      ? activity.lastOutputAt
        ? `last output ${ago(silent)} ago`
        : quietWord
      : `last activity ${ago(silent)} ago`;
    return [doing, since].filter(Boolean).join(' · ');
  }
  // Said plainly and only as far as Polaris knows: it has not seen an end.
  const still = `${quietWord} for ${ago(silent)} · still active · ctrl+c to cancel`;
  return state === 'slow' ? `${still} · may be slow or stalled` : still;
}

function doingOf(activity: Activity): string {
  switch (activity.state) {
    case 'waiting-model':
      return 'waiting for model response';
    case 'waiting-runtime':
      return 'waiting for runtime';
    case 'streaming':
      return 'streaming response';
    case 'waiting-tool':
      return 'running tools';
    default:
      break;
  }
  if (activity.kind === 'verification') return 'running relevant checks';
  if (activity.kind === 'command') return activity.lastOutputAt ? '' : 'process running';
  switch (activity.tool) {
    case 'Read':
      return 'reading';
    case 'Grep':
    case 'Glob':
    case 'List':
      return 'searching repository';
    case 'Write':
      return 'writing';
    case 'Edit':
      return 'editing';
    default:
      return 'running';
  }
}

/**
 * The status bar's version: one leaf, a few words. `./gradlew test · 00:47`,
 * `waiting for model · 00:18`, `no activity · 36s`, `waiting for approval`.
 */
export function activitySummary(live: readonly Activity[], now: number): string {
  if (live.length === 0) return '';
  const approval = live.find((activity) => activity.state === 'waiting-approval');
  if (approval) return 'waiting for approval';
  if (live.some((activity) => activity.state === 'cancelling')) return 'cancelling…';
  // The deepest, newest activity is the one actually being waited on.
  const leaf =
    [...live].reverse().find((activity) => !live.some((child) => child.parentId === activity.id)) ??
    (live.at(-1) as Activity);
  const level = liveness(leaf, now);
  const name =
    leaf.kind === 'model'
      ? leaf.state === 'streaming'
        ? 'streaming'
        : 'waiting for model'
      : leaf.kind === 'command' || leaf.kind === 'tool'
        ? headOf(leaf).replace(/^Run /, '')
        : leaf.label;
  const elapsed = clock(now - leaf.startedAt);
  if (level === 'silent' || level === 'slow') {
    return `${name} · ${elapsed} · no activity ${ago(now - leaf.lastActivityAt)}`;
  }
  if (level === 'quiet') return `${name} · ${elapsed} · quiet ${ago(now - leaf.lastActivityAt)}`;
  return `${name} · ${elapsed}`;
}
