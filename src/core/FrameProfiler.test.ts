import { describe, expect, it } from 'vitest';
import { FRAME_BUDGET_MS, FrameProfiler } from './FrameProfiler';

// A controllable clock so frame timings are exact and deterministic (no real performance.now()).
function clock() {
  let t = 0;
  const fn = () => t;
  fn.set = (v: number) => { t = v; };
  fn.advance = (d: number) => { t += d; };
  return fn;
}

// The smoothed readouts are an EMA, so run the same frame many times until they converge before asserting.
function settle(build: () => FrameProfiler, run: (p: FrameProfiler) => void): FrameProfiler {
  const p = build();
  p.enabled = true;
  for (let i = 0; i < 200; i++) run(p);
  return p;
}

describe('FrameProfiler', () => {
  it('is inert until enabled — never reads the clock, reports nothing', () => {
    let reads = 0;
    const p = new FrameProfiler(() => { reads++; return 0; });
    p.frameStart(); p.mark('render'); p.frameEnd();
    expect(reads).toBe(0); // a disabled profiler must not even sample the clock
    expect(p.total()).toBe(0);
    expect(p.sample()).toEqual([]);
  });

  it('reports a section as its percentage of the 60fps budget', () => {
    const t = clock();
    const p = settle(() => new FrameProfiler(t), (prof) => {
      t.set(0); prof.frameStart(); prof.mark('render'); t.set(FRAME_BUDGET_MS); prof.frameEnd();
    });
    expect(p.total()).toBeCloseTo(100, 1);
    expect(p.sample().find((b) => b.name === 'render')?.pct).toBeCloseTo(100, 1);
  });

  it('splits time across buckets; the total is their sum', () => {
    const t = clock();
    const p = settle(() => new FrameProfiler(t), (prof) => {
      t.set(0); prof.frameStart();
      prof.mark('render'); t.advance(FRAME_BUDGET_MS / 2); // render = 50%
      prof.mark('ai'); t.advance(FRAME_BUDGET_MS / 4); // ai = 25%
      prof.frameEnd();
    });
    const rows = Object.fromEntries(p.sample().map((b) => [b.name, b.pct]));
    expect(rows.render).toBeCloseTo(50, 1);
    expect(rows.ai).toBeCloseTo(25, 1);
    expect(p.total()).toBeCloseTo(75, 1);
  });

  it('accumulates a bucket revisited within the same frame (sub-steps)', () => {
    const t = clock();
    const p = settle(() => new FrameProfiler(t), (prof) => {
      t.set(0); prof.frameStart();
      prof.mark('sim'); t.advance(FRAME_BUDGET_MS / 4);
      prof.mark('draw'); t.advance(0);
      prof.mark('sim'); t.advance(FRAME_BUDGET_MS / 4); // second sub-step re-enters sim → 50% total
      prof.frameEnd();
    });
    expect(p.sample().find((b) => b.name === 'sim')?.pct).toBeCloseTo(50, 1);
  });

  it('keeps sample() in stable first-seen order (never reshuffles by size)', () => {
    const t = clock();
    const p = new FrameProfiler(t);
    p.enabled = true;
    t.set(0); p.frameStart();
    p.mark('small'); t.advance(1);
    p.mark('big'); t.advance(10);
    p.frameEnd();
    expect(p.sample().map((b) => b.name)).toEqual(['small', 'big']); // insertion order, not cost order
  });

  it('breakdown() ranks by cost, largest first', () => {
    const t = clock();
    const p = settle(() => new FrameProfiler(t), (prof) => {
      t.set(0); prof.frameStart();
      prof.mark('small'); t.advance(FRAME_BUDGET_MS * 0.1);
      prof.mark('big'); t.advance(FRAME_BUDGET_MS);
      prof.frameEnd();
    });
    expect(p.breakdown().map((b) => b.name)).toEqual(['big', 'small']);
  });

  it('a bucket that goes idle decays out of breakdown() but stays in sample() at 0%', () => {
    const t = clock();
    const p = new FrameProfiler(t);
    p.enabled = true;
    for (let i = 0; i < 50; i++) { t.set(0); p.frameStart(); p.mark('traffic'); t.set(FRAME_BUDGET_MS); p.frameEnd(); }
    expect(p.breakdown().some((b) => b.name === 'traffic')).toBe(true);
    for (let i = 0; i < 200; i++) { t.set(0); p.frameStart(); p.mark('render'); t.set(FRAME_BUDGET_MS); p.frameEnd(); }
    expect(p.breakdown().some((b) => b.name === 'traffic')).toBe(false); // EMA fell below the display threshold
    expect(p.sample().find((b) => b.name === 'traffic')?.pct).toBe(0); // still tracked for a stable stacking order
  });
});
