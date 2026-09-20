import { PolarisError } from '../../core/errors.ts';
import { PERMISSION_PROFILES } from '../../permissions/policy.ts';
import { toolFinished, toolStarted } from '../../tools/events.ts';
import { createRegistry, polarisAccess } from '../../tools/registry.ts';
import type {
  ModelEvent,
  ModelProvider,
  ModelSession,
  ProviderSessionOptions,
} from '../provider.ts';

/**
 * Directives the mock understands, so the whole tool and approval flow can be
 * exercised offline, with no account and no network:
 *
 *   @read(package.json)   @glob(src/**\/*.ts)   @grep(ModelProvider)
 *   @write(hello.ts :: export const hello = () => 'hi';)
 *   @edit(hello.ts :: 'hi' :: 'hello world')
 *   @run(node -e "console.log(1)")
 *   @wait(200)
 *
 * The tools are the real Polaris registry, running against the real workspace
 * under the real permission gate; only the "model" deciding to call them is
 * scripted. That makes a denied approval, a failing command and a full
 * read → edit → run loop all reproducible in a test.
 */
const DIRECTIVE = /@(read|glob|grep|write|edit|run|wait)\(([\s\S]*?)\)(?=\s|$)/g;

const TOOL_FOR = {
  read: 'read_file',
  glob: 'glob_files',
  grep: 'grep_text',
  write: 'write_file',
  edit: 'edit_file',
  run: 'run_command',
} as const;

type Kind = keyof typeof TOOL_FOR;

/** `a :: b :: c` — the separator is unlikely in a path, a pattern or a command. */
function inputFor(kind: Kind, argument: string): unknown {
  const parts = argument.split('::').map((part) => part.trim());
  switch (kind) {
    case 'read':
      return { path: parts[0] };
    case 'write':
      return { path: parts[0], content: `${parts.slice(1).join('::')}\n` };
    case 'edit':
      return { path: parts[0], oldText: parts[1] ?? '', newText: parts[2] ?? '' };
    case 'run':
      return { command: argument.trim() };
    default:
      return { pattern: argument.trim() };
  }
}

/** Split into a few chunks so the mock exercises the same streaming path as a real provider. */
function chunks(text: string): string[] {
  return ['You ', 'said: ', text];
}

/** Levels the mock pretends to support, so effort selection can be exercised offline. */
const MOCK_EFFORTS = ['low', 'medium', 'high'] as const;

export const mockProvider: ModelProvider = {
  id: 'mock',
  supports: PERMISSION_PROFILES,
  async createSession(options: ProviderSessionOptions): Promise<ModelSession> {
    const registry = createRegistry(options.permissions, options.gate);
    const history: string[] = [];
    let calls = 0;
    let effort = options.effort ?? 'medium';

    return {
      model: options.model ?? 'echo',
      access: polarisAccess(options.permissions),
      get effort() {
        return effort;
      },
      async efforts() {
        return [...MOCK_EFFORTS];
      },
      async setEffort(level) {
        if (!(MOCK_EFFORTS as readonly string[]).includes(level)) {
          throw new PolarisError(`Unknown effort "${level}".`);
        }
        effort = level;
      },
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
          const name = TOOL_FOR[kind as Kind];
          const toolInput = inputFor(kind as Kind, argument);
          const id = `mock-tool-${++calls}`;
          yield toolStarted(registry, id, name, toolInput);

          // Output arriving while the tool runs is queued and drained after
          // it, because a generator cannot yield from a callback.
          const streamed: ModelEvent[] = [];
          const result = await registry.execute(name, toolInput, {
            cwd: options.cwd,
            ...(signal ? { signal } : {}),
            onOutput: (text) => streamed.push({ type: 'tool-output-delta', id, text }),
          });
          for (const event of streamed) yield event;
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
