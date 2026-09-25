import { Box, Text, useInput } from 'ink';
import type { ApprovalRequest } from '../../permissions/gate.ts';
import { parseMouse, wrapText } from '../layout.ts';
import { palette } from '../theme.ts';

/**
 * The one screen where Polaris asks instead of acting. It is deliberately
 * compact — a card, not a modal takeover — but it never abbreviates the thing
 * being approved: the whole command, the real path, the actual diff.
 *
 * Keys follow one rule: nothing approves by accident. Enter and `y` allow;
 * `d`, `n` and Esc deny; anything else is ignored rather than guessed at.
 */
export function Approval({
  request,
  width,
  maxDiffRows,
  onDecide,
  onCancelTurn,
}: {
  request: ApprovalRequest;
  width: number;
  maxDiffRows: number;
  onDecide: (decision: 'allow' | 'deny') => void;
  /** Ctrl+C: deny this and stop the whole turn, never approve anything. */
  onCancelTurn: () => void;
}) {
  useInput((input, key) => {
    if (parseMouse(input).isMouse) return;
    if (key.ctrl && input.toLowerCase() === 'c') return onCancelTurn();
    if (key.return || input.toLowerCase() === 'y') return onDecide('allow');
    if (key.escape || ['d', 'n'].includes(input.toLowerCase())) return onDecide('deny');
  });

  const inner = Math.max(20, width - 4);
  const target = wrapText(request.target, inner).slice(0, 3);
  const diffRows = request.diff ? request.diff.split('\n').slice(0, maxDiffRows) : [];

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={palette.warning}
      backgroundColor={palette.panel}
      paddingX={1}
    >
      <Box>
        <Text color={palette.warning} bold>
          Permission required
        </Text>
        <Box flexGrow={1} />
        <Text color={palette.subtle}>enter allow · d deny</Text>
      </Box>

      <Box marginTop={1}>
        <Text color={palette.text} bold>
          {request.title}
        </Text>
      </Box>
      {target.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: wrapped rows of one string
        <Text key={`t${index}`} color={palette.accent}>
          {line}
        </Text>
      ))}

      {/* Why a person is being asked at all: the boundary this crosses. */}
      {request.reason ? (
        <Box>
          <Text color={request.high ? palette.error : palette.warning}>
            {request.high ? 'High risk: ' : 'Reason: '}
          </Text>
          <Text color={palette.text} wrap="truncate-end">
            {request.reason}
          </Text>
        </Box>
      ) : null}
      {(request.facts ?? []).map((fact) => (
        <Text key={fact} color={palette.muted} wrap="truncate-end">
          {fact}
        </Text>
      ))}

      {diffRows.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {diffRows.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional diff rows
            <Text key={`d${index}`} color={diffColor(line)} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={palette.success}>enter</Text>
        <Text color={palette.muted}>{'  Allow once'}</Text>
        <Box flexGrow={1} />
        <Text color={palette.error}>d</Text>
        <Text color={palette.muted}>{'  Deny'}</Text>
      </Box>
    </Box>
  );
}

function diffColor(line: string): string {
  if (line.startsWith('+')) return palette.success;
  if (line.startsWith('-')) return palette.error;
  if (line.startsWith('@@') || line.startsWith('…')) return palette.secondary;
  return palette.muted;
}
