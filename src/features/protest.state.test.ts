import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertNotLivingHost, blockadeSize, closureRadius, crowdSize, defaultProtestSave, hourDelta,
  ignitableTargets, isLivingTarget, MAX_OUTAGE_CREDIT_HOURS, OutageLedger, outageLedger, picketPayout,
  POST_PICKET_HOURS, ProhibitedTyreHostError, RIPE_OUTAGE_HOURS, sanitizeProtestState, SCORCH_CAP,
  SECONDS_PER_GAME_HOUR, shutdownPending, tickOutage, TYRE_CARRY_CAP, tyreCount,
} from './protest.state';
import { FEATURES } from './registry';
import { DAY_CYCLE_SECONDS } from '../world/DayNight';
import { setPower } from '../world/powerGrid';

/**
 * THE NECKLACING BLOCK IS THE FIRST SUITE IN THIS FILE ON PURPOSE.
 *
 * Necklacing — a petrol-soaked tyre forced over a person's chest and arms and lit — was a real 1980s
 * South African township execution method that recurs in present-day vigilantism. The rule is that no
 * tyre in this game may take a person, a ragdoll or a corpse as its host and no ignition may resolve
 * onto one. A stated rule with no test is not a block, so this is the test.
 */
describe('necklacing block: nothing living may host a tyre or an ignition', () => {
  const pedestrian = () => ({ health: 60, state: 'idle', scripted: true, hailing: false, group: {}, takeDamage: () => false });
  const corpse = () => ({ health: 0, state: 'down', group: {}, takeDamage: () => true });

  it('refuses a live pedestrian', () => {
    expect(isLivingTarget(pedestrian())).toBe(true);
    expect(() => assertNotLivingHost(pedestrian(), 'test')).toThrow(ProhibitedTyreHostError);
  });

  it('refuses a corpse — a body that is down is still a body', () => {
    expect(isLivingTarget(corpse())).toBe(true);
    expect(() => assertNotLivingHost(corpse(), 'test')).toThrow(ProhibitedTyreHostError);
  });

  it('refuses a ragdoll bone and a skinned mesh handed over directly', () => {
    expect(isLivingTarget({ type: 'Bone', isBone: true })).toBe(true);
    expect(isLivingTarget({ type: 'SkinnedMesh', isSkinnedMesh: true, skeleton: {} })).toBe(true);
  });

  it('refuses a limb, which is how a ragdoll actually gets passed around', () => {
    const hand = { type: 'Object3D', parent: { type: 'Bone', parent: { type: 'Group', parent: null } } };
    expect(isLivingTarget(hand)).toBe(true);
    expect(() => assertNotLivingHost(hand, 'test')).toThrow(ProhibitedTyreHostError);
  });

  it('refuses a group that merely CONTAINS a skeleton', () => {
    const body = { type: 'Group', children: [{ type: 'Group', children: [{ type: 'SkinnedMesh', isSkinnedMesh: true }] }] };
    expect(isLivingTarget(body)).toBe(true);
  });

  it('refuses anything tagged as a ped in userData', () => {
    expect(isLivingTarget({ type: 'Group', userData: { ped: {} } })).toBe(true);
    expect(isLivingTarget({ type: 'Mesh', parent: { type: 'Group', userData: { ragdoll: true } } })).toBe(true);
  });

  it('still allows ordinary props, or the barricade could not be built at all', () => {
    expect(isLivingTarget({ type: 'Mesh', children: [], parent: null, userData: {} })).toBe(false);
    expect(isLivingTarget({ x: 12, z: -4, r: 2 })).toBe(false);
    expect(isLivingTarget(null)).toBe(false);
    expect(isLivingTarget('tyre')).toBe(false);
    expect(() => assertNotLivingHost({ kind: 'tyre' }, 'test')).not.toThrow();
  });

  it('filters people out of an ignition sweep without throwing away the props', () => {
    const prop = { type: 'Mesh', children: [], parent: null, userData: {} };
    const swept = ignitableTargets([prop, pedestrian(), corpse(), { type: 'Bone' }, prop]);
    expect(swept).toEqual([prop, prop]);
    expect(ignitableTargets([pedestrian()])).toHaveLength(0);
  });
});

