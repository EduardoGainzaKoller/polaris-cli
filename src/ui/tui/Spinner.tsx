import { useEffect, useState } from 'react';

/**
 * Braille frames render in Windows Terminal and every common macOS/Linux font;
 * the legacy Windows console (no WT_SESSION) gets plain ASCII instead.
 */
const FRAMES =
  process.platform === 'win32' && !process.env.WT_SESSION
    ? ['|', '/', '-', '\\']
    : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * The current spinner frame while `active`, a static frame otherwise. The timer
 * only runs while something is actually happening, so an idle Polaris never
 * repaints.
 */
export function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % FRAMES.length), 90);
    return () => clearInterval(timer);
  }, [active]);
  return FRAMES[frame % FRAMES.length] as string;
}
