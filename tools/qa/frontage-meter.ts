/**
 * Street-frontage fill meter — the regression instrument behind the city-density work.
 *
 * Walks every road >= 6 u wide at 8 u arc pitch, BOTH sides, drops a frontage sample one sidewalk
 * apron beyond the kerb (exactly where CityGen anchors a lot), classifies the sample's zone, then
 * probes inward along the frontage normal for a building OBB within 16 u (block fill) and 8 u
 * (a true street wall). Coverage = covered samples / all samples in the zone — the denominator is
 * always the full sample count, never just the built lots, so "84% of CBD kerb faces nothing"
 * (the pre-density baseline) is directly comparable run over run.
 *
 * Also reports: per-zone parcel counts, capped chunk cells (buildings silently dropped at
 * CELL_BUILDING_CAP), the shop-bay census for the downtown family (plan()-derived, the same
 * arithmetic the builder draws from), and an OBB interpenetration audit for the street-wall CBD
 * (deep overlaps would mean the occupancy relaxation went too far).
 *
 *   npx tsx tools/qa/frontage-meter.ts
 */
import * as THREE from 'three';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, planShopBays, type BuildingSpec } from '../../src/world/BuildingArchitecture';
import { allBuildings, buildingStats, CELL_BUILDING_CAP, footprintOverlapXZ, urbanIntensity, type GeneratedBuilding } from '../../src/world/CityGen';
import { GENERATED_ROADS, districtAt } from '../../src/world/mapData';
import { classifyZone } from '../../src/world/data/zoning';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

const FRONTAGE_CLEARANCE = 3.05; // matches CityGen's sidewalk apron
const STEP = 8;
const NEAR = 8; const FAR = 16;

// ---- building spatial hash (64 u cells over each building's world AABB) ----------------------
const HASH_CELL = 64;
const hash = new Map<string, GeneratedBuilding[]>();
const buildings = allBuildings();
for (const b of buildings) {
  const c = Math.cos(b.heading); const s = Math.sin(b.heading);
  const ex = Math.abs(b.width / 2 * c) + Math.abs(b.depth / 2 * s);
  const ez = Math.abs(b.width / 2 * s) + Math.abs(b.depth / 2 * c);
  for (let cx = Math.floor((b.x - ex) / HASH_CELL); cx <= Math.floor((b.x + ex) / HASH_CELL); cx++) {
    for (let cz = Math.floor((b.z - ez) / HASH_CELL); cz <= Math.floor((b.z + ez) / HASH_CELL); cz++) {
      const key = `${cx},${cz}`;
      const bucket = hash.get(key);
      if (bucket) bucket.push(b); else hash.set(key, [b]);
    }
  }
}

function insideOBB(b: GeneratedBuilding, x: number, z: number): boolean {
  const c = Math.cos(b.heading); const s = Math.sin(b.heading);
  const dx = x - b.x; const dz = z - b.z;
  const lx = dx * c - dz * s; const lz = dx * s + dz * c;
  return Math.abs(lx) <= b.width / 2 && Math.abs(lz) <= b.depth / 2;
}

function coveredWithin(x: number, z: number, nx: number, nz: number, reach: number): boolean {
  for (let t = 0.5; t <= reach; t += 1.5) {
    const px = x + nx * t; const pz = z + nz * t;
    for (const b of hash.get(`${Math.floor(px / HASH_CELL)},${Math.floor(pz / HASH_CELL)}`) ?? []) {
      if (insideOBB(b, px, pz)) return true;
    }
  }
  return false;
}

