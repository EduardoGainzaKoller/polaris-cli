import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { colors } from '../theme.ts';

export interface SelectorProps {
  readonly title: string;
  readonly options: readonly string[];
  readonly current?: string;
  readonly onChoose: (value: string) => void;
  /** Esc leaves everything exactly as it was. */
  readonly onCancel: () => void;
  readonly height: number;
}

/** Keyboard list picker: ↑↓ to move, type to filter, Enter to choose, Esc to cancel. */
export function Selector({ title, options, current, onChoose, onCancel, height }: SelectorProps) {
  const [filter, setFilter] = useState('');
  const [index, setIndex] = useState(0);

  const matches = options.filter((option) => option.toLowerCase().includes(filter.toLowerCase()));
  const active = Math.min(index, Math.max(0, matches.length - 1));

  useInput((input, key) => {
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
    if (input && !key.ctrl && !key.meta) {
      setIndex(0);
      setFilter((text) => text + input);
    }
  });

  // Keep the highlighted row on screen without a full scrolling model.
  const rows = Math.max(1, height);
  const from = Math.max(0, Math.min(active - Math.floor(rows / 2), matches.length - rows));
  const visible = matches.slice(Math.max(0, from), Math.max(0, from) + rows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.accent} paddingX={1}>
      <Text color={colors.accent}>
        {title}
        {filter ? <Text color={colors.muted}>{`  ${filter}`}</Text> : null}
      </Text>
      {visible.map((option) => (
        <Text key={option} {...(option === matches[active] ? { color: colors.accent } : {})}>
          {option === matches[active] ? '> ' : '  '}
          {option}
          {option === current ? <Text color={colors.muted}> (current)</Text> : null}
        </Text>
      ))}
      {matches.length === 0 ? <Text color={colors.muted}>no matches</Text> : null}
      <Text color={colors.muted}>↑↓ move · enter select · esc cancel</Text>
    </Box>
  );
}
