import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { debug } from '../core/logger.ts';
import { executableName, parseCommand } from '../permissions/shell.ts';
import {
  COMMAND_OUTPUT_HEAD_LINES,
  COMMAND_OUTPUT_TAIL_LINES,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT,
  MAX_COMMAND_TIMEOUT_MS,
} from './limits.ts';
import type { ToolDefinition } from './registry.ts';
import { displayPath, resolveInWorkspace, ToolError } from './workspace.ts';

export interface RunCommandInput {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
}

/**
 * Deliberately not called `bash`. Polaris runs on Windows, Linux and macOS,
 * and on Windows there is usually no bash — the command goes to the platform's
 * own shell, which is also what makes `npm test` work there at all (`npm` is a
 * `.cmd` shim, not an executable).
 *
 * This is NOT sandboxed. Unlike the Codex runtime, which runs commands inside
 * an OS sandbox, a command started here has the same reach as the user's own
 * shell. What bounds it in v0.6 is an explicit approval for every single run,
 * a working directory pinned inside the workspace, a timeout, and killing the
 * whole process tree on cancellation — not isolation.
 */
export const runCommandTool: ToolDefinition<RunCommandInput> = {
  name: 'run_command',
  title: 'Run',
  capability: 'command',
  description:
    'Run a shell command in the workspace and return its output and exit code. Runs through the ' +
    "platform's own shell (cmd.exe on Windows, sh elsewhere), so write portable commands such as " +
    '"npm test". A non-zero exit code is a normal result, not an error: read the output and act ' +
    'on it. Every run is shown to the user for approval first.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: {
        type: 'string',
        description: 'Directory to run in, relative to the workspace root. Defaults to the root.',
      },
      timeoutMs: {
        type: 'integer',
        minimum: 1000,
        maximum: MAX_COMMAND_TIMEOUT_MS,
        description: `Milliseconds before the command is terminated (default ${DEFAULT_COMMAND_TIMEOUT_MS}).`,
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  parse(input) {
    const value = (input ?? {}) as Record<string, unknown>;
    if (typeof value.command !== 'string' || value.command.trim() === '') {
      throw new ToolError('command must be a non-empty string.');
    }
    if (value.cwd !== undefined && typeof value.cwd !== 'string') {
      throw new ToolError('cwd must be a string.');
    }
    if (value.timeoutMs !== undefined && !Number.isInteger(value.timeoutMs)) {
      throw new ToolError('timeoutMs must be an integer.');
    }
    const timeout = (value.timeoutMs as number | undefined) ?? DEFAULT_COMMAND_TIMEOUT_MS;
    return {
      command: value.command.trim(),
      ...(value.cwd ? { cwd: value.cwd } : {}),
      timeoutMs: Math.min(Math.max(1000, timeout), MAX_COMMAND_TIMEOUT_MS),
    };
  },

  target: (input) => input.command,

  /** The command is shown whole and unedited: a shortened one cannot be judged. */
  async preview(input, { cwd }) {
    const where = await resolveCwd(cwd, input.cwd);
    return {
      title: 'Run command',
      facts: [`cwd: ${where.display}`, `timeout: ${Math.round(input.timeoutMs / 1000)}s`],
      fingerprint: null,
      cwd: where.absolute,
    };
  },

  async execute(input, { cwd, signal, onOutput }) {
    signal?.throwIfAborted();
    const where = await resolveCwd(cwd, input.cwd);
    const started = Date.now();
    const result = await runProcess(input, where.absolute, signal, onOutput);
    const duration = Date.now() - started;

    if (result.timedOut) {
      throw new ToolError(
        `Command timed out after ${Math.round(input.timeoutMs / 1000)}s and was terminated.`,
      );
    }

    const { text, truncated, lines } = truncateOutput(result.output);
    const status = result.exitCode === 0 ? 'succeeded' : `failed with exit code ${result.exitCode}`;
    const seconds = (duration / 1000).toFixed(1);

    return {
      // A failed command is still a successful tool call: the model has to see
      // the output to be able to fix anything.
      content: [
        `$ ${input.command}`,
        `Command ${status} in ${seconds}s.`,
        truncated ? `[output truncated — ${lines} lines produced]` : '',
        '',
        text || '(no output)',
      ]
        .filter((part) => part !== '')
        .join('\n'),
      summary: `exit ${result.exitCode}`,
      metadata: {
        command: input.command,
        cwd: where.display,
        exitCode: result.exitCode,
        durationMs: duration,
        stdout: result.stdout.length,
        stderr: result.stderr.length,
        lines,
        truncated,
      },
    };
  },
};