// ---- frontage walk ---------------------------------------------------------------------------
interface ZoneTally { samples: number; near: number; far: number; }
const zones = new Map<string, ZoneTally>();
// Residential coverage BY DISTRICT — the suburbs-density pass is judged per suburb, not citywide,
// so a packed Greenside can't hide an empty Chartwell. Same samples, same probe, keyed by the
// nearest district centre (exactly the lookup zoning itself uses).
const residentialDistricts = new Map<string, ZoneTally>();
for (const road of GENERATED_ROADS) {
  if (road.width < 6) continue;
  const half = road.width / 2;
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i]!; const b = road.points[i + 1]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const dirX = dx / length; const dirZ = dz / length;
    const steps = Math.max(1, Math.floor(length / STEP));
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const px = a.x + dx * t; const pz = a.z + dz * t;
      for (const side of [1, -1] as const) {
        const nx = side * -dirZ; const nz = side * dirX;
        const fx = px + nx * (half + FRONTAGE_CLEARANCE);
        const fz = pz + nz * (half + FRONTAGE_CLEARANCE);
        const zone = classifyZone(fx, fz, road.width);
        if (zone === 'none') continue;
        let tally = zones.get(zone);
        if (!tally) { tally = { samples: 0, near: 0, far: 0 }; zones.set(zone, tally); }
        tally.samples++;
        const far = coveredWithin(fx, fz, nx, nz, FAR);
        const near = far && coveredWithin(fx, fz, nx, nz, NEAR);
        if (far) tally.far++;
        if (near) tally.near++;
        if (zone === 'residential') {
          const name = districtAt(fx, fz);
          let dt = residentialDistricts.get(name);
          if (!dt) { dt = { samples: 0, near: 0, far: 0 }; residentialDistricts.set(name, dt); }
          dt.samples++;
          if (far) dt.far++;
          if (near) dt.near++;
        }
      }
    }
  }
}

console.log(`frontage samples (roads >= 6 u wide, ${STEP} u pitch, both sides), coverage by building OBB probe:`);
for (const [zone, tally] of [...zones].sort((x, y) => y[1].samples - x[1].samples)) {
  console.log(`  ${zone.padEnd(20)} samples ${String(tally.samples).padStart(6)}   within ${FAR}u ${(100 * tally.far / tally.samples).toFixed(1).padStart(5)}%   within ${NEAR}u ${(100 * tally.near / tally.samples).toFixed(1).padStart(5)}%`);
}

const bigDistricts = [...residentialDistricts].filter(([, t]) => t.samples >= 300).sort((x, y) => y[1].samples - x[1].samples);
console.log(`\nresidential frontage by district (districts with >= 300 samples, ${bigDistricts.length} of ${residentialDistricts.size}):`);
for (const [name, tally] of bigDistricts) {
  console.log(`  ${name.padEnd(24)} samples ${String(tally.samples).padStart(5)}   within ${FAR}u ${(100 * tally.far / tally.samples).toFixed(1).padStart(5)}%   within ${NEAR}u ${(100 * tally.near / tally.samples).toFixed(1).padStart(5)}%`);
}

// ---- parcel stats ----------------------------------------------------------------------------
const stats = buildingStats();
console.log(`\nparcels: ${stats.total} buildings in ${stats.cells} cells (cap ${CELL_BUILDING_CAP}); max/cell ${stats.maxPerCell}; capped cells ${stats.cappedCells}`);
console.log(`  per zone: ${Object.entries(stats.perZone).map(([zone, count]) => `${zone} ${count}`).join(', ')}`);

// ---- shop-bay census (downtown family, plan()-derived — same arithmetic the builder draws) ----
const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial(); const roof = new THREE.MeshBasicMaterial();
let downtown = 0; let withBays = 0; let totalBays = 0; let shuttered = 0;
for (const building of buildings) {
  if (building.style !== 'downtown') continue;
  downtown++;
  const district = districtAt(building.x, building.z);
  const variant = neighbourhoodBuildingVariant(district, building.variant);
  const spec: BuildingSpec = {
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, building.style, building.variant)),
  };
  const profile = architecture.plan(spec);
  const massing = variant % ARCHITECTURE_VARIANTS.downtown;
  const bays = planShopBays(profile.tiers, building.width, building.height, massing, variant, profile.entrance);
  if (bays.length > 0) { withBays++; totalBays += bays.length; shuttered += bays.length; }
}
console.log(`\nshopfronts (downtown family): ${withBays}/${downtown} buildings carry shop bays (${(100 * withBays / Math.max(1, downtown)).toFixed(1)}%), ${totalBays} bays total, ${shuttered} night shutters`);

