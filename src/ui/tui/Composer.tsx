import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { colors } from '../theme.ts';

export interface ComposerProps {
  readonly placeholder: string;
  readonly busy: boolean;
  readonly isActive: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  /** Ctrl+C with text in the box clears it; with an empty box it exits. */
  readonly onInterrupt: () => void;
  readonly onExit: () => void;
  readonly onScroll: (direction: -1 | 1) => void;
  /** Tab completion for the current `/…` prefix. */
  readonly complete: (value: string) => string | null;
}

/**
 * A small controlled line editor. Ink has no built-in input, and the third-party
 * one would be another dependency for ~60 lines of cursor arithmetic.
 */
export function Composer({
  placeholder,
  busy,
  isActive,
  onChange,
  onSubmit,
  onInterrupt,
  onExit,
  onScroll,
  complete,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);

  const apply = (next: string, at: number): void => {
    setValue(next);
    setCursor(Math.max(0, Math.min(at, next.length)));
    onChange(next);
  };

  useInput(
    (input, key) => {
      if (key.pageUp) return onScroll(1);
      if (key.pageDown) return onScroll(-1);

      if (key.ctrl && input === 'c') {
        if (busy || value.length === 0) onInterrupt();
        else apply('', 0);
        return;
      }
      if (key.ctrl && input === 'd' && value.length === 0) return onExit();

      if (key.return) {
        const submitted = value.trim();
        apply('', 0);
        if (submitted.length > 0) onSubmit(submitted);
        return;
      }
      if (key.tab) {
        const completed = complete(value);
        if (completed) apply(completed, completed.length);
        return;
      }
      if (key.leftArrow) return setCursor((at) => Math.max(0, at - 1));
      if (key.rightArrow) return setCursor((at) => Math.min(value.length, at + 1));
      if (key.home || (key.ctrl && input === 'a')) return setCursor(0);
      if (key.end || (key.ctrl && input === 'e')) return setCursor(value.length);
      if (key.backspace) {
        if (cursor === 0) return;
        return apply(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.delete) {
        return apply(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      }
      // Anything else is literal text; a paste arrives as one multi-character chunk.
      if (input && !key.ctrl && !key.meta && !key.escape) {
        const text = input.replace(/[\r\n]+/g, ' ');
        apply(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
      }
    },
    { isActive },
  );

  const shown = value.length > 0 ? value : placeholder;
  return (
    <Box borderStyle="round" borderColor={colors.border} paddingX={1}>
      <Text color={colors.accent}>{'> '}</Text>
      {value.length === 0 ? (
        <Text color={colors.muted}>{shown}</Text>
      ) : (
        <Text>
          {value.slice(0, cursor)}
          <Text inverse>{value[cursor] ?? ' '}</Text>
          {value.slice(cursor + 1)}
        </Text>
      )}
    </Box>
  );
}
