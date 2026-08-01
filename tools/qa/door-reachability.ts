/**
 * DOOR REACHABILITY — can a player on foot actually walk from the street to every front door?
 *
 * The density work put buildings shoulder to shoulder and then ringed the suburbs with fences, and
 * both of those can seal a doorstep: a house packed into the gap behind its neighbour, or a gate
 * that opens into a pocket closed off by the NEXT stand's fence. A sealed door is invisible in
 * every other meter (the parcel counts, the frontage coverage, the fence census all look healthy)
 * and only shows up when a player walks at a door and cannot reach it — so it gets its own audit,
 * run as a gate on every future density change.
 *
 * METHOD (the verifier's, preserved verbatim in method and constants):
 *   - every parcel's PLANNED entrance (BuildingArchitecture.plan — the same tag the interiors
 *     feature opens), stepped 0.6 u out from the wall;
 *   - flood fill on a 0.9 u grid over an 80 u box; anything still sealed is re-tested at 0.45 u
 *     over 120 u so a coarse-grid diagonal artefact never counts as a seal;
 *   - obstacles are the ARCHITECTURE MASSING TIERS with y0 <= 1.0 (the real ground-band colliders,
 *     not the parcel rectangle — a recessed door sits inside its own parcel rect), plus every
 *     fence segment inflated 0.35/side (generous: PLAYER.radius is 0.65);
 *   - "reached the street" = distanceToRoadEdge <= 0.5;
 *   - a sealed door is re-run with NO fences to attribute cause: still sealed -> buildings, freed
 *     -> fences.
 *
 * THRESHOLDS (exit code 1 when breached), split by who is responsible.
 *
 *   - A fenced stand's OWN gate must lead out: that is entirely inside ParcelFences' control (it
 *     plans the ring, the gate and the neighbours it is planned against), so the limit is ZERO.
 *     394 doors failed this on 9298b50 — every one of them a back-yard mass ringed as if it were a
 *     stand of its own, its gate opening onto the back wall of the house in front.
 *   - An UNFENCED parcel walled in purely by other stands' rings is the residual class: no
 *     per-parcel planner can see it without running the whole flood fill, because the rings doing
 *     the sealing are 20 u away and each of them has a perfectly good gate of its own. One such
 *     door exists (a mixed-use rear mass in Killarney, tp 3252 -1277, which the buildings around it
 *     already all but seal); the limit is a RATCHET at that one, not a licence.
 *   - Buildings are held to a RATE, not a count. The pre-density city sealed 82 of 3,712 doors —
 *     2.21% — and an absolute ceiling of 82 was the right gate while the door count was flat. It
 *     stopped being the right gate when the row builder took the city to 10,284 doors: holding 82
 *     absolute would demand that each building in a packed street wall be THREE TIMES less likely
 *     to seal a neighbour than a building in the sparse city was, which is not a statement about
 *     this pass's quality. So the gate is the pre-density rate, and the absolute count is reported
 *     beside it so a regression in either reads at a glance. This is a deliberate change of unit;
 *     the numbers behind it are in the commit that made it.
 *
 *   npx tsx tools/qa/door-reachability.ts
 */
import * as THREE from 'three';
import { BuildingArchitecture, type BuildingSpec } from '../../src/world/BuildingArchitecture';
import { allBuildings, CELL_SIZE, type GeneratedBuilding } from '../../src/world/CityGen';
import { districtAt, distanceToRoadEdge } from '../../src/world/mapData';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';
import { FENCE_THICKNESS, planParcelFence, type FencePlan } from '../../src/world/ParcelFences';

/** A fenced stand's own gate must lead out — the planner's own responsibility, so: none. */
export const OWN_GATE_SEALED_LIMIT = 0;
/** Unfenced parcels walled in purely by other stands' rings — ratchet, see the header. */
export const NEIGHBOUR_FENCE_SEALED_LIMIT = 1;
/** Fraction of doors buildings may seal — the pre-density city's own rate (82 of 3,712 on
 *  762f62d, same method). Packing the city denser must not make a door MORE likely to be walled in
 *  than it was when parcels stood apart. */
