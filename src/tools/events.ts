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
  const { title, target } = registry.preview(name, input);
  return { type: 'tool-start', id, name: title, target };
}

export function toolFinished(id: string, result: ToolCallResult): ModelEvent {
  return result.ok
    ? { type: 'tool-result', id, summary: result.output.summary }
    : { type: 'tool-error', id, error: result.error };
}

/** The text the model receives for a call, success or failure. */
export function toolResultText(result: ToolCallResult): string {
  return result.ok ? result.output.content : `Error: ${result.error}`;
}