describe('grievance ledger', () => {
  beforeEach(() => outageLedger.reset());

  it('credits nothing while the grid is up', () => {
    const ledger = new OutageLedger();
    ledger.tick(6, 0, 0, true);
    ledger.tick(6.4, 0, 0, true);
    expect(ledger.hours).toBe(0);
    expect(ledger.ripe).toBe(false);
  });

  it('credits outage hours the player stood through, and ripens at the threshold', () => {
    const ledger = new OutageLedger();
    ledger.tick(6, 10, 10, false); // first call only seeds the clock
    for (let step = 1; step <= 40; step++) ledger.tick(6 + step * 0.1, 10, 10, false);
    expect(ledger.hours).toBeCloseTo(4, 5);
    expect(ledger.ripe).toBe(true);
    expect(RIPE_OUTAGE_HOURS).toBeLessThan(4);
  });

  it('never dumps a day of grievance in one step, however the clock jumps', () => {
    const ledger = new OutageLedger();
    ledger.tick(1, 0, 0, false);
    ledger.tick(19, 0, 0, false); // `set timerate 500`, a long pause, a mission time-skip
    expect(ledger.hours).toBeLessThanOrEqual(0.5);
  });

  it('never runs backwards when the clock does', () => {
    const ledger = new OutageLedger();
    ledger.tick(9, 0, 0, false);
    ledger.tick(8.5, 0, 0, false);
    expect(ledger.hours).toBe(0);
  });

  it('wraps past midnight without losing the night', () => {
    const ledger = new OutageLedger();
    ledger.tick(23.9, 0, 0, false);
    ledger.tick(0.1, 0, 0, false);
    expect(ledger.hours).toBeCloseTo(0.2, 5);
  });

  it('anchors on where the player actually stood in the dark', () => {
    const ledger = new OutageLedger();
    ledger.tick(2, 400, -900, false);
    ledger.tick(2.2, 400, -900, false);
    for (let step = 1; step <= 20; step++) ledger.tick(2.2 + step * 0.1, 400, -900, false);
    expect(ledger.anchorX).toBeCloseTo(400, 0);
    expect(ledger.anchorZ).toBeCloseTo(-900, 0);
    expect(ledger.hasAnchor).toBe(true);
  });

  it('knocks the ledger back after a picket rather than zeroing it — a failed place gets quicker to close its road', () => {
    const ledger = new OutageLedger();
    ledger.hours = 12; ledger.hasAnchor = true;
    ledger.spend();
    expect(ledger.hours).toBe(POST_PICKET_HOURS);
    expect(ledger.ripe).toBe(false);
  });

  it('drives the shared ledger from the loaded body’s per-frame tick', () => {
    tickOutage(4, 5, 5);   // seeds
    tickOutage(4.2, 5, 5); // powerGrid starts powered, so nothing is credited
    expect(outageLedger.hours).toBe(0);
  });

  it('ripens on hours alone — the eager path cannot build an anchor, and does not need one', () => {
    const ledger = new OutageLedger();
    ledger.hours = RIPE_OUTAGE_HOURS;
    expect(ledger.hasAnchor).toBe(false);
    expect(ledger.ripe).toBe(true);
  });
});

/**
 * THE CROSS-FEATURE BUG THE VERIFIER FOUND, pinned so it cannot come back.
 *
 * The clock used to tick as a side effect inside the registry's `approach.near()` predicate, and
 * `resolveInteraction` returns on the FIRST descriptor that offers something. With any other feature
 * registered above protest's `order: 60`, the predicate never ran and the ledger never moved — 3.90
 * outage-hours measured out in the open street against 0.00 on a doorstep. It is this feature's only
 * unlock gate, so merged as-is it would simply never have triggered.
 */
