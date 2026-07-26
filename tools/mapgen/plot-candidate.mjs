/**
 * Draw a candidate Vaal placement AS THE MAP WILL SEE IT: the world square in game units, the
 * transformed + clipped real water polygon, the islands, and the budget lines. Nothing here is
 * deformed — the only transform is one uniform scale, one rotation, one translation.
 *
 *   node tools/mapgen/plot-candidate.mjs out.png k deg ox oz [label]
 * where (ox,oz) is the real-metre point that becomes the NORTH end of the map's WEST EDGE line.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const CACHE = new URL('./cache/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL(readdirSync(CACHE).find((f) => f.startsWith('overpass-vaal-')), CACHE), 'utf8'));
const data = raw.data ?? raw;
const relation = data.elements.find((e) => e.type === 'relation' && e.id === 253822);
const ORIGIN = { lat: -26.9, lon: 28.15 }; const RE = 6378137;
const project = (lat, lon) => ({
  x: ((lon - ORIGIN.lon) * Math.PI / 180) * RE * Math.cos((ORIGIN.lat * Math.PI) / 180),
  z: -((lat - ORIGIN.lat) * Math.PI / 180) * RE,
});
function chainRings(members) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const rem = members.filter((m) => m.length >= 2).map((m) => [...m]); const rings = [];
  while (rem.length) {
    let ch = rem.shift(); let ext = true;
    while (ext) { ext = false;
      for (let i = 0; i < rem.length; i++) { const c = rem[i];
        if (key(c[0]) === key(ch[ch.length - 1])) ch = ch.concat(c.slice(1));
        else if (key(c[c.length - 1]) === key(ch[ch.length - 1])) ch = ch.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]) === key(ch[0])) ch = c.slice(0, -1).concat(ch);
        else if (key(c[0]) === key(ch[0])) ch = c.slice(1).reverse().concat(ch);
        else continue;
        rem.splice(i, 1); ext = true; break; } }
    rings.push(ch);
  }
  return rings.sort((a, b) => b.length - a.length);
}
const outer = chainRings(relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry))[0]
  .map((g) => project(g.lat, g.lon));
const inners = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length)
  .map((m) => ({ id: m.ref, pts: m.geometry.map((g) => project(g.lat, g.lon)) }));

const LANDMARKS = [
  ['Deneysville', -26.89, 28.0964], ['Refengkgotso', -26.8953, 28.0725], ['Dam wall', -26.8722, 28.1119],
  ['Grooteiland', -26.8671, 28.1726], ['MISTY BAY', -26.888104, 28.192121], ['Marina Latata', -26.8753, 28.2003],
  ['Vaal Marina', -26.8744, 28.2311], ['Oranjeville', -26.9722, 28.2036], ['Jim Fouche', -26.9269, 28.1531],
];

// ---- map frame -------------------------------------------------------------------------------
const MPU = 1.36, WORLD_U = 9806;
const HALF = WORLD_U * MPU / 2;                       // world half-size in map metres
const OVERHANG = Number(process.env.OVERHANG ?? 920) * MPU;
const [out, kS, degS, oxS, ozS, label] = process.argv.slice(2);
const k = Number(kS), deg = Number(degS), ox = Number(oxS), oz = Number(ozS);
const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
// real (ox,oz) is the north end of the map west-edge line, which sits at map (-HALF, bandNorth).
const BAND_N = Number(process.env.BAND_N ?? -HALF);
// world = ox + v*(cs,sn) + u*(-sn,cs)  ->  map x = -HALF + v*k, map z = BAND_N + u*k
const toMap = (p) => {
  const dx = p.x - ox, dz = p.z - oz;
  const v = dx * cs + dz * sn, u = -dx * sn + dz * cs;
  return { x: -HALF + v * k, z: BAND_N + u * k };
};

// clip against three half-planes (west / north / south) — never east, an east cut would be visible
const CLIPS = [
  (p) => p.x >= -HALF - OVERHANG,
  (p) => p.z >= -HALF - 1400 * MPU,
  (p) => p.z <= HALF + 1400 * MPU,
];
const INTER = [
  (a, b) => { const t = (-HALF - OVERHANG - a.x) / (b.x - a.x); return { x: -HALF - OVERHANG, z: a.z + (b.z - a.z) * t }; },
  (a, b) => { const L = -HALF - 1400 * MPU; const t = (L - a.z) / (b.z - a.z); return { x: a.x + (b.x - a.x) * t, z: L }; },
  (a, b) => { const L = HALF + 1400 * MPU; const t = (L - a.z) / (b.z - a.z); return { x: a.x + (b.x - a.x) * t, z: L }; },
];
function clipPoly(poly) {
  let cur = poly;
  for (let i = 0; i < CLIPS.length; i++) {
    const inside = CLIPS[i], inter = INTER[i]; const next = [];
    for (let j = 0; j < cur.length; j++) {
      const a = cur[(j + cur.length - 1) % cur.length], b = cur[j];
      const ia = inside(a), ib = inside(b);
      if (ib) { if (!ia) next.push(inter(a, b)); next.push(b); }
      else if (ia) next.push(inter(a, b));
    }
    cur = next; if (!cur.length) break;
  }
  return cur;
}
const water = clipPoly(outer.map(toMap));
const isles = inners.map((i) => ({ id: i.id, pts: clipPoly(i.pts.map(toMap)) })).filter((i) => i.pts.length >= 3);

// ---- measure ---------------------------------------------------------------------------------
let wmnx = Infinity, wmxx = -Infinity, wmnz = Infinity, wmxz = -Infinity;
for (const p of water) { wmnx = Math.min(wmnx, p.x); wmxx = Math.max(wmxx, p.x); wmnz = Math.min(wmnz, p.z); wmxz = Math.max(wmxz, p.z); }
const pip = (poly, x, z) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
  const a = poly[i], b = poly[j]; if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) c = !c; } return c; };
const N = 420; let inside = 0, wetRows = 0, maxReach = -Infinity, sumReach = 0, nReach = 0;
for (let j = 0; j < N; j++) {
  const z = -HALF + (2 * HALF) * (j + 0.5) / N; let rowWet = false, reach = -HALF;
  for (let i = 0; i < N; i++) {
    const x = -HALF + (2 * HALF) * (i + 0.5) / N;
    if (pip(water, x, z) && !isles.some((s) => pip(s.pts, x, z))) { inside++; rowWet = true; reach = x; }
  }
  if (rowWet) { wetRows++; sumReach += (reach + HALF); nReach++; maxReach = Math.max(maxReach, reach + HALF); }
}
const stats = {
  widthU: (wmxx - wmnx) / MPU, overhangU: (-HALF - wmnx) / MPU,
  areaPct: 100 * inside / (N * N), wetRowsPct: 100 * wetRows / N,
  meanReachU: (sumReach / Math.max(1, nReach)) / MPU, maxReachU: maxReach / MPU,
  islands: isles.length,
  grooteilandU: (() => { const g = isles.find((i) => i.id === 6139539); if (!g) return null;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of g.pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
    return { w: (b - a) / MPU, h: (d - c) / MPU }; })(),
};

// ---- draw ------------------------------------------------------------------------------------
const W = 1100, PADPX = 60;
const view = { x0: -HALF - OVERHANG - 400, x1: HALF, z0: -HALF - 2400, z1: HALF + 2400 };
const s = (W - 2 * PADPX) / (view.x1 - view.x0);
const H = Math.round((view.z1 - view.z0) * s) + 2 * PADPX;
const cv = createCanvas(W, H); const g = cv.getContext('2d');
const px = (p) => [PADPX + (p.x - view.x0) * s, PADPX + (p.z - view.z0) * s];
g.fillStyle = '#101418'; g.fillRect(0, 0, W, H);
// world square
g.fillStyle = '#3c4a35';
const [sx0, sz0] = px({ x: -HALF, z: -HALF }); const [sx1, sz1] = px({ x: HALF, z: HALF });
g.fillRect(sx0, sz0, sx1 - sx0, sz1 - sz0);
// water
g.fillStyle = '#2f6fa8'; g.beginPath();
water.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.fill();
g.fillStyle = '#6f8f5a';
for (const isl of isles) { g.beginPath(); isl.pts.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.fill(); }
// world square outline + budget lines
g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.strokeRect(sx0, sz0, sx1 - sx0, sz1 - sz0);
g.strokeStyle = '#ff5050'; g.lineWidth = 1.5; g.setLineDash([6, 5]);
for (const u of [1180]) { const [a] = px({ x: -HALF + u * MPU, z: 0 }); g.beginPath(); g.moveTo(a, sz0); g.lineTo(a, sz1); g.stroke(); }
g.setLineDash([]);
// landmarks
g.font = 'bold 13px sans-serif';
for (const [name, lat, lon] of LANDMARKS) {
  const m = toMap(project(lat, lon)); const [a, b] = px(m);
  if (a < 0 || a > W || b < 0 || b > H) continue;
  g.fillStyle = '#ff3030'; g.beginPath(); g.arc(a, b, 4, 0, 7); g.fill();
  g.fillStyle = '#ffe'; g.fillText(name, a + 7, b + 4);
}
g.fillStyle = '#fff'; g.font = 'bold 14px sans-serif';
g.fillText(`${label ?? ''} k=${k} rot=${deg} origin=(${ox},${oz})`, 8, 20);
g.font = '13px sans-serif';
g.fillText(`width ${stats.widthU.toFixed(0)}u (${(100 * stats.widthU / WORLD_U).toFixed(1)}%)  overhang ${stats.overhangU.toFixed(0)}u  `
  + `area ${stats.areaPct.toFixed(1)}%  wet latitudes ${stats.wetRowsPct.toFixed(0)}%`, 8, 38);
g.fillText(`mean reach ${stats.meanReachU.toFixed(0)}u  max reach ${stats.maxReachU.toFixed(0)}u  islands ${stats.islands}  `
  + `Grooteiland ${stats.grooteilandU ? `${stats.grooteilandU.w.toFixed(0)}x${stats.grooteilandU.h.toFixed(0)}u` : 'ABSENT'}`, 8, 55);
writeFileSync(out, cv.toBuffer('image/png'));
console.log(JSON.stringify({ label, k, deg, ox, oz, ...stats }, null, 0));
