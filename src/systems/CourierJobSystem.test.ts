import { describe, expect, it } from 'vitest';
import { COURIER_ORDERS, courierBasePay, courierHudText, courierOrder, courierTimeLimit, CourierJob } from './CourierJobSystem';

const delivering = (distance = 340): CourierJob => { const job = new CourierJob(); job.clockIn(); job.collect(distance); return job; };

describe('Sixty-Sekonds courier shift', () => {
  it('loops depot collection into a timed delivery and back to collection', () => {
    const job = new CourierJob();
    expect(job.clockIn()).toBe(true); expect(job.phase).toBe('collecting');
    expect(job.collect(340)).toBe(true); expect(job.phase).toBe('delivering');
    expect(job.basePay).toBe(courierBasePay(340)); expect(job.timeLeft).toBe(courierTimeLimit(340));
    const base = job.basePay; expect(job.deliver()?.total).toBeGreaterThan(base);
    expect(job.phase).toBe('collecting'); expect(job.completed).toBe(1);
  });

  it('pays for distance without allowing negative routes to reduce the flag pay', () => {
    expect(courierBasePay(-100)).toBe(courierBasePay(0));
    expect(courierBasePay(500)).toBeGreaterThan(courierBasePay(100));
    expect(courierTimeLimit(600)).toBeGreaterThan(courierTimeLimit(100));
  });

  it('damages only an active basket and clamps the groceries at zero percent', () => {
    const idle = new CourierJob(); expect(idle.recordCrash(50)).toBe(0); expect(idle.condition).toBe(100);
    const job = delivering(); expect(job.recordCrash(10)).toBeGreaterThan(0); expect(job.condition).toBeLessThan(100);
    job.recordCrash(999); expect(job.condition).toBe(0);
  });

  it('announces lateness once, removes the time bonus and breaks the streak', () => {
    const job = delivering(); job.streak = 3;
    expect(job.update(job.timeLeft - 0.1)).toBe(false);
    expect(job.update(1)).toBe(true); expect(job.update(1)).toBe(false);
    const pay = job.deliver(); expect(pay?.late).toBe(true); expect(pay?.timeBonus).toBe(0); expect(pay?.streak).toBe(0);
  });

  it('grows a clean-delivery streak but breaks it for scrambled groceries', () => {
    const job = delivering(); const first = job.deliver(); expect(first?.streak).toBe(1); expect(first?.streakBonus).toBeGreaterThan(0);
    job.collect(300); const second = job.deliver(); expect(second?.streak).toBe(2); expect(second!.streakBonus).toBeGreaterThan(first!.streakBonus);
    job.collect(300); job.recordCrash(30); const scrambled = job.deliver(); expect(scrambled?.condition).toBeLessThan(70); expect(scrambled?.streak).toBe(0);
  });

  it('cycles the joke baskets and exposes useful HUD text', () => {
    expect(courierOrder(COURIER_ORDERS.length)).toEqual(courierOrder(0));
    const job = new CourierJob(); expect(courierHudText(job)).toContain('UNEMPLOYED');
    job.clockIn(); expect(courierHudText(job)).toContain('ORDER 1');
    job.collect(200); expect(courierHudText(job)).toMatch(/SEC · GROCERIES 100%/);
  });
});
