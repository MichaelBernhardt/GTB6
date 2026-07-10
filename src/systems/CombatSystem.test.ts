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

  it('launches a visible projectile for the rocket launcher instead of hitscan', () => {
    const combat = makeCombat();
    const launches: Array<{ origin: THREE.Vector3; direction: THREE.Vector3 }> = [];
    combat.onRocket = (rocketOrigin, direction) => launches.push({ origin: rocketOrigin.clone(), direction: direction.clone() });
    combat.select('rpg'); combat.update(0.5);
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

  it('serializes and restores the loadout', () => {
    const combat = makeCombat();
    combat.grantWeapon('shotgun'); combat.select('shotgun'); combat.loadout.shotgun = { ammo: 2, reserve: 10, owned: true };
    const saved = combat.serialize();
    const fresh = makeCombat(); fresh.restore(saved);
    expect(fresh.current).toBe('shotgun');
    expect(fresh.state).toEqual({ ammo: 2, reserve: 10, owned: true });
  });
});
