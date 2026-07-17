import { describe, expect, it } from 'vitest';
import { LoadSheddingSystem } from './LoadSheddingSystem';

/** The Couch Run beat forces an outage via the same force() the console cheat uses. The world
 *  must come out of it exactly as from a natural event: the outage self-ends on the natural
 *  cadence, the next outage is scheduled on the natural cadence, and nothing sticks dark. */
describe('scripted load-shedding (mission beats)', () => {
  it('a forced outage runs the natural duration then restores on its own', () => {
    const grid = new LoadSheddingSystem();
    expect(grid.force()).toBe('start');
    expect(grid.active).toBe(true);
    let elapsed = 0; let event: 'start' | 'end' | undefined;
    while (elapsed < 60 && !event) { event = grid.update(1); elapsed += 1; }
    expect(event).toBe('end'); // outage self-terminated
    expect(grid.active).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(32); // natural outage window [32, 44]
    expect(elapsed).toBeLessThanOrEqual(45);
  });

  it('after a forced outage the next natural outage still arrives on the normal schedule', () => {
    const grid = new LoadSheddingSystem();
    grid.force();
    while (grid.active) grid.update(1); // let the forced outage end naturally
    let elapsed = 0; let event: 'start' | 'end' | undefined;
    while (elapsed < 240 && !event) { event = grid.update(1); elapsed += 1; }
    expect(event).toBe('start'); // the schedule kept running — no dead grid, no stuck darkness
    expect(elapsed).toBeGreaterThanOrEqual(130); // natural gap window [130, 190]
    expect(elapsed).toBeLessThanOrEqual(191);
  });

  it('forcing during an outage ends it and reschedules naturally (no double-flip weirdness)', () => {
    const grid = new LoadSheddingSystem();
    grid.force();
    expect(grid.force()).toBe('end');
    expect(grid.active).toBe(false);
    let elapsed = 0; let event: 'start' | 'end' | undefined;
    while (elapsed < 240 && !event) { event = grid.update(1); elapsed += 1; }
    expect(event).toBe('start');
  });
});
