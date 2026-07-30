import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertNotLivingHost, bearingName, blockadeSize, closureRadius, crowdSize, defaultProtestSave,
  grievanceHud, grievanceWarming, hourDelta, HUD_FROM_FRACTION, ignitableTargets, isLivingTarget,
  OutageLedger, outageLedger, picketPayout, pickBlockadeSite, POST_PICKET_HOURS,
  ProhibitedTyreHostError, RIPE_OUTAGE_HOURS, sanitizeProtestState, SCORCH_CAP, SITE_MAX_METRES,
  SITE_MIN_METRES, tickGrievance, TYRE_CARRY_CAP, tyreCount, WARN_FRACTION, type SiteCandidate,
} from './protest.state';
import { FEATURES } from './registry';
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

  it('drives the shared ledger through the one call both halves of the feature use', () => {
    outageLedger.reset();
    setPower(true);
    tickGrievance({ hour: 4, position: { x: 5, y: 0, z: 5 } as never });
    tickGrievance({ hour: 4.2, position: { x: 5, y: 0, z: 5 } as never });
    expect(outageLedger.hours).toBe(0); // the lights are on: nothing to be aggrieved about

    setPower(false);
    for (let step = 0; step <= 30; step++) tickGrievance({ hour: 4.2 + step * 0.1, position: { x: 640, y: 0, z: -55 } as never });
    expect(outageLedger.ripe).toBe(true);
    expect(outageLedger.anchorX).toBeCloseTo(640, 0); // and it knows WHERE, which the wall clock never did
    setPower(true);
    outageLedger.reset();
  });

  it('reports a fraction, a warning and ripeness off the same number', () => {
    const ledger = new OutageLedger();
    ledger.hours = RIPE_OUTAGE_HOURS * HUD_FROM_FRACTION;
    expect(ledger.warning).toBe(false);
    expect(ledger.ripe).toBe(false);
    ledger.hours = RIPE_OUTAGE_HOURS * WARN_FRACTION;
    expect(ledger.warning).toBe(true);   // said out loud BEFORE anything happens
    expect(ledger.ripe).toBe(false);
    ledger.hours = RIPE_OUTAGE_HOURS;
    expect(ledger.ripe).toBe(true);
    expect(ledger.fraction).toBe(1);
    ledger.hours = 99;
    expect(ledger.fraction).toBe(1);     // clamped: the chip is a bar, not a score
  });
});

/**
 * THE OWNER'S FIRST COMPLAINT, WHICH IS ABOUT LEGIBILITY AND NOT ABOUT A CRASH: "I don't quite
 * understand the game logic." Nothing on screen said a district was aggrieved until a road shut.
 */
describe('the grievance is visible before anything happens', () => {
  beforeEach(() => { outageLedger.reset(); setPower(true); });

  it('says nothing at all while there is nothing to say', () => {
    expect(grievanceHud()).toEqual([]);
    expect(grievanceWarming()).toBe(false);
  });

  it('shows a filling chip once the district is genuinely fed up, and warns before it ripens', () => {
    outageLedger.hours = RIPE_OUTAGE_HOURS * HUD_FROM_FRACTION;
    const early = grievanceHud();
    expect(early).toHaveLength(1);
    expect(early[0]?.label).toBe('FED UP');
    expect(early[0]?.fill).toBeGreaterThan(0);
    expect(early[0]?.warn).toBe(false);
    expect(grievanceWarming()).toBe(true); // …and the body is fetched from here, ahead of the protest

    outageLedger.hours = RIPE_OUTAGE_HOURS * WARN_FRACTION;
    expect(grievanceHud()[0]?.warn).toBe(true);
  });

  it('stands the chip down once the road is actually shut — the barricade is its own readout', () => {
    outageLedger.hours = RIPE_OUTAGE_HOURS;
    expect(grievanceHud()).toEqual([]);
  });

  it('is the SAME function the registry’s eager slice publishes, so the strip cannot change shape', () => {
    const feature = FEATURES.find((entry) => entry.id === 'protest');
    outageLedger.hours = RIPE_OUTAGE_HOURS * 0.5;
    const ctx = { context: 'foot' as const, position: { x: 0, y: 0, z: 0 } as never, vehicle: undefined, hour: 4 };
    expect(feature?.eager?.hud?.(ctx)).toEqual(grievanceHud());
  });

  it('the eager tick is on the registry, not in a predicate — the host runs it unconditionally', () => {
    const feature = FEATURES.find((entry) => entry.id === 'protest');
    expect(feature?.eager?.tick).toBeDefined();
    setPower(false);
    const ctx = { context: 'foot' as const, position: { x: 12, y: 0, z: 34 } as never, vehicle: undefined, hour: 3 };
    feature?.eager?.tick?.(0.1, ctx);
    for (let step = 1; step <= 20; step++) {
      feature?.eager?.tick?.(0.1, { ...ctx, hour: 3 + step * 0.1 });
    }
    expect(outageLedger.hours).toBeGreaterThan(1.5);
    expect(outageLedger.anchorX).toBeCloseTo(12, 0);
    setPower(true);
  });
});

