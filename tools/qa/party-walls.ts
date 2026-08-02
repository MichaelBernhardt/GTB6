/**
 * PARTY WALLS — the cross-BUILDING half of the coincident-face guard.
 *
 * tools/qa/coincident-faces.ts (and its vitest twin) audit one building at a time: no building
 * draws one of its own walls twice. That was the whole problem while parcels stood apart. The row
 * builder changed the premise — the inner city and the dense-residential blocks are now laid as
 * contiguous street wall, neighbours sharing a boundary — so the question "do two DIFFERENT
 * buildings draw the same wall?" needs its own answer, and an assertion rather than a hope.
 *
 * The reasoning it checks:
 *   - Two abutting flanks are OPPOSITE-facing (A's +x face against B's −x face) on one plane. That
 *     is ordinary assembly contact, exactly like a parapet seated on a roof: backface culling picks
 *     one winner, the other is never rasterised, and neither is reachable by a camera anyway
 *     because there is solid geometry on both sides of the plane. Harmless, and the row builder
 *     depends on it.
 *   - The real risk is SAME-FACING: two neighbours whose FRONT walls land on one plane while their
 *     footprints overlap in the along-street direction (the row tolerates up to
 *     STREETWALL_MAX_OVERLAP of interpenetration, so an overlap strip exists on many pairs). There
 *     the two facades fight per-triangle, each with its own UV origin — the MARTIAL x SMAL failure
 *     one building over. CityGen's per-parcel front-setback jitter (ROW_SETBACK_JITTER) exists to
 *     make that impossible; this is the meter that proves it did.
 *
 * Method: the REAL plan() massing for every parcel, tiers transformed to WORLD space, every pair of
 * parcels whose footprints come within touching distance, every same-facing axis-aligned face pair
 * closer than COINCIDENT_SEPARATION (the depth buffer's resolution at the CBD sightline) that also
 * OVERLAPS in both tangential axes. Diagonal streets rotate faces off the world axes, so faces are
 * compared in the shared local frame of pairs that share a heading (within a hair) — which is every
 * pair that can actually be coplanar; two boxes at different headings cannot have coplanar faces
 * except on a measure-zero set, and their separation is reported as the distance floor instead.
 *
 *   npx tsx tools/qa/party-walls.ts
 */
import * as THREE from 'three';
import { BuildingArchitecture, type BuildingSpec } from '../../src/world/BuildingArchitecture';
import { COINCIDENT_SEPARATION } from '../../src/world/coincidentFaces';
import { allBuildings, footprintOverlapXZ, isRowParcel, STREETWALL_MAX_OVERLAP, type GeneratedBuilding } from '../../src/world/CityGen';
import { districtAt } from '../../src/world/mapData';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

/** Headings within this are "the same street", so their faces share a frame and can be coplanar. */
const SAME_HEADING = 1e-3;
/** Below this the pair is not a neighbour at all and cannot share a wall. */
const NEIGHBOUR_REACH = 3;
/** Overlap below which a same-facing coplanar pair is a corner touch, not a fought wall. */
const MIN_FIGHT_OVERLAP = 0.05;

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

interface Slab { minU: number; maxU: number; minV: number; maxV: number; y0: number; y1: number }

const parcels = allBuildings();
const slabsOf = new Map<GeneratedBuilding, Slab[]>();
for (const parcel of parcels) {
  const district = districtAt(parcel.x, parcel.z);
  const variant = neighbourhoodBuildingVariant(district, parcel.variant);
  const spec: BuildingSpec = {
    x: 0, z: 0, width: parcel.width, depth: parcel.depth, height: parcel.height,
    style: parcel.style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, parcel.style, parcel.variant)),
  };
  const profile = architecture.plan(spec);
  // Local tiers, kept in the parcel's own (u = along street, v = into block) frame. Two parcels on
  // the same street share that frame up to a translation, which is what makes the compare exact.
  slabsOf.set(parcel, profile.tiers.filter((tier) => tier.kind !== 'wall').map((tier) => ({
    minU: tier.minX, maxU: tier.maxX, minV: tier.minZ, maxV: tier.maxZ, y0: tier.y0, y1: tier.y1,
  })));
}

