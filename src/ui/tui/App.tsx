import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandRegistry } from '../../cli/commands/registry.ts';
import { parseCommand } from '../../cli/commands/types.ts';
import { withEntry } from '../../config/history.ts';
import type { AppState, PolarisApp } from '../../core/app.ts';
import { toUserMessage } from '../../core/errors.ts';
import { VERSION } from '../../version.ts';
import { activityRows, activitySummary } from '../activity.ts';
import {
  clamp,
  footerHints,
  maxScroll,
  parseMouse,
  statusLabel,
  transcriptLines,
  workspaceLabel,
} from '../layout.ts';
import { shortenPath } from '../output.ts';
import { palette } from '../theme.ts';
import { ActivityPanel } from './ActivityPanel.tsx';
import { Approval } from './Approval.tsx';
import { useClock } from './Clock.tsx';
import { Composer } from './Composer.tsx';
import { Confirm } from './Confirm.tsx';
import { Home } from './Home.tsx';
import { Selector } from './Selector.tsx';
import { useSpinner } from './Spinner.tsx';
import { Transcript } from './Transcript.tsx';

const HEADER_HEIGHT = 2;
/** Rows an approval card needs before any diff: borders, title, target, actions. */
const APPROVAL_CHROME = 8;
/** Diff rows the card shows at most, however tall the terminal is. */
const MAX_CARD_DIFF_ROWS = 16;
/** The transcript never shrinks below this, even with a card open. */
const MIN_TRANSCRIPT_ROWS = 3;
const FOOTER_HEIGHT = 1;
/** Space between the transcript and the composer. */
const GAP = 1;

interface Pending {
  readonly title: string;
  readonly options: readonly string[];
  readonly current: string | null;
  readonly resolve: (value: string | null) => void;
}

interface Asking {
  readonly question: string;
  readonly details: readonly string[];
  readonly resolve: (yes: boolean) => void;
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
  const [asking, setAsking] = useState<Asking | null>(null);
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
  // One clock for every live activity; it stops when nothing is running.
  const now = useClock(state.activity.length > 0);
  const activity = useMemo(() => activityRows(state.activity, now), [state.activity, now]);
  // Approvals have their own card; the panel shows the work around them.
  const panel = approvalShown(state) ? activity.filter((row) => row.tone !== 'approval') : activity;
  const commands = useMemo(
    () => registry.list().map(({ name, summary }) => ({ name, summary })),
    [registry],
  );

  const approval = state.approval;
  const home =
    state.messages.length === 0 && pending === null && approval === null && asking === null;
  const bodyWidth = Math.max(20, size.columns - 6);
  const lines = useMemo(
    () => transcriptLines(state.messages, bodyWidth),
    [state.messages, bodyWidth],
  );