/**
 * THE OWNER'S SECOND COMPLAINT: "It just seems to spawn a protest where I am or something?" It did.
 * This is the rule that stops it, as a pure function over already-snapped road poses.
 */
describe('where the road gets closed', () => {
  const at = (x: number, z: number, district = 'Brixton'): SiteCandidate => ({ x, z, y: 0, heading: 0, district });
  const player = { x: 0, z: 0 };

  it('never picks a road the player is standing on', () => {
    const chosen = pickBlockadeSite([at(3, 0), at(20, 0), at(140, 0)], player, { x: 0, z: 0 }, 'Brixton');
    expect(chosen).toEqual(at(140, 0));
    expect(Math.hypot(chosen!.x, chosen!.z)).toBeGreaterThanOrEqual(SITE_MIN_METRES);
  });

  it('prefers the band over a road on the far side of the city', () => {
    const chosen = pickBlockadeSite([at(150, 0), at(4000, 0)], player, { x: 5000, z: 0 }, 'Brixton');
    expect(chosen).toEqual(at(150, 0)); // nearest-to-anchor would have taken the 4 km one
    expect(Math.hypot(chosen!.x, chosen!.z)).toBeLessThanOrEqual(SITE_MAX_METRES);
  });

  it('closes a road in the district that is actually aggrieved', () => {
    const chosen = pickBlockadeSite(
      [at(120, 0, 'Sandton'), at(0, 200, 'Brixton')],
      player, { x: 0, z: 400 }, 'Brixton',
    );
    expect(chosen?.district).toBe('Brixton');
  });

  it('within the band and the district, takes the road nearest where he stood in the dark', () => {
    const chosen = pickBlockadeSite([at(0, 100), at(0, 240), at(200, 0)], player, { x: 0, z: 260 }, 'Brixton');
    expect(chosen).toEqual(at(0, 240));
  });

  it('falls back to the furthest road it found rather than one under his feet', () => {
    const chosen = pickBlockadeSite([at(5, 0), at(30, 0)], player, { x: 0, z: 0 }, 'Brixton');
    expect(chosen).toEqual(at(30, 0));
  });

  it('answers nothing when the probe found no road at all — the caller has its own fallback', () => {
    expect(pickBlockadeSite([], player, { x: 0, z: 0 }, 'Brixton')).toBeUndefined();
  });

  it('is deterministic: the same candidates in the same order always choose the same road', () => {
    const list = [at(0, 120), at(120, 0), at(0, -130), at(-140, 0)];
    const first = pickBlockadeSite(list, player, { x: 0, z: 900 }, 'Brixton');
    for (let run = 0; run < 20; run++) expect(pickBlockadeSite(list, player, { x: 0, z: 900 }, 'Brixton')).toEqual(first);
  });
});

describe('which way to look', () => {
  it('names the eight points of the compass, with -z as north', () => {
    expect(bearingName(0, -100)).toBe('north');
    expect(bearingName(100, 0)).toBe('east');
    expect(bearingName(0, 100)).toBe('south');
    expect(bearingName(-100, 0)).toBe('west');
    expect(bearingName(70, 70)).toBe('south-east');
    expect(bearingName(-70, -70)).toBe('north-west');
    expect(bearingName(0, 0)).toBe('right here');
  });
});