describe('the grievance clock does not live in an interaction predicate', () => {
  beforeEach(() => { outageLedger.reset(); setPower(true); });

  it('the registry approach predicate is PURE — asking it a thousand times moves nothing', () => {
    const approach = FEATURES.find((feature) => feature.id === 'protest')?.approach;
    expect(approach).toBeDefined();
    const ctx = { context: 'foot' as const, position: { x: 5, y: 0, z: 5 } as never, vehicle: undefined, hour: 2 };
    setPower(false);
    for (let frame = 0; frame < 1000; frame++) approach!.near(ctx);
    expect(outageLedger.hours).toBe(0); // a predicate that credited would be at several hours by now
    expect(approach!.near(ctx)).toBe(false);
  });

  it('credits the outage from powerGrid’s own hook, which nothing can shadow', () => {
    // The listener is registered at module load; setPower is the exact call Game.applyEskom makes.
    setPower(false);
    expect(outageLedger.hours).toBe(0); // an outage is only worth something once it has been endured
    outageLedger.beginOutage(performance.now() - 38_000); // restamp: 38 s of shed, no CI wall-clock flake
    setPower(true);                                       // ...and let the real listener close it out
    expect(outageLedger.hours).toBeCloseTo(38 / SECONDS_PER_GAME_HOUR, 1);
  });

  it('converts a real outage into game hours at the day-cycle rate', () => {
    const ledger = new OutageLedger();
    ledger.beginOutage(0);
    ledger.endOutage(38_000); // 38 real seconds: the middle of LoadSheddingSystem's 32-44 s shed
    expect(ledger.hours).toBeCloseTo(38 / SECONDS_PER_GAME_HOUR, 6);
    expect(ledger.hours).toBeGreaterThan(1);
  });

  it('two sheds ripen it, which is the five minutes of play the design asks for', () => {
    const ledger = new OutageLedger();
    for (let shed = 0; shed < 2; shed++) { ledger.beginOutage(shed * 1e5); ledger.endOutage(shed * 1e5 + 38_000); }
    expect(ledger.ripe).toBe(true);
    expect(shutdownPending(false)).toBe(false); // …on the module singleton, which is untouched here
  });

  it('never banks a whole day because a tab was backgrounded mid-outage', () => {
    const ledger = new OutageLedger();
    ledger.beginOutage(0);
    ledger.endOutage(9_000_000); // two and a half hours of wall clock with the game not running
    expect(ledger.hours).toBe(MAX_OUTAGE_CREDIT_HOURS);
  });

  it('stands down while the loaded body is driving the ledger, so nothing is counted twice', () => {
    const ledger = new OutageLedger();
    ledger.driven = true;
    ledger.beginOutage(0);
    expect(ledger.endOutage(38_000)).toBe(0);
    expect(ledger.hours).toBe(0);
  });

  it('pins the conversion rate to DayNight, which it may not import at runtime', () => {
    // protest.state is eager `gameplay-rules`; DayNight is `simulation`. Importing it there would make
    // the two chunks mutually dependent and the production bundle would die on load. So the number is
    // duplicated — and this is the test that stops the duplicate drifting.
    expect(SECONDS_PER_GAME_HOUR).toBe(DAY_CYCLE_SECONDS / 24);
  });
});

describe('grievance ledger: the save handover', () => {
  beforeEach(() => outageLedger.reset());

  it('adopting a save at load time KEEPS what this session already felt', () => {
    // The regression the first in-engine playthrough caught: the eager hook had counted 3.2 outage
    // hours, `E  Follow the smoke` appeared, the chunk loaded — and the body wiped the ledger with an
    // empty saved slice, so the press did nothing at all.
    const ledger = new OutageLedger();
    ledger.tick(2, 50, 60, false);
    for (let step = 1; step <= 40; step++) ledger.tick(2 + step * 0.1, 50, 60, false);
    expect(ledger.ripe).toBe(true);
    ledger.adopt(defaultProtestSave()); // a brand-new save with no protest slice
    expect(ledger.hours).toBeCloseTo(4, 5);
    expect(ledger.ripe).toBe(true);
    expect(ledger.anchorX).toBeCloseTo(50, 0);
  });

  it('adopting adds this session on top of the stored baseline, and the live anchor wins', () => {
    const ledger = new OutageLedger();
    ledger.tick(2, 900, 900, false);
    ledger.tick(2.4, 900, 900, false);
    ledger.adopt({ ...defaultProtestSave(), hours: 2, anchor: [-10, -10] });
    expect(ledger.hours).toBeCloseTo(2.4, 5);
    expect(ledger.anchorX).toBeCloseTo(900, 0); // where they stood in the dark THIS session
  });

  it('a checkpoint reload REPLACES rather than adds', () => {
    const ledger = new OutageLedger();
    ledger.hours = 5; ledger.hasAnchor = true; ledger.anchorX = 3;
    ledger.load({ ...defaultProtestSave(), hours: 1, anchor: [7, 8] });
    expect(ledger.hours).toBe(1);
    expect(ledger.anchorX).toBe(7);
  });

  it('round-trips through the save', () => {
    const ledger = new OutageLedger();
    ledger.hours = 2.5; ledger.anchorX = 12.345; ledger.anchorZ = -6.7; ledger.hasAnchor = true;
    const stored = ledger.store();
    const other = new OutageLedger();
    other.load({ ...defaultProtestSave(), ...stored });
    expect(other.hours).toBeCloseTo(2.5, 3);
    expect(other.anchorX).toBeCloseTo(12.35, 2);
    expect(other.hasAnchor).toBe(true);
  });
});

