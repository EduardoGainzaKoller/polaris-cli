import { Box, Text } from 'ink';
import { VERSION } from '../../version.ts';
import { LOGO, LOGO_WIDTH } from '../layout.ts';
import { palette } from '../theme.ts';

const TIPS: ReadonlyArray<readonly [string, string]> = [
  ['/help', 'every command'],
  ['/provider', 'switch provider'],
  ['/model', 'switch model'],
  ['/permissions', 'what Polaris may change'],
];

/** The empty-session screen: the wordmark, and just enough to get going. */
export function Home({ width, permissions }: { width: number; permissions: string }) {
  const fits = width >= LOGO_WIDTH + 4;
  return (
    <Box flexDirection="column" alignItems="center">
      {fits ? (
        LOGO.map(([polar, is]) => (
          <Text key={polar + is}>
            <Text color={palette.text}>{polar}</Text>
            <Text color={palette.accent}>{is}</Text>
          </Text>
        ))
      ) : (
        <Text color={palette.accent} bold>
          ✦ polaris
        </Text>
      )}
      <Text color={palette.subtle}>{`v${VERSION} · permissions: ${permissions}`}</Text>
      <Box flexDirection="column" marginTop={1}>
        {TIPS.map(([command, description]) => (
          <Text key={command}>
            <Text color={palette.accent}>{command.padEnd(14)}</Text>
            <Text color={palette.muted}>{description}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