interface ProcessResult {
  readonly exitCode: number;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runProcess(
  input: RunCommandInput,
  cwd: string,
  signal: AbortSignal | undefined,
  onOutput: ((text: string) => void) | undefined,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    // `shell: true` is the portability: the model writes one command line and
    // the platform's own shell parses it. Detaching on POSIX puts the child in
    // its own process group, which is what makes killing the *tree* possible.
    const child = spawn(input.command, {
      cwd,
      env: environmentFor(input.command),
      shell: true,
      windowsHide: true,
      ...(process.platform === 'win32' ? {} : { detached: true }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    debug('command', 'started pid', child.pid, 'in', cwd);
    let stdout = '';
    let stderr = '';
    let output = '';
    let timedOut = false;
    let settled = false;

    const collect = (chunk: string, stream: 'out' | 'err') => {
      if (stream === 'out') stdout += chunk;
      else stderr += chunk;
      output += chunk;
      // The UI gets everything as it arrives; only what goes back to the model
      // is capped, further down.
      onOutput?.(chunk);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => collect(chunk, 'out'));
    child.stderr.on('data', (chunk: string) => collect(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child.pid);
    }, input.timeoutMs);

    const onAbort = () => terminate(child.pid);
    signal?.addEventListener('abort', onAbort, { once: true });

    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      done();
      reject(new ToolError(`Could not run the command: ${error.message}`));
    });

    child.on('close', (code, killedBy) => {
      debug('command', 'pid', child.pid, 'exited', code ?? killedBy);
      if (settled) return;
      settled = true;
      done();
      if (signal?.aborted && !timedOut) {
        reject(signal.reason);
        return;
      }
      resolve({
        // A killed process reports no code; the signal is what happened to it.
        exitCode: code ?? (killedBy ? 1 : 0),
        output,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

/**
 * Git is often run without asking (safe inspection), so it gets an
 * environment that cannot wait on a pager or a credential prompt, and that
 * drops an inherited `GIT_EXTERNAL_DIFF` — a diff helper would run a program
 * the user never approved. Every other command inherits the environment
 * untouched: it was approved as it is.
 *
 * ponytail: a `diff.external` in the user's own Git config still applies;
 * cover it with `--no-ext-diff` if that ever matters.
 */
export function environmentFor(command: string): NodeJS.ProcessEnv {
  const parsed = parseCommand(command);
  if (!parsed || executableName(parsed.argv[0] ?? '') !== 'git') return process.env;
  const { GIT_EXTERNAL_DIFF: _external, ...rest } = process.env;
  return { ...rest, GIT_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Kills the command *and* everything it started. A test runner spawns workers;
 * killing only the shell would leave them running and holding ports.
 *
 * Windows has no process groups, so `taskkill /T` walks the tree; elsewhere the
 * negative pid signals the whole group the child leads, with SIGKILL behind it
 * for anything that ignores SIGTERM.
 */
function terminate(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => undefined,
    );
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone, which is the outcome we wanted.
      }
    }, 2000).unref();
  } catch {
    // Already gone.
  }
}

/** Keeps the head and the tail: a failure is usually at the end, the context at the start. */
export function truncateOutput(output: string): {
  text: string;
  truncated: boolean;
  lines: number;
} {
  const all = output.split(/\r?\n/);
  const lines = all.length;
  if (output.length <= MAX_COMMAND_OUTPUT)
    return { text: output.trimEnd(), truncated: false, lines };

  const head = all.slice(0, COMMAND_OUTPUT_HEAD_LINES);
  const tail = all.slice(-COMMAND_OUTPUT_TAIL_LINES);
  const hidden = lines - head.length - tail.length;
  if (hidden <= 0) return { text: output.slice(0, MAX_COMMAND_OUTPUT), truncated: true, lines };
  return {
    text: [...head, `… ${hidden} lines omitted …`, ...tail].join('\n').trimEnd(),
    truncated: true,
    lines,
  };
}

/**
 * A command runs inside the workspace or not at all. The same symlink-aware
 * check the file tools use resolves it, so a junction pointing at C:\ is
 * rejected here exactly as it is for a write.
 */
async function resolveCwd(
  workspace: string,
  requested: string | undefined,
): Promise<{ absolute: string; display: string }> {
  const root = await realpath(workspace);
  if (!requested || requested === '.') return { absolute: root, display: root };
  const absolute = await resolveInWorkspace(workspace, requested);
  return { absolute, display: displayPath(root, absolute) };
}
