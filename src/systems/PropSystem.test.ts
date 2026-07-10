import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import type { InputManager } from '../core/InputManager';
import { Vehicle } from '../entities/Vehicle';
import type { City } from '../world/City';
import {
  FALL_DURATION, FALL_REST_ANGLE, fallAngle, fallAxis, HYDRANT_SPRAY_DURATION, KNOCKOVER_MIN_SPEED, KNOCKOVER_SPEED_KEEP,
  knockoverDamage, PROP_TIERS, PropGrid, type PropCollider, PropRegistry, PropSystem, solidImpactDamage,
} from './PropSystem';

const audio = { propKnock: () => {}, hydrantHiss: () => {} } as unknown as AudioManager;
const idleInput = { down: () => false } as unknown as InputManager;

/** Minimal city whose collision is exactly the prop registry, mirroring City.clampMove's axis-separated resolution. */
const propCity = (registry: PropRegistry): City => {
  const collides = (x: number, z: number, radius: number): boolean => registry.blocked(x, z, radius);
  return {
    props: registry,
    collides,
    clampMove: (from: THREE.Vector3, desired: THREE.Vector3, radius: number) => {
      const output = desired.clone();
      if (collides(output.x, from.z, radius)) output.x = from.x;
      if (collides(output.x, output.z, radius)) output.z = from.z;
      return output;
    },
  } as unknown as City;
};

const makeProp = (id: number, x: number, z: number, radius = 0.5): PropCollider =>
  ({ id, kind: 'sign', tier: 'knockover', x, z, radius, height: 2, down: false });

describe('prop tier classification', () => {
  it('marks massive props solid and street clutter knock-over', () => {
    for (const kind of ['tree', 'palm', 'fountain', 'monument', 'crane', 'shelter', 'signal', 'post'] as const) expect(PROP_TIERS[kind]).toBe('solid');
    for (const kind of ['streetlight', 'sign', 'hydrant', 'bench', 'shrub'] as const) expect(PROP_TIERS[kind]).toBe('knockover');
  });
});

describe('spatial grid', () => {
  it('returns only nearby props and finds props straddling cell borders exactly once', () => {
    const grid = new PropGrid();
    const near = makeProp(0, 11.9, 0);           // straddles the x cell border at 12
    const border = makeProp(1, 24, 24, 2);       // sits on a cell corner
    const far = makeProp(2, 200, 200);
    for (const prop of [near, border, far]) grid.add(prop);
    const hits = grid.nearby(12.5, 0, 1);
    expect(hits).toContain(near);
    expect(hits).not.toContain(far);
    expect(hits.filter((prop) => prop === near)).toHaveLength(1);
    expect(grid.nearby(23, 23, 2)).toContain(border);
    expect(grid.nearby(0, 0, 3)).not.toContain(border);
  });
});

describe('fall math', () => {
  it('tips the prop toward the direction of travel', () => {
    for (const [dx, dz] of [[1, 0], [0, 1], [-0.6, 0.8]] as const) {
      const axis = fallAxis(dx, dz);
      expect(Math.hypot(axis.x, axis.z)).toBeCloseTo(1, 5);
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(axis.x, 0, axis.z), FALL_REST_ANGLE);
      const tipped = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
      expect(tipped.x * dx + tipped.z * dz).toBeGreaterThan(0.9); // top ends up pointing the way the car was going
    }
  });

  it('accelerates from upright to the rest angle with a small bounce', () => {
    expect(fallAngle(0)).toBe(0);
    expect(fallAngle(FALL_DURATION)).toBeCloseTo(FALL_REST_ANGLE, 5);
    expect(fallAngle(FALL_DURATION * 10)).toBeCloseTo(FALL_REST_ANGLE, 5);
    let previous = 0;
    for (let t = 0.05; t <= 0.78; t += 0.05) { const angle = fallAngle(t * FALL_DURATION); expect(angle).toBeGreaterThan(previous); previous = angle; }
    expect(fallAngle(0.89 * FALL_DURATION)).toBeLessThan(FALL_REST_ANGLE - 0.05); // the bounce lifts it back up briefly
  });
});

describe('knock-over threshold', () => {
  it('leaves props standing below the speed threshold and fells them above it', () => {
    const registry = new PropRegistry();
    const prop = registry.register('streetlight', 0, 0, 0.2, 6.5);
    expect(registry.tryKnockdown(0, 0, 1, KNOCKOVER_MIN_SPEED - 1, 0, 1)).toBe(0);
    expect(prop.down).toBe(false);
    expect(registry.blocked(0, 0, 0.4)).toBe(true);
    expect(registry.tryKnockdown(0, 0, 1, KNOCKOVER_MIN_SPEED + 5, 0, 1)).toBe(1);
    expect(prop.down).toBe(true);
    expect(registry.blocked(0, 0, 0.4)).toBe(false); // downed props stop blocking peds and cars
    const events = registry.consumeKnockdowns();
    expect(events).toHaveLength(1);
    expect(events[0].prop).toBe(prop);
    expect(events[0].dirZ).toBe(1);
    expect(registry.consumeKnockdowns()).toHaveLength(0);
  });

  it('never fells solid props no matter the speed', () => {
    const registry = new PropRegistry();
    const tree = registry.register('tree', 0, 0, 0.5, 5);
    expect(registry.tryKnockdown(0, 0, 1, 99, 0, 1)).toBe(0);
    expect(tree.down).toBe(false);
    expect(registry.solidBlocked(0, 0, 0.4)).toBe(true);
  });
});

