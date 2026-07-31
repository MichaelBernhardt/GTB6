import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Barricade, ScorchField, TyreFire } from './Barricade';
import { createFeature } from './protest';
import {
  outageLedger, ProhibitedTyreHostError, RIPE_OUTAGE_HOURS, SCORCH_CAP, SITE_MIN_METRES,
  SOLO_TYRE_SECONDS, TYRE_CARRY_CAP,
} from '../protest.state';
import { FeatureHost } from '../host';
import { FEATURES } from '../registry';
import { roadClosures, roadHazards } from '../../systems/NavGraph';
import { setPower } from '../../world/powerGrid';
import type { FeatureGameApi } from '../types';

/** Flat ground, the default for the suites that are not about grounding. */
const FLAT = () => 0;

/** A Game stand-in: the whole FeatureGameApi surface, with nothing behind it but arithmetic. */
function stubApi(overrides: Partial<FeatureGameApi> = {}): FeatureGameApi & { notices: string[]; earned: number; events: string[] } {
  const scene = new THREE.Scene();
  const player = new THREE.Vector3(10, 0, 10);
  const notices: string[] = []; const events: string[] = [];
  let earned = 0;
  const api = {
    scene,
    surfaceHeightAt: () => 0,
    districtAt: () => 'Hillbrow',
    isPark: () => false,
    nearestRoadPose: (at: THREE.Vector3) => ({ position: new THREE.Vector3(at.x, 0, at.z), heading: 0 }),
    playerPosition: () => player,
    playerHeading: () => 0,
    drivenVehicle: () => undefined,
    hour: () => 5,
    blackout: () => 0,
    balance: () => earned,
    earn: (amount: number) => { earned += amount; },
    spend: () => true,
    notify: (title: string) => { notices.push(title); },
    showMenu: () => undefined,
    closeMenu: () => undefined,
    persist: () => undefined,
    analytics: (event: string) => { events.push(event); },
    spawnFixture: (x: number, z: number, name?: string) => {
      const ped = { health: 60, state: 'idle', scripted: true, hailing: false, group: new THREE.Group(), setHail(on: boolean) { this.hailing = on; }, takeDamage: () => false };
      ped.group.name = name ?? '';
      ped.group.position.set(x, 0, z);
      return ped as never;
    },
    removeFixture: () => undefined,
    ...overrides,
  } as unknown as FeatureGameApi;
  return Object.assign(api, { notices, earned: 0, events, get earnedTotal() { return earned; } }) as never;
}

/**
 * Walk to the barricade.
 *
 * The site is no longer the road under the player's feet — that was the owner's "it just seems to spawn
 * a protest where I am" — so every test about the picket has to make the walk the player makes. The
 * stub's `playerPosition()` hands back one live vector, exactly as the real api does.
 */
function walkToBlockade(api: FeatureGameApi, system: { qa?(action: string, args: Record<string, unknown>): string }): void {
  const site = system.qa?.('site', {}) ?? '';
  const [x, z] = site.slice(3).split(',').map(Number);
  if (Number.isFinite(x) && Number.isFinite(z)) api.playerPosition().set(x!, 0, z!);
}

/**
 * The second half of the necklacing block. protest.state.test.ts proves the PREDICATE; this proves
 * the API SHAPE — that the lazily loaded body has no code path capable of putting a tyre or a fire
 * on a body, whatever a caller passes.
 */
describe('necklacing block: the tyre and fire APIs take coordinates, never a host', () => {
  const site = { x: 0, y: 0, z: 0, heading: 0 };

  it('the tyre-fire constructor accepts only numbers — there is no parent parameter to abuse', () => {
    const scene = new THREE.Scene();
    const fire = new TyreFire(scene, 4, 0, 4, 30, new THREE.Texture(), new THREE.Texture());
    // (scene, x, y, z, life, smoke, flame): every positional slot after the scene is a number or a
    // texture. A Pedestrian cannot be passed to any of them without failing to typecheck, and there
    // is no runtime overload that would accept one.
    expect(TyreFire.length).toBe(7);
    expect(fire.group.parent).toBe(scene);
    fire.dispose(scene);
    expect(fire.group.parent).toBe(null);
  });

  it('the barricade refuses to ignite a pedestrian, a corpse or a bone', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, site, 'dawn', 4, FLAT);
    const ped = { health: 60, state: 'idle', group: new THREE.Group(), takeDamage: () => false };
    const bone = new THREE.Bone();
    const corpse = { health: 0, state: 'down', group: new THREE.Group(), takeDamage: () => true };
    for (const candidate of [ped, bone, corpse]) {
      expect(() => barricade.ignite([candidate])).toThrow(ProhibitedTyreHostError);
    }
    // …and a mixed sweep is refused wholesale rather than quietly lighting the props around a body.
    expect(() => barricade.ignite([{ kind: 'tyre' }, ped])).toThrow(ProhibitedTyreHostError);
    expect(barricade.ignite([{ kind: 'tyre' }, { kind: 'tyre' }])).toBe(2);
    barricade.dispose();
  });

  it('refuses a limb of a ragdoll, which is how a body actually arrives', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, site, 'daytime', 3, FLAT);
    const bone = new THREE.Bone(); const hand = new THREE.Object3D(); bone.add(hand);
    expect(() => barricade.ignite([hand])).toThrow(ProhibitedTyreHostError);
    barricade.dispose();
  });

  it('the loaded feature reports the block as held when driven in-engine', () => {
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('ripen', {}); system.qa?.('raise', {});
    expect(system.qa?.('necklace', {})).toMatch(/^ok:refused-/);
    system.dispose();
  });
});

