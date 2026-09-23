import { useEffect, useState } from 'react';

/**
 * The current time, refreshed once a second while `active` — one timer for
 * the whole UI, however many activities are live. It only drives repaints of
 * clocks and "last activity" ages; it never counts as activity itself.
 */
export function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? Math.max(now, Date.now()) : now;
}
