import { describe, expect, it } from 'vitest';
import { AI_FREEZE_RADIUS, AI_THAW_RADIUS, PLAYER, resolveFrozen, TRAFFIC_SPEED_FACTOR, VEHICLE_SPECS, WEAPON_BY_ID, WEAPONS } from './config';
import { calculateDamage } from './core/GameRules';

describe('distance freeze hysteresis', () => {
  const sq = (value: number): number => value * value;

  it('freezes beyond the freeze radius and thaws only inside the thaw radius', () => {
    expect(AI_THAW_RADIUS).toBeLessThan(AI_FREEZE_RADIUS);
    expect(resolveFrozen(false, sq(AI_FREEZE_RADIUS + 1))).toBe(true);
    expect(resolveFrozen(false, sq(AI_FREEZE_RADIUS - 1))).toBe(false);
    expect(resolveFrozen(true, sq(AI_THAW_RADIUS - 1))).toBe(false);
  });

  it('holds state inside the hysteresis band so agents never flicker at the boundary', () => {
    const band = sq((AI_FREEZE_RADIUS + AI_THAW_RADIUS) / 2);
    expect(resolveFrozen(true, band)).toBe(true); // frozen stays frozen
    expect(resolveFrozen(false, band)).toBe(false); // active stays active
  });
});

describe('vehicle configuration', () => {
  it('gives each class a distinct handling role', () => {
    expect(VEHICLE_SPECS.sport.maxSpeed).toBeGreaterThan(VEHICLE_SPECS.compact.maxSpeed);
    expect(VEHICLE_SPECS.van.health).toBeGreaterThan(VEHICLE_SPECS.sport.health);
    expect(VEHICLE_SPECS.compact.steering).toBeGreaterThan(VEHICLE_SPECS.van.steering);
    for (const spec of Object.values(VEHICLE_SPECS)) expect(spec.acceleration).toBeGreaterThan(0);
    expect(VEHICLE_SPECS.sport.maxSpeed * TRAFFIC_SPEED_FACTOR * 3.6).toBeLessThan(75);
  });

  it('orders the two-wheelers bicycle < motorbike < superbike around the JMPD interceptor', () => {
    const { bicycle, motorbike, courier, superbike, police } = VEHICLE_SPECS;
    expect(bicycle.maxSpeed).toBeLessThan(motorbike.maxSpeed);
    expect(motorbike.maxSpeed).toBeLessThan(superbike.maxSpeed);
    expect(motorbike.maxSpeed).toBeGreaterThan(police.maxSpeed); // just barely outruns the law
    expect(motorbike.maxSpeed).toBeLessThanOrEqual(police.maxSpeed * 1.15);
    expect(superbike.maxSpeed).toBeGreaterThanOrEqual(police.maxSpeed * 1.4); // leaves it for dead
    expect(superbike.maxSpeed).toBeLessThanOrEqual(police.maxSpeed * 1.5);
    expect(bicycle.maxSpeed / PLAYER.sprintSpeed).toBeGreaterThanOrEqual(1.8); // about twice a sprint
    expect(bicycle.maxSpeed / PLAYER.sprintSpeed).toBeLessThanOrEqual(2.2);
    for (const spec of [bicycle, motorbike, courier, superbike]) { expect(spec.twoWheeler).toBe(true); expect(spec.saddle).toBeDefined(); expect(spec.size[0]).toBeLessThan(1); }
    expect(courier.name).toContain('Sixty-Sekonds');
    for (const spec of Object.values(VEHICLE_SPECS)) if (!spec.twoWheeler) expect(spec.saddle).toBeUndefined();
  });
});