const CELL = 64;
const hash = new Map<string, GeneratedBuilding[]>();
for (const parcel of parcels) {
  const reach = (parcel.width + parcel.depth) / 2 + NEIGHBOUR_REACH;
  for (let dx = Math.floor((parcel.x - reach) / CELL); dx <= Math.floor((parcel.x + reach) / CELL); dx++) {
    for (let dz = Math.floor((parcel.z - reach) / CELL); dz <= Math.floor((parcel.z + reach) / CELL); dz++) {
      const key = `${dx},${dz}`;
      const bucket = hash.get(key);
      if (bucket) bucket.push(parcel); else hash.set(key, [parcel]);
    }
  }
}

let pairs = 0; let sameStreet = 0; let touching = 0;
let sameFacingCoincident = 0; let oppositeFacingCoincident = 0;
/** Split by whose fault it is: the ROW zones are the packed street wall this pass built, the rest
 *  are the scattered zones, where two independently-placed masses have always been able to land
 *  their fronts on one plane — a pre-existing class this audit is the first thing to look for. */
let rowFaults = 0; let scatterFaults = 0;
/** …and by AXIS. `u` is the PARTY-WALL axis the row builder creates and must therefore keep clean.
 *  `v` is the street/rear axis, where a fight needs two parcels off DIFFERENT kerbs (different road
 *  widths, so different frontage baselines) to land a wall on one plane by coincidence — a class no
 *  per-kerb setback rule can see, and one that predates the row builder. */
let partyAxisFaults = 0; let streetAxisFaults = 0;
const isRow = isRowParcel;
let closestSameFacing = Infinity; let closestAt = '';
const examples: string[] = [];
const seen = new Set<string>();

/** Offset of `other` in `parcel`'s local frame (u along the street, v into the block). */
function localOffset(parcel: GeneratedBuilding, other: GeneratedBuilding): { u: number; v: number } {
  const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
  const dx = other.x - parcel.x; const dz = other.z - parcel.z;
  return { u: dx * cos - dz * sin, v: dx * sin + dz * cos };
}

