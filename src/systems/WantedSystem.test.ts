import { describe, expect, it } from 'vitest';
import { WantedSystem } from './WantedSystem';

describe('WantedSystem', () => {
  it('raises heat through multiple wanted levels', () => {
    const wanted = new WantedSystem();
    wanted.addCrime(21);
    expect(wanted.level).toBe(2);
    wanted.setMinimumLevel(4);
    expect(wanted.level).toBe(4);
  });

  it('holds heat while seen and cools after a grace period', () => {
    const wanted = new WantedSystem();
    wanted.addCrime(35);
    wanted.reportSeen(); wanted.update(30);
    expect(wanted.level).toBe(2);
    for (let i = 0; i < 30; i++) wanted.update(1);
    expect(wanted.level).toBeLessThan(2);
  });
});
