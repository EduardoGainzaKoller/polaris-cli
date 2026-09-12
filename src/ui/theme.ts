import { styleText } from 'node:util';

const enabled =
  !process.env.NO_COLOR && process.stdout.isTTY === true && process.env.TERM !== 'dumb';

type Style = Parameters<typeof styleText>[0];

const paint =
  (style: Style) =>
  (text: string): string =>
    enabled ? styleText(style, text) : text;

export const theme = {
  accent: paint('cyan'),
  dim: paint('dim'),
  bold: paint('bold'),
  error: paint('red'),
  warn: paint('yellow'),
  ok: paint('green'),
};