/**
 * THE CROSS-FEATURE BUG THE VERIFIER FOUND, pinned so it cannot come back — and it has now been
 * pinned against all three places this clock has lived.
 *
 * It used to tick as a side effect inside the registry's `approach.near()` predicate, and
 * `resolveInteraction` returns on the FIRST descriptor that offers something. With any other feature
 * registered above protest's `order: 60`, the predicate never ran and the ledger never moved — 3.90
 * outage-hours measured out in the open street against 0.00 on a doorstep. It is this feature's only
 * unlock gate, so merged as-is it would simply never have triggered.
 *
 * The replacement was `powerGrid.onPowerChange` against `performance.now()`, which fires reliably and
 * is still wrong: a wall clock is not the game's clock (it ran while the game was paused and while the
 * tab was in the background, hence the cap that had to exist) and it carries no position, so the anchor
 * never existed and every protest went up under the player's feet.
 *
 * It is now `eager.tick` — the sim sub-step, the same hook petrol burns fuel on. The host calls it for
 * every unloaded feature unconditionally, so no prompt can shadow it and no frame rate can change it.
 */
describe('the grievance clock does not live in an interaction predicate', () => {
  beforeEach(() => { outageLedger.reset(); setPower(true); });

  it('the registry approach predicate is PURE — and offers nothing at all, whatever the ledger says', () => {
    const approach = FEATURES.find((feature) => feature.id === 'protest')?.approach;
    expect(approach).toBeDefined();
    const ctx = { context: 'foot' as const, position: { x: 5, y: 0, z: 5 } as never, vehicle: undefined, hour: 2 };
    setPower(false);
    for (let frame = 0; frame < 1000; frame++) approach!.near(ctx);
    expect(outageLedger.hours).toBe(0); // a predicate that credited would be at several hours by now

    // …and it stays false even RIPE. There is no prompt for starting a protest: the rung that used to
    // sit here offered `E  Follow the smoke` from anywhere in the city, above `E  Enter vehicle`.
    outageLedger.hours = RIPE_OUTAGE_HOURS + 5;
    expect(approach!.near(ctx)).toBe(false);
    setPower(true);
  });

  it('rides the preload seam instead, which offers nothing and steals no press', () => {
    const approach = FEATURES.find((feature) => feature.id === 'protest')?.approach as
      (undefined | { preload?(x: number, z: number): boolean });
    expect(approach?.preload).toBeDefined();
    expect(approach!.preload!(0, 0)).toBe(false);
    outageLedger.hours = RIPE_OUTAGE_HOURS * HUD_FROM_FRACTION;
    expect(approach!.preload!(0, 0)).toBe(true); // fetched EARLY: the body is what raises the protest
  });

  it('counts the outage on the game clock, not the wall clock — a paused game is not a grievance', () => {
    setPower(false);
    // Two sheds' worth of game hours, delivered as sim sub-steps exactly as the host delivers them.
    tickGrievance({ hour: 2, position: { x: 0, y: 0, z: 0 } as never });
    for (let step = 1; step <= 32; step++) tickGrievance({ hour: 2 + step * 0.1, position: { x: 0, y: 0, z: 0 } as never });
    expect(outageLedger.ripe).toBe(true);

    // Wall-clock time passing with no sim steps credits NOTHING. That is the whole difference.
    const parked = outageLedger.hours;
    const until = performance.now() + 25;
    while (performance.now() < until) { /* a paused game, a backgrounded tab, an open menu */ }
    expect(outageLedger.hours).toBe(parked);
    setPower(true);
  });

  it('credits nothing while the lights are on, however long the player stands there', () => {
    setPower(true);
    tickGrievance({ hour: 6, position: { x: 0, y: 0, z: 0 } as never });
    for (let step = 1; step <= 60; step++) tickGrievance({ hour: 6 + step * 0.1, position: { x: 0, y: 0, z: 0 } as never });
    expect(outageLedger.hours).toBe(0);
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
    expect(sanitizeProtestState({ tyres: 'x', scorch: 'no' })).toEqual(defaultProtestSave());
  });

  it('clamps a hand-edited localStorage into range', () => {
    const value = sanitizeProtestState({ tyres: 99, pickets: -4 });
    expect(value.tyres).toBe(TYRE_CARRY_CAP);
    expect(value.pickets).toBe(0);
  });

  it('loads a save written by the build that persisted the grievance, ignoring those keys', () => {
    // The grievance is session-scoped now (see ProtestSave). An old slice must still load its tyres
    // and its stains rather than being thrown away wholesale.
    const value = sanitizeProtestState({ hours: 900, anchor: [12, 34], tyres: 2, pickets: 3, scorch: [1, 2, 3] });
    expect(value).toEqual({ tyres: 2, pickets: 3, scorch: [1, 2, 3] });
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
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