describe('barricade', () => {
  it('lays its junk ACROSS the lane, not along it', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'dawn', 6, FLAT);
    // heading 0 means travelling +z, so the across-axis is x: the tyres must spread in x.
    const spreadX = Math.max(...barricade.scorchPlan.map((mark) => Math.abs(mark.x)));
    const spreadZ = Math.max(...barricade.scorchPlan.map((mark) => Math.abs(mark.z)));
    expect(spreadX).toBeGreaterThan(4);
    expect(spreadZ).toBeLessThan(spreadX);
    barricade.dispose();
    expect(barricade.group.parent).toBe(null);
  });

  it('is built deterministically — the same corner builds the same barricade twice', () => {
    const scene = new THREE.Scene();
    const first = new Barricade(scene, { x: 123.5, y: 0, z: -88.25, heading: 1.1 }, 'dawn', 5, FLAT);
    const second = new Barricade(scene, { x: 123.5, y: 0, z: -88.25, heading: 1.1 }, 'dawn', 5, FLAT);
    expect(second.scorchPlan).toEqual(first.scorchPlan);
    first.dispose(); second.dispose();
  });
});

describe('scorch field', () => {
  it('is one instanced draw call, capped and FIFO', () => {
    const scene = new THREE.Scene();
    const field = new ScorchField(scene, () => 0);
    for (let index = 0; index < SCORCH_CAP + 12; index++) field.add(index, 0, 2);
    expect(field.count).toBe(SCORCH_CAP);
    expect(field.serialize()).toHaveLength(SCORCH_CAP * 3);
    expect(field.serialize()[0]).toBe(12); // oldest twelve retired
    const mesh = scene.getObjectByName('protest-scorch');
    expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
    expect((mesh as THREE.InstancedMesh).count).toBe(SCORCH_CAP);
    field.dispose();
    expect(scene.getObjectByName('protest-scorch')).toBeUndefined();
  });

  it('round-trips through the save', () => {
    const scene = new THREE.Scene();
    const field = new ScorchField(scene, () => 0);
    field.load([1, 2, 3, 4, 5, 6]);
    expect(field.count).toBe(2);
    expect(field.serialize()).toEqual([1, 2, 3, 4, 5, 6]);
    field.dispose();
  });
});

