import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AudioManager } from '../core/AudioManager';
import type { InputManager } from '../core/InputManager';
import type { Pedestrian } from '../entities/Pedestrian';
import { CombatSystem } from './CombatSystem';
import type { PopulationSystem } from './PopulationSystem';

const fakeInput = (firing = false, firePressed = false): InputManager => ({ firing, firePressed, consume: () => false } as unknown as InputManager);
const emptyPopulation = { pedestrians: [], vehicles: [], nearestPedestrian: () => undefined } as unknown as PopulationSystem;
const makeCombat = (): CombatSystem => new CombatSystem(new THREE.Scene(), new AudioManager());
const camera = new THREE.PerspectiveCamera();
const origin = new THREE.Vector3();

describe('CombatSystem', () => {
  it('cycles owned weapons in loadout order, skipping unowned ones', () => {
    const combat = makeCombat();
    expect(combat.current).toBe('pistol');
    combat.cycle(1); expect(combat.current).toBe('fists');
    combat.grantWeapon('rpg'); combat.select('pistol');
    combat.cycle(1); expect(combat.current).toBe('rpg');
    combat.cycle(1); expect(combat.current).toBe('fists');
    combat.cycle(-1); expect(combat.current).toBe('rpg');
    combat.grantWeapon('smg'); combat.grantWeapon('shotgun');
    combat.select('pistol');
    combat.cycle(1); expect(combat.current).toBe('smg');
    combat.cycle(1); expect(combat.current).toBe('shotgun');
    combat.select('pistol'); expect(combat.current).toBe('pistol');
    expect(combat.select('pistol')).toBe(false);
  });

  it('rejects selecting weapons the player does not own', () => {
    const combat = makeCombat();
    expect(combat.select('smg')).toBe(false);
    expect(combat.current).toBe('pistol');
    expect(combat.grantWeapon('smg')).toBe('new');
    expect(combat.loadout.smg).toEqual({ ammo: 30, reserve: 120, owned: true });
    expect(combat.select('smg')).toBe(true);
  });

  it('tops up reserve ammo for owned weapons and via ammo boxes', () => {
    const combat = makeCombat();
    expect(combat.grantWeapon('pistol')).toBe('ammo');
    expect(combat.loadout.pistol.reserve).toBe(84 + 24);
    expect(combat.addAmmo()).toBe('pistol');
    expect(combat.loadout.pistol.reserve).toBe(84 + 48);
    combat.select('fists');
    expect(combat.addAmmo()).toBe('pistol');
    combat.loadout.pistol.reserve = 999; combat.grantWeapon('pistol');
    expect(combat.loadout.pistol.reserve).toBe(84 * 3);
  });

  it('requires a fresh press for semi-auto weapons', () => {
    const combat = makeCombat();
    expect(combat.fire(fakeInput(true, false), camera, origin, emptyPopulation).fired).toBe(false);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(true);
    expect(combat.state.ammo).toBe(11);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(false);
    combat.update(0.5);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(true);
  });

  it('lets full-auto weapons fire on hold once the cooldown clears', () => {
    const combat = makeCombat();
    combat.grantWeapon('smg'); combat.select('smg'); combat.update(0.5);
    expect(combat.fire(fakeInput(true, false), camera, origin, emptyPopulation).fired).toBe(true);
    expect(combat.fire(fakeInput(true, false), camera, origin, emptyPopulation).fired).toBe(false);
    combat.update(0.1);
    expect(combat.fire(fakeInput(true, false), camera, origin, emptyPopulation).fired).toBe(true);
    expect(combat.state.ammo).toBe(28);
    expect(combat.fire(fakeInput(false, false), camera, origin, emptyPopulation).fired).toBe(false);
  });

  it('auto-reloads an empty magazine when reserve remains', () => {
    const combat = makeCombat();
    combat.loadout.pistol = { ammo: 0, reserve: 20, owned: true };
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(false);
    expect(combat.reloading).toBeGreaterThan(0);
    combat.update(1.1);
    expect(combat.state).toEqual({ ammo: 12, reserve: 8, owned: true });
  });

  it('falls back to fists when magazine and reserve are empty', () => {
    const combat = makeCombat();
    combat.loadout.pistol = { ammo: 0, reserve: 0, owned: true };
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(false);
    expect(combat.current).toBe('fists');
    combat.update(0.5);
    const punch = combat.fire(fakeInput(true, true), camera, origin, emptyPopulation);
    expect(punch.fired).toBe(true);
    expect(punch.melee).toBe(true);
  });

  it('punches the nearest pedestrian in range', () => {
    const combat = makeCombat();
    combat.select('fists'); combat.update(0.5);
    let received = 0;
    const ped = { police: false, hostile: false, group: new THREE.Group(), takeDamage: (amount: number) => { received = amount; return false; } } as unknown as Pedestrian;
    const population = { pedestrians: [], vehicles: [], nearestPedestrian: (_: THREE.Vector3, range: number) => (range >= 2 ? ped : undefined) } as unknown as PopulationSystem;
    const result = combat.fire(fakeInput(true, true), camera, origin, population);
    expect(result).toMatchObject({ fired: true, melee: true, killed: false, policeHit: false });
    expect(result.victim).toBe(ped);
    expect(received).toBe(34);
    expect(combat.fire(fakeInput(true, true), camera, origin, population).fired).toBe(false);
  });

  it('hands bullet weapons to the simulator as a deferred shot instead of hitscan', () => {
    const combat = makeCombat();
    const shots: Array<{ count: number; weapon: string; direction: THREE.Vector3; origin: THREE.Vector3 }> = [];
    combat.onShot = (_position, shotOrigin, directions, count, spec) => shots.push({ count, weapon: spec.id, direction: directions[0]!.clone(), origin: shotOrigin.clone() });
    const result = combat.fire(fakeInput(true, true), camera, origin, emptyPopulation);
    expect(result).toMatchObject({ fired: true, deferred: true });
    expect(result.victim).toBeUndefined(); // outcome arrives later via BulletSystem resolution
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ count: 1, weapon: 'pistol' });
    expect(shots[0]!.direction.length()).toBeCloseTo(1, 5);
    combat.grantWeapon('shotgun'); combat.select('shotgun'); combat.update(0.5);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).deferred).toBe(true);
    expect(shots[1]!.count).toBe(7); // the whole pellet fan travels as one trigger pull
  });

  it('fires hip shots level along the facing with the muzzle pushed clear of the body', () => {
    const combat = makeCombat();
    const shots: Array<{ direction: THREE.Vector3; origin: THREE.Vector3 }> = [];
    combat.onShot = (_position, shotOrigin, directions) => shots.push({ direction: directions[0]!.clone(), origin: shotOrigin.clone() });
    combat.fire(fakeInput(true, true), camera, new THREE.Vector3(2, 0, 3), emptyPopulation, { aim: false, heading: Math.PI / 2 });
    expect(shots[0]!.direction.x).toBeCloseTo(1, 5);
    expect(shots[0]!.direction.y).toBeCloseTo(0, 5);
    expect(shots[0]!.origin.y).toBeCloseTo(1.35, 5);
    expect(shots[0]!.origin.x).toBeCloseTo(2.5, 5);
  });

  it('launches a visible projectile for the rocket launcher instead of hitscan', () => {
    const combat = makeCombat();
    const launches: Array<{ origin: THREE.Vector3; direction: THREE.Vector3 }> = [];
    combat.onRocket = (rocketOrigin, direction) => launches.push({ origin: rocketOrigin.clone(), direction: direction.clone() });
    combat.grantWeapon('rpg'); combat.select('rpg'); combat.update(0.5);
    expect(combat.fire(fakeInput(true, false), camera, origin, emptyPopulation).fired).toBe(false);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(true);
    expect(launches).toHaveLength(1);
    expect(combat.state.ammo).toBe(0);
    combat.update(1);
    expect(combat.fire(fakeInput(true, true), camera, origin, emptyPopulation).fired).toBe(false);
    expect(combat.reloading).toBeGreaterThan(0);
    combat.update(3.1);
    expect(combat.state).toEqual({ ammo: 1, reserve: 3, owned: true });
  });

  it('maxes mag and reserve for every owned gun, skipping fists and unowned weapons', () => {
    const combat = makeCombat();
    combat.grantWeapon('shotgun'); combat.loadout.pistol = { ammo: 0, reserve: 2, owned: true }; combat.loadout.shotgun = { ammo: 1, reserve: 0, owned: true };
    expect(combat.maxAmmo()).toBe(2);
    expect(combat.loadout.pistol).toEqual({ ammo: 12, reserve: 84 * 3, owned: true });
    expect(combat.loadout.shotgun).toEqual({ ammo: 6, reserve: 24 * 3, owned: true });
    expect(combat.loadout.smg).toEqual({ ammo: 0, reserve: 0, owned: false });
    expect(combat.loadout.rpg).toEqual({ ammo: 0, reserve: 0, owned: false });
    expect(combat.loadout.fists).toEqual({ ammo: 0, reserve: 0, owned: true });
    combat.grantWeapon('rpg');
    expect(combat.maxAmmo()).toBe(3);
    expect(combat.loadout.rpg).toEqual({ ammo: 1, reserve: 12, owned: true });
  });

  it('serializes and restores the loadout', () => {
    const combat = makeCombat();
    combat.grantWeapon('shotgun'); combat.select('shotgun'); combat.loadout.shotgun = { ammo: 2, reserve: 10, owned: true };
    const saved = combat.serialize();
    const fresh = makeCombat(); fresh.restore(saved);
    expect(fresh.current).toBe('shotgun');
    expect(fresh.state).toEqual({ ammo: 2, reserve: 10, owned: true });
  });
});
