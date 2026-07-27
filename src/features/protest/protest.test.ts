import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Barricade, ScorchField, TyreFire } from './Barricade';
import { createFeature } from './protest';
import { ProhibitedTyreHostError, SCORCH_CAP, outageLedger } from '../protest.state';
import { FeatureHost } from '../host';
import { FEATURES } from '../registry';
import { roadClosures } from '../../systems/NavGraph';
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
  it('a session that ripened BEFORE the chunk loaded still raises on the first press', () => {
    // Exactly what the first in-engine playthrough did, and exactly where it failed: the eager
    // approach counted the outage, showed `E  Follow the smoke`, the chunk arrived — and the body
    // adopted an empty save slice over the top, so the press did nothing.
    roadClosures.clear();
    outageLedger.reset();
    outageLedger.tick(2, 120, -300, false);
    for (let step = 1; step <= 40; step++) outageLedger.tick(2 + step * 0.1, 120, -300, false);
    expect(outageLedger.ripe).toBe(true);

    const api = stubApi();
    const system = createFeature(api, undefined); // a fresh game: no stored protest slice at all
    const rung = (system.interactions?.() ?? []).find((entry) => entry.id === 'protest:raise');
    const offer = rung?.test({ context: 'foot', position: new THREE.Vector3(), vehicle: undefined, hour: 5 });
    expect(offer?.prompt).toBe('E  Follow the smoke');
    offer?.act();
    expect(system.qa?.('site', {})).toMatch(/^ok:/);
    expect(system.qa?.('closures', {})).toContain('protest:blockade');
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
    system.qa?.('raise', {}); system.qa?.('join', {});
    const rungs = system.interactions?.() ?? [];
    const ctx = { context: 'foot' as const, position: new THREE.Vector3(), vehicle: undefined, hour: 5 };
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
    system.qa?.('raise', {}); system.qa?.('join', {});
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
  const greedy = {
    id: 'tuckshop', saveKey: 'tuckshop', label: 'Tuck shop',
    approach: { context: 'foot' as const, order: 1, prompt: 'E  Buy a cooldrink', near: () => true },
    load: () => Promise.resolve({ createFeature: () => ({ dispose: () => undefined }) }),
  };

  it('still ripens while a shop door wins the ladder every frame', () => {
    outageLedger.reset();
    setPower(true);
    const api = stubApi();
    const host = new FeatureHost(
      { api, suspended: () => false, emit: () => undefined, reportError: () => undefined },
      [greedy, ...FEATURES] as never,
    );

    // 600 frames of standing in a doorway. Protest's predicate is never even reached.
    for (let frame = 0; frame < 600; frame++) expect(host.offer('foot')?.prompt).toBe('E  Buy a cooldrink');
    expect(outageLedger.hours).toBe(0);

    // Two load-shedding cycles, through powerGrid's own hook — the path Game.applyEskom takes.
    // 38 real seconds is the middle of LoadSheddingSystem's 32-44 s shed; the stamp is rewritten so
    // the credit is deterministic instead of depending on how fast the test runner got here.
    for (let shed = 0; shed < 2; shed++) {
      setPower(false);
      outageLedger.beginOutage(performance.now() - 38_000);
      setPower(true);
    }
    expect(outageLedger.ripe).toBe(true);

    // The rung is now live; it is still (correctly) below the shop door, and it is there the moment
    // the player steps off the doorstep — which is exactly what "0.00 outage-hours" prevented.
    const rung = host.descriptors('foot').find((entry) => entry.id === 'protest:approach');
    expect(rung?.test({ context: 'foot', position: new THREE.Vector3(), vehicle: undefined, hour: 2 })?.prompt)
      .toBe('E  Follow the smoke');
    host.dispose();
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