describe('the eager-to-lazy handover', () => {
  it('a session that ripened BEFORE the chunk loaded raises a protest on its own, with no press', () => {
    // Exactly what the first in-engine playthrough did, and where it has failed twice: the eager half
    // counted the outage, `E  Follow the smoke` appeared… and then either the body wiped the ledger
    // with an empty save slice, or the press raised a barricade on top of the player. There is no
    // press in this path any more. The body simply arrives, sees a ripe grievance, and closes a road.
    roadClosures.clear();
    outageLedger.reset();
    outageLedger.tick(2, 120, -300, false);
    for (let step = 1; step <= 40; step++) outageLedger.tick(2 + step * 0.1, 120, -300, false);
    expect(outageLedger.ripe).toBe(true);

    const api = stubApi();
    const system = createFeature(api, undefined); // a fresh game: no stored protest slice at all
    expect(outageLedger.ripe).toBe(true);         // the grievance survived the chunk landing on it
    expect(system.qa?.('site', {})).toBe('stuck:no-blockade');

    system.update?.(0.1);
    expect(system.qa?.('site', {})).toMatch(/^ok:/);
    expect(system.qa?.('closures', {})).toContain('protest:blockade');
    expect(api.notices.join(' ')).toMatch(/has shut its road/);
    system.dispose();
  });

  it('does NOT raise one before the grievance ripens, and says so first', () => {
    roadClosures.clear();
    outageLedger.reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    for (let step = 0; step < 20; step++) system.update?.(0.1);
    expect(system.qa?.('site', {})).toBe('stuck:no-blockade');
    expect(api.notices).toEqual([]);

    // The warning beat, once, before anything happens.
    outageLedger.hours = RIPE_OUTAGE_HOURS * 0.7;
    system.update?.(0.1);
    system.update?.(0.1);
    expect(api.notices.filter((line) => /has had enough/.test(line))).toHaveLength(1);
    expect(system.qa?.('site', {})).toBe('stuck:no-blockade');
    system.dispose();
  });

  it('spends the grievance on every stand-down, so protests cannot chain forever', () => {
    roadClosures.clear();
    outageLedger.reset();
    setPower(true); // the lights are back on: nothing may be credited while this runs
    let hour = 5;
    const api = stubApi({ hour: () => hour });
    const system = createFeature(api, undefined);
    outageLedger.hours = RIPE_OUTAGE_HOURS + 2;
    system.update?.(0.1);
    expect(system.qa?.('site', {})).toMatch(/^ok:/);

    // Let it fade unattended: the ledger must come back below ripeness or update() raises the next
    // one on the very next frame, forever, somewhere behind the player.
    for (let step = 0; step < 400; step++) { hour = (hour + 0.05) % 24; system.update?.(0.5); }
    expect(outageLedger.ripe).toBe(false);
    expect(system.qa?.('site', {})).toBe('stuck:no-blockade');
    system.dispose();
  });
});

/**
 * THE OWNER'S THIRD AND WORST REPORT: "it was saying to press E but didn't do anything, and since it
 * was also blocking E it prevented entering vehicles."
 *
 * `FeatureHost.act()` returns true the moment any rung offers, and Game.updateOnFoot then RETURNS —
 * above the vehicle-entry branch. So a rung that offers and declines does not fizzle, it eats the key.
 * This suite walks every state this feature has and asserts the two halves of the rule: a rung offers
 * only when its verb will run, and no rung offers anything that is not in front of the player.
 */
describe('a rung that offers is a rung that acts', () => {
  const ctxAt = (x: number, z: number) =>
    ({ context: 'foot' as const, position: new THREE.Vector3(x, 0, z), vehicle: undefined, hour: 5 });

  it('offers nothing at all when there is no protest — E belongs to the rest of the ladder', () => {
    roadClosures.clear();
    outageLedger.reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    for (const where of [ctxAt(0, 0), ctxAt(10, 10), ctxAt(4000, -4000)]) {
      expect((system.interactions?.() ?? []).some((rung) => rung.test(where))).toBe(false);
    }
    // …and still nothing when the grievance is ripe. This is the whole of the E-blocking bug: the old
    // `protest:raise` rung offered here, from anywhere on the map, for as long as `ripe` stayed true.
    outageLedger.hours = RIPE_OUTAGE_HOURS + 9;
    expect((system.interactions?.() ?? []).some((rung) => rung.test(ctxAt(0, 0)))).toBe(false);
    system.dispose();
  });

  it('offers nothing 100 m from the barricade it just raised', () => {
    roadClosures.clear();
    outageLedger.reset();
    const player = new THREE.Vector3(0, 0, 0);
    const api = stubApi({ playerPosition: () => player });
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    player.set(400, 0, 400);
    expect((system.interactions?.() ?? []).some((rung) => rung.test(ctxAt(400, 400)))).toBe(false);
    system.dispose();
  });

  it('every offer, in every phase, actually changes something when pressed', () => {
    // The structural claim, exercised rather than asserted: walk the feature through its whole life
    // and after each step take whatever the ladder offers and press it. `qa('press')` compares the
    // status line before and after and reports `failed:offer-did-nothing` if the verb was a no-op.
    roadClosures.clear();
    outageLedger.reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    walkToBlockade(api, system);   // the walk the player makes; the site is never under his feet now
    const pressed: string[] = [];
    for (let second = 0; second < 130; second++) {
      const verdict = system.qa?.('press', {}) ?? '';
      expect(verdict).not.toMatch(/^failed:/);
      if (verdict.startsWith('ok:') && verdict !== 'ok:no-offer') pressed.push(verdict.slice(3));
      for (let sub = 0; sub < 10; sub++) system.update?.(0.1);
    }
    // …and it really did walk the loop, rather than finding nothing to press for 130 seconds.
    expect(pressed.some((line) => /Join the picket/.test(line))).toBe(true);
    expect(pressed.some((line) => /Throw a tyre/.test(line))).toBe(true);
    expect(pressed.some((line) => /Take a tyre|Roll out a tyre/.test(line))).toBe(true);
    system.dispose();
  });

  it('stops offering the tyre pickup at the carry cap instead of offering a full pocket', () => {
    roadClosures.clear();
    outageLedger.reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    walkToBlockade(api, system);
    system.qa?.('tyre', { n: TYRE_CARRY_CAP });
    for (let step = 0; step < 400; step++) system.update?.(0.5); // fade to smouldering
    const take = (system.interactions?.() ?? []).find((rung) => rung.id === 'protest:take');
    const at = api.playerPosition();
    expect(take?.test(ctxAt(at.x, at.z))).toBeUndefined();
    system.dispose();
  });
});

