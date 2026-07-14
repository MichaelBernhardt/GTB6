/** Per-frame wall-clock breakdown of the game loop, expressed as a percentage of the 60fps frame budget.
 *
 *  100% means the loop spent exactly one 60fps frame's worth of CPU time (16.67ms); 50% leaves half the budget
 *  spare; 200% means the JS work alone cannot hit 60fps. The value is a diagnostic for *CPU* cost centres — it
 *  sums the time spent inside our own code, sliced into named buckets so an overspend can be traced to a system
 *  (traffic AI, combat, render submission, …) rather than guessed at.
 *
 *  Usage is a moving cursor, not nested spans: `mark('a')` opens bucket a, the next `mark('b')` closes a and
 *  opens b, and `frameEnd()` closes the last. This suits the loop's flat, sequential shape and keeps the
 *  instrumentation to one call per boundary. Sub-steps that run update() several times in a frame accumulate
 *  into the same buckets, so the reported time is the whole frame's simulation cost, not one step's.
 *
 *  Caveat: wrapping the renderer's draw call measures the CPU cost of *submitting* the frame, not the GPU's
 *  execution of it (that runs asynchronously). A total under 100% with a low frame rate therefore points at the
 *  GPU or vsync, not at this breakdown — whose value is isolating the JS-bound systems. */

/** One 60fps frame in milliseconds — the denominator that turns elapsed time into a "% of budget". */
export const FRAME_BUDGET_MS = 1000 / 60;

/** Smoothing factor for the per-bucket exponential moving average. Low enough to read steadily by eye while
 *  still tracking a genuine regression within a second or so. */
const SMOOTH = 0.1;

export interface ProfileBucket {
  name: string;
  pct: number; // smoothed percentage of the 60fps budget
}

export class FrameProfiler {
  /** When false every method is a no-op that never reads the clock: an unused profiler collects nothing and costs
   *  only a branch. The clock is read *inside* the guarded methods (not passed by the caller) precisely so a
   *  disabled profiler never even evaluates `performance.now()` at the instrumentation sites. */
  enabled = false;

  private readonly acc = new Map<string, number>(); // ms accumulated per bucket this frame
  private readonly smoothed = new Map<string, number>(); // EMA of each bucket's % of budget
  private readonly lastPct = new Map<string, number>(); // raw % of the last *completed* frame — feeds the graph
  private readonly order: string[] = []; // first-seen bucket order, kept stable so colours/stacking never jump
  private label = ''; // bucket the cursor is currently timing ('' = untimed)
  private cursor = 0; // clock reading at the last mark

  /** @param clock injectable time source (ms); defaults to performance.now(). Tests pass a controllable clock. */
  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Begin a frame: clear this frame's accumulators and start the cursor. Call once at the top of the loop. */
  frameStart(): void {
    if (!this.enabled) return;
    this.acc.clear();
    this.label = '';
    this.cursor = this.clock();
  }

  /** Close the section that was open and open a new one named `label`. Reads the clock once so the closed
   *  section's end and the new section's start share a single timestamp (no gap, no double count). */
  mark(label: string): void {
    if (!this.enabled) return;
    const now = this.clock();
    if (this.label) this.acc.set(this.label, (this.acc.get(this.label) ?? 0) + (now - this.cursor));
    if (label && !this.order.includes(label)) this.order.push(label);
    this.label = label;
    this.cursor = now;
  }

  /** Close the final open section, snapshot this frame's raw percentages, and fold them into the smoothed set. */
  frameEnd(): void {
    if (!this.enabled) return;
    this.mark(''); // close whatever was open
    this.lastPct.clear();
    for (const name of this.order) {
      const pct = ((this.acc.get(name) ?? 0) / FRAME_BUDGET_MS) * 100; // absent this frame → 0, decays the EMA down
      this.lastPct.set(name, pct);
      const prev = this.smoothed.get(name);
      this.smoothed.set(name, prev === undefined ? pct : prev + (pct - prev) * SMOOTH);
    }
  }

  /** The last completed frame's raw (unsmoothed) percentages, in stable first-seen order. This is what the
   *  scrolling graph plots — one column per frame — so spikes show as spikes rather than being averaged away.
   *  The order never reshuffles, which keeps each phase pinned to its colour and stack position across frames. */
  sample(): ProfileBucket[] {
    return this.order.map((name) => ({ name, pct: this.lastPct.get(name) ?? 0 }));
  }

  /** Buckets sorted by cost (largest first) so the current hotspot reads at the front. Drops buckets that have
   *  smoothed below a rounding threshold, so systems that went idle disappear rather than linger at "0%". */
  breakdown(): ProfileBucket[] {
    const rows: ProfileBucket[] = [];
    for (const name of this.order) {
      const pct = this.smoothed.get(name) ?? 0;
      if (pct >= 0.5) rows.push({ name, pct });
    }
    return rows.sort((a, b) => b.pct - a.pct);
  }

  /** Whole-loop cost as a percentage of the 60fps budget: the sum of every bucket. */
  total(): number {
    let sum = 0;
    for (const pct of this.smoothed.values()) sum += pct;
    return sum;
  }
}
