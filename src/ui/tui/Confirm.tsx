import { Box, Text, useInput } from 'ink';
import { parseMouse } from '../layout.ts';
import { palette } from '../theme.ts';

/** Rows of details shown before the rest is summarised. */
const MAX_DETAILS = 12;

/**
 * A yes/no question for a destructive command. Unlike an approval, Enter
 * does nothing here: only `y` answers yes, and `n`, Esc or Ctrl+C answer no.
 */
export function Confirm({
  question,
  details,
  width,
  onAnswer,
}: {
  question: string;
  details: readonly string[];
  width: number;
  onAnswer: (yes: boolean) => void;
}) {
  useInput((input, key) => {
    if (parseMouse(input).isMouse) return;
    const typed = input.toLowerCase();
    if (typed === 'y' && !key.ctrl) return onAnswer(true);
    if (typed === 'n' || key.escape || (key.ctrl && typed === 'c')) return onAnswer(false);
  });

  const shown = details.slice(0, MAX_DETAILS);
  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={palette.warning}
      backgroundColor={palette.panel}
      paddingX={1}
    >
      <Text color={palette.warning} bold>
        {question}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((line) => (
          <Text key={line} color={palette.text} wrap="truncate-end">
            {`  ${line}`}
          </Text>
        ))}
        {details.length > shown.length ? (
          <Text color={palette.muted}>{`  … ${details.length - shown.length} more`}</Text>
        ) : null}
      </Box>
      <Box marginTop={1}>
        <Text color={palette.success}>y</Text>
        <Text color={palette.muted}>{'  Yes'}</Text>
        <Box flexGrow={1} />
        <Text color={palette.error}>n</Text>
        <Text color={palette.muted}>{'  No'}</Text>
      </Box>
    </Box>
  );
}
