import { Box, Text } from 'ink';
import type { ActivityRow } from '../activity.ts';
import { activityTone, palette } from '../theme.ts';

/**
 * What is running, under the transcript: each activity with its clock, what
 * it is waiting for and a command's last lines. Rows are precomputed and
 * capped, so the panel's height is known before it is drawn.
 */
export function ActivityPanel({
  rows,
  spinner,
}: {
  rows: readonly ActivityRow[];
  spinner: string;
}) {
  return (
    <Box flexDirection="column" paddingX={1} width="100%">
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional rows of one snapshot
        <Row key={index} row={row} spinner={spinner} />
      ))}
    </Box>
  );
}

function Row({ row, spinner }: { row: ActivityRow; spinner: string }) {
  const indent = '  '.repeat(row.depth);
  const color = activityTone[row.tone];
  if (row.kind === 'head') {
    // Words carry every state; the icon and colour only repeat them.
    const icon = row.tone === 'approval' ? '◆' : spinner;
    const branch = row.depth > 0 ? '└─ ' : '';
    return (
      <Box width="100%">
        <Text color={color}>{`${indent.slice(2)}${branch}${icon} `}</Text>
        <Text color={palette.text} bold wrap="truncate-end">
          {row.text}
        </Text>
        <Box flexGrow={1} />
        {row.aside ? <Text color={palette.muted}>{row.aside}</Text> : null}
      </Box>
    );
  }
  const tint =
    row.kind === 'output' ? palette.subtle : row.tone === 'active' ? palette.muted : color;
  return (
    <Text color={tint} wrap="truncate-end">
      {`${indent}  ${row.text || ' '}`}
    </Text>
  );
}
