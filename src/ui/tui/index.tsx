import { render } from 'ink';
import { createRegistry } from '../../cli/commands/builtin.ts';
import { CommandRegistry } from '../../cli/commands/registry.ts';
import { loadHistory, saveHistory } from '../../config/history.ts';
import type { PolarisApp } from '../../core/app.ts';
import { App } from './App.tsx';

/**
 * Mouse reporting: 1000 reports button presses (the wheel is buttons 64/65),
 * 1006 encodes them as SGR text. While it is on, most terminals only select
 * text with Shift held — the price of a scrollable full-screen app.
 */
const MOUSE_ON = '[?1000h[?1006h';
const MOUSE_OFF = '[?1000l[?1006l';

/**
 * Runs the full-screen UI. Ink owns the alternate screen, raw mode and the
 * cursor, and restores them on unmount; mouse reporting is switched off on
 * every way out — normal exit, an exception, or the process exiting.
 */
export async function runTui(app: PolarisApp): Promise<void> {
  const registry = createRegistry(new CommandRegistry());
  const history = await loadHistory();
  const instance = render(
    <App
      app={app}
      registry={registry}
      history={history}
      onHistory={(next) => void saveHistory(next)}
    />,
    {
      alternateScreen: true,
      // Ctrl+C is Polaris's to interpret: it cancels a turn before it exits.
      exitOnCtrlC: false,
      // Caps repaints during a fast stream without touching the text itself.
      maxFps: 30,
    },
  );

  const disableMouse = () => process.stdout.write(MOUSE_OFF);
  process.stdout.write(MOUSE_ON);
  process.once('exit', disableMouse);

  try {
    await instance.waitUntilExit();
  } finally {
    disableMouse();
    process.off('exit', disableMouse);
    instance.unmount();
  }
}
