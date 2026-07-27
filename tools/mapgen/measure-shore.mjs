/**
 * SHORE MEASUREMENT HARNESS — reports the numbers the owner rejected the last shore for not having.
 * Reads the EMITTED map, so every number is what actually ships.
 *
 *   node tools/mapgen/measure-shore.mjs [path-to-map.json]
 */
import { readFileSync, statSync } from 'node:fs';

const path = process.argv[2] ?? 'src/world/generated/joburg-map.json';
const map = JSON.parse(readFileSync(path, 'utf8'));
// Emitted maps store points as [x, z] pairs; normalise to {x,z} for readability.
const P = (a) => (Array.isArray(a) ? { x: a[0], z: a[1] } : a);
const PL = (arr) => arr.map(P);
const half = map.stats.targetSize / 2;
const mpu = map.stats.metresPerUnit;

const line = (s) => console.log(s);

// ---------- 1. Crenellation ----------
const shore = PL(map.coast.coastline);
let segs = [];
let turning = 0;
for (let i = 1; i < shore.length; i++) {
  segs.push(Math.hypot(shore[i].x - shore[i - 1].x, shore[i].z - shore[i - 1].z));
}
for (let i = 2; i < shore.length; i++) {
  const a = shore[i - 2], b = shore[i - 1], c = shore[i];
  const h1 = Math.atan2(b.z - a.z, b.x - a.x);
  const h2 = Math.atan2(c.z - b.z, c.x - b.x);
  let d = h2 - h1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  turning += Math.abs(d);
}
segs.sort((a, b) => a - b);
const q = (p) => segs[Math.min(segs.length - 1, Math.max(0, Math.round((segs.length - 1) * p)))];
const total = segs.reduce((s, v) => s + v, 0);
line(`\n== CRENELLATION (emitted shore, world units) ==`);
line(`points          ${shore.length}`);
line(`length          ${total.toFixed(0)} u  (${(total * mpu / 1000).toFixed(2)} km)`);
line(`segment len     min ${q(0).toFixed(1)} p10 ${q(0.1).toFixed(1)} median ${q(0.5).toFixed(1)} p90 ${q(0.9).toFixed(1)} max ${q(1).toFixed(1)}`);
line(`seg CV          ${(Math.sqrt(segs.reduce((s, v) => s + (v - total / segs.length) ** 2, 0) / segs.length) / (total / segs.length)).toFixed(3)}  (0 = perfectly uniform resample)`);
line(`TOTAL TURNING   ${(turning * 180 / Math.PI).toFixed(0)} deg  (${(turning * 180 / Math.PI / (total * mpu / 1000)).toFixed(0)} deg per real km)`);
// straightness: chord/length
const chord = Math.hypot(shore[shore.length - 1].x - shore[0].x, shore[shore.length - 1].z - shore[0].z);
line(`sinuosity       ${(total / chord).toFixed(3)}  (length / end-to-end chord)`);
line(`x range         ${Math.min(...shore.map((p) => p.x)).toFixed(0)} .. ${Math.max(...shore.map((p) => p.x)).toFixed(0)}`);

// ---------- 2. Wet span on the west edge ----------
// Sample the true water polygon(s) along the west edge of the world square.
const polys = [];
const ocean = map.coast.ocean ? PL(map.coast.ocean) : null;
if (ocean) polys.push(PL(ocean));
const inPoly = (poly, x, z) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
};
const N = 4000;
const edgeX = -half + 0.5;
let wetRuns = [];
let cur = null;
for (let i = 0; i <= N; i++) {
  const z = -half + (2 * half * i) / N;
  const wet = polys.some((p) => inPoly(p, edgeX, z));
  if (wet && !cur) cur = { z0: z, z1: z };
  else if (wet) cur.z1 = z;
  else if (cur) { wetRuns.push(cur); cur = null; }
}
if (cur) wetRuns.push(cur);
const wetTotal = wetRuns.reduce((s, r) => s + (r.z1 - r.z0), 0);
line(`\n== WEST-EDGE WET SPAN (sampled on the emitted water polygon at x = ${edgeX.toFixed(0)}) ==`);
line(`runs            ${wetRuns.map((r) => `${r.z0.toFixed(0)}..${r.z1.toFixed(0)}`).join(', ') || 'none'}`);
line(`wet total       ${wetTotal.toFixed(0)} u of ${(2 * half).toFixed(0)} u = ${(100 * wetTotal / (2 * half)).toFixed(1)}%`);
if (wetRuns.length) {
  line(`land above      ${(wetRuns[0].z0 + half).toFixed(0)} u`);
  line(`land below      ${(half - wetRuns[wetRuns.length - 1].z1).toFixed(0)} u`);
}

