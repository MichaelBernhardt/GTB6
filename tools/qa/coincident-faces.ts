/**
 * Coincident-facade audit — the evidence that no building in the city draws one wall twice.
 *
 * Two same-facing massing faces on the same plane share one material, one depth range and no
 * tie-breaker, so which face wins is decided per-triangle and changes with viewpoint: the wall
 * crawls, and because each box bakes its own facade-UV origin, every window gets a phase-shifted
 * ghost twin (the MARTIAL x SMAL corner-tower report). This sweep runs the REAL
 * BuildingArchitecture.plan() over the REAL parcel list and reports every same-facing face pair
 * closer than the depth buffer can resolve at CBD viewing distances — massing boxes plus the
 * concrete foundation mirrors City draws under them — classified into visible defects and the
 * harmless assembly contacts (seated undersides, gable-covered roof pairs) that are part of any
 * stacked massing. The vitest twin (src/world/coincidentFaces.test.ts) fails CI on any visible
 * pair; this report is the human-readable census behind it.
 *
 *   npx tsx tools/qa/coincident-faces.ts
 */
import * as THREE from 'three';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, type BuildingSpec } from '../../src/world/BuildingArchitecture';
import {
  CAMERA_NEAR, CBD_SIGHTLINE, COINCIDENT_SEPARATION, DEPTH_BITS,
  auditProfile, depthResolutionAt,
} from '../../src/world/coincidentFaces';
import { allBuildings, CELL_SIZE } from '../../src/world/CityGen';
import { districtAt } from '../../src/world/mapData';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from '../../src/world/data/neighbourhoods';
import { facadeWorldTile } from '../../src/world/ProceduralMaterials';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

console.log('camera near plane (src/Game.ts): %s   depth buffer: %s-bit (WebGL default, no logarithmicDepthBuffer)', CAMERA_NEAR, DEPTH_BITS);
console.log('depth resolution at eye distance:  100 u -> %s u   %s u -> %s u   600 u -> %s u',
  depthResolutionAt(100).toFixed(4), CBD_SIGHTLINE, depthResolutionAt(CBD_SIGHTLINE).toFixed(4), depthResolutionAt(600).toFixed(4));
console.log('coincidence threshold: %s u (unresolvable within the %s u CBD sightline)\n', COINCIDENT_SEPARATION.toFixed(4), CBD_SIGHTLINE);

interface ClassEntry { buildings: number; pairs: number; maxArea: number; example: { x: number; z: number }; }
const byClass = new Map<string, ClassEntry>();
const verdictTotals = new Map<string, number>();
const styleTotals = new Map<string, number>();
let total = 0; let buildingsWithVisible = 0; let nearestSeparation = Infinity; let nearestSeparationAt = '';

// The nine chunk cells covering the CBD (the corner-tower report came from cell 2,1).
const CBD_CELLS = new Set<string>();
for (let cellX = 1; cellX <= 3; cellX++) for (let cellZ = 0; cellZ <= 2; cellZ++) CBD_CELLS.add(`${cellX},${cellZ}`);
let cbdDowntown = 0; let cbdCornerTowers = 0;

for (const building of allBuildings()) {
  total++;
  styleTotals.set(building.style, (styleTotals.get(building.style) ?? 0) + 1);
  const district = districtAt(building.x, building.z);
  const variant = neighbourhoodBuildingVariant(district, building.variant);
  const massing = variant % ARCHITECTURE_VARIANTS[building.style];
  const inCbd = CBD_CELLS.has(`${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`);
  if (building.style === 'downtown' && inCbd) { cbdDowntown++; if (massing === 9) cbdCornerTowers++; }
  const spec: BuildingSpec = {
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant, facade, roof,
    facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, building.style, building.variant)),
  };
  const profile = architecture.plan(spec);
  // Track the closest same-facing pair that is NOT coincident — the safety margin the massing
  // arithmetic actually leaves (e.g. the dense-residential wing reveal, one corner radius wide).
  for (const near of auditProfile(profile, 1.0)) {
    if (near.gap > COINCIDENT_SEPARATION && near.gap < nearestSeparation && near.verdict === 'visible') {
      nearestSeparation = near.gap;
      nearestSeparationAt = `${building.style} m${massing} ${near.axis}${near.sign > 0 ? '+' : '-'} at ${building.x.toFixed(0)},${building.z.toFixed(0)}`;
    }
  }
  const pairs = auditProfile(profile);
  if (pairs.length === 0) continue;
  if (pairs.some((pair) => pair.verdict === 'visible')) buildingsWithVisible++;
  const seen = new Set<string>();
  for (const pair of pairs) {
    verdictTotals.set(pair.verdict, (verdictTotals.get(pair.verdict) ?? 0) + 1);
    const key = `${pair.verdict.padEnd(16)} ${building.style} m${massing} ${pair.boxI < 0 ? 'foundation' : 'massing'} ${pair.axis}${pair.sign > 0 ? '+' : '-'}`;
    let entry = byClass.get(key);
    if (!entry) { entry = { buildings: 0, pairs: 0, maxArea: 0, example: { x: building.x, z: building.z } }; byClass.set(key, entry); }
    if (!seen.has(key)) { entry.buildings++; seen.add(key); }
    entry.pairs++;
    if (pair.area > entry.maxArea) { entry.maxArea = pair.area; entry.example = { x: building.x, z: building.z }; }
  }
}

console.log(`parcels audited: ${total}  (${[...styleTotals].map(([style, count]) => `${style} ${count}`).join(', ')})`);
console.log(`CBD nine-cell denominator: ${cbdDowntown} downtown buildings, ${cbdCornerTowers} of them massing-9 corner towers\n`);
console.log('coincident face pairs by class:');
for (const [key, entry] of [...byClass].sort()) {
  console.log(`  ${key.padEnd(58)} buildings ${String(entry.buildings).padStart(4)}  pairs ${String(entry.pairs).padStart(5)}  max area ${entry.maxArea.toFixed(1).padStart(7)} u²  e.g. tp ${entry.example.x.toFixed(0)} ${entry.example.z.toFixed(0)}`);
}
console.log(`\nclosest visible same-facing pair that is NOT coincident: ${Number.isFinite(nearestSeparation) ? `${nearestSeparation.toFixed(3)} u (${nearestSeparationAt}) — resolvable out to ${Math.sqrt(nearestSeparation * CAMERA_NEAR * 2 ** DEPTH_BITS).toFixed(0)} u` : 'none within 1 u'}`);

const visible = verdictTotals.get('visible') ?? 0;
console.log(`\nverdicts: ${[...verdictTotals].map(([verdict, count]) => `${verdict} ${count}`).join(', ') || 'none'}`);
if (visible > 0) {
  console.log(`\nFAIL: ${visible} visible coincident face pair(s) on ${buildingsWithVisible} building(s) — one wall drawn twice.`);
  process.exitCode = 1;
} else {
  console.log('\nPASS: no visible coincident exterior faces anywhere in the city.');
}
