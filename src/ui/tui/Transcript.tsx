import { Box, Text } from 'ink';
import type { TranscriptLine } from '../layout.ts';
import { palette } from '../theme.ts';

const TOOL_ICON: Record<TranscriptLine['state'], string> = {
  streaming: '',
  complete: '✓',
  error: '✗',
  // A refused call: an outline, not a cross. Nothing went wrong.
  cancelled: '○',
};

/**
 * Draws a window of transcript rows. Each row is exactly one terminal line —
 * wrapping already happened in `transcriptLines` — so the window's height is
 * exact and nothing reflows while an answer streams in.
 */
export function Transcript({
  lines,
  spinner,
}: {
  lines: readonly TranscriptLine[];
  spinner: string;
}) {
  return (
    <>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows in a fixed window
        <Row key={index} line={line} spinner={spinner} />
      ))}
    </>
  );
}

function Row({ line, spinner }: { line: TranscriptLine; spinner: string }) {
  switch (line.kind) {
    case 'blank':
      return <Text> </Text>;

    case 'user':
      return (
        <Box backgroundColor={palette.panel} width="100%">
          <Text color={palette.accent}>┃ </Text>
          <Text color={palette.text}>{line.text || ' '}</Text>
        </Box>
      );

    case 'tool': {
      const running = line.state === 'streaming';
      const iconColor =
        line.state === 'error'
          ? palette.error
          : line.state === 'complete'
            ? palette.success
            : palette.muted;
      return (
        <Box width="100%">
          <Text color={iconColor}>{`${running ? spinner : TOOL_ICON[line.state]} `}</Text>
          <Text color={running ? palette.muted : palette.text} bold>
            {line.label}
          </Text>
          <Text color={palette.muted}>{` ${line.text}`}</Text>
          <Box flexGrow={1} />
          {line.aside ? <Text color={palette.subtle}>{line.aside}</Text> : null}
        </Box>
      );
    }

    case 'detail':
      return (
        <Text color={line.state === 'error' ? palette.error : palette.subtle}>
          {`  ${line.text}`}
        </Text>
      );

    case 'output':
      return (
        <Text color={palette.subtle} wrap="truncate-end">
          {`  ${line.text || ' '}`}
        </Text>
      );

    case 'meta':
      return (
        <Text color={line.state === 'cancelled' ? palette.warning : palette.subtle}>
          {`◇ ${line.text}`}
        </Text>
      );

    case 'notice':
      return (
        <Text color={line.state === 'error' ? palette.error : palette.muted}>
          {line.text || ' '}
        </Text>
      );

    default:
      return <Text color={palette.text}>{line.text || ' '}</Text>;
  }
}
