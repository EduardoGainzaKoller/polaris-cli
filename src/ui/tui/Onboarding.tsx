import { Box, render, Text } from 'ink';
import { type OnboardingPlan, PREVIEW_NOTICE } from '../../cli/onboarding.ts';
import type { ProviderCheck } from '../../providers/detect.ts';
import { VERSION } from '../../version.ts';
import { palette } from '../theme.ts';
import { Selector } from './Selector.tsx';

const MARK: Record<ProviderCheck['status'], string> = {
  available: '✓',
  unknown: '?',
  'not-authenticated': '○',
  'not-configured': '○',
  'not-installed': '○',
};

export function Onboarding({
  checks,
  plan,
  onDone,
}: {
  checks: readonly ProviderCheck[];
  plan: OnboardingPlan;
  onDone: (provider: string | null) => void;
}) {
  const width = Math.min(80, Math.max(40, (process.stdout.columns || 80) - 4));
  const labels = plan.options.map((option) => option.label);
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color={palette.accent} bold>
        {`✦ POLARIS ${VERSION} — Developer Preview`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {PREVIEW_NOTICE.map((line) => (
          <Text
            key={line || 'blank'}
            color={line.includes('Developer Preview') ? palette.warning : palette.text}
          >
            {line || ' '}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={palette.muted}>Detected providers</Text>
        {checks.map((check) => (
          <Text key={check.id}>
            <Text color={check.status === 'available' ? palette.success : palette.muted}>
              {`  ${MARK[check.status]} ${check.label.padEnd(15)}`}
            </Text>
            <Text color={palette.subtle}>{check.detail}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Selector
          title="Choose a provider (you can change it any time with /provider)"
          options={labels}
          current={null}
          width={width}
          height={Math.min(labels.length, 6)}
          onChoose={(label) =>
            onDone(plan.options.find((option) => option.label === label)?.id ?? null)
          }
          onCancel={() => onDone(null)}
        />
      </Box>
    </Box>
  );
}

/** Shows the first-run screen and returns the chosen provider, or null if cancelled. */
export async function runOnboarding(
  checks: readonly ProviderCheck[],
  plan: OnboardingPlan,
): Promise<string | null> {
  let chosen: string | null = null;
  const instance = render(
    <Onboarding
      checks={checks}
      plan={plan}
      onDone={(provider) => {
        chosen = provider;
        instance.unmount();
      }}
    />,
    { exitOnCtrlC: true },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
  }
  return chosen;
}