describe('hourDelta', () => {
  it('is signed, wraps, and stays small', () => {
    expect(hourDelta(5, 5.25)).toBeCloseTo(0.25, 6);
    expect(hourDelta(23.5, 0.5)).toBeCloseTo(1, 6);
    expect(hourDelta(0.5, 23.5)).toBeCloseTo(-1, 6);
    expect(hourDelta(5, 5)).toBeCloseTo(0, 6);
  });
});

describe('blockade shape', () => {
  it('is the full shutdown at dawn and a handful of neighbours otherwise', () => {
    expect(blockadeSize(5)).toBe('dawn');
    expect(blockadeSize(3)).toBe('dawn');
    expect(blockadeSize(8)).toBe('daytime');
    expect(blockadeSize(14)).toBe('daytime');
    expect(blockadeSize(29)).toBe('dawn'); // wraps: 29 → 05:00
    expect(blockadeSize(26)).toBe('daytime'); // 26 → 02:00, before anyone is up to close a road
    expect(crowdSize('dawn')).toBeGreaterThan(crowdSize('daytime'));
    expect(tyreCount('dawn')).toBeGreaterThan(tyreCount('daytime'));
    expect(closureRadius('dawn')).toBeGreaterThan(closureRadius('daytime'));
  });

  it('pays a generous, bounded morning of selling to the queue', () => {
    expect(picketPayout(0, 'daytime')).toBe(200);
    expect(picketPayout(70, 'dawn')).toBe(740);
    expect(picketPayout(9999, 'dawn')).toBe(740); // capped at the picket length, not farmable
  });
});

describe('save sanitiser', () => {
  it('survives rubbish', () => {
    expect(sanitizeProtestState(undefined)).toEqual(defaultProtestSave());
    expect(sanitizeProtestState('nope')).toEqual(defaultProtestSave());
    expect(sanitizeProtestState([1, 2, 3])).toEqual(defaultProtestSave());
    expect(sanitizeProtestState({ hours: Number.NaN, tyres: 'x', scorch: 'no' })).toEqual(defaultProtestSave());
  });

  it('clamps a hand-edited localStorage into range', () => {
    const value = sanitizeProtestState({ hours: 1e9, tyres: 99, pickets: -4, anchor: [1e9, -1e9] });
    expect(value.hours).toBe(999);
    expect(value.tyres).toBe(TYRE_CARRY_CAP);
    expect(value.pickets).toBe(0);
    expect(value.anchor).toEqual([100_000, -100_000]);
  });

  it('keeps only the newest SCORCH_CAP stains, and only complete triples', () => {
    const flat: number[] = [];
    for (let index = 0; index < SCORCH_CAP + 20; index++) flat.push(index, index, 2);
    const value = sanitizeProtestState({ scorch: [...flat, 7] }); // trailing partial triple dropped
    expect(value.scorch).toHaveLength(SCORCH_CAP * 3);
    expect(value.scorch[0]).toBe(20); // FIFO: the oldest twenty are gone
  });

  it('drops a scorch radius that would paint the whole city black', () => {
    expect(sanitizeProtestState({ scorch: [0, 0, 5000] }).scorch).toEqual([0, 0, 12]);
  });
});
