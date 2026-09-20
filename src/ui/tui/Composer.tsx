import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { completions, historyStep, inputRows, parseMouse } from '../layout.ts';
import { palette } from '../theme.ts';

export interface CommandHint {
  readonly name: string;
  readonly summary: string;
}

export interface ComposerProps {
  readonly busy: boolean;
  readonly isActive: boolean;
  readonly commands: readonly CommandHint[];
  /** Everything submitted before, oldest first. */
  readonly history: readonly string[];
  /** Shown under the input: mode badge, then provider · model · effort. */
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly mode: string | null;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /** Ctrl+C: cancel the running turn, or exit when idle and empty. */
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  /** Width available to the composer, in columns. */
  readonly width: number;
  /** Reports the rows the composer occupies, so the transcript can take the rest. */
  readonly onHeight: (rows: number) => void;
}

/** How many command suggestions are listed at once. */
export const PALETTE_ROWS = 6;

/**
 * The prompt box. It edits one logical line, walks the prompt history with
 * ↑/↓, and opens a command palette while the text starts with `/`.
 *
 * Scrolling keys (PgUp/PgDn, Shift/Ctrl+↑↓, the mouse wheel) belong to the
 * transcript and are deliberately ignored here.
 */
export function Composer(props: ComposerProps) {
  const { busy, isActive, commands, history, onChange, onSubmit, onInterrupt, onExit } = props;
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [browsing, setBrowsing] = useState<number | null>(null);
  const [stash, setStash] = useState('');
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const matches = dismissed
    ? []
    : completions(
        value,
        commands.map((command) => command.name),
      ).map((name) => commands.find((command) => command.name === name) as CommandHint);
  const highlighted = Math.min(selected, Math.max(0, matches.length - 1));

  /** Replace the text. `typed` edits leave history browsing; recalls keep it. */
  const apply = (next: string, at: number, typed = true): void => {
    setValue(next);
    setCursor(Math.max(0, Math.min(at, next.length)));
    setSelected(0);
    setDismissed(false);
    if (typed) setBrowsing(null);
    onChange(next);
  };

  const submit = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // A prompt waits while a turn is running; commands still go through.
    if (busy && !trimmed.startsWith('/')) return;
    apply('', 0);
    onSubmit(trimmed);
  };

  useInput(
    (input, key) => {
      if (parseMouse(input).isMouse) return;
      if (key.pageUp || key.pageDown) return;
      if ((key.upArrow || key.downArrow) && (key.shift || key.ctrl)) return;

      if (key.ctrl && input === 'c') {
        if (busy || value.length === 0) onInterrupt();
        else apply('', 0);
        return;
      }
      if (key.ctrl && input === 'd' && value.length === 0) return onExit();

      if (matches.length > 0) {
        if (key.upArrow) return setSelected(Math.max(0, highlighted - 1));
        if (key.downArrow) return setSelected(Math.min(matches.length - 1, highlighted + 1));
        if (key.escape) return setDismissed(true);
        const pick = matches[highlighted];
        if (key.tab && pick) return apply(`/${pick.name} `, pick.name.length + 2);
        if (key.return && pick) return submit(`/${pick.name}`);
      }

      if (key.upArrow || key.downArrow) {
        const next = historyStep(history.length, browsing, key.upArrow ? 'older' : 'newer');
        if (next === browsing) return;
        if (browsing === null) setStash(value);
        setBrowsing(next);
        const recalled = next === null ? stash : (history[next] ?? '');
        return apply(recalled, recalled.length, false);
      }

      if (key.return) return submit(value);
      if (key.leftArrow) return setCursor((at) => Math.max(0, at - 1));
      if (key.rightArrow) return setCursor((at) => Math.min(value.length, at + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(0);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(value.length);
      if (key.ctrl && input === 'u') return apply('', 0);
      if (key.backspace) {
        if (cursor === 0) return;
        return apply(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) return apply(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      // Anything else is literal text; a paste arrives as one multi-character chunk.
      if (input && !key.ctrl && !key.meta && !key.escape && !key.tab) {
        const text = input.replace(/[\r\n]+/g, ' ');
        apply(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
      }
    },
    { isActive },
  );

  const first = Math.max(
    0,
    Math.min(highlighted - PALETTE_ROWS + 1, matches.length - PALETTE_ROWS),
  );
  const shownMatches = matches.slice(first, first + PALETTE_ROWS);
  const width = Math.max(...commands.map((command) => command.name.length)) + 3;

  // Palette (+2 border) + input box: 2 border rows, the wrapped input, the info row.
  const height =
    (shownMatches.length > 0 ? shownMatches.length + 2 : 0) +
    2 +
    inputRows(value, props.width - 6) +
    1;
  const { onHeight } = props;
  useEffect(() => onHeight(height), [height, onHeight]);

  return (
    <Box flexDirection="column" width={props.width}>
      {shownMatches.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.border}
          backgroundColor={palette.panel}
          paddingX={1}
        >
          {shownMatches.map((command) => {
            const active = command === matches[highlighted];
            return (
              <Box
                key={command.name}
                {...(active ? { backgroundColor: palette.element } : {})}
                width="100%"
              >
                <Text color={active ? palette.accent : palette.text} bold={active}>
                  {`/${command.name}`.padEnd(width)}
                </Text>
                <Text color={palette.muted} wrap="truncate-end">
                  {command.summary}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isActive ? palette.accent : palette.border}
        backgroundColor={palette.panel}
        paddingX={1}
      >
        <Box>
          <Text color={palette.accent}>{'> '}</Text>
          {value.length === 0 ? (
            <Text color={palette.subtle} wrap="truncate-end">
              {busy ? 'Working… ctrl+c to cancel' : 'Ask anything, or type / for commands'}
            </Text>
          ) : (
            <Text color={palette.text}>
              {value.slice(0, cursor)}
              <Text inverse>{value[cursor] ?? ' '}</Text>
              {value.slice(cursor + 1)}
            </Text>
          )}
        </Box>
        <Box>
          {props.mode ? (
            <Text backgroundColor={palette.accent} color={palette.background} bold>
              {` ${props.mode.toUpperCase()} `}
            </Text>
          ) : null}
          <Text color={palette.muted}>{`  ${props.provider} · `}</Text>
          <Text color={palette.text} wrap="truncate-end">
            {props.model}
          </Text>
          {props.effort ? <Text color={palette.secondary}>{` · ${props.effort}`}</Text> : null}
          <Box flexGrow={1} />
          <Text color={palette.subtle}>
            {browsing !== null ? `history ${browsing + 1}/${history.length}` : 'enter send'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
