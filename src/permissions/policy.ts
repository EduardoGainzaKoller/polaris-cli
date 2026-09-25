import { type Classification, classifyCommand, type Risk, type RiskCategory } from './risk.ts';
import type { TaskAuthorization } from './task.ts';

/**
 * What a tool *does*, independent of who is allowed to do it: "Polaris can
 * edit files" and "Polaris may edit this file now" are different questions.
 */
export type Capability = 'read' | 'write' | 'edit' | 'command';

export type Decision = 'allow' | 'ask' | 'deny';

export type PermissionProfile = 'read-only' | 'smart' | 'workspace-write';

export const PERMISSION_PROFILES = ['read-only', 'smart', 'workspace-write'] as const;

/** Routine work goes ahead; crossing a boundary asks. */
export const DEFAULT_PROFILE: PermissionProfile = 'smart';

export function isProfile(value: string): value is PermissionProfile {
  return (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/**
 * A stored or typed profile name, with v0.6's `ask` read as `smart` — the
 * profile it grew into. null for anything unknown, which callers turn into
 * the default: a typo must never widen access.
 */
export function toProfile(value: string): PermissionProfile | null {
  if (value === 'ask') return 'smart';
  return isProfile(value) ? value : null;
}

/**
 * Whether a capability is offered at all. Read-only has no file writes to
 * offer; it keeps commands, because safe Git inspection is reading too — and
 * every other command is denied there by the policy below.
 */
export function isAvailable(profile: PermissionProfile, capability: Capability): boolean {
  return !(profile === 'read-only' && (capability === 'write' || capability === 'edit'));
}

/** One operation, described the same way whichever runtime asked for it. */
export interface Operation {
  readonly capability: Capability;
  /** What it acts on, for the card and for "already refused" memory. */
  readonly target: string;
  /** Files a write or edit changes, or a read reads: absolute or workspace-relative. */
  readonly paths?: readonly string[];
  /** The command line, for `command`. */
  readonly command?: string;
  /** Where a command runs; the workspace when absent. */
  readonly cwd?: string;
  /** A write that replaces an existing file entirely: its current length. */
  readonly replacesLines?: number;
  /** A runtime asking to widen its writable root. */
  readonly grantRoot?: string;
  /** A runtime saying the command wants the network, e.g. `api.github.com`. */
  readonly network?: string;
}

export interface PermissionDecision {
  readonly decision: Decision;
  readonly risk: Risk;
  readonly reason: string;
  readonly category: RiskCategory | 'read' | 'edit' | 'broad-change';
  readonly high?: boolean;
}

/** More files than this in one task is not a local change any more. */
export const MASS_CHANGE_FILES = 25;
/** Replacing an existing file this long, wholesale, is worth a look. */
export const LARGE_OVERWRITE_LINES = 300;

/** Per-task counters the policy needs, kept by the gate. */
export interface TaskState {
  /** Distinct files this task has changed so far. */
  readonly editedFiles: number;
  /** True when this operation touches a file the task has not changed yet. */
  readonly touchesNewFile: boolean;
  /** The user already agreed to a broad change in this task. */
  readonly broadChangeApproved: boolean;
}

const allow = (reason: string, category: PermissionDecision['category']): PermissionDecision => ({
  decision: 'allow',
  risk: 'safe',
  reason,
  category,
});
const ask = (
  reason: string,
  category: PermissionDecision['category'],
  high = false,
): PermissionDecision => ({
  decision: 'ask',
  risk: 'sensitive',
  reason,
  category,
  ...(high ? { high: true } : {}),
});
const deny = (reason: string, category: PermissionDecision['category']): PermissionDecision => ({
  decision: 'deny',
  risk: 'forbidden',
  reason,
  category,
});

/**
 * The policy, once the hard constraints (the workspace boundary) have passed:
 *
 *   read                    allow
 *   command                 classified: safe → allow, sensitive → ask
 *                           (read-only: safe → allow, anything else → deny)
 *   write / edit
 *     read-only             deny
 *     smart                 allow when the task asked for changes, else ask;
 *                           a very broad change or a large overwrite asks
 *     workspace-write       allow
 */
export function evaluate(
  operation: Operation,
  profile: PermissionProfile,
  task: TaskAuthorization,
  state: TaskState,
): PermissionDecision {
  if (operation.capability === 'read') return allow('Reading inside the workspace.', 'read');

  if (operation.capability === 'command') {
    if (operation.network) {
      if (profile === 'read-only') return deny('Read-only has no network access.', 'network');
      return ask(`Requests network access to ${operation.network}.`, 'network');
    }
    const risk: Classification = classifyCommand(operation.command ?? operation.target);
    if (risk.risk === 'safe') return allow(risk.reason, risk.category);
    if (profile === 'read-only') {
      return deny(`Read-only runs only safe inspection commands. ${risk.reason}`, risk.category);
    }
    return ask(risk.reason, risk.category, risk.high === true);
  }

  // write / edit
  if (profile === 'read-only') return deny('Read-only does not change files.', 'edit');
  if (profile === 'workspace-write') {
    return allow('Workspace edits are allowed under workspace-write.', 'edit');
  }
  if (!task.modifyWorkspace) {
    return ask(
      `The current request (${task.intent}) did not ask for changes to the workspace.`,
      'edit',
    );
  }
  if (
    state.touchesNewFile &&
    state.editedFiles >= MASS_CHANGE_FILES &&
    !state.broadChangeApproved
  ) {
    return ask(
      `This task has already changed ${state.editedFiles} files; going wider needs your approval.`,
      'broad-change',
    );
  }
  if ((operation.replacesLines ?? 0) >= LARGE_OVERWRITE_LINES) {
    return ask(
      `Replaces an existing ${operation.replacesLines}-line file entirely.`,
      'broad-change',
    );
  }
  return allow('Normal workspace edit authorised by the current task.', 'edit');
}

/** One line each, for /permissions. */
export const PROFILE_SUMMARY: Record<PermissionProfile, string> = {
  'read-only': 'Repository inspection only.',
  smart: 'Does the routine work the current task needs; asks only when crossing a risk boundary.',
  'workspace-write': 'Allows workspace modifications; sensitive commands still ask.',
};

/**
 * What every model is told about approvals. The policy is enforced in code;
 * this only stops a model from asking in prose for what Polaris already
 * decides, and from reaching for a shell command where a file tool does the
 * same job without crossing any boundary.
 */
export const AUTONOMY_GUIDANCE = [
  'Polaris decides what needs the user’s approval and asks them itself when an operation',
  'crosses a risk boundary: running project code, installing packages, network access,',
  'destructive Git commands. Do not ask in your reply for permission to read, search or edit',
  'files, and do not announce routine steps — do them. Prefer the file tools for reading,',
  'searching and editing over shell commands that do the same (cat, ls, grep, sed), which',
  'need approval more often. If the user refuses an operation, do not repeat it: explain',
  'what you wanted to do or suggest an alternative.',
].join(' ');
