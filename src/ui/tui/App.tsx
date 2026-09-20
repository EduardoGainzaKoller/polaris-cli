import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandRegistry } from '../../cli/commands/registry.ts';
import { parseCommand } from '../../cli/commands/types.ts';
import { withEntry } from '../../config/history.ts';
import type { AppState, PolarisApp } from '../../core/app.ts';
import { toUserMessage } from '../../core/errors.ts';
import { VERSION } from '../../version.ts';
import {
  clamp,
  footerHints,
  maxScroll,
  parseMouse,
  statusLabel,
  transcriptLines,
} from '../layout.ts';
import { shortenPath } from '../output.ts';
import { palette } from '../theme.ts';
import { Composer } from './Composer.tsx';
import { Home } from './Home.tsx';
import { Selector } from './Selector.tsx';
import { useSpinner } from './Spinner.tsx';
import { Transcript } from './Transcript.tsx';

const HEADER_HEIGHT = 2;
const FOOTER_HEIGHT = 1;
/** Space between the transcript and the composer. */
const GAP = 1;

interface Pending {
  readonly title: string;
  readonly options: readonly string[];
  readonly current: string | null;
  readonly resolve: (value: string | null) => void;
}

export interface AppProps {
  readonly app: PolarisApp;
  readonly registry: CommandRegistry;
  /** Prompt history loaded at start, oldest first. */
  readonly history?: readonly string[];
  /** Called with the new history after each submission, to persist it. */
  readonly onHistory?: (history: readonly string[]) => void;
}

