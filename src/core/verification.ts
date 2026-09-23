import type { FileChange } from '../workspace/changes.ts';

/**
 * Whether the current workspace has been shown to work.
 *
 * Verification is not a separate agent: it is bookkeeping over the coding
 * loop that is already running. Every check command the model runs is
 * recorded with the workspace revision it ran against; every change to the
 * workspace bumps the revision. A check therefore only counts while nothing
 * has changed since — edit, test ✓, edit again, and the pass is stale.
 */
export type VerificationState =
  /** Nothing changed and nothing checked: nothing to say. */
  | 'none'
  /** Changes exist and no check has run against them, or the last ones are stale. */
  | 'unverified'
  | 'verifying'
  | 'verified'
  | 'failed'
  /** A check against the current state was cancelled before it finished. */
  | 'incomplete';

export type CheckOutcome = 'running' | 'passed' | 'failed' | 'cancelled';

export interface CheckRun {
  readonly id: string;
  readonly command: string;
  readonly outcome: CheckOutcome;
  readonly exitCode?: number;
  readonly at: Date;
  /** The workspace revision the command saw. */
  readonly revision: number;
}

/**
 * Commands that check something rather than just look at something. The
 * model chooses what to run for the stack in front of it; this only decides
 * which of those runs are evidence that the code works.
 *
 * ponytail: a keyword heuristic — `cat test.txt` counts, a bespoke `make ci`
 * does not. Replace with the model declaring intent when that matters.
 */
const CHECK =
  /test|spec|check|lint|build|verify|\btsc\b|jest|mocha|clippy|\bvet\b|mypy|ruff|\bmake\b/i;

export function isCheck(command: string): boolean {
  return CHECK.test(command);
}

export class Verifier {
  #revision = 0;
  #runs: CheckRun[] = [];

  get revision(): number {
    return this.#revision;
  }

  /** The workspace changed: every check so far is about an older state. */
  mutated(): void {
    this.#revision += 1;
  }

  /** Records a command as it starts; false when it is not a check. */
  started(id: string, command: string): boolean {
    if (!isCheck(command)) return false;
    this.#runs.push({ id, command, outcome: 'running', at: new Date(), revision: this.#revision });
    return true;
  }

  isRunning(id: string): boolean {
    return this.#runs.some((run) => run.id === id && run.outcome === 'running');
  }

  /** A refused command never ran, so it is forgotten rather than failed. */
  finished(
    id: string,
    outcome: Exclude<CheckOutcome, 'running'> | 'denied',
    exitCode?: number,
  ): void {
    if (outcome === 'denied') {
      this.#runs = this.#runs.filter((run) => run.id !== id);
      return;
    }
    this.#runs = this.#runs.map((run) =>
      run.id === id && run.outcome === 'running'
        ? { ...run, outcome, ...(exitCode === undefined ? {} : { exitCode }) }
        : run,
    );
  }

  /** The turn ended with checks still running: none of them finished. */
  cancelRunning(): void {
    this.#runs = this.#runs.map((run) =>
      run.outcome === 'running' ? { ...run, outcome: 'cancelled' } : run,
    );
  }

  /** The latest run of each command, split by whether it saw the current workspace. */
  checks(): { current: CheckRun[]; stale: CheckRun[] } {
    const latest = new Map<string, CheckRun>();
    for (const run of this.#runs) latest.set(run.command, run);
    const runs = [...latest.values()];
    return {
      current: runs.filter((run) => run.revision === this.#revision),
      stale: runs.filter((run) => run.revision !== this.#revision),
    };
  }

  state(hasChanges: boolean): VerificationState {
    const { current } = this.checks();
    if (current.some((run) => run.outcome === 'running')) return 'verifying';
    if (current.some((run) => run.outcome === 'failed')) return 'failed';
    if (current.some((run) => run.outcome === 'cancelled')) return 'incomplete';
    if (current.some((run) => run.outcome === 'passed')) return 'verified';
    return hasChanges ? 'unverified' : 'none';
  }

  reset(): void {
    this.#revision = 0;
    this.#runs = [];
  }
}

export const RESULT_LABEL: Record<VerificationState, string> = {
  none: 'nothing to verify',
  unverified: 'unverified',
  verifying: 'verifying',
  verified: 'passed',
  failed: 'failed',
  incomplete: 'incomplete',
};

/**
 * The verification block: what changed, what was checked against it, what
 * appeared that nobody wrote, and the verdict. Plain rows, so the TUI, the
 * line renderer and the exit summary all print the same thing.
 */
export function verificationLines(
  changes: readonly FileChange[],
  checks: { current: readonly CheckRun[]; stale: readonly CheckRun[] },
  state: VerificationState,
): string[] {
  const lines: string[] = [];
  lines.push('  Changes');
  if (changes.length === 0) lines.push('    none');
  for (const change of changes.slice(0, 12)) {
    lines.push(`    ${MARK[change.kind]} ${change.path}`);
  }
  if (changes.length > 12) lines.push(`    … ${changes.length - 12} more (see /diff)`);

  lines.push('  Checks');
  if (checks.current.length === 0 && checks.stale.length === 0) lines.push('    none run');
  for (const run of checks.current) lines.push(`    ${checkRow(run)}`);
  for (const run of checks.stale) {
    lines.push(`    ! ${run.command}  stale — ran before the latest change`);
  }

  const unexpected = changes.filter((change) => change.unexpected);
  lines.push('  Workspace');
  if (unexpected.length === 0) lines.push('    ✓ no unexpected changes');
  for (const change of unexpected.slice(0, 6)) {
    lines.push(`    ! unexpected change: ${change.path}`);
  }
  for (const change of changes.filter((item) => item.external)) {
    lines.push(`    ! changed outside Polaris: ${change.path}`);
  }

  lines.push(`  Result    ${RESULT_LABEL[state]}`);
  return lines;
}

const MARK = { created: 'A', modified: 'M', deleted: 'D' } as const;

function checkRow(run: CheckRun): string {
  switch (run.outcome) {
    case 'passed':
      return `✓ ${run.command}`;
    case 'failed':
      return `✗ ${run.command}${run.exitCode === undefined ? '' : `  exit ${run.exitCode}`}`;
    case 'cancelled':
      return `○ ${run.command}  cancelled`;
    default:
      return `… ${run.command}  running`;
  }
}

/**
 * What every provider's model is told about finishing work. It shapes the
 * answer; the verification block Polaris prints after the turn is what makes
 * a wrong answer visible anyway.
 */
export const COMPLETION_GUIDANCE = [
  'When you change code, run the project’s relevant tests or checks before saying the work is',
  'done, and run them again after any later edit: a pass from before an edit no longer counts.',
  'If checks still fail when you stop, say plainly "Implementation changed, but verification',
  'failed." and what is failing. Never claim something works when its checks failed or were',
  'not run.',
].join(' ');

/** The instruction `/verify` sends: the model picks the commands, Polaris keeps the score. */
export function verifyPrompt(changes: readonly FileChange[]): string {
  const files = changes.length > 0 ? changes.map((change) => change.path).join(', ') : 'none';
  return [
    'Verify the current state of the workspace. Work out this project’s test, typecheck and lint',
    'commands from its own files (package.json, build files, CI config, README) and run the ones',
    'relevant to the changes. Do not modify any files. Report which commands passed or failed.',
    `Files changed this session: ${files}.`,
  ].join(' ');
}
