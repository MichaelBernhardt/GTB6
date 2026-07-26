/**
 * Grade the SHIPPED map against the brief, from the emitted JSON rather than from the placement
 * search — so every number below is what the player gets, not what a candidate promised.
 *
 *   node tools/mapgen/measure-dam.mjs [src/world/generated/joburg-map.json]
 *
 * Measures, in game units:
 *   budget       water width / west overhang / in-world water area, against the old ocean
 *   R3           what fraction of the WEST BOUNDARY is wet, and the longest dry run on it
 *   R4           Grooteiland's size and its clearance from the world edge (can a boat get round?)
 *   R2/D1        Misty Bay: is it on the map, and how much real road/pier/building is near it
 *   shore        crenellation (real shore length / straight-line span) and orientation histogram
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? new URL('../../src/world/generated/joburg-map.json', import.meta.url);
const map = JSON.parse(readFileSync(file, 'utf8'));
const half = map.stats.targetSize / 2;
const MPU = map.stats.metresPerUnit;
const ocean = map.coast.ocean.map(([x, z]) => ({ x, z }));
const islands = (map.coast.islands ?? []).map((r) => r.map(([x, z]) => ({ x, z })));

const inRing = (ring, p) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
};
const wet = (p) => inRing(ocean, p) && !islands.some((r) => inRing(r, p));

let mnx = Infinity, mxx = -Infinity;
for (const p of ocean) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); }

// ---- water area + west-edge wetness ------------------------------------------------------------
const N = 400;
let cells = 0, edgeWet = 0;
const edge = new Uint8Array(N);
for (let r = 0; r < N; r++) {
  const z = -half + (2 * half * (r + 0.5)) / N;
  for (let c = 0; c < N; c++) if (wet({ x: -half + (2 * half * (c + 0.5)) / N, z })) cells++;
  if (wet({ x: -half + 6, z })) { edge[r] = 1; edgeWet++; }
}
let longestDry = 0, run = 0, dryRuns = [];
for (let r = 0; r < N; r++) {
  if (edge[r]) { if (run) dryRuns.push(run); run = 0; } else { run++; longestDry = Math.max(longestDry, run); }
}
if (run) dryRuns.push(run);
const toU = (rows) => (rows / N) * 2 * half;

console.log(`world ${map.stats.targetSize} u @ ${MPU.toFixed(3)} m/u`);
console.log(`BUDGET   water width ${(mxx - mnx).toFixed(0)} u (${(100 * (mxx - mnx) / (2 * half)).toFixed(1)}% — old ocean 20.7%), ` +
  `west overhang ${(-half - mnx).toFixed(0)} u (old 922 u), in-world water area ${(100 * cells / (N * N)).toFixed(1)}% (old 7.9%)`);
console.log(`R3       west boundary wet ${(100 * edgeWet / N).toFixed(1)}% (was 38.3%), ` +
  `longest dry run ${toU(longestDry).toFixed(0)} u (was 1674 u), dry runs ${dryRuns.map((d) => toU(d).toFixed(0)).join('/')} u, ` +
  `corners ${edge[0] ? 'wet' : 'dry'}/${edge[N - 1] ? 'wet' : 'dry'}`);

// ---- R4: Grooteiland ---------------------------------------------------------------------------
const named = islands.map((ring) => {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of ring) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
  return { w: b - a, h: d - c, minX: a, maxX: b, minZ: c, maxZ: d };
}).sort((p, q) => q.w * q.h - p.w * p.h);
for (const [i, g] of named.entries()) {
  // Can a boat get round the OUTSIDE? Walk west from the island's west shore along its mid-latitude.
  const zc = (g.minZ + g.maxZ) / 2;
  let channel = 0;
  for (let d = 4; d < 2000; d += 4) { if (!wet({ x: g.minX - d, z: zc })) break; channel = d; }
  console.log(`R4       island #${i} ${g.w.toFixed(0)}x${g.h.toFixed(0)} u, west shore ${(g.minX + half).toFixed(0)} u inside the ` +
    `world edge, open water west of it ${channel.toFixed(0)} u`);
}
if (!named.length) console.log('R4       NO ISLANDS');

// ---- R2 / D1: Misty Bay ------------------------------------------------------------------------
const misty = [...map.districts, ...map.landmarks].find((d) => /misty/i.test(d.name));
if (!misty) console.log('R2       MISTY BAY IS NOT ON THE MAP');
else {
  const near = (r) => (p) => (p.x - misty.x) ** 2 + (p.z - misty.z) ** 2 < r * r;
  const roadsNear = map.roads.filter((rd) => rd.points.some(([x, z]) => near(800)({ x, z })));
  let km = 0, realKm = 0;
  const names = new Set();
  for (const rd of roadsNear) {
    let L = 0;
    for (let i = 1; i < rd.points.length; i++) L += Math.hypot(rd.points[i][0] - rd.points[i - 1][0], rd.points[i][1] - rd.points[i - 1][1]);
    km += (L * MPU) / 1000;
    if (!/^(Dampad|Straat|Weg|Laan)/.test(rd.name) && rd.name) { realKm += (L * MPU) / 1000; names.add(rd.name); }
  }
  const tracksNear = map.tracks.filter((t) => t.points.some(([x, z]) => near(800)({ x, z })));
  console.log(`R2/D1    Misty Bay at (${misty.x.toFixed(0)},${misty.z.toFixed(0)}) u, ${(misty.x + half).toFixed(0)} u inside the west edge; ` +
    `within 800 u: ${roadsNear.length} roads / ${km.toFixed(1)} km (${realKm.toFixed(1)} km named, ${names.size} distinct names), ` +
    `${tracksNear.length} tracks/piers`);
  const beach = map.coast.beaches.find((b) => /misty/i.test(b.name));
  console.log(`R2/D1    Misty Bay beach: ${beach ? 'yes' : 'NO'}; nearest water ${(() => {
    for (let d = 4; d < 4000; d += 8) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
      if (wet({ x: misty.x + dx * d, z: misty.z + dz * d })) return `${d} u`;
    } return '>4000 u';
  })()}`);
}
const dampad = map.roads.filter((r) => r.name === 'Dampad');
let dampadKm = 0;
for (const rd of dampad) for (let i = 1; i < rd.points.length; i++) dampadKm += Math.hypot(rd.points[i][0] - rd.points[i - 1][0], rd.points[i][1] - rd.points[i - 1][1]) * MPU / 1000;
console.log(`D1       placeholder 'Dampad': ${dampad.length} polylines / ${dampadKm.toFixed(1)} km (was 35.1 km)`);
console.log(`D1       real shore building footprints: ${(map.coast.shoreBuildings ?? []).length}`);

// ---- shore crenellation + orientation ----------------------------------------------------------
const pieces = map.coast.shore ?? [];
let shoreLen = 0;
const bins = new Array(12).fill(0);
for (const line of pieces) {
  for (let i = 1; i < line.length; i++) {
    const dx = line[i][0] - line[i - 1][0], dz = line[i][1] - line[i - 1][1];
    const L = Math.hypot(dx, dz);
    // only grade the part inside the world square
    const mx = (line[i][0] + line[i - 1][0]) / 2, mz = (line[i][1] + line[i - 1][1]) / 2;
    if (mx < -half || mx > half || mz < -half || mz > half) continue;
    shoreLen += L;
    let a = (Math.atan2(dz, dx) * 180) / Math.PI; if (a < 0) a += 180;
    bins[Math.min(11, Math.floor(a / 15))] += L;
  }
}
const total = bins.reduce((s, v) => s + v, 0) || 1;
console.log(`SHORE    ${shoreLen.toFixed(0)} u of real waterline inside the square = ${(shoreLen / (2 * half)).toFixed(2)}x the world height ` +
  `(crenellation); ${pieces.length} unbroken piece(s)`);
console.log(`SHORE    orientation (15 deg bins from east): ${bins.map((v) => (100 * v / total).toFixed(0).padStart(3)).join('')}  ` +
  `| north-south share ${(100 * (bins[5] + bins[6]) / total).toFixed(0)}%`);
