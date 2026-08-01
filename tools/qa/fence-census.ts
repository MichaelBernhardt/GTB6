/**
 * Fence census + collision audit — the citywide count behind the fences-as-norm pass.
 *
 * Runs the REAL planner (ParcelFences.planParcelFence) over the REAL parcel list with the REAL
 * runtime inputs — the architecture's own massing/entrance via plan() (the coincident-faces
 * pattern) and the same 3x3-cell neighbour list City hands the chunk builder — so the counts here
 * ARE what the game builds. Reports fenced fractions by kind, style and district, segment/collider
 * totals, and audits every segment: road/rail clearance, water, overlap against every parcel in
 * the neighbourhood, and collider-matches-segment (same function, asserted anyway).
 *
 *   npx tsx tools/qa/fence-census.ts
 */
import * as THREE from 'three';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, type BuildingSpec } from '../../src/world/BuildingArchitecture';
import {
  allBuildings, CELL_SIZE, footprintOverlapXZ, footprintRailwayClearance, footprintRoadClearance,
  type GeneratedBuilding,
} from '../../src/world/CityGen';
import { districtAt, pointInAnyPolygon, WATER_POLYGONS } from '../../src/world/mapData';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';
import {
  FENCE_RAIL_CLEARANCE, FENCE_ROAD_CLEARANCE, FENCE_THICKNESS,
  fenceSegmentCollider, planParcelFence, type FencePlan,
} from '../../src/world/ParcelFences';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

const parcels = allBuildings();
const cells = new Map<string, GeneratedBuilding[]>();
for (const building of parcels) {
  const key = `${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`;
  const bucket = cells.get(key);
  if (bucket) bucket.push(building); else cells.set(key, [building]);
}
const neighbourhoodOf = (parcel: GeneratedBuilding): GeneratedBuilding[] => {
  const cellX = Math.floor(parcel.x / CELL_SIZE); const cellZ = Math.floor(parcel.z / CELL_SIZE);
  const out: GeneratedBuilding[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(cells.get(`${cellX + dx},${cellZ + dz}`) ?? []));
  return out;
};

interface Row { residential: number; fenced: number; wall: number; palisade: number; razor: number; }
const emptyRow = (): Row => ({ residential: 0, fenced: 0, wall: 0, palisade: 0, razor: 0 });
const byDistrict = new Map<string, Row>();
const byStyle = new Map<string, Row>();
const totals = emptyRow();
let residentialParcels = 0; let stoepExempt = 0; let unluckyRoll = 0;
let segments = 0; let colliders = 0; let posts = 0; let gates = 0; let fenceLength = 0;
let hazardColliders = 0;
let roadViolations = 0; let railViolations = 0; let waterViolations = 0; let overlapViolations = 0;
let colliderMismatch = 0;
const samples = new Map<string, { parcel: GeneratedBuilding; plan: FencePlan }>();

for (const parcel of parcels) {
  if (parcel.zone !== 'residential') continue;
  residentialParcels++;
  const district = districtAt(parcel.x, parcel.z);
  const variant = neighbourhoodBuildingVariant(district, parcel.variant);
  const massing = variant % ARCHITECTURE_VARIANTS[parcel.style];
  const spec: BuildingSpec = {
    x: 0, z: 0, width: parcel.width, depth: parcel.depth, height: parcel.height,
    style: parcel.style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, parcel.style, parcel.variant)),
  };
  const profile = architecture.plan(spec);
  const neighbours = neighbourhoodOf(parcel);
  const options: { massing: number; entranceX?: number; neighbours: readonly GeneratedBuilding[] } =
    profile.entrance ? { massing, entranceX: profile.entrance.x, neighbours } : { massing, neighbours };
  const plan = planParcelFence(parcel, options);
  const districtRow = byDistrict.get(district) ?? emptyRow(); byDistrict.set(district, districtRow);
  const styleRow = byStyle.get(parcel.style) ?? emptyRow(); byStyle.set(parcel.style, styleRow);
  districtRow.residential++; styleRow.residential++; totals.residential++;
  if (!plan) {
    if (parcel.style === 'suburban' && massing === 6) stoepExempt++;
    else unluckyRoll++; // (or, rarely, nothing survived the clearance checks — counted below)
    continue;
  }
  totals.fenced++; districtRow.fenced++; styleRow.fenced++;
  totals[plan.kind]++; districtRow[plan.kind]++; styleRow[plan.kind]++;
  gates++;
  posts += plan.posts.length;
  if (!samples.has(plan.kind) && plan.segments.some((segment) => segment.along === 'x' && segment.lz > 0 && segment.length >= 4)) samples.set(plan.kind, { parcel, plan });
  for (const segment of plan.segments) {
    segments++; colliders++; fenceLength += segment.length;
    if (plan.hazard) hazardColliders++;
    if (footprintRoadClearance(segment.x, segment.z, segment.length, FENCE_THICKNESS, segment.heading) < FENCE_ROAD_CLEARANCE - 1e-6) roadViolations++;
    if (footprintRailwayClearance(segment.x, segment.z, segment.length, FENCE_THICKNESS, segment.heading) < FENCE_RAIL_CLEARANCE - 1e-6) railViolations++;
    if (pointInAnyPolygon(WATER_POLYGONS, segment.x, segment.z)) waterViolations++;
    const rect = { x: segment.x, z: segment.z, width: segment.length, depth: FENCE_THICKNESS, heading: segment.heading };
    for (const other of neighbours) {
      if (other.x === parcel.x && other.z === parcel.z) continue;
      if ((other.x - segment.x) ** 2 + (other.z - segment.z) ** 2 > ((segment.length + other.width + other.depth) / 2 + 2) ** 2) continue;
      if (footprintOverlapXZ(rect, other) > 0.05 + 1e-6) overlapViolations++;
    }
    // Collider == drawn segment (same function the game registers; asserted, not assumed).
    const box = fenceSegmentCollider(segment, plan, 0);
    const cos = Math.cos(segment.heading); const sin = Math.sin(segment.heading);
    const spanX = Math.abs(segment.length * cos) + Math.abs(FENCE_THICKNESS * sin);
    const spanZ = Math.abs(segment.length * sin) + Math.abs(FENCE_THICKNESS * cos);
    const centreOk = Math.abs((box.minX + box.maxX) / 2 - segment.x) < 1e-6 && Math.abs((box.minZ + box.maxZ) / 2 - segment.z) < 1e-6;
    const spanOk = Math.abs(box.maxX - box.minX - spanX) < 1e-6 && Math.abs(box.maxZ - box.minZ - spanZ) < 1e-6;
    if (!centreOk || !spanOk || box.hazard !== plan.hazard) colliderMismatch++;
  }
}