describe('the protest goes up where he can come across it', () => {
  it('never closes the road under his feet, and blips it so he can find it', () => {
    roadClosures.clear();
    outageLedger.reset();
    const player = new THREE.Vector3(0, 0, 0);
    // A dense grid of lanes, so `nearestRoadPose` snaps to a real road wherever the probe lands.
    const api = stubApi({
      playerPosition: () => player,
      nearestRoadPose: (at: THREE.Vector3) => ({
        position: new THREE.Vector3(Math.round(at.x / 40) * 40, 0, Math.round(at.z / 40) * 40),
        heading: 0,
      }),
    });
    const system = createFeature(api, undefined);
    outageLedger.hours = RIPE_OUTAGE_HOURS + 1;
    outageLedger.anchorX = 150; outageLedger.anchorZ = 0; outageLedger.hasAnchor = true;
    system.update?.(0.1);

    const site = system.qa?.('site', {}) ?? '';
    expect(site).toMatch(/^ok:/);
    const [x, z] = site.slice(3).split(',').map(Number);
    expect(Math.hypot(x! - player.x, z! - player.z)).toBeGreaterThanOrEqual(SITE_MIN_METRES);
    expect(system.qa?.('blips', {})).toBe('ok:1');
    // The notification carries the bearing and the distance, not just a district name.
    expect(api.notices.join(' ')).toMatch(/has shut its road/);
    system.dispose();
  });
});

describe('the loaded feature', () => {
  it('closes a road when a blockade goes up and reopens it on dispose', () => {
    roadClosures.clear();
    const api = stubApi();
    const system = createFeature(api, undefined);
    expect(roadClosures.count).toBe(0);
    expect(system.qa?.('raise', {})).toBe('ok');
    expect(roadClosures.ids).toContain('protest:blockade');
    system.dispose();
    expect(roadClosures.count).toBe(0);
  });

  it('never offers anything in the vehicle context, so E always exits the car', () => {
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    expect((system.interactions?.() ?? []).every((rung) => rung.context === 'foot')).toBe(true);
    system.dispose();
  });

  it('runs a whole picket: join, feed, hold, get paid, and stain the tar', () => {
    roadClosures.clear();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    walkToBlockade(api, system);
    expect(system.qa?.('join', {})).toBe('ok');
    for (let second = 0; second < 80; second++) {
      if (second % 8 === 0) system.qa?.('feed', {});
      system.update?.(1);
    }
    expect(api.balance()).toBeGreaterThan(0);
    expect(system.qa?.('scorch', {})).not.toBe('ok:0');
    expect((system.serialize?.() as { pickets: number }).pickets).toBe(1);
    system.dispose();
  });

  it('ends the picket with no payout when a protester is put down', () => {
    roadClosures.clear();
    const downed: Array<{ state: string }> = [];
    const api = stubApi({
      spawnFixture: (x: number, z: number) => {
        const ped = { health: 60, state: 'idle', group: new THREE.Group(), setHail() { /* pose only */ }, takeDamage: () => false };
        ped.group.position.set(x, 0, z);
        downed.push(ped as never);
        return ped as never;
      },
    });
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    walkToBlockade(api, system);
    system.qa?.('join', {});
    system.update?.(1);
    downed[0]!.state = 'down';
    system.update?.(1);
    expect(api.balance()).toBe(0);
    expect((system.serialize?.() as { pickets: number }).pickets).toBe(0);
    system.dispose();
  });

  it('serialises a JSON-safe slice and restores it', () => {
    roadClosures.clear();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('tyre', { n: 2 });
    const slice = system.serialize?.();
    expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);
    system.restore?.({ ...(slice as object), tyres: 1, scorch: [5, 5, 2] });
    expect((system.serialize?.() as { tyres: number }).tyres).toBe(1);
    expect((system.serialize?.() as { scorch: number[] }).scorch).toEqual([5, 5, 2]);
    system.dispose();
    expect(outageLedger.hours).toBe(0);
  });
});