  // The card's rows come out of the transcript's, so the whole screen still
  // fits: everything else is fixed height, and the transcript is the only part
  // that can give. Clipping the card instead would hide what is being agreed to.
  const chrome =
    HEADER_HEIGHT +
    FOOTER_HEIGHT +
    GAP +
    composerHeight +
    (panel.length > 0 ? panel.length + 1 : 0);
  const budget = Math.max(0, size.rows - chrome - MIN_TRANSCRIPT_ROWS);
  const diffRows = approval ? diffRowsFor(approval, budget) : 0;
  const approvalHeight = approval ? APPROVAL_CHROME + (approval.facts?.length ?? 0) + diffRows : 0;
  const available = Math.max(MIN_TRANSCRIPT_ROWS, size.rows - chrome - approvalHeight);
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
      // Switching provider, model, effort or profile replaces the session the
      // pending request belongs to, which would strand it.
      if (command.blockedByApproval && app.state.approval) {
        app.notice('Finish or deny the pending approval first.', 'error');
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
            confirm: (question, details) =>
              new Promise<boolean>((resolve) => setAsking({ question, details, resolve })),
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
    // While an approval is open the card has the keyboard, so no other binding
    // can be mistaken for an answer to it.
    if (approval || asking) return;
    if (key.pageUp) return scrollBy(transcriptHeight - 1);
    if (key.pageDown) return scrollBy(-(transcriptHeight - 1));
    if ((key.shift || key.ctrl) && key.upArrow) return scrollBy(1);
    if ((key.shift || key.ctrl) && key.downArrow) return scrollBy(-1);
    if (key.escape && offset > 0 && !pending && !draft.startsWith('/')) setScroll(0);
  });

  const composer = (
    <Composer
      width={home ? Math.min(size.columns - 2, 88) : size.columns - 2}
      isActive={pending === null && approval === null && asking === null}
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

  // Narrow terminals lose the path first; the status and the workspace
  // indicator are what a glance at the footer is for.
  const workspace = workspaceLabel(state.workspace, state.context.loaded.length);
  const fullPath = shortenPath(state.cwd);
  const where = size.columns - workspace.length - fullPath.length >= 60 ? fullPath : '';
  const hintsWidth = Math.max(0, size.columns - where.length - workspace.length - 28);

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
        <Text color={palette.subtle}>{`v${VERSION} · Developer Preview`}</Text>
      </Box>

      {/* Body */}
      <Box
        flexDirection="column"
        flexGrow={1}
        overflow="hidden"
        justifyContent={home ? 'center' : 'flex-end'}
      >
        {asking ? (
          <Box justifyContent="center" alignItems="center" flexGrow={1}>
            <Confirm
              question={asking.question}
              details={asking.details}
              width={Math.min(76, size.columns - 6)}
              onAnswer={(yes) => {
                const { resolve } = asking;
                setAsking(null);
                resolve(yes);
              }}
            />
          </Box>
        ) : pending ? (
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
            <Home width={size.columns} permissions={state.permissions} />
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
            {/* The card sits inside the body and below the transcript, which
                already gave up the rows for it. Outside, a short terminal
                would clip the card itself — the one thing that must stay
                readable, since it is what is being agreed to. */}
            {approval ? (
              <Box justifyContent="center" marginTop={1} flexShrink={0}>
                <Approval
                  request={approval}
                  width={Math.min(76, size.columns - 6)}
                  maxDiffRows={diffRows}
                  onDecide={(decision) => app.resolveApproval(decision)}
                  onCancelTurn={() => {
                    app.resolveApproval('deny');
                    app.cancel();
                  }}
                />
              </Box>
            ) : null}
          </Box>
        )}
      </Box>

      {/* What is running: a fixed, capped block, so the transcript above
          keeps its scroll position while clocks tick. */}
      {panel.length > 0 ? (
        <Box marginTop={1} flexShrink={0} width="100%">
          <ActivityPanel rows={panel} spinner={spinner} />
        </Box>
      ) : null}

      {/* Composer */}
      <Box height={GAP} />
      <Box justifyContent="center">{composer}</Box>

      {/* Footer */}
      <Box height={FOOTER_HEIGHT}>
        {state.busy ? (
          <Text color={palette.accent} wrap="truncate-end">
            {`${spinner} ${activitySummary(state.activity, now) || statusLabel(state.status)}`}
          </Text>
        ) : (
          <Text color={state.status === 'error' ? palette.error : palette.subtle}>
            {`● ${statusLabel(state.status)}`}
          </Text>
        )}
        {where ? <Text color={palette.subtle}>{`   ${where}`}</Text> : null}
        {workspace ? (
          <Text color={verificationColor(state.workspace.verification)}>{`   ${workspace}`}</Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={palette.subtle} wrap="truncate-end">
          {footerHints(hintsWidth, state.busy, approval !== null)}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * How many diff rows the card can show: as many as fit, never so many that
 * the transcript disappears, and never more than a screenful — a diff cut to
 * nothing is worse than no diff at all, because it looks like there was no
 * change to see.
 */
function diffRowsFor(
  approval: { diff?: string; facts?: readonly string[] },
  budget: number,
): number {
  if (!approval.diff) return 0;
  const wanted = approval.diff.split('\n').length;
  const room = budget - APPROVAL_CHROME - (approval.facts?.length ?? 0);
  return Math.max(0, Math.min(wanted, room, MAX_CARD_DIFF_ROWS));
}

/** True when the approval card is on screen, and so already tells the story. */
function approvalShown(state: AppState): boolean {
  return state.approval !== null;
}

function verificationColor(state: AppState['workspace']['verification']): string {
  if (state === 'verified') return palette.success;
  if (state === 'failed') return palette.error;
  if (state === 'unverified' || state === 'incomplete') return palette.warning;
  return palette.subtle;
}

function terminalSize(): { columns: number; rows: number } {
  return {
    columns: Math.max(40, process.stdout.columns || 80),
    rows: Math.max(14, process.stdout.rows || 24),
  };
}
