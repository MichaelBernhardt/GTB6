/**
 * SEGMENT-ORIENTATION HISTOGRAM — the gate on the dam shore's shape.
 *
 * A real coastline is roughly ISOTROPIC: bin its segments by their angle to the east-west axis,
 * weight by length, and the six 15-degree buckets come out broadly flat. A coastline that has been
 * compressed on one axis does not: every diagonal collapses toward the long axis, the histogram
 * piles up in one bucket, and the shore renders as a staircase of runs joined by hairpins however
 * many vertices it has. This is the measurement that condemned the anisotropic fit (67.7% of the
 * emitted length inside 15 degrees of east-west, 1.2% north-south) and it is the measurement the
 * uniform fit has to pass.
 *
 * Both histograms are computed THE SAME WAY, on the same six buckets, length-weighted:
 *   - EMITTED: src/world/generated/joburg-map.json, coast.coastline, in world units.
 *   - SOURCE:  the stretch of the REAL Vaal ring the fit selected, in the same rotated frame,
 *              simplified to the same real-metre tolerance. Rotation and uniform scale cannot
 *              change a histogram, so any difference is the fold, the run-outs and the reduction.
 *
 *   node tools/mapgen/measure-orientation.mjs [path-to-map.json]
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const mapPath = process.argv[2] ?? resolve(HERE, '../../src/world/generated/joburg-map.json');
const map = JSON.parse(readFileSync(mapPath, 'utf8'));

const BUCKETS = 6;
const BUCKET_DEG = 90 / BUCKETS;

/** Length-weighted share of each 15-degree orientation bucket. 0 = east-west, 90 = north-south. */
export function orientationHistogram(points) {
  const bins = new Array(BUCKETS).fill(0);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dz = points[i].z - points[i - 1].z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const deg = (Math.atan2(Math.abs(dz), Math.abs(dx)) * 180) / Math.PI;
    bins[Math.min(BUCKETS - 1, Math.floor(deg / BUCKET_DEG))] += len;
    total += len;
  }
  return { pct: bins.map((v) => (v / total) * 100), total };
}

const emitted = orientationHistogram(map.coast.coastline.map(([x, z]) => ({ x, z })));

// The source stretch is written by the build itself (tools/mapgen/index.ts), so the comparison can
// never drift from the fit that actually shipped: it IS the window dam.ts selected, rotated into
// the map frame but not scaled, folded or run out.
const source = orientationHistogram(
  JSON.parse(readFileSync(join(HERE, 'source-stretch.json'), 'utf8')).map(([x, z]) => ({ x, z })),
);

const row = (label, h) =>
  `${label.padEnd(9)}` + h.pct.map((v) => `${v.toFixed(1).padStart(5)}%`).join('  ');
const head = '         ' + Array.from({ length: BUCKETS }, (_, i) => `${i * 15}-${i * 15 + 15}`.padStart(6)).join('  ');

console.log('\n== SEGMENT-ORIENTATION HISTOGRAM (length-weighted; 0 deg = east-west, 90 = north-south) ==');
console.log(head);
console.log(row('SOURCE', source));
console.log(row('EMITTED', emitted));
const ratios = emitted.pct.map((v, i) => v / Math.max(1e-9, source.pct[i]));
console.log('ratio    ' + ratios.map((v) => `${v.toFixed(2)}x`.padStart(6)).join('  '));
const worst = Math.max(...ratios);
const worstBucket = ratios.indexOf(worst);
console.log(
  `\nworst bucket ratio ${worst.toFixed(2)}x (${worstBucket * 15}-${worstBucket * 15 + 15} deg) ` +
    `— gate is 1.60x  => ${worst <= 1.6 ? 'PASS' : 'FAIL'}`,
);
console.log(
  `source stretch ${(source.total / 1000).toFixed(1)} km of real shoreline; ` +
    `emitted ${(emitted.total * map.stats.metresPerUnit / 1000).toFixed(1)} km of map shoreline ` +
    `(${map.coast.coastline.length} pts)`,
);
process.exitCode = worst <= 1.6 ? 0 : 1;
