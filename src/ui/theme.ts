import { styleText } from 'node:util';

const enabled =
  !process.env.NO_COLOR && process.stdout.isTTY === true && process.env.TERM !== 'dumb';

type Style = Parameters<typeof styleText>[0];

const paint =
  (style: Style) =>
  (text: string): string =>
    enabled ? styleText(style, text) : text;

/**
 * The full-screen UI's palette — "polar night": a dark canvas, slightly lifted
 * panels for the things you interact with, one cold accent and a lilac for
 * model details. Colour lives here and nowhere else. Hex values are downsampled
 * by the terminal library on terminals without truecolor.
 */
export const palette = {
  background: '#0b0e14',
  panel: '#141923',
  element: '#1e2532',
  border: '#2a3242',
  text: '#e4e8ef',
  muted: '#7d8698',
  subtle: '#4a5263',
  accent: '#7fb4ff',
  secondary: '#c3a6ff',
  success: '#7fd88f',
  warning: '#f2c36b',
  error: '#f07178',
} as const;

/** Plain-text styling for the line renderer used when output is piped. */
export const theme = {
  accent: paint('cyan'),
  dim: paint('dim'),
  bold: paint('bold'),
  error: paint('red'),
  warn: paint('yellow'),
  ok: paint('green'),
};
