import { isAbsolute, resolve } from 'node:path';
import type { Operation, PermissionProfile } from '../../permissions/policy.ts';
import { parseCommand } from '../../permissions/shell.ts';
import { truncateDiff } from '../../tools/diff.ts';
import type { JsonObject } from './app-server.ts';
import { type CommandAction, classify } from './items.ts';

/**
 * Codex owns its agent loop, its sandbox and its approval protocol. This file
 * is the translation layer and nothing else: a server-initiated approval
 * request becomes a Polaris `ApprovalRequest`, and the answer goes back in
 * Codex's own vocabulary. Polaris adds no rules of its own on top — doing so
 * would be a second permission system disagreeing with the first.
 *
 * Verified against `codex app-server generate-ts` (codex-cli 0.153.4):
 * `ServerRequest` carries `item/commandExecution/requestApproval` and
 * `item/fileChange/requestApproval` in the current protocol, and the legacy
 * `execCommandApproval` / `applyPatchApproval` for older servers.
 */

/** Sandbox and approval policy for a profile, as `thread/start` takes them. */
export function threadPolicy(profile: PermissionProfile): {
  sandbox: string;
  approvalPolicy: string;
} {
  // The sandbox is what the runtime can technically do; the approval policy is
  // when it must ask. Read-only keeps both closed, so nothing can be approved
  // into existence. Otherwise the sandbox is limited to the workspace — never
  // danger-full-access — and `on-request` lets the runtime ask when it needs
  // to step outside it.
  if (profile === 'read-only') return { sandbox: 'read-only', approvalPolicy: 'never' };
  // `untrusted`, not `on-request`: on-request only asks when the runtime wants
  // to leave its sandbox, so a workspace-write thread would edit files and run
  // commands without ever asking — which is not what either profile promises.
  // The sandbox stays limited to the workspace, so even an approved action
  // cannot reach outside it. Which of those requests actually reaches the user
  // is then the profile's decision, made by the gate, not Codex's.
  return { sandbox: 'workspace-write', approvalPolicy: 'untrusted' };
}

/** The decision values the current protocol accepts, per request family. */
const ACCEPT = 'accept';
const DECLINE = 'decline';

export interface ApprovalCard {
  /** What Codex wants to do, in Polaris's terms; the policy decides from this. */
  readonly operation: Operation;
  readonly title: string;
  readonly target: string;
  readonly reason?: string;
  readonly diff?: string;
  readonly facts?: readonly string[];
}

/**
 * Turns one server request into an approval card, or returns null when the
 * method is not an approval Polaris knows how to present.
 *
 * `item/fileChange/requestApproval` carries only ids — the diff itself arrived
 * earlier on the `item/started` notification — so the changes are looked up in
 * the cache the session keeps for exactly this.
 */
export function toCard(
  method: string,
  params: JsonObject,
  changesFor: (itemId: string) => FileChange[] | undefined,
  cwd: string,
): ApprovalCard | null {
  if (method === 'item/commandExecution/requestApproval') {
    return commandCard(unwrap(params), params, cwd);
  }
  if (method === 'execCommandApproval') {
    // Legacy shape: the command arrives already split into argv.
    const command = Array.isArray(params.command) ? params.command.join(' ') : '';
    return commandCard(command, params, cwd);
  }
  if (method === 'item/fileChange/requestApproval') {
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const changes = changesFor(itemId) ?? [];
    return fileCard(
      changes.map((change) => ({ path: change.path, diff: change.diff })),
      typeof params.reason === 'string' ? params.reason : undefined,
      typeof params.grantRoot === 'string' ? params.grantRoot : undefined,
      cwd,
    );
  }
  if (method === 'applyPatchApproval') {
    const changes = (params.fileChanges ?? {}) as Record<string, { unified_diff?: string }>;
    return fileCard(
      Object.entries(changes).map(([path, change]) => ({
        path,
        diff: change?.unified_diff ?? '',
      })),
      typeof params.reason === 'string' ? params.reason : undefined,
      typeof params.grantRoot === 'string' ? params.grantRoot : undefined,
      cwd,
    );
  }
  return null;
}

