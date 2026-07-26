import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Barricade, ScorchField, TyreFire } from './Barricade';
import { createFeature } from './protest';
import { ProhibitedTyreHostError, SCORCH_CAP, outageLedger } from '../protest.state';
import { roadClosures } from '../../systems/NavGraph';
import type { FeatureGameApi } from '../types';

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
    const barricade = new Barricade(scene, site, 'dawn', 4);
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
    const barricade = new Barricade(scene, site, 'daytime', 3);
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
    const barricade = new Barricade(scene, { x: 0, y: 0, z: 0, heading: 0 }, 'dawn', 6);
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
    const first = new Barricade(scene, { x: 123.5, y: 0, z: -88.25, heading: 1.1 }, 'dawn', 5);
    const second = new Barricade(scene, { x: 123.5, y: 0, z: -88.25, heading: 1.1 }, 'dawn', 5);
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