// ---------- 3. Eastward reach + water area inside the square ----------
let maxEast = -Infinity, maxEastZ = 0;
for (const p of shore) if (Math.abs(p.z) <= half && p.x > maxEast) { maxEast = p.x; maxEastZ = p.z; }
line(`\n== REACH ==`);
line(`max shore east  x=${maxEast.toFixed(0)} at z=${maxEastZ.toFixed(0)}  (${(maxEast + half).toFixed(0)} u from the west edge)`);
// water area inside the square by grid sample
const G = 700;
let wet = 0;
for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
  const x = -half + (2 * half * (i + 0.5)) / G;
  const z = -half + (2 * half * (j + 0.5)) / G;
  if (polys.some((p) => inPoly(p, x, z))) wet++;
}
const cell = ((2 * half) / G) * mpu;
line(`dam water area  ${((wet * cell * cell) / 1e6).toFixed(2)} km2 inside the world square`);

// ---------- 3b. THE ARMS ----------
// A water arm reaching east shows as a local maximum of shore x. Depth is measured against the
// LOWER of the two flanking minima (an arm is only as deep as the shallower side lets you round
// it), the MOUTH is the z distance between the two points where the shore first falls back to that
// base level, and the LAND BETWEEN two arms is the z gap between one arm's south flank and the
// next arm's north flank — the strip that has to carry a road.
const arms = (() => {
  const s = shore.filter((p) => Math.abs(p.z) <= half).slice().sort((a, b) => a.z - b.z);
  const WIN = 900;
  const heads = [];
  for (let i = 1; i < s.length - 1; i++) {
    if (!(s[i].x > s[i - 1].x && s[i].x >= s[i + 1].x)) continue;
    let minL = Infinity, minR = Infinity;
    let lo = i, hi = i;
    while (lo > 0 && s[i].z - s[lo].z < WIN) { lo--; if (s[lo].x < minL) minL = s[lo].x; }
    while (hi < s.length - 1 && s[hi].z - s[i].z < WIN) { hi++; if (s[hi].x < minR) minR = s[hi].x; }
    const base = Math.max(minL, minR);
    const depth = s[i].x - base;
    if (depth < 300) continue;
    // Mouth: first crossing of the base level on each side.
    let a = i; while (a > 0 && s[a].x > base) a--;
    let b = i; while (b < s.length - 1 && s[b].x > base) b++;
    heads.push({ x: s[i].x, z: s[i].z, depth, mouth: s[b].z - s[a].z, z0: s[a].z, z1: s[b].z });
  }
  heads.sort((p, q) => q.depth - p.depth);
  const kept = [];
  for (const h of heads) if (!kept.some((k) => h.z >= k.z0 && h.z <= k.z1)) kept.push(h);
  kept.sort((p, q) => p.z - q.z);
  return kept;
})();
line(`\n== ARMS reaching east (shore-x local maxima >= 300 u deep, inside the world square) ==`);
const byZ = shore.filter((p) => Math.abs(p.z) <= half).slice().sort((a, b) => a.z - b.z);
arms.forEach((h, i) => {
  let gap = '';
  if (i > 0) {
    // The LAND between two arms: how wide the tongue is head-to-head, and how far west its own
    // shoreline reaches (a tongue whose tip is close to the west edge is a drivable peninsula; one
    // that stops far east of it is a knife edge).
    const prev = arms[i - 1];
    let tip = Infinity;
    for (const p of byZ) if (p.z > prev.z && p.z < h.z) tip = Math.min(tip, p.x);
    gap = `  | land tongue to the previous arm: ${(h.z - prev.z).toFixed(0)} u head-to-head, its own shore reaches ${(tip + half).toFixed(0)} u from the west edge`;
  }
  line(`  z ${h.z.toFixed(0).padStart(6)}  head x ${h.x.toFixed(0).padStart(6)} = ${(h.x + half).toFixed(0)} u from the west edge  depth ${h.depth.toFixed(0).padStart(4)} u  mouth ${h.mouth.toFixed(0).padStart(4)} u${gap}`);
});
if (arms.length === 0) line('  none');

