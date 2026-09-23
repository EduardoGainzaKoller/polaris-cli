import type { ModelEvent } from '../providers/provider.ts';
import type { ToolCallResult, ToolRegistry } from './registry.ts';

/**
 * Translation from Polaris's own tool calls to the shared event protocol, used
 * by every provider whose tools Polaris executes itself.
 */
export function toolStarted(
  registry: ToolRegistry,
  id: string,
  name: string,
  input: unknown,
): ModelEvent {
  const { title, target, paths } = registry.preview(name, input);
  return { type: 'tool-start', id, name: title, target, ...(paths ? { paths } : {}) };
}

export function toolFinished(id: string, result: ToolCallResult): ModelEvent {
  if (result.ok) {
    const { exitCode } = result.output.metadata;
    return {
      type: 'tool-result',
      id,
      summary: result.output.summary,
      ...(typeof exitCode === 'number' ? { exitCode } : {}),
    };
  }
  return {
    type: 'tool-error',
    id,
    error: result.error,
    ...(result.denied ? { denied: true } : {}),
  };
}

/** The text the model receives for a call, success or failure. */
export function toolResultText(result: ToolCallResult): string {
  if (result.ok) return result.output.content;
  // A refusal is stated as a decision, not as a malfunction, so the model
  // offers an alternative instead of retrying the same call.
  return result.denied ? result.error : `Error: ${result.error}`;
}

/**
 * Runs a tool and yields its output as it arrives, then returns its result.
 * A generator cannot yield from inside a callback, so output is queued and
 * the generator wakes for each chunk — live, rather than all at the end.
 */
export async function* streamOutput<T>(
  id: string,
  run: (onOutput: (text: string) => void) => Promise<T>,
): AsyncGenerator<ModelEvent, T> {
  const queue: string[] = [];
  let settled = false;
  let wake: (() => void) | null = null;
  const nudge = () => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const work = run((text) => {
    queue.push(text);
    nudge();
  });
  work.then(
    () => {
      settled = true;
      nudge();
    },
    () => {
      settled = true;
      nudge();
    },
  );
  while (true) {
    while (queue.length > 0) yield { type: 'tool-output-delta', id, text: queue.shift() as string };
    if (settled) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  return await work;
}