// ---- THE GRADIENT, BY RING ---------------------------------------------------------------------
// The owner's rule is that buildings get smaller and sparser away from the CBD, so it has to be
// legible as a monotone table, not asserted in prose. Rings are bands of urbanIntensity — the same
// function the generator grades on — and every column is measured off the built parcels.
const RINGS: Array<{ name: string; lo: number; hi: number }> = [
  { name: 'inner city   (>=0.80)', lo: 0.8, hi: 1.01 },
  { name: 'middle ring  (0.35-0.80)', lo: 0.35, hi: 0.8 },
  { name: 'outer suburb (0.05-0.35)', lo: 0.05, hi: 0.35 },
  { name: 'boondocks    (<0.05)', lo: -0.01, hi: 0.05 },
];
interface RingTally { samples: number; near: number; far: number; parcels: number; dense: number; area: number; height: number; }
const ringFrontage = RINGS.map((): RingTally => ({ samples: 0, near: 0, far: 0, parcels: 0, dense: 0, area: 0, height: 0 }));
const ringOf = (x: number, z: number): number => {
  const urban = urbanIntensity(x, z);
  return RINGS.findIndex((ring) => urban >= ring.lo && urban < ring.hi);
};
for (const building of buildings) {
  if (building.zone !== 'residential') continue;
  const ring = ringFrontage[ringOf(building.x, building.z)];
  if (!ring) continue;
  ring.parcels++;
  if (building.style === 'dense-residential') ring.dense++;
  ring.area += building.width * building.depth;
  ring.height += building.height;
}
for (const road of GENERATED_ROADS) {
  if (road.width < 6) continue;
  const half = road.width / 2;
  for (let i = 0; i < road.points.length - 1; i++) {
    const a = road.points[i]!; const b = road.points[i + 1]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz);
    if (length < 0.01) continue;
    const dirX = dx / length; const dirZ = dz / length;
    const steps = Math.max(1, Math.floor(length / STEP));
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const px = a.x + dx * t; const pz = a.z + dz * t;
      for (const side of [1, -1] as const) {
        const nx = side * -dirZ; const nz = side * dirX;
        const fx = px + nx * (half + FRONTAGE_CLEARANCE); const fz = pz + nz * (half + FRONTAGE_CLEARANCE);
        if (classifyZone(fx, fz, road.width) !== 'residential') continue;
        const ring = ringFrontage[ringOf(fx, fz)];
        if (!ring) continue;
        ring.samples++;
        // BOTH probes, because the gradient moves the house BACK as well as apart: an outer stand's
        // front garden alone is deeper than the 8 u probe, so the 8 u column measures the street
        // wall and the 16 u column measures whether a house is there at all.
        if (coveredWithin(fx, fz, nx, nz, FAR)) { ring.far++; if (coveredWithin(fx, fz, nx, nz, NEAR)) ring.near++; }
      }
    }
  }
}
console.log('\nTHE GRADIENT — residential, by ring of urbanIntensity (the generator\'s own signal):');
console.log('  ring                        kerb samples  built within 8u   parcels  dense-res   avg footprint   avg height');
for (const [index, ring] of RINGS.entries()) {
  const tally = ringFrontage[index]!;
  console.log(`  ${ring.name.padEnd(26)}${String(tally.samples).padStart(12)}`
    + `${(100 * tally.far / Math.max(1, tally.samples)).toFixed(1).padStart(11)}%`
    + `${(100 * tally.near / Math.max(1, tally.samples)).toFixed(1).padStart(10)}%`
    + `${String(tally.parcels).padStart(10)}`
    + `${(100 * tally.dense / Math.max(1, tally.parcels)).toFixed(0).padStart(10)}%`
    + `${(tally.area / Math.max(1, tally.parcels)).toFixed(0).padStart(14)} u²`
    + `${(tally.height / Math.max(1, tally.parcels)).toFixed(1).padStart(12)} u`);
}

