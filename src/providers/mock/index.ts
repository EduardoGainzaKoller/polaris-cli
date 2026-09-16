import { toolFinished, toolStarted } from '../../tools/events.ts';
import { createReadOnlyRegistry, POLARIS_TOOL_ACCESS } from '../../tools/registry.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';

/**
 * Directives the mock understands, so tool flows can be exercised offline:
 *
 *   @read(package.json)  @glob(src/**\/*.ts)  @grep(ModelProvider)  @wait(200)
 *
 * The tools are the real Polaris registry running against the real workspace;
 * only the "model" deciding to call them is scripted.
 */
const DIRECTIVE = /@(read|glob|grep|wait)\(([^)]*)\)/g;

const TOOL_FOR = { read: 'read_file', glob: 'glob_files', grep: 'grep_text' } as const;

function inputFor(kind: keyof typeof TOOL_FOR, argument: string): unknown {
  if (kind === 'read') return { path: argument };
  return { pattern: argument };
}

/** Split into a few chunks so the mock exercises the same streaming path as a real provider. */
function chunks(text: string): string[] {
  return ['You ', 'said: ', text];
}

export const mockProvider: ModelProvider = {
  id: 'mock',
  access: POLARIS_TOOL_ACCESS,
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    const registry = createReadOnlyRegistry();
    const history: string[] = [];
    let calls = 0;

    return {
      model: options.model ?? 'echo',
      async *send(input, signal): AsyncIterable<ModelEvent> {
        signal?.throwIfAborted();
        history.push(input);
        yield { type: 'message-start' };

        for (const [, kind, argument = ''] of input.matchAll(DIRECTIVE)) {
          signal?.throwIfAborted();
          if (kind === 'wait') {
            await sleep(Number(argument) || 0, signal);
            continue;
          }
          const name = TOOL_FOR[kind as keyof typeof TOOL_FOR];
          const toolInput = inputFor(kind as keyof typeof TOOL_FOR, argument.trim());
          const id = `mock-tool-${++calls}`;
          yield toolStarted(registry, id, name, toolInput);
          const result = await registry.execute(name, toolInput, {
            cwd: options.cwd,
            ...(signal ? { signal } : {}),
          });
          yield toolFinished(id, result);
        }

        const text = input.replace(DIRECTIVE, '').trim() || input;
        for (const piece of chunks(text)) {
          signal?.throwIfAborted();
          yield { type: 'text-delta', text: piece };
        }
        yield { type: 'message-end' };
      },
      async listModels() {
        return ['echo', 'echo-uppercase'];
      },
      async close() {
        history.length = 0;
      },
    };
  },
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
