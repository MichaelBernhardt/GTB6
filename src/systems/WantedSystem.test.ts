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

describe('WantedSystem teflon cheat', () => {
  it('blocks every heat-gaining path', () => {
    const wanted = new WantedSystem();
    wanted.teflon = true;
    wanted.addCrime(1); // a witnessed mugging
    wanted.addCrime(30); // gunfire / carjacking / attacking police — same funnel
    wanted.addCrime(100); // a matured 911 report landing all at once
    wanted.setMinimumLevel(5); // mission-forced stars
    wanted.reportSeen(); // an officer with eyes on you still earns nothing
    expect(wanted.heat).toBe(0);
    expect(wanted.level).toBe(0);
    expect(wanted.isWanted).toBe(false);
  });

  it('clears the heat you already had when it switches on', () => {
    const wanted = new WantedSystem();
    wanted.addCrime(80);
    expect(wanted.level).toBe(4);
    wanted.teflon = true;
    expect(wanted.heat).toBe(0);
    expect(wanted.unseenTime).toBe(0);
    expect(wanted.isWanted).toBe(false);
  });

  it('re-asserting the same value never re-clears heat', () => {
    const wanted = new WantedSystem();
    wanted.teflon = false; // every restore path pushes the saved flag in, on or off
    wanted.addCrime(40);
    wanted.teflon = false;
    expect(wanted.level).toBe(2); // an off-to-off push must not wipe a live pursuit
    wanted.teflon = true; wanted.teflon = true;
    expect(wanted.heat).toBe(0);
  });

  it('lets heat rise again once switched off', () => {
    const wanted = new WantedSystem();
    wanted.teflon = true;
    wanted.addCrime(45);
    expect(wanted.level).toBe(0);
    wanted.teflon = false;
    expect(wanted.heat).toBe(0); // switching off grants nothing retroactively
    wanted.addCrime(45);
    expect(wanted.level).toBe(3);
    wanted.setMinimumLevel(5);
    expect(wanted.level).toBe(5);
  });

  it('still cools normally when set (heat can only ever fall)', () => {
    const wanted = new WantedSystem();
    wanted.addCrime(35);
    wanted.teflon = true;
    for (let i = 0; i < 30; i++) wanted.update(1);
    expect(wanted.heat).toBe(0);
  });
});
