/**
 * What a tool *does*, independent of who is allowed to do it. The whole point
 * of the split is that "Polaris can edit files" and "Polaris may edit this
 * file now" are different questions: capabilities are a property of the tool,
 * decisions are a property of the active profile.
 */
export type Capability = 'read' | 'write' | 'edit' | 'command';

export type Decision = 'allow' | 'ask' | 'deny';

export type PermissionProfile = 'read-only' | 'ask' | 'workspace-write';

export const PERMISSION_PROFILES = ['read-only', 'ask', 'workspace-write'] as const;

/** Asking before every mutation is the only default that is safe to ship. */
export const DEFAULT_PROFILE: PermissionProfile = 'ask';

/**
 * The entire policy engine. A table, deliberately: rules that cannot be
 * composed cannot surprise anyone, and every cell is one assertion in a test.
 *
 * `run_command` asks even under workspace-write. A command is not bounded by
 * the workspace the way a file write is — it can reach the network, the home
 * directory or the package manager — so v0.6 never auto-approves one.
 */
const TABLE: Record<PermissionProfile, Record<Capability, Decision>> = {
  'read-only': { read: 'allow', write: 'deny', edit: 'deny', command: 'deny' },
  ask: { read: 'allow', write: 'ask', edit: 'ask', command: 'ask' },
  'workspace-write': { read: 'allow', write: 'allow', edit: 'allow', command: 'ask' },
};

export function decide(profile: PermissionProfile, capability: Capability): Decision {
  return TABLE[profile][capability];
}

/** True when the profile lets this capability run at all, approval or not. */
export function isAvailable(profile: PermissionProfile, capability: Capability): boolean {
  return decide(profile, capability) !== 'deny';
}

export function isProfile(value: string): value is PermissionProfile {
  return (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/** One line each, for /permissions and /help. */
export const PROFILE_SUMMARY: Record<PermissionProfile, string> = {
  'read-only': 'Inspect the repository only',
  ask: 'Ask before writes, edits and commands',
  'workspace-write': 'Allow workspace edits; ask before commands',
};
