import { render } from 'ink';
import { Component, type ReactNode } from 'react';
import { createRegistry } from '../../cli/commands/builtin.ts';
import { CommandRegistry } from '../../cli/commands/registry.ts';
import { loadHistory, saveHistory } from '../../config/history.ts';
import type { PolarisApp } from '../../core/app.ts';
import { restoreTerminal } from '../terminal.ts';
import { App } from './App.tsx';

/**
 * Mouse reporting: 1000 reports button presses (the wheel is buttons 64/65),
 * 1006 encodes them as SGR text. While it is on, most terminals only select
 * text with Shift held — the price of a scrollable full-screen app.
 */
const MOUSE_ON = '\u001b[?1000h\u001b[?1006h';

/**
 * A render error must not leave an unusable screen: the boundary hands it to
 * `runTui`, which unmounts, restores the terminal and rethrows it to the crash
 * handler — which says what happened and where the log is.
 */
class ErrorBoundary extends Component<
  { onError: (error: unknown) => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Runs the full-screen UI. Ink owns the alternate screen, raw mode and the
 * cursor, and restores them on unmount; the rest — mouse reporting, and every
 * exit Ink does not see — is restored by `restoreTerminal`.
 */
export async function runTui(app: PolarisApp): Promise<void> {
  const registry = createRegistry(new CommandRegistry());
  const history = await loadHistory();
  let failure: unknown = null;
  const instance = render(
    <ErrorBoundary
      onError={(error) => {
        failure = error;
        instance.unmount();
      }}
    >
      <App
        app={app}
        registry={registry}
        history={history}
        onHistory={(next) => void saveHistory(next)}
      />
    </ErrorBoundary>,
    {
      alternateScreen: true,
      // Ctrl+C is Polaris's to interpret: it cancels a turn before it exits.
      exitOnCtrlC: false,
      // Caps repaints during a fast stream without touching the text itself.
      maxFps: 30,
    },
  );

  process.stdout.write(MOUSE_ON);
  process.once('exit', restoreTerminal);

  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
    restoreTerminal();
    process.off('exit', restoreTerminal);
  }
  if (failure) throw failure;
}