/**
 * THE OWNER'S FIRST REPORT: "tyres float in the air".
 *
 * The barricade group sits at ONE height — the road pose at the centre of the site — and the junk is
 * laid out to nine units either side of the centreline. The tar rolls with the terrain, so resting
 * every prop at a constant local height hangs the outer half of the barricade over the road. These
 * two cases are the fix and its control on the SAME sloped world.
 */
describe('grounded on the tar, not floating over it', () => {
  const SLOPE = 0.12; // 12 cm of climb per unit across the lane: an ordinary Joburg side street
  const sloped = (x: number) => x * SLOPE;

  /** Vertical gap between each prop's resting point and the ground under THAT prop. */
  function propGaps(barricade: Barricade, height: (x: number, z: number) => number): number[] {
    const origin = barricade.group.position;
    return barricade.group.children
      .filter((child) => child.name !== 'protest-plume')
      .map((child) => origin.y + child.position.y - height(origin.x + child.position.x, origin.z + child.position.z));
  }

  it('rests every prop on the surface under it, on a road that is not flat', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'dawn', 6, sloped);
    const gaps = propGaps(barricade, sloped);
    expect(gaps.length).toBeGreaterThan(20);       // tyres, bricks, bin, mattress, branches, placards
    expect(Math.min(...gaps)).toBeGreaterThan(-0.02); // nothing sunk into the tar
    expect(Math.max(...gaps)).toBeLessThan(0.9);      // nothing higher than a stacked tyre
    barricade.dispose();
  });

  it('CONTROL: one height for the lot is what put them in the air', () => {
    // Exactly what shipped — a surface query that ignores where the prop actually is.
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'dawn', 6, () => 0);
    const gaps = propGaps(barricade, sloped);
    expect(Math.max(...gaps.map(Math.abs))).toBeGreaterThan(1); // over a metre of daylight
    barricade.dispose();
  });

  it('still builds the same barricade twice on the same sloped corner', () => {
    const scene = new THREE.Scene();
    const site = { x: 123.5, y: 0, z: -88.25, heading: 1.1 };
    const first = new Barricade(scene, site, 'dawn', 5, sloped);
    const second = new Barricade(scene, site, 'dawn', 5, sloped);
    expect(second.scorchPlan).toEqual(first.scorchPlan);
    expect(propGaps(second, sloped)).toEqual(propGaps(first, sloped));
    first.dispose(); second.dispose();
  });
});

/**
 * THE OWNER'S SECOND REPORT: "tyre throwing didn't seem to work but it could be me doing it wrong".
 *
 * Both halves of that sentence were true. The old `feed()` set a boolean and moved a HUD number: no
 * tyre appeared, the plume did not change, nothing was said — and then the prompt vanished for three
 * and a half seconds and came back as a different verb.
 */
describe('throwing a tyre on the fire', () => {
  it('takes no arguments at all, so there is nothing a tyre could be thrown AT', () => {
    // The necklacing block as a shape: a method with zero parameters cannot be handed a person.
    expect(Barricade.prototype.addTyre.length).toBe(0);
  });

  it('puts a real tyre on the pile every time it is pressed', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'daytime', 3, () => 0);
    const before = barricade.group.children.length;
    barricade.addTyre(); barricade.addTyre();
    expect(barricade.thrownTyres).toBe(2);
    expect(barricade.group.children.length).toBe(before + 2); // two more meshes IN THE SCENE GRAPH
    barricade.dispose();
  });

  it('bounds the pile instead of growing the scene graph forever', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'daytime', 3, () => 0);
    const before = barricade.group.children.length;
    for (let press = 0; press < 60; press++) barricade.addTyre();
    expect(barricade.thrownTyres).toBe(60);
    expect(barricade.group.children.length).toBeLessThan(before + 20);
    expect(barricade.scorchPlan.length).toBeLessThanOrEqual(12); // and cannot flush the citywide FIFO
    barricade.dispose();
  });

  it('grounds a thrown tyre on the tar under it, like every other prop', () => {
    const scene = new THREE.Scene();
    const sloped = (x: number) => x * 0.12;
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'dawn', 6, sloped);
    const mark = barricade.addTyre();
    const tyre = barricade.group.children[barricade.group.children.length - 1]!;
    expect(tyre.position.y - sloped(tyre.position.x)).toBeGreaterThan(0);
    expect(tyre.position.y - sloped(tyre.position.x)).toBeLessThan(0.9);
    expect(mark.x).toBeCloseTo(tyre.position.x, 6);
    barricade.dispose();
  });

  it('offers ONE stable prompt while picketing, whatever the cooldown is doing', () => {
    roadClosures.clear();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {}); walkToBlockade(api, system); system.qa?.('join', {});
    const rungs = system.interactions?.() ?? [];
    const ctx = { context: 'foot' as const, position: api.playerPosition(), vehicle: undefined, hour: 5 };
    const prompt = () => rungs.map((rung) => rung.test(ctx)).find(Boolean)?.prompt;
    expect(prompt()).toBe('E  Throw a tyre on the fire');
    rungs.find((rung) => rung.id === 'protest:feed')!.test(ctx)!.act();
    // The old body dropped the rung here and the band flickered to a DIFFERENT verb mid-picket.
    expect(prompt()).toBe('E  Throw a tyre on the fire');
    system.dispose();
  });

  it('says something the first time, and moves the smoke every time', () => {
    roadClosures.clear();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {}); walkToBlockade(api, system); system.qa?.('join', {});
    for (let second = 0; second < 12; second++) system.update?.(1); // let the smoke bleed down
    const before = Number(/^ok:(\d+)/.exec(system.qa?.('smoke', {}) ?? '')?.[1]);
    expect(system.qa?.('feed', {})).toMatch(/^ok:\d+:tyres-on-the-pile-1$/);
    const after = Number(/^ok:(\d+)/.exec(system.qa?.('smoke', {}) ?? '')?.[1]);
    expect(after).toBeGreaterThan(before);
    expect(api.notices).toContain('On the fire it goes');
    system.dispose();
  });
});