// ---------- 4. STRAIGHT-RUN / CAP AUDIT ----------
line(`\n== STRAIGHT-RUN AUDIT (maximal runs straight to 2 u of their own chord) ==`);
line(`   method: a run is a maximal span of the polygon whose every interior vertex lies within`);
line(`   2 units of the chord between its ends — curvature-aware, so it cannot be gamed by`);
line(`   subdividing a cap into short segments the way a per-segment or heading-chaining test can.`);
line(`   Each run is then scored by its CLOSEST APPROACH to the world square (256 samples), not by`);
line(`   whether its midpoint happens to fall inside it — the old test's blind spot, which is exactly`);
line(`   why a 2,029 u cap 321 u outside the square passed.`);
const straightRuns = (poly) => {
  const out = [];
  const n = poly.length;
  let i = 0;
  while (i < n - 1) {
    let j = i + 1;
    let last = j;
    while (j < n) {
      const a = poly[i], b = poly[j];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      let bulge = 0;
      for (let k = i + 1; k < j; k++) bulge = Math.max(bulge, Math.abs((poly[k].x - a.x) * dz - (poly[k].z - a.z) * dx) / len);
      if (bulge > 2) break;
      last = j; j++;
    }
    out.push([poly[i], poly[last]]);
    i = Math.max(last, i + 1);
  }
  return out;
};
const approach = (a, b) => {
  let best = Infinity;
  for (let t = 0; t <= 256; t++) {
    const x = a.x + (b.x - a.x) * (t / 256); const z = a.z + (b.z - a.z) * (t / 256);
    best = Math.min(best, Math.hypot(Math.max(Math.abs(x) - half, 0), Math.max(Math.abs(z) - half, 0)));
  }
  return best;
};
const VIS_U = 3000 / mpu;
// The ocean polygon is [shoreline..., closure...]. Split it: a straight stretch of SHORELINE is
// real coast (the raw OSM Vaal ring behind the longest one is straight to 8 m over 1,284 m), while a
// straight stretch of CLOSURE is the synthetic cap that was the defect. They get different bars.
const closureStart = shore.length - 1;
const rows = [];
for (const [name, poly] of [
  // OPEN polylines: wrapping a slice back to its own first vertex would invent a 4,971 u chord
  // that is not in the polygon at all (it caught me once — it reported as a 0.00 deg run).
  ['shoreline', ocean ? ocean.slice(0, shore.length) : null],
  ['CLOSURE', ocean ? [...ocean.slice(closureStart), ocean[0]] : null],
  ...map.water.map((w, i) => [`water[${i}] ${w.name ?? ''}`, [...PL(w.points), P(w.points[0])]]),
]) {
  if (!poly) continue;
  for (const [a, b] of straightRuns(poly)) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 120) continue;
    const ang = (Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI;
    const mo = Math.abs(((ang % 90) + 90) % 90);
    rows.push({ name, len, off: Math.min(mo, 90 - mo), d: approach(a, b), a, b });
  }
}
const visible = rows.filter((r) => r.d <= VIS_U).sort((x, y) => y.len - x.len);
line(`  runs within 3 km (${VIS_U.toFixed(0)} u) of the world square, longest first:`);
for (const r of visible.slice(0, 6)) {
  line(`    ${r.name}: ${r.len.toFixed(0)} u (${(r.len * mpu).toFixed(0)} m), ${r.off.toFixed(2)} deg off axis, ${r.d.toFixed(0)} u (${(r.d * mpu).toFixed(0)} m) from the square`);
}
const closure = rows.filter((r) => r.name === 'CLOSURE').sort((x, y) => y.len - x.len);
const closureNear = closure.filter((r) => r.d <= VIS_U).sort((x, y) => y.len - x.len)[0];
const shoreNear = rows.filter((r) => r.name === 'shoreline').sort((x, y) => y.len - x.len)[0];
line(`  WORST CLOSURE run within 3 km: ${closureNear ? `${closureNear.len.toFixed(0)} u at ${closureNear.off.toFixed(2)} deg, ${closureNear.d.toFixed(0)} u (${(closureNear.d * mpu).toFixed(0)} m) out` : 'none >= 120 u'}`);
if (closure[0]) line(`  longest CLOSURE run anywhere: ${closure[0].len.toFixed(0)} u (${(closure[0].len * mpu).toFixed(0)} m), ${closure[0].off.toFixed(2)} deg off axis, ${closure[0].d.toFixed(0)} u (${(closure[0].d * mpu).toFixed(0)} m) from the square`);
if (shoreNear) line(`  longest SHORELINE run (real coast): ${shoreNear.len.toFixed(0)} u (${(shoreNear.len * mpu).toFixed(0)} m), ${shoreNear.off.toFixed(2)} deg off axis`);
const closestClosure = closure.slice().sort((x, y) => x.d - y.d)[0];
if (closestClosure) line(`  closest CLOSURE run to the square: ${closestClosure.d.toFixed(0)} u (${(closestClosure.d * mpu).toFixed(0)} m), len ${closestClosure.len.toFixed(0)} u`);