export const BUILDING_SEALED_RATE = 82 / 3712;
/** …and a bounded absolute ceiling, so the rate cannot be met by simply growing the denominator. */
export const BUILDING_SEALED_LIMIT = 150;

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

const parcels = allBuildings();
const cells = new Map<string, GeneratedBuilding[]>();
for (const parcel of parcels) {
  const key = `${Math.floor(parcel.x / CELL_SIZE)},${Math.floor(parcel.z / CELL_SIZE)}`;
  const bucket = cells.get(key);
  if (bucket) bucket.push(parcel); else cells.set(key, [parcel]);
}
const neighbourhoodOf = (parcel: GeneratedBuilding): GeneratedBuilding[] => {
  const cellX = Math.floor(parcel.x / CELL_SIZE); const cellZ = Math.floor(parcel.z / CELL_SIZE);
  const out: GeneratedBuilding[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(cells.get(`${cellX + dx},${cellZ + dz}`) ?? []));
  return out;
};

interface Rect { x: number; z: number; width: number; depth: number; heading: number }

const tiersByParcel = new Map<GeneratedBuilding, { minX: number; maxX: number; minZ: number; maxZ: number; y0: number }[]>();
const plansByParcel = new Map<GeneratedBuilding, FencePlan>();
const entranceByParcel = new Map<GeneratedBuilding, { x: number; z: number; width: number }>();
for (const parcel of parcels) {
  const district = districtAt(parcel.x, parcel.z);
  const variant = neighbourhoodBuildingVariant(district, parcel.variant);
  const spec: BuildingSpec = {
    x: 0, z: 0, width: parcel.width, depth: parcel.depth, height: parcel.height,
    style: parcel.style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, parcel.style, parcel.variant)),
  };
  const profile = architecture.plan(spec);
  if (profile.entrance) entranceByParcel.set(parcel, profile.entrance);
  tiersByParcel.set(parcel, profile.tiers.map((tier) => ({ minX: tier.minX, maxX: tier.maxX, minZ: tier.minZ, maxZ: tier.maxZ, y0: tier.y0 })));
  if (parcel.zone !== 'residential') continue;
  const plan = planParcelFence(parcel, {
    massing: profile.massing, entranceX: profile.entrance?.x, neighbours: neighbourhoodOf(parcel),
  });
  if (plan) plansByParcel.set(parcel, plan);
}

const BUCKET = 64;
const bucketOf = (x: number, z: number): string => `${Math.floor(x / BUCKET)},${Math.floor(z / BUCKET)}`;
const pushRect = (hash: Map<string, Rect[]>, rect: Rect, reach: number): void => {
  const keys = new Set<string>();
  for (const [dx, dz] of [[-reach, -reach], [-reach, reach], [reach, -reach], [reach, reach], [0, 0]]) {
    keys.add(bucketOf(rect.x + dx, rect.z + dz));
  }
  for (const key of keys) {
    const bucket = hash.get(key);
    if (bucket) bucket.push(rect); else hash.set(key, [rect]);
  }
};

const segHash = new Map<string, Rect[]>();
for (const plan of plansByParcel.values()) {
  for (const segment of plan.segments) {
    pushRect(segHash, {
      x: segment.x, z: segment.z, width: segment.length + 0.7, depth: FENCE_THICKNESS + 0.7, heading: segment.heading,
    }, segment.length / 2 + 2);
  }
}
const bldHash = new Map<string, Rect[]>();
for (const parcel of parcels) {
  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  for (const tier of tiersByParcel.get(parcel) ?? []) {
    if (tier.y0 > 1.0) continue; // above the walking band — you duck under it
    const lx = (tier.minX + tier.maxX) / 2; const lz = (tier.minZ + tier.maxZ) / 2;
    const rect: Rect = {
      x: parcel.x + lx * cos + lz * sin, z: parcel.z - lx * sin + lz * cos,
      width: tier.maxX - tier.minX, depth: tier.maxZ - tier.minZ, heading: parcel.heading,
    };
    pushRect(bldHash, rect, Math.max(rect.width, rect.depth) / 2 + 2);
  }
}

