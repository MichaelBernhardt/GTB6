import { describe, expect, it } from 'vitest';
import { easeProgress, HOLDBACK, isStalled, STALL_AFTER_MS, workingDots } from './BootProgress';

describe('easeProgress', () => {
  it('moves toward the target but never reaches it before the next real checkpoint', () => {
    let display = 10;
    for (let i = 0; i < 200; i++) display = easeProgress(display, 40, 120);
    expect(display).toBeGreaterThan(35);
    expect(display).toBeLessThanOrEqual(40 - HOLDBACK);
  });
  it('is monotonic even if the target sits below the display', () => {
    expect(easeProgress(50, 40, 120)).toBe(50); // never walk the bar backwards
  });
  it('a new checkpoint unfreezes a plateaued bar', () => {
    let display = 10;
    for (let i = 0; i < 500; i++) display = easeProgress(display, 40, 120);
    const plateau = display;
    const moved = easeProgress(plateau, 60, 120);
    expect(moved).toBeGreaterThan(plateau + 1);
  });
  it('snaps to exactly 100 at the end', () => {
    expect(easeProgress(97, 100, 120)).toBe(100);
  });
  it('advances more per step when the gap is larger, never past the holdback', () => {
    const small = easeProgress(30, 32, 120) - 30;
    const large = easeProgress(30, 70, 120) - 30;
    expect(large).toBeGreaterThan(small);
    expect(easeProgress(30, 32, 1e9)).toBe(32 - HOLDBACK);
  });
});

describe('isStalled', () => {
  it('trips only after the threshold of no real progress', () => {
    expect(isStalled(7999, 0)).toBe(false);
    expect(isStalled(STALL_AFTER_MS, 0)).toBe(true);
    expect(isStalled(20_000, 15_000)).toBe(false); // a fresh checkpoint resets the clock
  });
});

describe('workingDots', () => {
  it('cycles 1..3 dots over time', () => {
    expect(workingDots(0)).toBe('.');
    expect(workingDots(450)).toBe('..');
    expect(workingDots(900)).toBe('...');
    expect(workingDots(1350)).toBe('.');
  });
});