export function App({ app, registry, history: initialHistory = [], onHistory }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<AppState>(() => app.state);
  const [size, setSize] = useState(terminalSize());
  const [scroll, setScroll] = useState(0);
  const [draft, setDraft] = useState('');
  const [composerHeight, setComposerHeight] = useState(4);
  const [pending, setPending] = useState<Pending | null>(null);
  const [history, setHistory] = useState<readonly string[]>(initialHistory);

  // One subscription, coalesced through React's own batching: a fast stream
  // updates state often, and Ink's frame cap bounds how often it repaints.
  useEffect(() => app.subscribe(setState), [app]);

  useEffect(() => {
    const onResize = () => setSize(terminalSize());
    stdout?.on('resize', onResize);
    return () => {
      stdout?.off('resize', onResize);
    };
  }, [stdout]);

  const spinner = useSpinner(state.busy);
  const commands = useMemo(
    () => registry.list().map(({ name, summary }) => ({ name, summary })),
    [registry],
  );

  const home = state.messages.length === 0 && pending === null;
  const bodyWidth = Math.max(20, size.columns - 6);
  const lines = useMemo(
    () => transcriptLines(state.messages, bodyWidth),
    [state.messages, bodyWidth],
  );

  const available = Math.max(3, size.rows - HEADER_HEIGHT - FOOTER_HEIGHT - GAP - composerHeight);
  const limit = maxScroll(lines.length, available);
  const offset = clamp(scroll, 0, limit);
  // While scrolled back, one row shows how far below the latest output is.
  const transcriptHeight = offset > 0 ? available - 1 : available;
  const end = lines.length - offset;
  const visible = lines.slice(Math.max(0, end - transcriptHeight), end);

  const scrollBy = useCallback(
    (rows: number) => setScroll((at) => clamp(at + rows, 0, limit)),
    [limit],
  );

  const run = useCallback(
    async (text: string) => {
      const next = withEntry(history, text);
      setHistory(next);
      onHistory?.(next);

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
      setScroll(0);
      try {
        await command.run(
          {
            app,
            canSelect: true,
            select: (title, options, current) =>
              new Promise<string | null>((resolve) =>
                setPending({ title, options, current: current ?? null, resolve }),
              ),
            clearScreen: () => setScroll(0),
            requestExit: exit,
          },
          parsed.args,
        );
      } catch (error) {
        app.notice(toUserMessage(error), 'error');
      }
    },
    [app, registry, exit, history, onHistory],
  );

  // The transcript owns scrolling, whoever has the keyboard: PgUp/PgDn a page,
  // Shift or Ctrl with ↑↓ a line, the mouse wheel three lines, Esc back to the
  // latest output. Plain ↑↓ stay with the composer for history.
  useInput((input, key) => {
    const mouse = parseMouse(input);
    if (mouse.isMouse) return scrollBy(mouse.scroll);
    if (key.pageUp) return scrollBy(transcriptHeight - 1);
    if (key.pageDown) return scrollBy(-(transcriptHeight - 1));
    if ((key.shift || key.ctrl) && key.upArrow) return scrollBy(1);
    if ((key.shift || key.ctrl) && key.downArrow) return scrollBy(-1);
    if (key.escape && offset > 0 && !pending && !draft.startsWith('/')) setScroll(0);
  });

  const composer = (
    <Composer
      width={home ? Math.min(size.columns - 2, 88) : size.columns - 2}
      isActive={pending === null}
      busy={state.busy}
      commands={commands}
      history={history}
      provider={state.provider}
      model={state.model}
      effort={state.effort}
      mode={state.access?.mode ?? null}
      onChange={setDraft}
      onHeight={setComposerHeight}
      onSubmit={(text) => void run(text)}
      onInterrupt={() => {
        if (!app.cancel()) exit();
      }}
      onExit={exit}
    />
  );

  const where = shortenPath(state.cwd);
  const hintsWidth = Math.max(0, size.columns - where.length - 24);

  return (
    <Box
      flexDirection="column"
      width={size.columns}
      height={size.rows}
      backgroundColor={palette.background}
      paddingX={1}
    >
      {/* Header */}
      <Box height={HEADER_HEIGHT}>
        <Text color={palette.accent} bold>
          ✦
        </Text>
        <Text color={palette.text} bold>{` ${state.project}`}</Text>
        <Box flexGrow={1} />
        <Text color={palette.subtle}>{`v${VERSION}`}</Text>
      </Box>

      {/* Body */}
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        justifyContent={home ? 'center' : 'flex-end'}
      >
        {pending ? (
          <Box justifyContent="center" alignItems="center" flexGrow={1}>
            <Selector
              title={pending.title}
              options={pending.options}
              current={pending.current}
              width={Math.min(60, size.columns - 6)}
              height={Math.max(3, Math.min(10, size.rows - 16))}
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
          </Box>
        ) : home ? (
          <Box flexDirection="column" alignItems="center">
            <Home width={size.columns} />
          </Box>
        ) : (
          <Box flexDirection="column" paddingX={1}>
            <Transcript lines={visible} spinner={spinner} />
            {offset > 0 ? (
              <Box justifyContent="center">
                <Text color={palette.accent}>
                  {`↓ ${offset} more ${offset === 1 ? 'line' : 'lines'} · esc to jump to latest`}
                </Text>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>

      {/* Composer */}
      <Box height={GAP} />
      <Box justifyContent="center">{composer}</Box>

      {/* Footer */}
      <Box height={FOOTER_HEIGHT}>
        {state.busy ? (
          <Text color={palette.accent}>{`${spinner} ${statusLabel(state.status)}`}</Text>
        ) : (
          <Text color={state.status === 'error' ? palette.error : palette.subtle}>
            {`● ${statusLabel(state.status)}`}
          </Text>
        )}
        <Text color={palette.subtle}>{`   ${where}`}</Text>
        <Box flexGrow={1} />
        <Text color={palette.subtle} wrap="truncate-end">
          {footerHints(hintsWidth, state.busy)}
        </Text>
      </Box>
    </Box>
  );
}

function terminalSize(): { columns: number; rows: number } {
  return {
    columns: Math.max(40, process.stdout.columns || 80),
    rows: Math.max(14, process.stdout.rows || 24),
  };
}
