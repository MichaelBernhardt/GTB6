import { describe, expect, it } from 'vitest';
import { PLAYER_SPAWN } from './placements';
import {
  CBD_HERO_ACTIVITY_BATCH_BUDGET,
  CBD_HERO_FACADE_ROLES,
  CBD_HERO_HALF_WIDTH,
  CBD_HERO_LENGTH,
  CBD_HERO_OPENING_PEDESTRIANS,
  CBD_HERO_TREE_BUDGET,
  cbdHeroFacadeRole,
  cbdHeroRoadXAt,
  createCbdHeroCorridorPlan,
  inCbdHeroCorridor,
  selectCbdHeroPedestrianSites,
} from './cbdHeroCorridor';

const spawn = { x: PLAYER_SPAWN[0], z: PLAYER_SPAWN[2] };

describe('default-spawn CBD hero corridor', () => {
  it('is deterministic and keeps every authored item inside the bounded 165m workstream', () => {
    const first = createCbdHeroCorridorPlan(spawn);
    expect(createCbdHeroCorridorPlan(spawn)).toEqual(first);
    const sites = [...first.activitySites, ...first.jacarandaSites, ...first.pedestrianSites, ...first.parkedVehicles, first.mineHeadgear];
    for (const site of sites) {
      expect(spawn.z - site.z).toBeGreaterThanOrEqual(0);
      expect(spawn.z - site.z).toBeLessThanOrEqual(CBD_HERO_LENGTH);
      expect(Math.abs(site.x - cbdHeroRoadXAt(spawn, site.z))).toBeLessThanOrEqual(CBD_HERO_HALF_WIDTH);
      expect(inCbdHeroCorridor(spawn, site.x, site.z)).toBe(true);
    }
  });

  it('budgets a legible opening crowd, vehicle layer, trees, and instanced activity batches', () => {
    const plan = createCbdHeroCorridorPlan(spawn);
    expect(plan.pedestrianSites).toHaveLength(CBD_HERO_OPENING_PEDESTRIANS);
    expect(plan.parkedVehicles.filter((vehicle) => vehicle.kind === 'taxi')).toHaveLength(2);
    expect(plan.parkedVehicles.filter((vehicle) => vehicle.kind === 'van')).toHaveLength(2);
    expect(plan.jacarandaSites.length).toBeLessThanOrEqual(CBD_HERO_TREE_BUDGET);
    expect(CBD_HERO_ACTIVITY_BATCH_BUDGET).toBeLessThanOrEqual(9);
  });

  it('offers all eight non-repeating facade grammars down the two kerbs', () => {
    const roles = new Set<string>();
    for (let along = 8; along <= 160; along += 11) {
      const z = spawn.z - along; const roadX = cbdHeroRoadXAt(spawn, z);
      roles.add(cbdHeroFacadeRole(spawn, roadX - 28, z)!);
      roles.add(cbdHeroFacadeRole(spawn, roadX + 28, z)!);
    }
    expect([...roles].sort()).toEqual([...CBD_HERO_FACADE_ROLES].sort());
  });

  it('snaps the hero crowd deterministically and leaves remote resume crowds alone', () => {
    const plan = createCbdHeroCorridorPlan(spawn);
    const points = plan.pedestrianSites.flatMap((point) => [point, { x: point.x + 2, z: point.z + 2 }]);
    expect(selectCbdHeroPedestrianSites(plan, points, spawn)).toEqual(plan.pedestrianSites);
    expect(selectCbdHeroPedestrianSites(plan, points, { x: spawn.x + 1_000, z: spawn.z })).toEqual([]);
  });
});
