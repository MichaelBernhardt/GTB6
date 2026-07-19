/** Pure loading-bar model: honest smoothing between real checkpoints, and a stall detector.
 *  The display value eases toward the latest REAL checkpoint but never arrives — the last
 *  half-percent is only crossed by the next real signal, so the bar can slow to a crawl but
 *  can never lie its way past work that hasn't happened. */

export const STALL_AFTER_MS = 8000;
/** The eased bar stops this far short of the real target until the next checkpoint lands. */
export const HOLDBACK = 0.5;

/** One smoothing step: move `display` toward `target` with time constant `tauMs`.
 *  Monotonic (never decreases) and capped at `target - HOLDBACK`; 100 snaps exactly. */
export function easeProgress(display: number, target: number, dtMs: number, tauMs = 1600): number {
  if (target >= 100) return 100;
  const eased = display + (target - display) * (1 - Math.exp(-Math.max(dtMs, 0) / tauMs));
  return Math.max(display, Math.min(eased, Math.max(display, target - HOLDBACK)));
}

/** No real checkpoint for STALL_AFTER_MS: show a "still working" state instead of advancing. */
export function isStalled(nowMs: number, lastRealProgressMs: number, thresholdMs = STALL_AFTER_MS): boolean {
  return nowMs - lastRealProgressMs >= thresholdMs;
}

/** Animated ellipsis for the stalled state — time-driven so it visibly ticks while the bar holds. */
export function workingDots(nowMs: number, periodMs = 450): string {
  return '.'.repeat(1 + (Math.floor(nowMs / periodMs) % 3));
}
