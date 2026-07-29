import { describe, expect, it } from 'vitest';
import { LoadSheddingSystem, OUTAGE_JITTER_SECONDS, OUTAGE_MIN_SECONDS } from './LoadSheddingSystem';

describe('LoadSheddingSystem', () => {
  it('starts an outage after the initial delay and later restores power', () => {
    const system = new LoadSheddingSystem(10);
    expect(system.update(9)).toBeUndefined();
    expect(system.active).toBe(false);
    expect(system.update(2)).toBe('start');
    expect(system.active).toBe(true);
    let elapsed = 0;
    let event: string | undefined;
    for (let i = 0; i < 120 && !event; i++) { event = system.update(1); elapsed += 1; }
    expect(event).toBe('end');
    expect(elapsed).toBeGreaterThanOrEqual(OUTAGE_MIN_SECONDS);
    expect(elapsed).toBeLessThanOrEqual(OUTAGE_MIN_SECONDS + OUTAGE_JITTER_SECONDS + 1);
    expect(system.active).toBe(false);
  });

  it('cycles outages indefinitely like the real thing', () => {
    const system = new LoadSheddingSystem(1);
    const events: string[] = [];
    for (let i = 0; i < 600; i++) { const event = system.update(1); if (event) events.push(event); }
    expect(events[0]).toBe('start');
    expect(events.filter((event) => event === 'start').length).toBeGreaterThanOrEqual(2);
  });

  it('can guarantee a fair remaining window without starting the grid event itself', () => {
    const waiting = new LoadSheddingSystem(10);
    expect(waiting.guaranteeActiveWindow(200)).toBe(false);
    expect(waiting.update(9)).toBeUndefined(); // inactive schedule was untouched

    const active = new LoadSheddingSystem(1);
    expect(active.update(2)).toBe('start');
    expect(active.guaranteeActiveWindow(200)).toBe(true);
    expect(active.update(199)).toBeUndefined();
    expect(active.update(2)).toBe('end');
  });
});
