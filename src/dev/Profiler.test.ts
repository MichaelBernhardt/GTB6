import { describe, expect, it } from 'vitest';
import { quantile, summarizeFrameSamples, type FrameSample } from './Profiler';

function sample(frame: number, dt: number): FrameSample {
  return {
    frame,
    rafTimestamp: frame * 16.7,
    dt,
    calls: 100 + frame,
    tris: 10_000,
    heap: 20 * 1048576,
    buckets: { gameUpdate: frame + 1, population: 0.25, render: 4 },
  };
}

describe('Gauntlet profiler receipts', () => {
  it('uses nearest-rank p95/p99 and retains the worst native frame', () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(quantile(sorted, 0.95)).toBe(95);
    expect(quantile(sorted, 0.99)).toBe(99);
    expect(quantile(sorted, 1)).toBe(100);
  });

  it('labels subsystem buckets as exclusive and reports p99 plus >50 ms frames', () => {
    const samples = [sample(0, 16), sample(1, 17), sample(2, 51), sample(3, 90)];
    const summary = summarizeFrameSamples(samples) as {
      dtMs: { p99: number; max: number; over50: number };
      cpu: { semantics: string; buckets: Record<string, { exclusive: boolean }> };
    };
    expect(summary.dtMs).toMatchObject({ p99: 90, max: 90, over50: 2 });
    expect(summary.cpu.semantics).toContain('exclusive');
    expect(summary.cpu.buckets.gameUpdate?.exclusive).toBe(true);
    expect(summary.cpu.buckets.render?.exclusive).toBe(true);
  });
});
