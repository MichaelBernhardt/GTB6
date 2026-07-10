import { describe, expect, it } from 'vitest';
import { LoadSheddingSystem } from './LoadSheddingSystem';

describe('LoadSheddingSystem', () => {
  it('starts an outage after the initial delay and later restores power', () => {
    const system = new LoadSheddingSystem(10);
    expect(system.update(9)).toBeUndefined();
    expect(system.active).toBe(false);
    expect(system.update(2)).toBe('start');
    expect(system.active).toBe(true);
    let event: string | undefined;
    for (let i = 0; i < 60 && !event; i++) event = system.update(1);
    expect(event).toBe('end');
    expect(system.active).toBe(false);
  });

  it('cycles outages indefinitely like the real thing', () => {
    const system = new LoadSheddingSystem(1);
    const events: string[] = [];
    for (let i = 0; i < 600; i++) { const event = system.update(1); if (event) events.push(event); }
    expect(events[0]).toBe('start');
    expect(events.filter((event) => event === 'start').length).toBeGreaterThanOrEqual(2);
  });
});