describe('vehicle vs props', () => {
  it('ploughs through a knock-over prop with ~20% speed loss and light damage', () => {
    const registry = new PropRegistry();
    const prop = registry.register('streetlight', 0, 0, 0.2, 6.5);
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3(0, 0, -1.5));
    vehicle.speed = 20;
    vehicle.updatePlayer(1 / 60, idleInput, propCity(registry));
    expect(prop.down).toBe(true);
    expect(vehicle.group.position.z).toBeGreaterThan(-1.5); // kept moving forward
    expect(vehicle.speed).toBeGreaterThan(20 * KNOCKOVER_SPEED_KEEP * 0.9);
    expect(vehicle.speed).toBeLessThan(20 * KNOCKOVER_SPEED_KEEP * 1.02);
    expect(vehicle.health).toBeLessThan(vehicle.maxHealth);
    expect(vehicle.health).toBeGreaterThan(vehicle.maxHealth - knockoverDamage(20) - 0.5);
  });

  it('stops dead on a solid tree, reflecting speed and taking heavy scaled damage', () => {
    const registry = new PropRegistry();
    registry.register('tree', 0, 0, 0.5, 5);
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3(0, 0, -2));
    vehicle.speed = 20;
    vehicle.updatePlayer(1 / 60, idleInput, propCity(registry));
    expect(vehicle.group.position.z).toBe(-2); // reflected, not through
    expect(vehicle.speed).toBeLessThan(0);
    const wallDamage = Math.max(0, 20 - 8) * 0.35;
    expect(vehicle.maxHealth - vehicle.health).toBeGreaterThan(wallDamage); // trees hit harder than walls
    expect(vehicle.maxHealth - vehicle.health).toBeLessThanOrEqual(solidImpactDamage(20));
  });

  it('treats a slow hit on a knock-over prop as a gentle stop with no fall', () => {
    const registry = new PropRegistry();
    const prop = registry.register('streetlight', 0, 0, 0.2, 6.5);
    const vehicle = new Vehicle(new THREE.Scene(), 'compact', new THREE.Vector3(0, 0, -1.5));
    vehicle.speed = KNOCKOVER_MIN_SPEED - 1;
    vehicle.updatePlayer(1 / 60, idleInput, propCity(registry));
    expect(prop.down).toBe(false);
    expect(vehicle.group.position.z).toBe(-1.5);
    expect(vehicle.speed).toBeLessThan(0);
    expect(vehicle.health).toBe(vehicle.maxHealth); // too slow to hurt
  });
});

describe('prop effects system', () => {
  it('animates the debris tipping to rest and leaves it in the scene', () => {
    const scene = new THREE.Scene();
    const registry = new PropRegistry();
    const debris = new THREE.Group();
    registry.register('sign', 0, 0, 0.14, 2.6, { debris: () => debris });
    registry.tryKnockdown(0, 0, 1, 20, 1, 0);
    const system = new PropSystem(scene, registry, audio);
    system.update(0.1);
    expect(debris.parent).toBe(scene);
    const midway = new THREE.Vector3(0, 1, 0).applyQuaternion(debris.quaternion);
    expect(midway.y).toBeLessThan(1);
    for (let step = 0; step < 20; step++) system.update(0.05);
    const settled = new THREE.Vector3(0, 1, 0).applyQuaternion(debris.quaternion);
    expect(settled.y).toBeCloseTo(Math.cos(FALL_REST_ANGLE), 3);
    expect(settled.x).toBeGreaterThan(0.9); // fell in the direction of travel
    expect(debris.parent).toBe(scene); // debris persists
  });

  it('runs a hydrant spray that emits droplets and cleans up when the water runs out', () => {
    const scene = new THREE.Scene();
    const registry = new PropRegistry();
    registry.register('hydrant', 0, 0, 0.24, 0.9);
    registry.tryKnockdown(0, 0, 1, 20, 0, 1);
    const system = new PropSystem(scene, registry, audio);
    for (let step = 0; step < 20; step++) system.update(0.05);
    expect(scene.children.length).toBeGreaterThan(10); // droplets in flight
    for (let step = 0; step < (HYDRANT_SPRAY_DURATION + 3) * 20; step++) system.update(0.05);
    expect(scene.children).toHaveLength(0); // spray over, droplets removed
  });
});
