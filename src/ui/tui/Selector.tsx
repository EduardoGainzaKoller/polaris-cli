import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { parseMouse } from '../layout.ts';
import { palette } from '../theme.ts';

export interface SelectorProps {
  readonly title: string;
  readonly options: readonly string[];
  readonly current?: string | null;
  readonly onChoose: (value: string) => void;
  /** Esc leaves everything exactly as it was. */
  readonly onCancel: () => void;
  /** Rows available for the option list. */
  readonly height: number;
  readonly width: number;
}

/**
 * A centred dialog: type to filter, ↑↓ to move, Enter to choose, Esc to close.
 * The option already in use is marked, and starts highlighted.
 */
export function Selector({
  title,
  options,
  current,
  onChoose,
  onCancel,
  height,
  width,
}: SelectorProps) {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(() => Math.max(0, options.indexOf(current ?? '')));

  const matches = options.filter((option) => option.toLowerCase().includes(filter.toLowerCase()));
  const active = Math.min(index, Math.max(0, matches.length - 1));

  useInput((input, key) => {
    if (parseMouse(input).isMouse) return;
    if (key.escape) return onCancel();
    if (key.return) {
      const chosen = matches[active];
      if (chosen) onChoose(chosen);
      return;
    }
    if (key.upArrow) return setIndex(Math.max(0, active - 1));
    if (key.downArrow) return setIndex(Math.min(matches.length - 1, active + 1));
    if (key.backspace) {
      setIndex(0);
      return setFilter((text) => text.slice(0, -1));
    }
    if (input && !key.ctrl && !key.meta && !key.tab) {
      setIndex(0);
      setFilter((text) => text + input);
    }
  });

  const rows = Math.max(1, height);
  const from = Math.max(0, Math.min(active - Math.floor(rows / 2), matches.length - rows));
  const visible = matches.slice(from, from + rows);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={palette.accent}
      backgroundColor={palette.panel}
      paddingX={2}
      paddingY={1}
    >
      <Box>
        <Text color={palette.text} bold>
          {title}
        </Text>
        <Box flexGrow={1} />
        <Text color={palette.subtle}>esc</Text>
      </Box>
      <Box marginY={1}>
        <Text color={palette.accent}>{'> '}</Text>
        <Text color={filter ? palette.text : palette.subtle}>{filter || 'type to filter'}</Text>
      </Box>
      {visible.map((option) => {
        const highlighted = option === matches[active];
        return (
          <Box
            key={option}
            {...(highlighted ? { backgroundColor: palette.element } : {})}
            width="100%"
          >
            <Text color={option === current ? palette.accent : palette.subtle}>
              {option === current ? '● ' : '  '}
            </Text>
            <Text color={highlighted ? palette.accent : palette.text} bold={highlighted}>
              {option}
            </Text>
            <Box flexGrow={1} />
            {option === current ? <Text color={palette.subtle}>current</Text> : null}
          </Box>
        );
      })}
      {matches.length === 0 ? <Text color={palette.subtle}>no matches</Text> : null}
    </Box>
  );
}