function commandCard(command: string, params: JsonObject, cwd: string): ApprovalCard {
  const where = typeof params.cwd === 'string' ? params.cwd : cwd;
  const network = params.networkApprovalContext as { host?: string } | null | undefined;
  // Typing into a running terminal is running code, whatever the text says.
  const stdin = params.kind === 'writeStdin';
  const reads = network || stdin ? null : readPaths(command, params, where);
  return {
    // Codex asks even for the commands it uses to read (on Windows, every
    // Get-Content). When its own parse says a command only reads, lists or
    // searches, it is a read — and reads inside the workspace are routine.
    operation: reads
      ? { capability: 'read', target: command, paths: reads }
      : {
          capability: 'command',
          target: command,
          command: stdin ? `(input to a running process) ${command}` : command,
          cwd: where,
          ...(network ? { network: network.host ?? 'an external host' } : {}),
        },
    title: 'Run command',
    target: command,
    ...(typeof params.reason === 'string' ? { reason: params.reason } : {}),
    facts: [
      `cwd: ${typeof params.cwd === 'string' ? params.cwd : cwd}`,
      'Runs inside the Codex sandbox',
    ],
  };
}

/**
 * On Windows every command Codex runs is wrapped in a `powershell.exe
 * -Command '...'` invocation (elsewhere, `bash -lc '...'`), and approving
 * `"C:\\WINDOWS\\System32\\...` tells nobody anything. The wrapper is peeled
 * off the actual text, so the card — and the policy — see the whole real
 * command. Codex's parsed actions never stand in for the text: a first action
 * standing in for a longer line would hide whatever came after it.
 */
function unwrap(params: JsonObject): string {
  const raw = typeof params.command === 'string' ? params.command : '';
  return peel(raw) ?? raw;
}

const WRAPPER =
  /^\s*(?:"[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NonInteractive\s+)*-Command\s+'((?:[^']|'')*)'\s*$/i;
const POSIX_WRAPPER = /^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+'([^']*)'\s*$/;

/** The command inside a known launcher wrapper, or null when there is none. */
export function peel(raw: string): string | null {
  const windows = WRAPPER.exec(raw);
  if (windows) return (windows[1] ?? '').replaceAll("''", "'");
  const posix = POSIX_WRAPPER.exec(raw);
  return posix ? (posix[1] ?? '') : null;
}

const READ_ACTIONS = new Set(['read', 'listFiles', 'search']);

/**
 * The paths a command reads, when Codex parsed every part of it as a read,
 * listing or search — or null when it does anything else. The line itself
 * must not compose commands either: a read followed by `; rm …` is not a read.
 */
function readPaths(command: string, params: JsonObject, where: string): string[] | null {
  const actions = (
    Array.isArray(params.commandActions) ? params.commandActions : []
  ) as CommandAction[];
  if (actions.length === 0) return null;
  const parsed = parseCommand(command);
  if (!parsed || parsed.composite) return null;
  const paths: string[] = [];
  for (const raw of actions) {
    const action = raw.type === 'unknown' && raw.command ? (classify(raw.command) ?? raw) : raw;
    if (!READ_ACTIONS.has(action.type ?? '')) return null;
    const path = action.path ?? '.';
    paths.push(isAbsolute(path) ? path : resolve(where, path));
  }
  return paths;
}

export interface FileChange {
  readonly path: string;
  readonly diff: string;
}

function fileCard(
  changes: readonly FileChange[],
  reason: string | undefined,
  grantRoot: string | undefined,
  cwd: string,
): ApprovalCard {
  const paths = changes.map((change) => relative(cwd, change.path));
  return {
    operation: {
      capability: 'edit',
      target: paths.join(', '),
      paths: changes.map((change) => change.path),
      ...(grantRoot ? { grantRoot } : {}),
    },
    title: changes.length > 1 ? `Edit ${changes.length} files` : 'Edit',
    target: paths.join(', ') || '(no files reported)',
    ...(reason ? { reason } : {}),
    // A request to widen the writable root is the interesting part of the
    // card, not a footnote: it asks for more than this one change.
    ...(grantRoot ? { facts: [`Also asks for write access to ${grantRoot}`] } : {}),
    diff: truncateDiff(changes.map((change) => change.diff).join('\n')),
  };
}

/** The answer Codex expects, in the shape the method it came from uses. */
export function toDecision(method: string, allowed: boolean): unknown {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return allowed
      ? { decision: 'approved' }
      : { decision: { denied: { rejection: 'The user declined this operation.' } } };
  }
  return { decision: allowed ? ACCEPT : DECLINE };
}

function relative(cwd: string, path: string): string {
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '');
  const normalized = path.replaceAll('\\', '/');
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}