// ---------- 5. Infra west of x = -3000 ----------
line(`\n== WEST-SIDE INFRASTRUCTURE (x < -3000) ==`);
const westRoads = map.roads.filter((r) => PL(r.points).every((p) => p.x < -3000));
const partWestRoads = map.roads.filter((r) => PL(r.points).some((p) => p.x < -3000));
line(`roads fully west  ${westRoads.length}   partially west ${partWestRoads.length}`);
const names = new Map();
for (const r of partWestRoads) names.set(r.name ?? '(unnamed)', (names.get(r.name ?? '(unnamed)') ?? 0) + 1);
line(`distinct names    ${names.size}`);
line(`  ${[...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([n, c]) => `${n}x${c}`).join(', ')}`);
const westTracks = (map.tracks ?? []).filter((t) => PL(t.points).some((p) => p.x < -3000));
line(`tracks west       ${westTracks.length}`);
const westLanduse = (map.landuse ?? []).filter((l) => PL(l.points).some((p) => p.x < -3000));
line(`landuse west      ${westLanduse.length}`);
const westDistricts = (map.districts ?? []).filter((d) => d.x < -3000);
line(`districts west    ${westDistricts.length}: ${westDistricts.map((d) => d.name).join(', ')}`);
const bl = (map.rural?.farms ?? []).map((f) => ({ x: f.x ?? P(f.p ?? [0,0]).x, z: f.z ?? P(f.p ?? [0,0]).z }));
line(`rural buildings west ${bl.filter((b) => b.x < -3000).length} / ${bl.length}`);
if (map.coast.shoreBuildings) line(`shore buildings   ${map.coast.shoreBuildings.length}`);

line(`\n== BUDGET ==`);
line(`map JSON          ${statSync(path).size} bytes (${(statSync(path).size / 1024).toFixed(1)} kB)`);
