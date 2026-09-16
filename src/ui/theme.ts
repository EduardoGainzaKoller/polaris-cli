import { styleText } from 'node:util';

const enabled =
  !process.env.NO_COLOR && process.stdout.isTTY === true && process.env.TERM !== 'dumb';

type Style = Parameters<typeof styleText>[0];

const paint =
  (style: Style) =>
  (text: string): string =>
    enabled ? styleText(style, text) : text;

/**
 * Colour lives here and nowhere else. The palette is deliberately small and
 * sober: one accent, muted for everything secondary, red only for errors. No
 * background is painted, so Polaris keeps the terminal's own look and stays
 * readable on light themes and on terminals without truecolor.
 */
export const colors = {
  accent: 'cyan',
  user: 'green',
  assistant: 'cyan',
  muted: 'gray',
  error: 'red',
  border: 'gray',
} as const;

export const theme = {
  accent: paint(colors.accent),
  dim: paint('dim'),
  bold: paint('bold'),
  error: paint(colors.error),
  warn: paint('yellow'),
  ok: paint('green'),
};
