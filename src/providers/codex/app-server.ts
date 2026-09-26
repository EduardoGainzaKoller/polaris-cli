import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { debug } from '../../core/logger.ts';
import { killTree, resolveExecutable, spawnPlan } from '../../core/process.ts';
import { runtimeStopped, sessionClosed, toPolarisError } from './errors.ts';

/**
 * The seam between Polaris and the Codex App Server process. Everything above
 * this file speaks methods and params; everything below speaks JSON-RPC 2.0 over
 * newline-delimited stdio. Tests replace the whole connection.
 */
export interface CodexConnection {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** Server-initiated notifications (streaming events, status changes, ...). */
  onNotification(handler: (method: string, params: JsonObject) => void): void;
  /**
   * Server-initiated requests, e.g. approvals. May answer asynchronously — an
   * approval waits for a person — and throwing returns a JSON-RPC error.
   */
  onRequest(handler: (method: string, params: JsonObject) => Promise<unknown>): void;
  /** Rejects pending work and reports why the runtime went away. */
  onClose(handler: (error: Error) => void): void;
  close(): Promise<void>;
}

export type Connect = () => Promise<CodexConnection>;

export type JsonObject = Record<string, unknown>;

/** Documented override for installs where `codex` is not on PATH. */
const EXECUTABLE = process.env.POLARIS_CODEX_EXECUTABLE ?? 'codex';

export const connectToAppServer: Connect = async () => {
  let child: ChildProcessWithoutNullStreams;
  try {
    // Resolved the way a shell would, so an npm-installed `codex.cmd` on
    // Windows starts as readily as the native `codex.exe`.
    const path = await resolveExecutable(EXECUTABLE);
    if (!path) throw new Error(`spawn ${EXECUTABLE} ENOENT`);
    const plan = spawnPlan(path);
    child = spawn(plan.command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: plan.shell,
      windowsHide: true,
      // Its own process group, so closing it takes every command it started.
      ...(process.platform === 'win32' ? {} : { detached: true }),
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    throw toPolarisError(error);
  }
  return createConnection(child);
};

function createConnection(child: ChildProcessWithoutNullStreams): CodexConnection {
  const pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (e: Error) => void }
  >();
  let notificationHandler: ((method: string, params: JsonObject) => void) | null = null;
  let requestHandler: ((method: string, params: JsonObject) => Promise<unknown>) | null = null;
  let closeHandler: ((error: Error) => void) | null = null;
  let nextId = 0;
  let closed: Error | null = null;

  const write = (message: JsonObject): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  // The protocol owns stdout; Codex's own logs go to stderr and only surface
  // under --debug, so they can never land in the conversation.
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line.trim().length === 0) return;
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      // A malformed frame is a protocol hiccup, not a reason to kill the session.
      debug('codex', 'ignoring unparsable frame');
      return;
    }
    handle(message);
  });

  createInterface({ input: child.stderr }).on('line', (line) => debug('codex', line));

  child.on('error', (error) => fail(toPolarisError(error)));
  child.on('exit', (code, signal) => {
    debug('codex', 'app-server exited', String(code ?? signal));
    fail(closed ?? runtimeStopped());
  });

  function fail(error: Error): void {
    closed ??= error;
    for (const [id, request] of pending) {
      pending.delete(id);
      request.reject(error);
    }
    closeHandler?.(error);
  }

  function handle(message: JsonObject): void {
    const id = message.id;
    const method = message.method;

    if (typeof method === 'string' && id === undefined) {
      notificationHandler?.(method, (message.params as JsonObject | undefined) ?? {});
      return;
    }
    if (typeof method === 'string') {
      void respond(id, method, (message.params as JsonObject | undefined) ?? {});
      return;
    }
    if (typeof id !== 'number') return;

    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (message.error) {
      request.reject(new Error(describeRpcError(message.error)));
      return;
    }
    request.resolve(message.result as never);
  }

  async function respond(id: unknown, method: string, params: JsonObject): Promise<void> {
    try {
      if (!requestHandler) throw new Error(`unhandled request ${method}`);
      // Approvals wait for a person, so this can take minutes. The connection
      // stays readable meanwhile: nothing here blocks the stdout reader.
      const result = await requestHandler(method, params);
      if (result === undefined) throw new Error(`unhandled request ${method}`);
      write({ jsonrpc: '2.0', id, result: result as JsonObject });
    } catch (error) {
      // Answer rather than hang: an unanswered request stalls the turn forever.
      write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: (error as Error).message },
      });
    }
  }

  return {
    request<T>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(closed);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject });
        write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      if (closed) return;
      write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    onNotification(handler) {
      notificationHandler = handler;
    },
    onRequest(handler) {
      requestHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
    },
    async close() {
      if (closed) return;
      closed = sessionClosed();
      child.stdin.end();
      // The app server and anything it is running — no orphaned commands.
      killTree(child.pid);
    },
  };
}

/** Never echoes the raw error object: it can carry request details. */
function describeRpcError(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return 'Codex rejected the request.';
}
