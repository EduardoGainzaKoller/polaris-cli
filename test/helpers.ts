import { PermissionGate } from '../src/permissions/gate.ts';
import { DEFAULT_PROFILE, type PermissionProfile } from '../src/permissions/policy.ts';
import type { ProviderSessionOptions, ToolAccess } from '../src/providers/provider.ts';

/**
 * The two options every provider session now needs, filled in for tests that
 * are about something else. Pass a handler to answer approvals, or leave it
 * out and every `ask` is a denial — the gate's own behaviour with no UI.
 */
export function testSession(
  cwd: string,
  options: {
    permissions?: PermissionProfile;
    gate?: PermissionGate;
    model?: string;
    effort?: string;
  } = {},
): ProviderSessionOptions {
  const permissions = options.permissions ?? DEFAULT_PROFILE;
  return {
    cwd,
    permissions,
    gate: options.gate ?? new PermissionGate(permissions),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}

/** A gate that answers every approval the same way, without a UI. */
export function autoGate(
  profile: PermissionProfile,
  answer: 'allow' | 'deny',
): { gate: PermissionGate; asked: string[] } {
  const gate = new PermissionGate(profile);
  const asked: string[] = [];
  gate.onApproval(async (request) => {
    asked.push(`${request.title} ${request.target}`);
    return answer;
  });
  return { gate, asked };
}

export const TEST_ACCESS: ToolAccess = {
  mode: 'read-only',
  runtime: 'Test runtime',
  tools: ['Read'],
};

export { PERMISSION_PROFILES } from '../src/permissions/policy.ts';
