import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type DoctorEnvironment,
  formatDoctor,
  runDoctor,
  sanitize,
  type WorkspaceState,
} from '../src/cli/doctor.ts';
import { MIN_NODE_MAJOR, nodeSupported } from '../src/cli/node-check.ts';
import { completeOnboarding, planOnboarding } from '../src/cli/onboarding.ts';
import { configExists, configPath, loadConfig, saveConfig } from '../src/config/config.ts';
import { PolarisError } from '../src/core/errors.ts';
import {
  closeSessionLog,
  info,
  MAX_LOG_FILES,
  openSessionLog,
  redact,
} from '../src/core/logger.ts';
import { probe, resolveExecutable, spawnPlan } from '../src/core/process.ts';
import {
  type DetectionProbes,
  detectProviders,
  type ProviderCheck,
} from '../src/providers/detect.ts';
import { sweepStaleCheckpoints } from '../src/workspace/changes.ts';

const home = () => process.env.POLARIS_HOME as string;
const scratch = async (prefix: string) => realpath(await mkdtemp(join(tmpdir(), prefix)));

/** Runs the real CLI from source, with its own throwaway home. */
function cli(args: string[], polarisHome: string, input?: string) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'src/bin.ts', ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, POLARIS_HOME: polarisHome, NO_COLOR: '1' },
      ...(input === undefined ? {} : { input }),
      timeout: 60_000,
    },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

// ------------------------------------------------------------------ node

test('the Node requirement is Node 22 or newer', () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.equal(nodeSupported('22.0.0'), true);
  assert.equal(nodeSupported('24.18.0'), true);
  assert.equal(nodeSupported('20.19.1'), false);
  assert.equal(nodeSupported('garbage'), false);
});

// ----------------------------------------------------------------- config

test('no configuration is a first run; saving one ends it', async () => {
  await rm(configPath(), { force: true });
  assert.equal(await configExists(), false);
  assert.equal((await loadConfig()).permissions, 'smart', 'new users start on smart');
  await completeOnboarding('codex');
  assert.equal(await configExists(), true);
  const saved = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.deepEqual(saved, { version: 1, provider: 'codex', permissions: 'smart' });
});

test('a broken configuration stops Polaris with the path, and is never overwritten', async () => {
  await writeFile(configPath(), '{ "provider": "codex", ');
  await assert.rejects(loadConfig(), (error: unknown) => {
    assert.ok(error instanceof PolarisError);
    assert.equal(error.code, 'POLARIS_CONFIG_INVALID');
    assert.match(error.message, /Invalid Polaris configuration/);
    assert.ok(error.message.includes(configPath()));
    assert.match(error.message, /polaris doctor/);
    return true;
  });
  assert.equal(await readFile(configPath(), 'utf8'), '{ "provider": "codex", ');
  await rm(configPath());
});

