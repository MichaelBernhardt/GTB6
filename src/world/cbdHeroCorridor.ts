/**
 * A deliberately small authored layer around the default CBD spawn. The generated city remains the
 * source of truth; this plan only gives the first 165 metres of Risk-It Street a memorable rhythm.
 * Keeping the arithmetic here pure makes every placement reproducible and gives QA one place to
 * enforce the corridor's spatial and draw-call budgets.
 */

export interface XZ { x: number; z: number }

export const CBD_HERO_LENGTH = 165;
export const CBD_HERO_HALF_WIDTH = 54;
export const CBD_HERO_ACTIVITY_BATCH_BUDGET = 9;
export const CBD_HERO_TREE_BUDGET = 3;
export const CBD_HERO_OPENING_PEDESTRIANS = 10;

export const CBD_HERO_FACADE_ROLES = [
  'heritage-arcade',
  'art-deco',
  'curtain-wall',
  'brutalist-shades',
  'balcony-stack',
  'green-screen',
  'heritage-veranda',
  'gold-fins',
] as const;

export type CbdHeroFacadeRole = typeof CBD_HERO_FACADE_ROLES[number];

export interface CbdHeroVehicle extends XZ {
  kind: 'taxi' | 'van';
  heading: number;
  color?: number;
}

export interface CbdHeroCorridorPlan {
  spawn: XZ;
  activitySites: Array<XZ & { kind: 'produce' | 'braai' | 'taxi-rank' }>;
  jacarandaSites: XZ[];
  pedestrianSites: XZ[];
  parkedVehicles: CbdHeroVehicle[];
  mineHeadgear: XZ;
}

/** Risk-It Street bends gently west as it runs north from the spawn. */
export function cbdHeroRoadXAt(spawn: XZ, z: number): number {
  return spawn.x + 9.4 + (z - spawn.z) * 0.125;
}

export function inCbdHeroCorridor(spawn: XZ, x: number, z: number): boolean {
  const along = spawn.z - z;
  return along >= -18 && along <= CBD_HERO_LENGTH
    && Math.abs(x - cbdHeroRoadXAt(spawn, z)) <= CBD_HERO_HALF_WIDTH;
}

/**
 * Eight grammars cycle down each kerb, with the opposite side phase-shifted. The small stable
 * coordinate term breaks a same-depth pair without introducing randomness or new material families.
 */
export function cbdHeroFacadeRole(spawn: XZ, x: number, z: number): CbdHeroFacadeRole | undefined {
  if (!inCbdHeroCorridor(spawn, x, z)) return undefined;
  const side = x >= cbdHeroRoadXAt(spawn, z) ? 1 : 0;
  const band = Math.max(0, Math.floor((spawn.z - z + 8) / 19));
  const nudge = Math.abs(Math.floor(x * 0.17 + z * 0.11)) % 2;
  return CBD_HERO_FACADE_ROLES[(band + side * 3 + nudge) % CBD_HERO_FACADE_ROLES.length];
}

const sidewalk = (spawn: XZ, z: number, side: -1 | 1): XZ => ({
  x: cbdHeroRoadXAt(spawn, z) + side * 8.9,
  z,
});

const lane = (spawn: XZ, z: number, side: -1 | 1): XZ => ({
  x: cbdHeroRoadXAt(spawn, z) + side * 6.0,
  z,
});

export function createCbdHeroCorridorPlan(spawn: XZ): CbdHeroCorridorPlan {
  const activitySites: CbdHeroCorridorPlan['activitySites'] = [
    { ...sidewalk(spawn, spawn.z - 27, -1), x: cbdHeroRoadXAt(spawn, spawn.z - 27) - 13.0, kind: 'taxi-rank' },
    { ...sidewalk(spawn, spawn.z - 42, -1), x: cbdHeroRoadXAt(spawn, spawn.z - 42) - 13.1, kind: 'produce' },
    { ...sidewalk(spawn, spawn.z - 78, -1), x: cbdHeroRoadXAt(spawn, spawn.z - 78) - 13.3, kind: 'braai' },
    { ...sidewalk(spawn, spawn.z - 116, 1), x: cbdHeroRoadXAt(spawn, spawn.z - 116) + 12.7, kind: 'taxi-rank' },
  ];
  const jacarandaSites = [
    { x: cbdHeroRoadXAt(spawn, spawn.z - 60) - 15.8, z: spawn.z - 60 },
    { x: cbdHeroRoadXAt(spawn, spawn.z - 103) - 16.2, z: spawn.z - 103 },
    { x: cbdHeroRoadXAt(spawn, spawn.z - 145) + 15.4, z: spawn.z - 145 },
  ];
  const pedestrianSites: XZ[] = [
    sidewalk(spawn, spawn.z - 21, -1), sidewalk(spawn, spawn.z - 24, 1),
    sidewalk(spawn, spawn.z - 34, -1), sidewalk(spawn, spawn.z - 38, 1),
    sidewalk(spawn, spawn.z - 50, -1), sidewalk(spawn, spawn.z - 55, 1),
    sidewalk(spawn, spawn.z - 66, -1), sidewalk(spawn, spawn.z - 72, 1),
    sidewalk(spawn, spawn.z - 84, -1), sidewalk(spawn, spawn.z - 92, 1),
  ];
  const parkedVehicles: CbdHeroVehicle[] = [
    { ...lane(spawn, spawn.z - 57, -1), kind: 'taxi', heading: Math.PI },
    { ...lane(spawn, spawn.z - 89, 1), kind: 'van', heading: 0, color: 0xe3e0d7 },
    { ...lane(spawn, spawn.z - 126, -1), kind: 'taxi', heading: Math.PI },
    { ...lane(spawn, spawn.z - 157, 1), kind: 'van', heading: 0, color: 0xb9c0b8 },
  ];
  return {
    spawn: { ...spawn }, activitySites, jacarandaSites, pedestrianSites, parkedVehicles,
    mineHeadgear: { x: cbdHeroRoadXAt(spawn, spawn.z - 151) - 14.6, z: spawn.z - 151 },
  };
}

/** Snap the authored crowd anchors to real navigation points. Remote save games deliberately return
 * an empty list so the ordinary resume-point crowd policy remains untouched. */
export function selectCbdHeroPedestrianSites(
  plan: CbdHeroCorridorPlan,
  sidewalkPoints: readonly XZ[],
  resume: XZ,
  maxSnap = 20,
): XZ[] {
  if (Math.hypot(resume.x - plan.spawn.x, resume.z - plan.spawn.z) > 45) return [];
  const selected: XZ[] = [];
  const used = new Set<number>();
  for (const anchor of plan.pedestrianSites) {
    let bestIndex = -1; let bestDistance = maxSnap * maxSnap;
    sidewalkPoints.forEach((point, index) => {
      if (used.has(index)) return;
      const distance = (point.x - anchor.x) ** 2 + (point.z - anchor.z) ** 2;
      if (distance < bestDistance) { bestDistance = distance; bestIndex = index; }
    });
    if (bestIndex < 0) continue;
    used.add(bestIndex); selected.push(sidewalkPoints[bestIndex]!);
  }
  return selected;
}
