import { render } from 'ink';
import { createRegistry } from '../../cli/commands/builtin.ts';
import { CommandRegistry } from '../../cli/commands/registry.ts';
import type { PolarisApp } from '../../core/app.ts';
import { App } from './App.tsx';

/**
 * Runs the full-screen UI. Ink owns the alternate screen, raw mode and the
 * cursor, and restores all three on unmount — including after a crash — so the
 * shell is left exactly as it was found.
 */
export async function runTui(app: PolarisApp): Promise<void> {
  const registry = createRegistry(new CommandRegistry());
  const instance = render(<App app={app} registry={registry} />, {
    alternateScreen: true,
    // Ctrl+C is Polaris's to interpret: it cancels a turn before it exits.
    exitOnCtrlC: false,
    // Caps repaints during a fast stream without touching the text itself.
    maxFps: 30,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
  }
}
