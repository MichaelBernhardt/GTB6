import { describe, expect, it } from 'vitest';
import { ASSAULT_BUMP_COUNT, BUMP_PUSH_PED, BUMP_PUSH_PLAYER, BUMP_RADIUS, BUMP_WINDOW, bumpEscalates, KNOCKDOWN_DAMAGE, KNOCKDOWN_DURATION, knockdownOutcome, recordBump, separationPush } from './BumpSystem';

describe('BumpSystem bump window', () => {
  it('counts repeated bumps inside the window', () => {
    const times: number[] = [];
    expect(recordBump(times, 0)).toBe(1);
    expect(recordBump(times, 2)).toBe(2);
    expect(recordBump(times, 4)).toBe(3);
  });

  it('expires bumps older than the window', () => {
    const times: number[] = [];
    recordBump(times, 0);
    expect(recordBump(times, BUMP_WINDOW + 0.1)).toBe(1);
    expect(times).toEqual([BUMP_WINDOW + 0.1]);
  });

  it('keeps a bump landed exactly at the window edge out of the count', () => {
    const times: number[] = [];
    recordBump(times, 0); recordBump(times, 5.9);
    expect(recordBump(times, BUMP_WINDOW)).toBe(2); // the t=0 bump has aged out, the 5.9 one has not
  });

  it('treats the first bump as an accident and repeats as an attack', () => {
    expect(bumpEscalates(1)).toBe(false);
    expect(bumpEscalates(ASSAULT_BUMP_COUNT)).toBe(true);
    expect(bumpEscalates(ASSAULT_BUMP_COUNT + 1)).toBe(true);
  });

  it('escalates a knockdown immediately, even on the first bump', () => {
    expect(bumpEscalates(1, true)).toBe(true);
  });
});

describe('BumpSystem knockdown thresholds', () => {
  it('floors a healthy ped briefly and costs the knockdown damage', () => {
    const outcome = knockdownOutcome(60);
    expect(outcome).toEqual({ health: 60 - KNOCKDOWN_DAMAGE, killed: false, downTime: KNOCKDOWN_DURATION });
  });

  it('kills when health is depleted, with no recovery timer', () => {
    expect(knockdownOutcome(KNOCKDOWN_DAMAGE)).toEqual({ health: 0, killed: true, downTime: 0 });
    expect(knockdownOutcome(3)).toEqual({ health: 0, killed: true, downTime: 0 });
  });

  it('never leaves health negative', () => {
    expect(knockdownOutcome(1).health).toBe(0);
  });
});

describe('BumpSystem separation push', () => {
  it('splits the overlap with the ped taking the larger share', () => {
    const push = separationPush(BUMP_RADIUS * 0.5);
    const overlap = BUMP_RADIUS * 0.5;
    expect(push.ped).toBeCloseTo(overlap * BUMP_PUSH_PED);
    expect(push.player).toBeCloseTo(overlap * BUMP_PUSH_PLAYER);
    expect(push.ped).toBeGreaterThan(push.player);
  });

  it('pushes nobody once the pair is separated', () => {
    expect(separationPush(BUMP_RADIUS)).toEqual({ ped: 0, player: 0 });
    expect(separationPush(BUMP_RADIUS + 1)).toEqual({ ped: 0, player: 0 });
  });
});