describe('weapon configuration', () => {
  it('gives each weapon a distinct combat role', () => {
    expect(WEAPONS.map((spec) => spec.id)).toEqual(['fists', 'pistol', 'smg', 'shotgun', 'rpg', 'sniper']); // order sets wheel slots and digit keys: sniper is Digit6
    expect(WEAPON_BY_ID.fists.melee).toBe(true);
    expect(WEAPON_BY_ID.smg.auto).toBe(true);
    expect(WEAPON_BY_ID.pistol.auto).toBe(false);
    expect(WEAPON_BY_ID.smg.cooldown).toBeLessThan(WEAPON_BY_ID.pistol.cooldown);
    expect(WEAPON_BY_ID.smg.damage).toBeLessThan(WEAPON_BY_ID.pistol.damage);
    expect(WEAPON_BY_ID.shotgun.pellets).toBeGreaterThanOrEqual(6);
    expect(WEAPON_BY_ID.shotgun.pellets).toBeLessThanOrEqual(8);
    for (const spec of WEAPONS.filter((entry) => !entry.melee)) { expect(spec.magazine).toBeGreaterThan(0); expect(spec.reloadTime).toBeGreaterThan(0); expect(spec.sound.length).toBeGreaterThan(0); }
  });

  it('makes the rocket launcher a slow, scarce, projectile siege weapon', () => {
    const rpg = WEAPON_BY_ID.rpg;
    expect(rpg.projectile).toBeDefined();
    expect(rpg.magazine).toBe(1);
    expect(rpg.auto).toBe(false);
    expect(rpg.reloadTime).toBeGreaterThanOrEqual(2.5);
    expect(rpg.projectile!.speed).toBeGreaterThanOrEqual(55);
    expect(rpg.projectile!.speed).toBeLessThanOrEqual(70);
    expect(rpg.projectile!.radius).toBeGreaterThan(3);
    for (const spec of WEAPONS.filter((entry) => entry.id !== 'rpg')) expect(spec.projectile).toBeUndefined();
  });

  it('makes the sniper a slow, surgical, long-range one-shot rifle', () => {
    const sniper = WEAPON_BY_ID.sniper; const pistol = WEAPON_BY_ID.pistol;
    expect(sniper.starter).toBe(false);
    expect(sniper.auto).toBe(false); // semi-auto: one crack per click
    expect(sniper.spread).toBe(0);
    expect(sniper.pellets).toBe(1);
    expect(sniper.magazine).toBe(5);
    expect(sniper.reserve).toBe(15);
    expect(sniper.cooldown).toBeGreaterThanOrEqual(1.5); // the bolt cycle dwarfs every other trigger
    for (const spec of WEAPONS.filter((entry) => entry.id !== 'sniper')) expect(spec.cooldown).toBeLessThan(sniper.cooldown);
    expect(sniper.range).toBeGreaterThanOrEqual(400);
    expect(sniper.range).toBeLessThan(950); // stays inside the camera far plane
    expect(sniper.range).toBeGreaterThan(pistol.range * 3);
    expect(sniper.falloffFloor).toBe(1); // no falloff: full damage across the whole range
    expect(calculateDamage(sniper.damage, sniper.range, 0, sniper.falloffFloor)).toBe(sniper.damage);
    expect(sniper.damage).toBeGreaterThanOrEqual(100); // one-shots a 60-health ped anywhere in range
    expect(sniper.sound).toBe('sniper');
  });

  it('makes the shotgun devastating up close but capped at short range', () => {
    const shotgun = WEAPON_BY_ID.shotgun; const pistol = WEAPON_BY_ID.pistol;
    const closeBurst = calculateDamage(shotgun.damage, 4) * shotgun.pellets;
    expect(closeBurst).toBeGreaterThan(calculateDamage(pistol.damage, 4) * 2);
    expect(shotgun.range).toBeLessThan(pistol.range / 2);
  });

  it('gives every bullet weapon a gameplay-tuned muzzle velocity', () => {
    for (const spec of WEAPONS.filter((entry) => !entry.melee && !entry.projectile)) { expect(spec.bulletSpeed).toBeGreaterThan(200); expect(spec.bulletSpeed).toBeLessThan(400); } // fast enough to feel instant up close, slow enough to demand a lead at range
    expect(WEAPON_BY_ID.fists.bulletSpeed).toBeUndefined();
    expect(WEAPON_BY_ID.rpg.bulletSpeed).toBeUndefined(); // the rocket keeps its own ProjectileSpec speed
    const sniper = WEAPON_BY_ID.sniper;
    expect(170 / sniper.bulletSpeed!).toBeCloseTo(0.5, 2); // half a second to a mid-range target
    expect(sniper.range / sniper.bulletSpeed!).toBeGreaterThan(1); // over a second at max range: real leading required
    expect(sniper.bulletSpeed!).toBeGreaterThan(WEAPON_BY_ID.pistol.bulletSpeed!); // the rifle round is the fastest thing flying
    expect(WEAPON_BY_ID.smg.range / WEAPON_BY_ID.smg.bulletSpeed!).toBeLessThan(0.35); // spray stays effectively instant inside its envelope
    expect(sniper.tracer).toBe(true); // the long flight reads visually
    for (const spec of WEAPONS.filter((entry) => entry.id !== 'sniper')) expect(spec.tracer).toBeUndefined();
  });
});