test('saving keeps fields Polaris does not know, and old profiles migrate', async () => {
  await writeFile(
    configPath(),
    JSON.stringify({ provider: 'claude', permissions: 'ask', theme: 'dark', future: { a: 1 } }),
  );
  const loaded = await loadConfig();
  assert.equal(loaded.permissions, 'smart', 'ask → smart');
  await saveConfig({ ...loaded, model: 'opus' });
  const saved = JSON.parse(await readFile(configPath(), 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.future, { a: 1 });
  assert.equal(saved.version, 1);
  assert.equal(saved.permissions, 'smart');
  await rm(configPath());
});

// -------------------------------------------------------------- detection

function probes(machine: {
  paths?: Record<string, string>;
  runs?: Record<string, { code: number; stdout: string } | null>;
  env?: string[];
  bundled?: boolean;
}): DetectionProbes {
  return {
    resolve: async (name) => machine.paths?.[name] ?? null,
    run: async (name, args) => {
      const key = `${name} ${args.join(' ')}`;
      const result = machine.runs?.[key];
      return result === undefined ? null : result && { ...result, stderr: '' };
    },
    hasEnv: (name) => (machine.env ?? []).includes(name),
    claudeBundled: async () => machine.bundled ?? false,
  };
}

const byId = (checks: ProviderCheck[]) =>
  Object.fromEntries(checks.map((check) => [check.id, check]));

test('detection: Codex installed and signed in, Claude missing, Anthropic configured', async () => {
  const checks = byId(
    await detectProviders(
      probes({
        paths: { codex: '/bin/codex' },
        runs: {
          'codex --version': { code: 0, stdout: 'codex-cli 0.157.0\n' },
          'codex login status': { code: 0, stdout: 'Logged in using ChatGPT\n' },
        },
        env: ['ANTHROPIC_API_KEY'],
      }),
    ),
  );
  assert.equal(checks.codex?.status, 'available');
  assert.match(checks.codex?.detail ?? '', /codex-cli 0\.157\.0 · signed in/);
  assert.equal(checks.claude?.status, 'not-installed');
  assert.match(checks.claude?.hint ?? '', /POLARIS_CLAUDE_EXECUTABLE/);
  assert.equal(checks['anthropic-api']?.status, 'available');
  assert.equal(checks.mock?.status, 'available');
});

test('detection: missing, signed out, unconfigured and a hung runtime are all told apart', async () => {
  const checks = byId(
    await detectProviders(
      probes({
        paths: { claude: '/bin/claude', codex: '/bin/codex' },
        runs: {
          'codex --version': { code: 0, stdout: 'codex-cli 1.0\n' },
          'codex login status': { code: 1, stdout: 'Not logged in\n' },
          // The real status JSON carries the account email; it must never surface.
          'claude auth status': {
            code: 0,
            stdout: '{"loggedIn":false,"email":"someone@example.com"}',
          },
        },
        bundled: true,
      }),
    ),
  );
  assert.equal(checks.codex?.status, 'not-authenticated');
  assert.match(checks.codex?.hint ?? '', /codex/);
  assert.equal(checks.claude?.status, 'not-authenticated');
  assert.doesNotMatch(JSON.stringify(checks), /someone@example\.com/);
  assert.equal(checks['anthropic-api']?.status, 'not-configured');
  assert.match(checks['anthropic-api']?.hint ?? '', /never stores it/);

  // A status command that never answers is "unknown", not a hang.
  const hung = byId(
    await detectProviders(
      probes({ paths: { codex: '/bin/codex' }, runs: { 'codex --version': null } }),
    ),
  );
  assert.equal(hung.codex?.status, 'unknown');
});

test('first-run options put ready providers first and the mock last', () => {
  const plan = planOnboarding([
    { id: 'codex', label: 'Codex', status: 'not-installed', detail: 'not found' },
    { id: 'claude', label: 'Claude', status: 'available', detail: 'signed in' },
    { id: 'anthropic-api', label: 'Anthropic API', status: 'not-configured', detail: 'no key' },
    { id: 'mock', label: 'Mock', status: 'available', detail: 'offline' },
  ]);
  assert.deepEqual(
    plan.options.map((option) => option.id),
    ['claude', 'codex', 'anthropic-api', 'mock'],
  );
  assert.equal(plan.suggested, 'claude');
  assert.equal(plan.options[0]?.label, 'Claude — ready');
  assert.equal(plan.options[1]?.label, 'Codex — not found');
});

// ----------------------------------------------------------------- doctor

const WORKSPACE: WorkspaceState = {
  accessible: true,
  writable: true,
  gitRoot: '/repo',
  projectFiles: ['POLARIS.md'],
  skills: 2,
  invalidSkills: 0,
};

function doctorEnv(overrides: Partial<DoctorEnvironment> = {}): DoctorEnvironment {
  return {
    version: '0.8.3',
    node: '24.8.0',
    platform: 'linux',
    arch: 'x64',
    terminal: { tty: true, columns: 120, term: 'xterm-256color' },
    cwd: '/repo',
    providers: async () => [
      { id: 'codex', label: 'Codex', status: 'available', detail: 'codex-cli 1.0 · signed in' },
      { id: 'mock', label: 'Mock', status: 'available', detail: 'offline demo' },
    ],
    git: async () => 'git version 2.51.0',
    config: async () => ({
      path: '/home/me/.polaris/config.json',
      state: 'ok',
      provider: 'codex',
      permissions: 'smart',
    }),
    workspace: async () => WORKSPACE,
    ...overrides,
  };
}

test('doctor reports every area and says ready when nothing blocks', async () => {
  const result = await runDoctor(doctorEnv());
  const text = formatDoctor(result);
  for (const title of [
    'Polaris',
    'Runtime',
    'Git',
    'Providers',
    'Configuration',
    'Workspace',
    'Result',
  ]) {
    assert.match(text, new RegExp(`^${title}$`, 'm'), title);
  }
  assert.match(text, /✓ version 0\.8\.3 · Developer Preview/);
  assert.match(text, /✓ Codex {2}\(configured\): codex-cli 1\.0 · signed in/);
  assert.match(text, /default permissions: smart/);
  assert.match(text, /POLARIS\.md: POLARIS\.md/);
  assert.equal(result.blocking, false);
  assert.match(result.summary, /appears ready/);
});

test('doctor blocks on an old Node, a broken config or an inaccessible workspace', async () => {
  const old = await runDoctor(doctorEnv({ node: '20.11.0' }));
  assert.equal(old.blocking, true);
  assert.match(formatDoctor(old), /× Node 20\.11\.0 — Polaris requires Node\.js >= 22/);

  const broken = await runDoctor(
    doctorEnv({
      config: async () => ({ path: '/c.json', state: 'invalid', detail: 'Unexpected end of JSON' }),
    }),
  );
  assert.equal(broken.blocking, true);
  assert.match(formatDoctor(broken), /× \/c\.json — invalid: Unexpected end of JSON/);

  const gone = await runDoctor(
    doctorEnv({ workspace: async () => ({ ...WORKSPACE, accessible: false }) }),
  );
  assert.equal(gone.blocking, true);
});

test('a configured provider that is not ready is a warning with a way forward, not a blocker', async () => {
  const result = await runDoctor(
    doctorEnv({
      providers: async () => [
        {
          id: 'codex',
          label: 'Codex',
          status: 'not-installed',
          detail: 'Codex CLI not found on PATH',
          hint: 'Install the Codex CLI.',
        },
      ],
      git: async () => null,
    }),
  );
  const text = formatDoctor(result);
  assert.equal(result.blocking, false);
  assert.match(
    text,
    /× Codex {2}\(configured\): Codex CLI not found on PATH\n {6}→ Install the Codex CLI\./,
  );
  assert.match(text, /! git not found/);
  assert.match(result.summary, /configured provider \(codex\) is not ready/);
});

test('a report hides the home directory and every credential', () => {
  const text = sanitize(
    `config: ${join(homedir(), '.polaris', 'config.json')}\nerror: 401 Incorrect API key sk-svcac****fvMA\nANTHROPIC_API_KEY=sk-ant-abc123456`,
  );
  assert.doesNotMatch(text, new RegExp(homedir().replace(/[\\]/g, '\\\\')));
  assert.match(text, /config: ~/);
  assert.doesNotMatch(text, /svcac|abc123456/);
});

// ------------------------------------------------------------------- logs

test('logs never carry credentials', () => {
  const line = redact(
    [
      'key sk-ant-api03-abcdefghijklmnop',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload',
      'ANTHROPIC_API_KEY=sk-live-123456789',
      '{"OPENAI_API_KEY":"abcdef123456"}',
      'cookie: session=abcdef; other=1',
      'GITHUB_TOKEN=ghp_abcdefghijkl',
    ].join('\n'),
  );
  for (const secret of [
    'abcdefghijklmnop',
    'eyJhbGciOiJIUzI1NiJ9',
    '123456789',
    'abcdef123456',
    'session=abcdef',
    'ghp_abcdefghijkl',
  ]) {
    assert.doesNotMatch(line, new RegExp(secret), secret);
  }
  assert.match(line, /ANTHROPIC_API_KEY=\[redacted\]/);
});

test('session logs are written, redacted, and only the latest ones are kept', async () => {
  const directory = await scratch('polaris-logs-');
  for (let index = 0; index < MAX_LOG_FILES + 3; index += 1) {
    await writeFile(join(directory, `polaris-old-${index}.log`), 'old\n');
    const past = new Date(Date.now() - (index + 1) * 60_000);
    await utimes(join(directory, `polaris-old-${index}.log`), past, past);
  }
  const path = openSessionLog(directory);
  assert.ok(path);
  info('startup', 'Polaris test', 'token=abc123456789');
  closeSessionLog();
  const logs = (await readdir(directory)).filter((name) => name.endsWith('.log'));
  assert.equal(logs.length, MAX_LOG_FILES, 'older logs pruned');
  const text = await readFile(path, 'utf8');
  assert.match(text, /startup Polaris test token=\[redacted\]/);
});

// --------------------------------------------------------------- processes

test('executables are found on PATH, Windows shims included, and a hung probe times out', async () => {
  assert.ok(await resolveExecutable('node'), 'node itself is on PATH');
  assert.equal(await resolveExecutable('polaris-definitely-not-installed'), null);
  assert.deepEqual(spawnPlan('/usr/bin/codex'), { command: '/usr/bin/codex', shell: false });
  if (process.platform === 'win32') {
    assert.deepEqual(spawnPlan('C:\\npm\\codex.cmd'), {
      command: '"C:\\npm\\codex.cmd"',
      shell: true,
    });
  }
  const started = Date.now();
  assert.equal(await probe('node', ['-e', 'setTimeout(() => {}, 20000)'], 300), null);
  assert.ok(Date.now() - started < 5000, 'gave up on time');
});

test('only abandoned checkpoint stores are swept, never a live one', async () => {
  const directory = await scratch('polaris-sweep-');
  const stale = join(directory, 'polaris-checkpoints-old');
  const live = join(directory, 'polaris-checkpoints-live');
  const other = join(directory, 'someone-elses-dir');
  for (const path of [stale, live, other]) await mkdir(path);
  const long = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await utimes(stale, long, long);
  await utimes(other, long, long);
  const removed = await sweepStaleCheckpoints(directory);
  assert.deepEqual(removed, [stale]);
  assert.ok(existsSync(live));
  assert.ok(existsSync(other), 'not Polaris’s to delete');
});

// ------------------------------------------------------------------- CLI

test('--version prints the package version, from one source', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const result = cli(['--version'], home());
  assert.equal(result.code, 0);
  assert.equal(result.out.trim(), `Polaris ${version}`);
});