/**
 * THE CROSS-FEATURE BUG, at the level it was actually found: through the real FeatureHost, with
 * another feature registered above protest that offers a rung on every single frame.
 */
describe('the grievance clock with a feature registered above protest', () => {
  // A feature that answers the ladder on EVERY frame, from a real body — because `host.update()` now
  // pulls an unloaded feature's stand-in off the ladder while its chunk is in flight, so a stand-in
  // alone would stop winning halfway through the measurement and prove nothing.
  const counter = {
    id: 'tuckshop:counter', order: 1, context: 'foot' as const,
    test: () => ({ prompt: 'E  Buy a cooldrink', act: () => undefined }),
  };
  const greedy = {
    id: 'tuckshop', saveKey: 'tuckshop', label: 'Tuck shop',
    approach: { context: 'foot' as const, order: 1, prompt: 'E  Buy a cooldrink', near: () => true },
    load: () => Promise.resolve({ createFeature: () => ({ interactions: () => [counter], dispose: () => undefined }) }),
  };
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

  it('still ripens while a shop door wins the ladder every frame, on the REAL five-feature registry', async () => {
    outageLedger.reset();
    setPower(true);
    let hour = 2;
    const api = stubApi({ hour: () => hour });
    const host = new FeatureHost(
      { api, suspended: () => false, emit: () => undefined, reportError: () => undefined },
      [greedy, ...FEATURES] as never,
    );

    host.update(0.1);
    await settle(); // the tuck shop's body installs; it now answers the ladder from a real rung

    // The lights are on: standing in a doorway for 600 frames is worth nothing at all.
    for (let frame = 0; frame < 600; frame++) expect(host.offer('foot')?.prompt).toBe('E  Buy a cooldrink');
    expect(outageLedger.hours).toBe(0);

    // Now the lights go out and the player keeps standing on that doorstep, where a feature ordered
    // ABOVE protest answers the ladder on every single frame. The grievance rides `eager.tick`, which
    // FeatureHost.update runs for every unloaded feature unconditionally, so the doorstep is worth
    // exactly what the open street is worth. This measurement is the whole bug: it used to read 0.00.
    setPower(false);
    for (let step = 0; step < 40; step++) {
      hour += 0.1;
      host.update(0.1);
      expect(host.offer('foot')?.prompt).toBe('E  Buy a cooldrink'); // …and protest never offers here
    }
    expect(outageLedger.hours).toBeGreaterThan(RIPE_OUTAGE_HOURS);
    expect(outageLedger.ripe).toBe(true);
    expect(outageLedger.hasAnchor).toBe(true); // the eager path knows WHERE he stood, which is new

    // And RIPE, the ladder is still the shop door — there is no `protest:approach` rung to steal E.
    const rung = host.descriptors('foot').find((entry) => entry.id === 'protest:approach');
    expect(rung?.test({ context: 'foot', position: new THREE.Vector3(), vehicle: undefined, hour: 2 })).toBeUndefined();
    host.dispose();
    setPower(true);
    outageLedger.reset();
  });

  it('publishes the grievance chip through the host while the body is still unloaded', () => {
    outageLedger.reset();
    setPower(false);
    const api = stubApi();
    const host = new FeatureHost(
      { api, suspended: () => false, emit: () => undefined, reportError: () => undefined },
      FEATURES as never,
    );
    outageLedger.hours = RIPE_OUTAGE_HOURS * 0.5;
    const chip = (host.hud() ?? []).find((entry) => entry.id === 'protest:anger');
    expect(chip?.label).toBe('FED UP');
    expect(chip?.value).toBe('50%');
    host.dispose();
    setPower(true);
    outageLedger.reset();
  });
});

