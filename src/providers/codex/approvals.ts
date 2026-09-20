import type { PermissionProfile } from '../../permissions/policy.ts';
import { truncateDiff } from '../../tools/diff.ts';
import type { JsonObject } from './app-server.ts';
import { effectiveAction } from './items.ts';

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
  readonly capability: 'write' | 'edit' | 'command';
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
  return {
    capability: 'command',
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
 * -Command '...'` invocation, and approving `"C:\\WINDOWS\\System32\\...` tells
 * nobody anything. Codex reports the command it actually parsed alongside the
 * wrapper, so that is what the card shows — the real command, in full, never
 * shortened. The wrapper is only how it is launched.
 */
function unwrap(params: JsonObject): string {
  const raw = typeof params.command === 'string' ? params.command : '';
  const { action } = effectiveAction(params as never);
  const inner = action?.command;
  return inner && inner.length > 0 ? inner : raw;
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
    capability: 'edit',
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