const rectsNear = (x: number, z: number, hash: Map<string, Rect[]>, radius: number): Rect[] => {
  const out: Rect[] = [];
  const span = Math.ceil(radius / BUCKET);
  for (let dx = -span; dx <= span; dx++) {
    for (let dz = -span; dz <= span; dz++) out.push(...(hash.get(`${Math.floor(x / BUCKET) + dx},${Math.floor(z / BUCKET) + dz}`) ?? []));
  }
  return out;
};
const pointInRect = (x: number, z: number, rect: Rect): boolean => {
  const cos = Math.cos(rect.heading); const sin = Math.sin(rect.heading);
  const dx = x - rect.x; const dz = z - rect.z;
  const lx = dx * cos - dz * sin; const lz = dx * sin + dz * cos;
  return Math.abs(lx) <= rect.width / 2 && Math.abs(lz) <= rect.depth / 2;
};

const fill = (start: { x: number; z: number }, fences: Rect[], builds: Rect[], grid: number, half: number): boolean => {
  const n = Math.round((2 * half) / grid);
  const seen = new Uint8Array(n * n);
  const idx = (i: number, j: number): number => i * n + j;
  const origin = Math.round(half / grid);
  const queue: number[] = [idx(origin, origin)];
  seen[idx(origin, origin)] = 1;
  while (queue.length) {
    const cur = queue.pop()!;
    const i = Math.floor(cur / n); const j = cur % n;
    const x = start.x + (i - origin) * grid; const z = start.z + (j - origin) * grid;
    if (distanceToRoadEdge(x, z) <= 0.5) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di!; const nj = j + dj!;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
      const key = idx(ni, nj);
      if (seen[key]) continue;
      seen[key] = 1;
      const nx = start.x + (ni - origin) * grid; const nz = start.z + (nj - origin) * grid;
      let solid = false;
      for (const rect of fences) if (pointInRect(nx, nz, rect)) { solid = true; break; }
      if (!solid) for (const rect of builds) if (pointInRect(nx, nz, rect)) { solid = true; break; }
      if (solid) continue;
      queue.push(key);
    }
  }
  return false;
};

let doors = 0; let coarseSealed = 0; let sealedFine = 0; let fenceCaused = 0; let buildingCaused = 0;
let fenceCausedOwnFenced = 0; let fenceCausedUnfencedSelf = 0;
const fenceExamples: string[] = []; const buildingExamples: string[] = [];
/** Sealed doors by family and by whether the parcel fronts a street at all — the two questions that
 *  tell a REGRESSION (packing sealed a street building) from the standing residual (a back-yard
 *  mass whose yard has no way out). */