/** THE OWNER'S FOURTH REPORT: he could not reach a protest by hand at all. */
describe('the review route', () => {
  it('"feature protest now" raises one at your feet, hands you tyres, and prints the way back', () => {
    roadClosures.clear();
    outageLedger.reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    expect(outageLedger.ripe).toBe(false); // a cold start: no outage has ever been felt

    const lines = system.command?.(['now']) ?? [];
    expect(lines.join(' ')).toMatch(/Blockade up/);
    expect(lines.join(' ')).toMatch(/tp -?\d+ -?\d+/); // the coordinates to get back to it
    expect(system.qa?.('site', {})).toMatch(/^ok:/);
    expect(system.qa?.('status', {})).toMatch(/tyres=2/);

    // …and the whole loop is reachable from there, with no waiting on the grid.
    expect(system.qa?.('join', {})).toBe('ok');
    expect(system.qa?.('feed', {})).toMatch(/^ok:/);
    expect(system.command?.(['where']).join(' ')).toMatch(/blockade/);
    system.dispose();
  });

  it('lists itself first in the console help, so it is findable without reading the source', () => {
    const api = stubApi();
    const system = createFeature(api, undefined);
    expect(system.command?.(['heeeelp'])?.[0]).toContain('now');
    system.dispose();
  });
});

/**
 * THE OTHER HALF OF "TYRES FLOAT IN THE AIR", and the half a measurement could never find.
 *
 * Grounding every prop on the surface under it fixed the barricades pitched on a slope. It did not
 * fix this: a tyre marked "stacked" was lifted 0.5-0.85 u at its OWN random lateral offset, so on
 * perfectly flat tar it hung in mid-air over nothing. It took an eye-height frame from the in-engine
 * run to see it — the gap-to-ground numbers were all inside tolerance the whole time, because a
 * stacked tyre is *supposed* to be off the ground. The rule it was missing is what this pins: off
 * the ground is only allowed when there is another tyre underneath.
 */
describe('no tyre hangs in the air', () => {
  const flat = () => 0;
  const sloped = (x: number) => x * 0.12;

  /** Every torus in the group, with how far it rests above the ground at its own position. */
  function tyresOf(barricade: Barricade, height: (x: number, z: number) => number) {
    return barricade.group.children
      .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh && child.geometry.type === 'TorusGeometry')
      .map((mesh) => ({
        x: mesh.position.x, z: mesh.position.z,
        // Local y, minus the local ground under this prop: `restingY` works in WORLD coordinates.
        rest: mesh.position.y - (height(barricade.site.x + mesh.position.x, barricade.site.z + mesh.position.z) - barricade.site.y),
      }));
  }

  /** A tyre is legal if it lies flat, or if another tyre is directly beneath it. */
  function unsupported(tyres: ReturnType<typeof tyresOf>) {
    return tyres.filter((tyre) => {
      if (tyre.rest <= 0.2) return false; // lying on the tar
      return !tyres.some((other) => other !== tyre
        && Math.hypot(other.x - tyre.x, other.z - tyre.z) < 0.45
        && Math.abs(tyre.rest - other.rest - 0.34) < 0.06);
    });
  }

  it('holds for every barricade size, on flat tar and on a slope', () => {
    const scene = new THREE.Scene();
    for (const height of [flat, sloped]) {
      for (const [size, count] of [['dawn', 6], ['daytime', 3]] as const) {
        for (const site of [{ x: 0, y: 0, z: 0, heading: 0 }, { x: 811.5, y: 0, z: -204.25, heading: 2.4 }]) {
          const barricade = new Barricade(scene, site, size, count, height);
          const tyres = tyresOf(barricade, height);
          expect(tyres.length).toBe(count);
          expect(unsupported(tyres), `${size} at ${site.x},${site.z}`).toEqual([]);
          barricade.dispose();
        }
      }
    }
  });

  it('holds for the tyres the player throws on, however many they throw', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'daytime', 3, sloped);
    for (let press = 0; press < 40; press++) {
      barricade.addTyre();
      expect(unsupported(tyresOf(barricade, sloped)), `after ${press + 1} throws`).toEqual([]);
    }
    barricade.dispose();
  });

  it('retires a whole stack at a time, so recycling never pulls a tyre out from under another', () => {
    const scene = new THREE.Scene();
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'daytime', 3, () => 0);
    for (let press = 0; press < 60; press++) barricade.addTyre();
    expect(unsupported(tyresOf(barricade, () => 0))).toEqual([]);
    barricade.dispose();
  });
});