const pct = (num: number, den: number): string => den ? `${(100 * num / den).toFixed(1)}%` : '-';
console.log('FENCE CENSUS — planner inputs identical to the runtime (plan() massing/entrance, 3x3 neighbours)');
console.log('parcels citywide: %d   residential (denominator): %d', parcels.length, residentialParcels);
console.log('fenced: %d (%s of residential)   wall %d / palisade %d / razor %d', totals.fenced, pct(totals.fenced, totals.residential), totals.wall, totals.palisade, totals.razor);
console.log('unfenced: stoep-house exempt (own yard wall) %d, open-stand roll/no-surviving-run %d', stoepExempt, unluckyRoll);
console.log('segments %d = colliders %d (%d hazard-tagged)   posts %d   gates %d   fence line %s units (%s km real at 1.359 m/u)',
  segments, colliders, hazardColliders, posts, gates, Math.round(fenceLength).toLocaleString(), (fenceLength * 1.359 / 1000).toFixed(1));
console.log('\nby style:');
for (const [style, row] of byStyle) {
  console.log('  %s: %d parcels, fenced %s — wall %s / palisade %s / razor %s', style.padEnd(18), row.residential,
    pct(row.fenced, row.residential), pct(row.wall, row.fenced), pct(row.palisade, row.fenced), pct(row.razor, row.fenced));
}
console.log('\nby district (>=40 residential parcels):');
const rows = [...byDistrict.entries()].filter(([, row]) => row.residential >= 40).sort((a, b) => b[1].residential - a[1].residential);
for (const [name, row] of rows) {
  console.log('  %s %s parcels, fenced %s — w %s / p %s / r %s', name.padEnd(22), String(row.residential).padStart(4),
    pct(row.fenced, row.residential).padStart(6), pct(row.wall, row.fenced), pct(row.palisade, row.fenced), pct(row.razor, row.fenced));
}
console.log('\nAUDIT (denominator: all %d segments):', segments);
console.log('  road clearance <%s: %d   rail <%s: %d   in water: %d', FENCE_ROAD_CLEARANCE, roadViolations, FENCE_RAIL_CLEARANCE, railViolations, waterViolations);
console.log('  overlapping a neighbouring footprint >0.05u: %d', overlapViolations);
console.log('  collider != drawn segment: %d', colliderMismatch);
console.log('\nsample parcels for in-engine checks (front fence line, outward = local +z):');
for (const [kind, { parcel, plan }] of samples) {
  const front = plan.segments.filter((segment) => segment.along === 'x' && segment.lz > 0)
    .sort((a, b) => b.length - a.length)[0];
  if (!front) continue;
  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  const outside = { x: front.x + sin * 4, z: front.z + cos * 4 };
  const inside = { x: front.x - sin * 3, z: front.z - cos * 3 };
  console.log('  %s @ district %s: parcel (%s, %s) heading %s — approach (%s, %s) -> inside (%s, %s)',
    kind, districtAt(parcel.x, parcel.z), parcel.x.toFixed(1), parcel.z.toFixed(1), parcel.heading.toFixed(3),
    outside.x.toFixed(1), outside.z.toFixed(1), inside.x.toFixed(1), inside.z.toFixed(1));
}
const failed = roadViolations + railViolations + waterViolations + overlapViolations + colliderMismatch;
console.log(failed === 0 ? '\nPASS' : `\nFAIL: ${failed} violations`);
process.exit(failed === 0 ? 0 : 1);
