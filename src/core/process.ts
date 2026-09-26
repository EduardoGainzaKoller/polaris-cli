import { type SpawnOptions, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join } from 'node:path';

/**
 * Process plumbing shared by the command tool, the Codex runtime and the
 * diagnostics, written once so each platform difference is handled once.
 */

/**
 * The full path of an executable on PATH, or null. On Windows the PATHEXT
 * extensions are tried as the shell would, so an npm-installed `codex.cmd`
 * is found as readily as `codex.exe`.
 */
export async function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const windows = process.platform === 'win32';
  const extensions = windows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = (base: string) =>
    windows && extname(base) === '' ? extensions.map((ext) => base + ext.toLowerCase()) : [base];

  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    for (const candidate of candidates(name)) if (await executable(candidate)) return candidate;
    return null;
  }
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const candidate of candidates(join(directory, name))) {
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * How to spawn a resolved executable. Windows batch shims (`.cmd`, `.bat` —
 * what npm installs) can only run through the shell, so they get one; the
 * arguments passed with them are Polaris's own constants, never user input.
 */
export function spawnPlan(path: string): { command: string; shell: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(path)) {
    return { command: `"${path}"`, shell: true };
  }
  return { command: path, shell: false };
}

export interface ProbeResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a short diagnostic command with a hard timeout, so a hung binary can
 * never hang Polaris. null when it could not start or ran out of time.
 */
export async function probe(
  name: string,
  args: readonly string[],
  timeoutMs = 5000,
): Promise<ProbeResult | null> {
  const path = await resolveExecutable(name);
  if (!path) return null;
  const plan = spawnPlan(path);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result: ProbeResult | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const options: SpawnOptions = {
      windowsHide: true,
      shell: plan.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? {} : { detached: true }),
    };
    const child = spawn(plan.command, [...args], options);
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish(null);
    }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Kills a process *and* everything it started. Windows has no process
 * groups, so `taskkill /T` walks the tree; elsewhere the negative pid
 * signals the whole group (the child must have been spawned `detached`),
 * with SIGKILL behind it for anything that ignores SIGTERM.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => undefined,
    );
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(target, 'SIGKILL');
        } catch {
          // Already gone, which is the outcome we wanted.
        }
      }, 2000).unref();
      return;
    } catch {
      // Not a group leader, or already gone: try the process itself.
    }
  }
}