// ---- HOW PACKED IS THE ROW? ------------------------------------------------------------------
// Coverage says how much kerb has a building behind it; this says whether those buildings TOUCH.
// It is the number that separates "denser scatter" from "a street wall", and the suburban control
// row is the point: the owner's rule is that the inner city has no gaps and the low-density suburbs
// do, so the contrast has to be measurable, not just claimed.
console.log('\nside gap to the nearest neighbour along the street (0 = party wall):');
for (const [label, pick] of [
  ['commercial-highrise', (b: GeneratedBuilding) => b.zone === 'commercial-highrise'],
  ['dense-residential', (b: GeneratedBuilding) => b.style === 'dense-residential'],
  ['suburban (control)', (b: GeneratedBuilding) => b.style === 'suburban'],
] as const) {
  const gaps: number[] = [];
  for (const building of buildings) {
    if (!pick(building)) continue;
    let best = Infinity;
    const cos = Math.cos(building.heading); const sin = Math.sin(building.heading);
    for (const side of [-1, 1]) {
      for (let t = 0.05; t <= 14; t += 0.25) {
        const px = building.x + side * (building.width / 2 + t) * cos;
        const pz = building.z - side * (building.width / 2 + t) * sin;
        let hit = false;
        for (const other of hash.get(`${Math.floor(px / HASH_CELL)},${Math.floor(pz / HASH_CELL)}`) ?? []) {
          if (other !== building && insideOBB(other, px, pz)) { hit = true; break; }
        }
        if (hit) { best = Math.min(best, t); break; }
      }
    }
    if (best < Infinity) gaps.push(best);
  }
  gaps.sort((a, b) => a - b);
  const quantile = (q: number): string => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!.toFixed(2) : 'n/a');
  const touching = gaps.filter((gap) => gap <= 1).length;
  console.log(`  ${label.padEnd(20)} n ${String(gaps.length).padStart(5)}   p25 ${quantile(0.25).padStart(5)}   median ${quantile(0.5).padStart(5)}`
    + `   p75 ${quantile(0.75).padStart(5)}   within 1 u of a neighbour ${(100 * touching / Math.max(1, gaps.length)).toFixed(0).padStart(3)}%`);
}

// ---- CBD OBB interpenetration audit (footprintOverlapXZ — the generator's own packing rule) ---
const cbd = buildings.filter((b) => b.zone === 'commercial-highrise');
let touching = 0; let deep = 0; let maxDepth = 0; let maxAt = '';
const seenPairs = new Set<string>();
for (const a of cbd) {
  for (const b of hash.get(`${Math.floor(a.x / HASH_CELL)},${Math.floor(a.z / HASH_CELL)}`) ?? []) {
    if (b === a || b.zone !== 'commercial-highrise') continue;
    const key = a.x < b.x || (a.x === b.x && a.z < b.z) ? `${a.x},${a.z}|${b.x},${b.z}` : `${b.x},${b.z}|${a.x},${a.z}`;
    if (seenPairs.has(key)) continue; seenPairs.add(key);
    const depth = footprintOverlapXZ(a, b);
    if (depth > 0.05) touching++;
    if (depth > 3) deep++;
    if (depth > maxDepth) { maxDepth = depth; maxAt = `tp ${a.x.toFixed(0)} ${a.z.toFixed(0)}`; }
  }
}
console.log(`\nCBD OBB interpenetration (n=${cbd.length} commercial-highrise parcels, ${seenPairs.size} neighbour pairs): ${touching} pairs overlap > 0.05u (party walls), ${deep} pairs > 3u, max ${maxDepth.toFixed(2)}u${maxAt ? ` (${maxAt})` : ''}`);
