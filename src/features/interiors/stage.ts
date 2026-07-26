/**
 * Where an interior actually stands in the world — the decision the whole feature turns on.
 *
 * A room cannot go INSIDE its building: City.buildOneBuilding pushes one collider per massing tier,
 * so a procedural building is a solid block and City.clampMoveAt freezes both axes for anyone stood
 * in one. Splicing that collider back out would corrupt City's incremental collider index, which is
 * append-only by construction.
 *
 * A room cannot float ABOVE its building either: Player.update grounds the player on
 * City.supportHeight, which is max(terrain, collider tops, prop tops) — and the feature API exposes
 * no way to register a collider or a prop. A floor above the terrain is a floor you fall through.
 *
 * So an interior is built on REAL GROUND, on the nearest flat, road-free, building-free plot to its
 * own doorstep, and the player is walked there behind a fade. Keeping the plot NEAR is what makes
 * that safe: ChunkVisibility.CHUNK_VISIBLE_RANGE is 2500 world units, and every plot this search
 * returns is a few hundred units from the door, so not one building chunk, ambient pedestrian or
 * mission distance changes while you are inside. No host-level modal freeze flag is needed, which
 * is why this feature touches Game.ts not at all.
 *
 * The search is a deterministic outward ring scan — no Math.random, no Date — so the same door
 * always resolves to the same plot in the same build.
 */
import { CELL_SIZE, generateCell } from '../../world/CityGen';
import { scatterCell } from '../../world/ModelScatter';
import { distanceToRoadEdge, pointInAnyPolygon, ROAD_EDGE_CAP, WATER_POLYGONS } from '../../world/mapData';

export interface StagePlot { x: number; z: number; y: number }

/** Clear radius a plot must have: the biggest room half-diagonal plus the camera boom that will
 *  swing outside it (FOOT_VIEW_DISTANCES tops out at 9.5). */
export const PLOT_RADIUS = 20;
/** How flat the ground must be across the plot. Under PLAYER.stepUp (0.55) with room to spare, so
 *  the player stays grounded on the raised floor instead of falling and taking landing damage. */
export const PLOT_FLATNESS = 0.4;

interface Blocker { x: number; z: number; r: number }

const cells = new Map<string, Map<string, Blocker[]>>();
const BUCKET = 64;

/** Everything solid the generators would put in one chunk cell, bucketed so a plot test is O(9). */
function cellBlockers(cellX: number, cellZ: number): Map<string, Blocker[]> {
  const key = `${cellX},${cellZ}`;
  let grid = cells.get(key);
  if (grid) return grid;
  grid = new Map<string, Blocker[]>();
  const put = (blocker: Blocker): void => {
    const bx = Math.floor(blocker.x / BUCKET); const bz = Math.floor(blocker.z / BUCKET);
    const bucketKey = `${bx},${bz}`;
    const bucket = grid!.get(bucketKey);
    if (bucket) bucket.push(blocker); else grid!.set(bucketKey, [blocker]);
  };
  for (const building of generateCell(cellX, cellZ)) put({ x: building.x, z: building.z, r: Math.hypot(building.width, building.depth) / 2 });
  for (const model of scatterCell(cellX, cellZ)) put({ x: model.x, z: model.z, r: 3 });
  cells.set(key, grid);
  return grid;
}

function clearOfGeneratedWorld(x: number, z: number, radius: number): boolean {
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
    const px = x + ox * radius; const pz = z + oz * radius;
    const grid = cellBlockers(Math.floor(px / CELL_SIZE), Math.floor(pz / CELL_SIZE));
    const bx = Math.floor(px / BUCKET); const bz = Math.floor(pz / BUCKET);
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      for (const blocker of grid.get(`${bx + gx},${bz + gz}`) ?? []) {
        if (Math.hypot(blocker.x - x, blocker.z - z) < blocker.r + radius) return false;
      }
    }
  }
  return true;
}

/** Highest minus lowest ground across the plot, plus the highest point (the floor sits on it, so
 *  the built floor never has terrain poking through it). */
function ground(x: number, z: number, radius: number, surfaceHeightAt: (x: number, z: number) => number): { spread: number; top: number } {
  let low = Infinity; let high = -Infinity;
  const sample = (px: number, pz: number): void => { const h = surfaceHeightAt(px, pz); if (h < low) low = h; if (h > high) high = h; };
  sample(x, z);
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    sample(x + Math.cos(angle) * radius * 0.5, z + Math.sin(angle) * radius * 0.5);
    sample(x + Math.cos(angle) * radius, z + Math.sin(angle) * radius);
  }
  return { spread: high - low, top: high };
}

/**
 * The nearest plot to `near` that an interior can stand on. Rings outward in fixed 40u steps at 24
 * fixed bearings, so the answer is a pure function of the door and the map.
 */
export function findStagePlot(near: { x: number; z: number }, surfaceHeightAt: (x: number, z: number) => number, radius = PLOT_RADIUS): StagePlot | undefined {
  for (let ring = 1; ring <= 30; ring++) {
    const distance = 50 + ring * 40;
    for (let bearing = 0; bearing < 24; bearing++) {
      const angle = (bearing / 24) * Math.PI * 2;
      const x = near.x + Math.cos(angle) * distance;
      const z = near.z + Math.sin(angle) * distance;
      // Clear of every road SURFACE by the full grid cap: no traffic, no pavement, no ambient
      // pedestrians routed through the middle of somebody's lounge.
      if (distanceToRoadEdge(x, z) < ROAD_EDGE_CAP - 0.1) continue;
      if (pointInAnyPolygon(WATER_POLYGONS, x, z)) continue;
      if (!clearOfGeneratedWorld(x, z, radius)) continue;
      const shape = ground(x, z, radius, surfaceHeightAt);
      if (shape.spread > PLOT_FLATNESS) continue;
      return { x, z, y: shape.top + 0.03 };
    }
  }
  return undefined;
}

/** Test seam: drops the per-cell blocker cache so a suite can rebuild it. */
export function resetStageCache(): void { cells.clear(); }
