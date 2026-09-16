import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandRegistry } from '../../cli/commands/registry.ts';
import { parseCommand } from '../../cli/commands/types.ts';
import type { AppState, PolarisApp, UiMessage } from '../../core/app.ts';
import { toUserMessage } from '../../core/errors.ts';
import {
  clamp,
  completions,
  maxScroll,
  statusLabel,
  statusSegments,
  transcriptLines,
} from '../layout.ts';
import { colors } from '../theme.ts';
import { Composer } from './Composer.tsx';
import { Selector } from './Selector.tsx';

const HEADER_HEIGHT = 2;
const COMPOSER_HEIGHT = 3;
const STATUS_HEIGHT = 1;
const MIN_TRANSCRIPT = 3;

interface Pending {
  readonly title: string;
  readonly options: readonly string[];
  readonly resolve: (value: string | null) => void;
}

export function App({ app, registry }: { app: PolarisApp; registry: CommandRegistry }) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>(() => app.state);
  const [size, setSize] = useState(terminalSize());
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const { stdout } = useStdout();

  // One subscription, coalesced through React's own batching: a fast stream
  // updates state often, and Ink's frame rate caps how often it repaints.
  useEffect(() => app.subscribe(setState), [app]);

  useEffect(() => {
    const onResize = () => setSize(terminalSize());
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const names = useMemo(() => registry.list().map((command) => command.name), [registry]);
  const suggestions = completions(draft, names);
  const suggestionHeight = Math.min(suggestions.length, 5);

  const transcriptHeight = Math.max(
    MIN_TRANSCRIPT,
    size.rows - HEADER_HEIGHT - COMPOSER_HEIGHT - STATUS_HEIGHT - suggestionHeight,
  );
  const bodyWidth = Math.max(20, size.columns - 4);
  const lines = useMemo(
    () => transcriptLines(state.messages, bodyWidth),
    [state.messages, bodyWidth],
  );
  const limit = maxScroll(lines.length, transcriptHeight);
  const offset = clamp(scroll, 0, limit);
  const visible = lines.slice(
    Math.max(0, lines.length - transcriptHeight - offset),
    Math.max(0, lines.length - offset),
  );

  const run = useCallback(
    async (text: string) => {
      const parsed = parseCommand(text);
      if (!parsed) {
        setScroll(0);
        await app.submit(text);
        return;
      }
      const command = registry.get(parsed.name);
      if (!command) {
        app.notice(`Unknown command /${parsed.name} — try /help`, 'error');
        return;
      }
      try {
        await command.run(
          {
            app,
            canSelect: true,
            select: (title, options) =>
              new Promise<string | null>((resolve) => setPending({ title, options, resolve })),
            clearScreen: () => setScroll(0),
            requestExit: exit,
          },
          parsed.args,
        );
      } catch (error) {
        app.notice(toUserMessage(error), 'error');
      }
    },
    [app, registry, exit],
  );

  // Scrolling stays available while a picker is open; typing does not.
  useInput(
    (_input, key) => {
      if (key.pageUp) setScroll((at) => clamp(at + transcriptHeight, 0, limit));
      if (key.pageDown) setScroll((at) => clamp(at - transcriptHeight, 0, limit));
    },
    { isActive: pending !== null },
  );

  const status = statusSegments(state, size.columns);
  const statusColor = state.status === 'error' ? colors.error : colors.muted;

  return (
    <Box flexDirection="column" width={size.columns} height={size.rows}>
      <Box paddingX={1}>
        <Text color={colors.accent} bold>
          ✦ POLARIS
        </Text>
        <Text color={colors.muted}>{`  ${state.project}`}</Text>
        <Box flexGrow={1} />
        <Text color={colors.muted}>{`${state.provider} · ${state.model}`}</Text>
      </Box>
      <Box paddingX={1}>
        <Text color={colors.border}>{'─'.repeat(Math.max(0, size.columns - 2))}</Text>
      </Box>

      {/* Anchored to the bottom, so a short conversation sits next to the composer. */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" paddingX={1}>
        {/* A fixed window of positional lines: the row index is the identity. */}
        {visible.map((line, index) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: positional rows in a fixed window
            key={index}
            {...colorProp(lineColor(line.role, line.state))}
            bold={line.kind === 'label'}
          >
            {line.text || ' '}
          </Text>
        ))}
      </Box>

      {suggestionHeight > 0 && !pending ? (
        <Box paddingX={2}>
          <Text color={colors.muted}>{suggestions.map((name) => `/${name}`).join('  ')}</Text>
        </Box>
      ) : null}

      {pending ? (
        <Selector
          title={pending.title}
          options={pending.options}
          current={pending.title.includes('model') ? state.model : state.provider}
          height={Math.min(8, transcriptHeight)}
          onChoose={(value) => {
            const { resolve } = pending;
            setPending(null);
            resolve(value);
          }}
          onCancel={() => {
            const { resolve } = pending;
            setPending(null);
            resolve(null);
          }}
        />
      ) : (
        <Composer
          isActive={pending === null}
          busy={state.busy}
          placeholder={state.busy ? 'Working… ctrl+c cancels' : 'Ask Polaris…'}
          onChange={setDraft}
          onSubmit={(text) => void run(text)}
          onInterrupt={() => {
            if (!app.cancel()) exit();
          }}
          onExit={exit}
          onScroll={(direction) =>
            setScroll((at) => clamp(at + direction * transcriptHeight, 0, limit))
          }
          complete={(value) => {
            const matches = completions(value, names);
            return matches.length === 1 && matches[0] ? `/${matches[0]} ` : null;
          }}
        />
      )}

      <Box paddingX={1}>
        <Text color={colors.muted}>{status.left}</Text>
        <Box flexGrow={1} />
        <Text color={statusColor}>
          {offset > 0 ? `↑${offset}  ` : ''}
          {status.right || statusLabel(state.status)}
        </Text>
      </Box>
    </Box>
  );
}

/** `exactOptionalPropertyTypes` forbids passing an explicit undefined colour. */
function colorProp(color: string | undefined): { color?: string } {
  return color ? { color } : {};
}

function lineColor(role: UiMessage['role'], state: UiMessage['state']): string | undefined {
  if (state === 'error') return colors.error;
  if (role === 'user') return colors.user;
  if (role === 'system') return colors.muted;
  return undefined;
}

function terminalSize(): { columns: number; rows: number } {
  return {
    columns: Math.max(40, process.stdout.columns || 80),
    rows: Math.max(12, process.stdout.rows || 24),
  };
}