test('--help explains usage without starting a provider or a UI', async () => {
  const polarisHome = await scratch('polaris-help-');
  const result = cli(['--help'], polarisHome);
  assert.equal(result.code, 0);
  for (const part of ['Usage:', 'Options:', 'Providers:', 'Examples:', 'polaris doctor']) {
    assert.ok(result.out.includes(part), part);
  }
  assert.deepEqual(await readdir(polarisHome), [], 'nothing was written: no config, no log');
});

test('doctor runs without a terminal and changes nothing', async () => {
  const polarisHome = await scratch('polaris-doctor-');
  const result = cli(['doctor'], polarisHome);
  assert.ok(result.code === 0 || result.code === 1);
  assert.match(result.out, /Polaris Doctor/);
  assert.match(result.out, /Result/);
  assert.deepEqual(await readdir(polarisHome), [], 'no config, no log, no report');
});

test('an unknown command or flag is a short error, not a stack trace', async () => {
  const polarisHome = await scratch('polaris-args-');
  const unknown = cli(['frobnicate'], polarisHome);
  assert.equal(unknown.code, 2);
  assert.match(unknown.out, /Unknown command "frobnicate"/);
  const flag = cli(['--no-such-flag'], polarisHome);
  assert.equal(flag.code, 2);
  assert.doesNotMatch(flag.out, /\n\s+at /, 'no stack trace');
});

test('a first run without a terminal explains itself and saves nothing', async () => {
  const polarisHome = await scratch('polaris-first-');
  const result = cli([], polarisHome, '/exit\n');
  assert.equal(result.code, 0);
  assert.match(result.out, /Developer Preview/);
  assert.equal(existsSync(join(polarisHome, 'config.json')), false);
});

test('a provider that cannot start fails with a way forward, and a code', async () => {
  const polarisHome = await scratch('polaris-provider-');
  const result = cli(['--provider', 'nonexistent'], polarisHome, '/exit\n');
  assert.equal(result.code, 1);
  assert.match(result.out, /Could not start nonexistent/);
  assert.match(result.out, /polaris doctor/);
  assert.match(result.out, /POLARIS_PROVIDER_START_FAILED/);
  assert.doesNotMatch(result.out, /\n\s+at /, 'no stack trace');
});