/**
 * THE OWNER'S REPORTS, both of them, at the feature's own boundary.
 *
 *  (1) "when I join a protest, everyone gets scared of me and runs away, which means it's not much of
 *      a protest."
 *  (2) "when I throw a burning tyre on the road, cars etc just drive through it. Isn't it supposed to
 *      do something like block them?"
 *
 * The simulation half of both lives in src/systems (see PopulationSystem.protest.test.ts). What is
 * proved here is the contract between them: who this feature grants solidarity to and when it takes
 * it back, and that everything it lays on a road is taken off again — on stand-down, on dispose, and
 * on the PvP suspend, which does NOT dispose the feature and has left phantom state behind before.
 */
describe('what the protest publishes into the simulation', () => {
  const reset = () => { roadClosures.clear(); roadHazards.clear(); };

  it('gives the whole crowd solidarity while the barricade stands, and takes it back when it comes down', () => {
    reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    const crowd = Number(system.qa?.('crowd', {})?.slice(3));
    expect(crowd).toBeGreaterThan(0);
    // Granted on RAISE, not on join: a crowd that scatters as you walk up is a picket there is
    // nothing left to join.
    expect(system.qa?.('solidarity', {})).toBe(`ok:${crowd}/${crowd}`);
    system.command?.(['clear']);
    expect(system.qa?.('solidarity', {})).toBe('ok:0/0');
    system.dispose();
  });

  it('puts a row of circles across the lane a driver can actually see, and clears them on dispose', () => {
    reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    expect(roadHazards.count).toBe(0);
    system.qa?.('raise', {});
    // A barricade is published as several circles laid across its own lane, never one big one — so a
    // car on the cross street meets only the part in front of him, and the "can I get round this"
    // arithmetic is the same one the player's own tyres go through.
    expect(roadHazards.count).toBeGreaterThan(2);
    system.dispose();
    expect(roadHazards.count).toBe(0);
    expect(roadClosures.count).toBe(0);
  });

  it('drops one circle per tyre the player lights, and takes it off again when the tyre burns out', () => {
    reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('tyre', { n: 2 });
    expect(system.qa?.('burn', {})).toBe('ok:1');
    expect(roadHazards.count).toBe(1);
    // SOLO_SPACING is 4.5 now, not 22: three carried tyres lay a real line across a lane. A wider
    // spacing than the road meant the player could never build anything, which is half of report (2).
    api.playerPosition().x += 5;
    expect(system.qa?.('burn', {})).toBe('ok:2');
    expect(roadHazards.count).toBe(2);
    for (let second = 0; second < SOLO_TYRE_SECONDS + 2; second++) system.update?.(1);
    expect(roadHazards.count).toBe(0);
    expect(roadClosures.count).toBe(0);
    system.dispose();
  });

  it('takes everything off the road when the feature is SUSPENDED, and puts it back when it resumes', () => {
    reset();
    const api = stubApi();
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    const standing = roadHazards.count;
    expect(standing).toBeGreaterThan(0);
    expect(roadClosures.count).toBeGreaterThan(0);

    // PvP: no ticks, so its tyres never burn down. Leaving them registered shuts a road for as long
    // as the player stays online, in a city with no protest in it.
    system.suspend?.();
    expect(roadHazards.count).toBe(0);
    expect(roadClosures.count).toBe(0);

    // ...and the very first frame back restates the lot. No resume hook anywhere.
    system.update?.(1 / 60);
    expect(roadHazards.count).toBe(standing);
    expect(roadClosures.ids).toContain('protest:blockade');
    system.dispose();
  });

  it('leaves one threadable heap behind while it smoulders, so traffic weaves rather than stops', () => {
    reset();
    let clock = 5;
    const api = stubApi({ hour: () => clock });
    const system = createFeature(api, undefined);
    system.qa?.('raise', {});
    const standing = roadHazards.count;
    // The blockade stands BLOCKADE_HOURS of GAME time, and hourDelta clamps each step to half an hour.
    for (let step = 0; step < 16; step++) { clock += 0.4; system.update?.(1); }
    expect(system.qa?.('status', {})).toContain('phase=smouldering');
    expect(roadHazards.count).toBeLessThan(standing);
    expect(roadHazards.count).toBe(1);
    expect(roadClosures.ids).not.toContain('protest:blockade'); // the road is open again, junk and all
    system.dispose();
  });
});