for (const parcel of parcels) {
  const key = `${Math.floor(parcel.x / CELL)},${Math.floor(parcel.z / CELL)}`;
  for (const other of hash.get(key) ?? []) {
    if (other === parcel) continue;
    const pairKey = parcel.x < other.x || (parcel.x === other.x && parcel.z < other.z)
      ? `${parcel.x},${parcel.z}|${other.x},${other.z}` : `${other.x},${other.z}|${parcel.x},${parcel.z}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    pairs++;
    // Touching = footprints within a hair of each other, which is what a party wall is.
    const grown = { x: other.x, z: other.z, width: other.width + 2 * NEIGHBOUR_REACH, depth: other.depth + 2 * NEIGHBOUR_REACH, heading: other.heading };
    if (footprintOverlapXZ(parcel, grown) <= 0) continue;
    touching++;
    let delta = Math.abs(parcel.heading - other.heading) % (Math.PI * 2);
    if (delta > Math.PI) delta = Math.PI * 2 - delta;
    if (delta > SAME_HEADING && Math.abs(delta - Math.PI) > SAME_HEADING) continue; // different streets: no shared frame
    sameStreet++;
    const flip = Math.abs(delta - Math.PI) <= SAME_HEADING ? -1 : 1; // a parcel facing back down the same street
    const at = localOffset(parcel, other);
    for (const a of slabsOf.get(parcel) ?? []) {
      for (const raw of slabsOf.get(other) ?? []) {
        // `other`'s slab expressed in `parcel`'s frame.
        const b = flip > 0
          ? { minU: raw.minU + at.u, maxU: raw.maxU + at.u, minV: raw.minV + at.v, maxV: raw.maxV + at.v, y0: raw.y0, y1: raw.y1 }
          : { minU: at.u - raw.maxU, maxU: at.u - raw.minU, minV: at.v - raw.maxV, maxV: at.v - raw.minV, y0: raw.y0, y1: raw.y1 };
        if (b.y1 <= a.y0 || a.y1 <= b.y0) continue; // no shared height band: no shared wall
        // U faces (the party planes) and V faces (the street faces), each with its outward sign.
        for (const axis of ['u', 'v'] as const) {
          const aFaces = axis === 'u'
            ? [{ plane: a.minU, sign: -1 }, { plane: a.maxU, sign: 1 }]
            : [{ plane: a.minV, sign: -1 }, { plane: a.maxV, sign: 1 }];
          const bFaces = axis === 'u'
            ? [{ plane: b.minU, sign: -1 }, { plane: b.maxU, sign: 1 }]
            : [{ plane: b.minV, sign: -1 }, { plane: b.maxV, sign: 1 }];
          // Overlap on the OTHER in-plane axis — two faces that do not overlap cannot fight.
          const spanOverlap = axis === 'u'
            ? Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV)
            : Math.min(a.maxU, b.maxU) - Math.max(a.minU, b.minU);
          // A sliver narrower than this is sub-pixel at any distance a facade is legible from — two
          // buildings merely touching at a corner are not drawing the same wall.
          if (spanOverlap <= MIN_FIGHT_OVERLAP) continue;
          for (const fa of aFaces) for (const fb of bFaces) {
            const separation = Math.abs(fa.plane - fb.plane);
            if (fa.sign === fb.sign) {
              if (separation < closestSameFacing) {
                closestSameFacing = separation;
                closestAt = `tp ${parcel.x.toFixed(0)} ${parcel.z.toFixed(0)} (${axis}${fa.sign > 0 ? '+' : '-'})`;
              }
              if (separation < COINCIDENT_SEPARATION) {
                sameFacingCoincident++;
                if (isRow(parcel) && isRow(other)) rowFaults++; else scatterFaults++;
                if (axis === 'u') partyAxisFaults++; else streetAxisFaults++;
                if (examples.length < 8) {
                  examples.push(`SAME-FACING ${parcel.style}/${parcel.zone} tp ${parcel.x.toFixed(0)} ${parcel.z.toFixed(0)}`
                    + ` axis ${axis}${fa.sign > 0 ? '+' : '-'} separation ${separation.toFixed(5)} u, overlap ${spanOverlap.toFixed(2)} u`);
                }
              }
            } else if (separation < COINCIDENT_SEPARATION) {
              oppositeFacingCoincident++;
            }
          }
        }
      }
    }
  }
}

console.log(`parcels ${parcels.length}; neighbour pairs examined ${pairs}, of which ${touching} touch`
  + ` (within ${NEIGHBOUR_REACH} u) and ${sameStreet} share a street frame`);
console.log(`coincident face pairs across DIFFERENT buildings (threshold ${COINCIDENT_SEPARATION.toFixed(5)} u,`
  + ` the depth buffer's resolution at the CBD sightline):`);
console.log(`  opposite-facing (party walls, assembly contact — HARMLESS, backface culling picks a winner): ${oppositeFacingCoincident}`);
console.log(`  same-facing     (two facades on one plane, both rasterised — THE DEFECT):                    ${sameFacingCoincident}`);
console.log(`    by zone: packed-row pairs ${rowFaults}, scattered-zone pairs ${scatterFaults}`);
console.log(`    by axis: PARTY-WALL axis ${partyAxisFaults} (the row builder's own class), street/rear axis ${streetAxisFaults} (cross-kerb coincidence)`);
console.log(`closest same-facing pair anywhere: ${closestSameFacing.toFixed(4)} u ${closestAt}`
  + ` (party-wall interpenetration is allowed up to ${STREETWALL_MAX_OVERLAP} u, which puts the walls INSIDE each other rather than on one plane)`);
for (const example of examples) console.log('  ', example);

// The row builder owns the packed fabric and must leave it clean; the scattered zones carry a
// ratchet at the count this audit first measured, so the class cannot grow unnoticed.
const PARTY_AXIS_LIMIT = 0;
const OTHER_AXIS_LIMIT = 6;
const failures: string[] = [];
if (partyAxisFaults > PARTY_AXIS_LIMIT) failures.push(`party-wall-axis same-facing pairs ${partyAxisFaults} > ${PARTY_AXIS_LIMIT}`);
if (streetAxisFaults > OTHER_AXIS_LIMIT) failures.push(`street/rear-axis same-facing pairs ${streetAxisFaults} > ${OTHER_AXIS_LIMIT}`);
if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS: party-wall axis ${partyAxisFaults}/${PARTY_AXIS_LIMIT}, street/rear axis ${streetAxisFaults}/${OTHER_AXIS_LIMIT}.`);
}
