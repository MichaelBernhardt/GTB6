/**
 * Rail/road clearance audit. Reports, over the whole generated network, how much rail ballast sits
 * inside a carriageway and inside the BUILT road footprint, plus the station platform census.
 *
 *   npx tsx tools/qa/rail-clearance.ts
 */
import {
  GENERATED_RAILWAYS, RAILWAY_LEVEL_CROSSINGS, RAILWAY_CORRIDOR_HALF_WIDTH,
  RAILWAY_STATION_SITES, ROAD_BUILD_MARGIN, STATION_PLATFORM_WIDTH,
  nearestBuiltRoad, platformSideClearance, stationPlatformLength, distanceToRoadEdge, distanceToBuiltRoadEdge,
} from '../../src/world/mapData';
import { RAIL_DECONFLICT_DEFAULTS } from '../../src/world/railAlignment';

const PLATFORM_WIDTH = STATION_PLATFORM_WIDTH;

let total = 0; let inTar = 0; let inBuilt = 0; let parallelInside = 0; let crossingInside = 0;
let worstTar = Infinity; let worstAt = { x: 0, z: 0 };
for (const line of GENERATED_RAILWAYS) {
  let lineTotal = 0; let lineTar = 0; let lineBuilt = 0; let lineParallel = 0;
  for (let index = 0; index < line.points.length - 1; index++) {
    const a = line.points[index]!; const b = line.points[index + 1]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-6) continue;
    const dirX = (b.x - a.x) / length; const dirZ = (b.z - a.z) / length;
    const steps = Math.max(1, Math.round(length / 4));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const x = a.x + (b.x - a.x) * t; const z = a.z + (b.z - a.z) * t;
      const step = length / steps;
      lineTotal += step;
      const tar = distanceToRoadEdge(x, z);
      if (tar < RAILWAY_CORRIDOR_HALF_WIDTH) lineTar += step;
      if (distanceToBuiltRoadEdge(x, z) < RAILWAY_CORRIDOR_HALF_WIDTH) {
        lineBuilt += step;
        // Split the residual by INTENT: a crossing is the designed answer, a parallel run is a defect.
        const probe = nearestBuiltRoad(x, z);
        const alignment = probe ? Math.abs(dirX * probe.dirX + dirZ * probe.dirZ) : 0;
        if (alignment >= RAIL_DECONFLICT_DEFAULTS.parallelCos) { lineParallel += step; parallelInside += step; }
        else crossingInside += step;
      }
      if (tar < worstTar) { worstTar = tar; worstAt = { x, z }; }
    }
  }
  total += lineTotal; inTar += lineTar; inBuilt += lineBuilt;
  console.log(
    `  ${line.name.padEnd(26)} ${(lineTotal / 1000).toFixed(2).padStart(6)} km | in tar ${lineTar.toFixed(1).padStart(8)} u`
    + ` (${((100 * lineTar) / lineTotal).toFixed(2).padStart(5)}%) | in built ${lineBuilt.toFixed(1).padStart(8)} u`
    + ` (${((100 * lineBuilt) / lineTotal).toFixed(2).padStart(5)}%) | of which PARALLEL ${lineParallel.toFixed(1).padStart(7)} u`
    + ` (${((100 * lineParallel) / lineTotal).toFixed(2).padStart(5)}%) | ${line.points.length} pts`,
  );
}
console.log(`  ${'TOTAL'.padEnd(26)} ${(total / 1000).toFixed(2).padStart(6)} km | in tar ${inTar.toFixed(1).padStart(8)} u`
  + ` (${((100 * inTar) / total).toFixed(2).padStart(5)}%) | in built ${inBuilt.toFixed(1).padStart(8)} u`
  + ` (${((100 * inBuilt) / total).toFixed(2).padStart(5)}%) | of which PARALLEL ${parallelInside.toFixed(1).padStart(7)} u`
  + ` (${((100 * parallelInside) / total).toFixed(2).padStart(5)}%)`);
console.log(`  crossing the road (by design, level crossings): ${crossingInside.toFixed(1)} u`);
console.log(`  ROAD_BUILD_MARGIN ${ROAD_BUILD_MARGIN} u/side; level crossings marked: ${RAILWAY_LEVEL_CROSSINGS.length}`);
console.log(`  worst tar clearance ${worstTar.toFixed(2)} u at (${worstAt.x.toFixed(1)}, ${worstAt.z.toFixed(1)})`);

console.log('\n  STATIONS — per side: clearance from the tar / from the road as built.');
console.log('  A side is only DROPPED when its slab would land on the carriageway (tar < half a slab).');
let dropped = 0; let onPavement = 0;
for (const station of RAILWAY_STATION_SITES) {
  const length = stationPlatformLength(station.name);
  const sides = ([-1, 1] as const).map((side) =>
    platformSideClearance(station.x, station.z, station.dirX, station.dirZ, side, length));
  const drops = sides.filter((c) => c.tar < PLATFORM_WIDTH / 2).length;
  const pavement = sides.filter((c) => c.tar >= PLATFORM_WIDTH / 2 && c.built < PLATFORM_WIDTH / 2).length;
  if (drops > 0) dropped++;
  if (pavement > 0) onPavement++;
  console.log(`    ${station.name.padEnd(34)} (${station.x.toFixed(0).padStart(6)},${station.z.toFixed(0).padStart(6)})`
    + `  ${sides.map((c) => `${c.tar.toFixed(1).padStart(6)}/${c.built.toFixed(1).padStart(6)}`).join('  ')}`
    + `  ${(2 - drops)} of 2 platforms${drops > 0 ? '   <== SIDE DROPPED' : ''}`);
}
console.log(`  stations rendering with a side missing: ${dropped} of ${RAILWAY_STATION_SITES.length}`);
console.log(`  stations with a platform meeting the pavement (fine, not a fault): ${onPavement}`);
