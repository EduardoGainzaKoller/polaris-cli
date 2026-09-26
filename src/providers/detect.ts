import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type ProbeResult, probe, resolveExecutable } from '../core/process.ts';

/**
 * Which providers look usable on this machine, without sending a single
 * request to a model: each check asks a runtime's own local status command
 * (`codex login status`, `claude auth status`) or looks for an environment
 * variable's *presence*. No credential is ever read, printed or stored.
 */
export type ProviderStatus =
  | 'available'
  | 'not-installed'
  | 'not-authenticated'
  | 'not-configured'
  | 'unknown';

export interface ProviderCheck {
  readonly id: string;
  readonly label: string;
  readonly status: ProviderStatus;
  /** One short line: what was found. */
  readonly detail: string;
  /** What to do about it, when something is missing. */
  readonly hint?: string;
}

/** Everything detection touches, so tests can describe any machine. */
export interface DetectionProbes {
  resolve(name: string): Promise<string | null>;
  run(name: string, args: readonly string[], timeoutMs: number): Promise<ProbeResult | null>;
  /** Whether a variable is set — never its value. */
  hasEnv(name: string): boolean;
  /** The Claude runtime bundled with the Agent SDK, when installed. */
  claudeBundled(): Promise<boolean>;
}

export const PROBE_TIMEOUT_MS = 5000;

export const systemProbes: DetectionProbes = {
  resolve: (name) => resolveExecutable(name),
  run: (name, args, timeoutMs) => probe(name, args, timeoutMs),
  hasEnv: (name) => (process.env[name] ?? '').trim().length > 0,
  claudeBundled,
};

export async function detectProviders(
  probes: DetectionProbes = systemProbes,
): Promise<ProviderCheck[]> {
  const [codex, claude] = await Promise.all([detectCodex(probes), detectClaude(probes)]);
  return [codex, claude, detectAnthropicApi(probes), MOCK];
}

const MOCK: ProviderCheck = {
  id: 'mock',
  label: 'Mock',
  status: 'available',
  detail: 'offline demo — no model, no account',
};

async function detectCodex(probes: DetectionProbes): Promise<ProviderCheck> {
  const name = process.env.POLARIS_CODEX_EXECUTABLE ?? 'codex';
  const base = { id: 'codex', label: 'Codex' };
  if (!(await probes.resolve(name))) {
    return {
      ...base,
      status: 'not-installed',
      detail: 'Codex CLI not found on PATH',
      hint: 'Install the Codex CLI (npm install -g @openai/codex), then run `codex` to sign in.',
    };
  }
  const version = await probes.run(name, ['--version'], PROBE_TIMEOUT_MS);
  const found = firstLine(version?.stdout) || 'Codex CLI';
  const login = await probes.run(name, ['login', 'status'], PROBE_TIMEOUT_MS);
  if (!login) {
    return {
      ...base,
      status: 'unknown',
      detail: `${found} · sign-in status did not answer in time`,
    };
  }
  if (login.code !== 0) {
    return {
      ...base,
      status: 'not-authenticated',
      detail: `${found} · not signed in`,
      hint: 'Run `codex` and sign in with ChatGPT.',
    };
  }
  return { ...base, status: 'available', detail: `${found} · signed in` };
}

async function detectClaude(probes: DetectionProbes): Promise<ProviderCheck> {
  const base = { id: 'claude', label: 'Claude' };
  const override = process.env.POLARIS_CLAUDE_EXECUTABLE;
  const cli = await probes.resolve('claude');
  const runtime =
    (override && (await probes.resolve(override))) || (await probes.claudeBundled()) || cli;
  if (!runtime) {
    return {
      ...base,
      status: 'not-installed',
      detail: 'Claude runtime not found',
      hint: 'Reinstall Polaris without --omit=optional, or install Claude Code and set POLARIS_CLAUDE_EXECUTABLE.',
    };
  }
  if (probes.hasEnv('ANTHROPIC_API_KEY')) {
    return { ...base, status: 'available', detail: 'runtime ready · uses ANTHROPIC_API_KEY' };
  }
  if (!cli) {
    return {
      ...base,
      status: 'unknown',
      detail: 'runtime ready · sign-in is checked when a session starts',
      hint: 'Install Claude Code and run `claude` to sign in, or set ANTHROPIC_API_KEY.',
    };
  }
  const status = await probes.run('claude', ['auth', 'status'], PROBE_TIMEOUT_MS);
  // The JSON also carries the account's email; only these two fields are read.
  const parsed = parseJson(status?.stdout) as { loggedIn?: unknown; authMethod?: unknown } | null;
  if (!status || !parsed) {
    return { ...base, status: 'unknown', detail: 'runtime ready · sign-in status unavailable' };
  }
  if (parsed.loggedIn !== true) {
    return {
      ...base,
      status: 'not-authenticated',
      detail: 'runtime ready · not signed in',
      hint: 'Run `claude` and sign in, or set ANTHROPIC_API_KEY.',
    };
  }
  const method = typeof parsed.authMethod === 'string' ? ` (${parsed.authMethod})` : '';
  return { ...base, status: 'available', detail: `runtime ready · signed in${method}` };
}

function detectAnthropicApi(probes: DetectionProbes): ProviderCheck {
  const base = { id: 'anthropic-api', label: 'Anthropic API' };
  if (probes.hasEnv('ANTHROPIC_API_KEY') || probes.hasEnv('ANTHROPIC_AUTH_TOKEN')) {
    return { ...base, status: 'available', detail: 'ANTHROPIC_API_KEY is set' };
  }
  return {
    ...base,
    status: 'not-configured',
    detail: 'ANTHROPIC_API_KEY not configured',
    hint: 'Set ANTHROPIC_API_KEY in your environment. Polaris never stores it.',
  };
}

/** The runtime the Agent SDK ships for this platform, if it was installed. */
async function claudeBundled(): Promise<boolean> {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(manifest), process.platform === 'win32' ? 'claude.exe' : 'claude');
    await access(binary);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split(/\r?\n/)[0]?.trim() ?? '';
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return null;
  }
}