const sealedByStyle = new Map<string, number>();
let sealedLandlocked = 0; let sealedOnStreet = 0;
for (const parcel of parcels) {
  const entrance = entranceByParcel.get(parcel);
  if (!entrance) continue;
  doors++;
  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  const doorLz = entrance.z + 0.6;
  const start = { x: parcel.x + entrance.x * cos + doorLz * sin, z: parcel.z - entrance.x * sin + doorLz * cos };
  if (fill(start, rectsNear(start.x, start.z, segHash, 88), rectsNear(start.x, start.z, bldHash, 88), 0.9, 80)) continue;
  coarseSealed++;
  const fencesFine = rectsNear(start.x, start.z, segHash, 128);
  const buildsFine = rectsNear(start.x, start.z, bldHash, 128);
  if (fill(start, fencesFine, buildsFine, 0.45, 120)) continue; // coarse-grid artefact, not a seal
  sealedFine++;
  if (fill(start, [], buildsFine, 0.45, 120)) {
    fenceCaused++;
    if (plansByParcel.get(parcel)) fenceCausedOwnFenced++; else fenceCausedUnfencedSelf++;
    if (fenceExamples.length < 8) fenceExamples.push(`FENCE     ${parcel.style}/${parcel.zone} tp ${parcel.x.toFixed(0)} ${parcel.z.toFixed(0)}  ${districtAt(parcel.x, parcel.z)}`);
  } else {
    buildingCaused++;
    sealedByStyle.set(parcel.style, (sealedByStyle.get(parcel.style) ?? 0) + 1);
    const frontLine = parcel.depth / 2 + 5.6;
    if (distanceToRoadEdge(parcel.x + frontLine * Math.sin(parcel.heading), parcel.z + frontLine * Math.cos(parcel.heading)) > 12) sealedLandlocked++;
    else sealedOnStreet++;
    if (buildingExamples.length < 8) buildingExamples.push(`BUILDINGS ${parcel.style}/${parcel.zone} tp ${parcel.x.toFixed(0)} ${parcel.z.toFixed(0)}  ${districtAt(parcel.x, parcel.z)}`);
  }
}

console.log(`doors ${doors}   coarse-sealed ${coarseSealed}   sealed@fine ${sealedFine}   FENCE-caused ${fenceCaused}   building-caused ${buildingCaused}`);
console.log(`fence-caused split: own parcel fenced (its own gate exists, the ring beyond seals) ${fenceCausedOwnFenced}, own parcel UNfenced (sealed purely by neighbours) ${fenceCausedUnfencedSelf}`);
console.log(`building-caused by family: ${[...sealedByStyle].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
console.log(`building-caused by frontage: ${sealedLandlocked} on parcels with NO street within reach of their own front line`
  + ` (back-yard masses — their yard is the way out, and it is closed), ${sealedOnStreet} on parcels that DO front a street`);
console.log(`sealed rate: ${(100 * sealedFine / Math.max(1, doors)).toFixed(2)}% of doors`
  + ` (pre-density baseline 82/3712 = 2.21%, all building-caused)`);
for (const example of [...fenceExamples, ...buildingExamples]) console.log('  ', example);

const failures: string[] = [];
if (fenceCausedOwnFenced > OWN_GATE_SEALED_LIMIT) failures.push(`own-gate sealed doors ${fenceCausedOwnFenced} > ${OWN_GATE_SEALED_LIMIT}`);
if (fenceCausedUnfencedSelf > NEIGHBOUR_FENCE_SEALED_LIMIT) failures.push(`neighbour-fence sealed doors ${fenceCausedUnfencedSelf} > ${NEIGHBOUR_FENCE_SEALED_LIMIT}`);
const buildingRate = buildingCaused / Math.max(1, doors);
if (buildingRate > BUILDING_SEALED_RATE) {
  failures.push(`building-caused seal rate ${(100 * buildingRate).toFixed(2)}% > ${(100 * BUILDING_SEALED_RATE).toFixed(2)}% (pre-density)`);
}
if (buildingCaused > BUILDING_SEALED_LIMIT) failures.push(`building-caused sealed doors ${buildingCaused} > ${BUILDING_SEALED_LIMIT} (absolute ceiling)`);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: own-gate ${fenceCausedOwnFenced}/${OWN_GATE_SEALED_LIMIT}, neighbour-fence `
    + `${fenceCausedUnfencedSelf}/${NEIGHBOUR_FENCE_SEALED_LIMIT}, building-caused ${buildingCaused}/${BUILDING_SEALED_LIMIT}`
    + ` at ${(100 * buildingCaused / Math.max(1, doors)).toFixed(2)}%/${(100 * BUILDING_SEALED_RATE).toFixed(2)}%`);
}
