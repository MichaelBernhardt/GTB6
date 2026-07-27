/**
 * TRUTHFUL evaluation of Vaal placements: apply the similarity, clip to the off-map box, and
 * measure exactly what the world square would show — water width, west overhang, wet latitudes,
 * water area, max eastward reach, islands, Grooteiland's size. Then refine locally.
 *
 *   node tools/mapgen/eval-candidates.mjs [renders/sel/candidates.json]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

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
/** Douglas-Peucker on a CLOSED ring: split at the vertex farthest from the first, reduce each half.
 *  (A closed ring's first/last coincide, so a single DP call has a degenerate base segment.) */
function dpRing(ring, tol) {
  const n = ring.length;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = (ring[i].x - ring[0].x) ** 2 + (ring[i].z - ring[0].z) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), tol);
  const b = dp(ring.slice(far), tol);
  return a.concat(b.slice(1));
}
function dp(points, tol) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length); keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); const A = points[a], B = points[b];
    const dx = B.x - A.x, dz = B.z - A.z; const L = Math.hypot(dx, dz) || 1;
    let bi = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const P = points[i]; const d = Math.abs((P.x - A.x) * dz - (P.z - A.z) * dx) / L;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return points.filter((_, i) => keep[i]);
}
const outerFull = chainRings(relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry))[0]
  .map((g) => project(g.lat, g.lon));
const outer = dpRing(outerFull, 18);
const inners = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length)
  .map((m) => ({ id: m.ref, pts: dpRing(m.geometry.map((g) => project(g.lat, g.lon)), 12) }));
console.error(`outer ${outerFull.length} -> ${outer.length} pts, ${inners.length} inner rings`);

const MPU = 1.36, WORLD_U = 9806;
const HALF = WORLD_U * MPU / 2;
const OVERHANG = 920 * MPU;
const NCLIP = HALF + 1400 * MPU, WCLIP = -HALF - OVERHANG;

function clipPoly(poly) {
  const planes = [
    [(p) => p.x >= WCLIP, (a, b) => { const t = (WCLIP - a.x) / (b.x - a.x); return { x: WCLIP, z: a.z + (b.z - a.z) * t }; }],
    [(p) => p.z >= -NCLIP, (a, b) => { const t = (-NCLIP - a.z) / (b.z - a.z); return { x: a.x + (b.x - a.x) * t, z: -NCLIP }; }],
    [(p) => p.z <= NCLIP, (a, b) => { const t = (NCLIP - a.z) / (b.z - a.z); return { x: a.x + (b.x - a.x) * t, z: NCLIP }; }],
  ];
  let cur = poly;
  for (const [inside, inter] of planes) {
    const next = [];
    for (let j = 0; j < cur.length; j++) {
      const a = cur[(j + cur.length - 1) % cur.length], b = cur[j];
      const ia = inside(a), ib = inside(b);
      if (ib) { if (!ia) next.push(inter(a, b)); next.push(b); } else if (ia) next.push(inter(a, b));
    }
    cur = next; if (!cur.length) break;
  }
  return cur;
}

export function place(k, deg, ox, oz, bandN) {
  const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  const toMap = (p) => {
    const dx = p.x - ox, dz = p.z - oz;
    return { x: -HALF + (dx * cs + dz * sn) * k, z: bandN + (-dx * sn + dz * cs) * k };
  };
  const water = clipPoly(outer.map(toMap));
  const isles = inners.map((i) => ({ id: i.id, pts: clipPoly(i.pts.map(toMap)) })).filter((i) => i.pts.length >= 3);
  return { water, isles, toMap };
}

const ROWS = 300, COLS = 300;
export function measure(water, isles) {
  if (water.length < 3) return null;
  let mnx = Infinity, mxx = -Infinity;
  for (const p of water) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); }
  // scanline over the world square
  let wetCells = 0, wetRows = 0, maxReach = -Infinity, sumReach = 0, nReach = 0, edgeRows = 0;
  const spans = (poly, z) => { const xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.z > z) !== (b.z > z)) xs.push(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
    } return xs.sort((p, q) => p - q); };
  for (let r = 0; r < ROWS; r++) {
    const z = -HALF + (2 * HALF) * (r + 0.5) / ROWS;
    const wx = spans(water, z); const ix = isles.map((s) => spans(s.pts, z));
    const inW = (x) => { let c = 0; for (let i = 0; i + 1 < wx.length; i += 2) if (x >= wx[i] && x <= wx[i + 1]) c++;
      if (!c) return false;
      for (const s of ix) for (let i = 0; i + 1 < s.length; i += 2) if (x >= s[i] && x <= s[i + 1]) return false;
      return true; };
    let rowWet = false, reach = -Infinity;
    for (let c = 0; c < COLS; c++) {
      const x = -HALF + (2 * HALF) * (c + 0.5) / COLS;
      if (inW(x)) { wetCells++; rowWet = true; reach = x; }
    }
    if (rowWet) { wetRows++; sumReach += reach + HALF; nReach++; if (reach + HALF > maxReach) maxReach = reach + HALF; }
    if (inW(-HALF + 30)) edgeRows++;
  }
  const g = isles.find((i) => i.id === 6139539);
  let gw = 0, gh = 0, gIn = false;
  if (g) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of g.pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
    gw = (b - a) / MPU; gh = (d - c) / MPU;
    gIn = b < HALF && a > -HALF - OVERHANG * 0.55 && c > -HALF && d < HALF; }
  return {
    widthU: (mxx - mnx) / MPU, overhangU: (-HALF - mnx) / MPU,
    areaPct: 100 * wetCells / (ROWS * COLS), wetRowsPct: 100 * wetRows / ROWS, edgeRowsPct: 100 * edgeRows / ROWS,
    meanReachU: nReach ? (sumReach / nReach) / MPU : 0, maxReachU: maxReach === -Infinity ? 0 : maxReach / MPU,
    islands: isles.length, grootW: gw, grootH: gh, grootIn: gIn,
  };
}

export function score(m) {
  if (!m) return -1e9;
  let s = 0;
  s += m.wetRowsPct * 0.10;                                   // coverage down the west edge
  s -= Math.max(0, m.widthU - 2100) / 100 * 2.2;              // width budget
  s -= Math.max(0, m.maxReachU - 1300) / 100 * 2.0;           // no arm eating the corridor
  s -= Math.abs(m.areaPct - 7.9) * 0.55;                      // the old ocean's in-world water area
  s += m.grootIn ? 6 : 0;
  s -= m.grootIn ? Math.max(0, Math.abs(m.grootH - 900) - 320) / 100 * 1.2 : 0;
  s += Math.min(6, m.islands) * 0.45;
  s -= Math.max(0, 88 - m.edgeRowsPct / Math.max(1e-6, m.wetRowsPct) * 100) * 0.05;
  return s;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cands = JSON.parse(readFileSync(process.argv[2] ?? new URL('../../renders/sel/candidates.json', import.meta.url), 'utf8'));
  const out = [];
  const seen = new Set();
  for (const c of cands.slice(0, 60)) {
    for (const dk of [0.85, 1.0, 1.18, 1.4]) for (const dd of [-8, -4, 0, 4, 8]) for (const du of [-4000, -2000, 0, 2000, 4000]) for (const dv of [-900, 0, 900]) {
      const k = +(c.k * dk).toFixed(4), deg = (c.deg + dd + 360) % 360;
      const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
      const ox = c.ox + du * -sn + dv * cs, oz = c.oz + du * cs + dv * sn;
      const bandN = -(c.H * dk) / 2;                       // centre the lobe vertically
      const key = `${k}|${deg}|${Math.round(ox / 300)}|${Math.round(oz / 300)}|${Math.round(bandN / 300)}`;
      if (seen.has(key)) continue; seen.add(key);
      const { water, isles } = place(k, deg, ox, oz, bandN);
      const m = measure(water, isles);
      const s = score(m);
      if (m) out.push({ k, deg, ox, oz, bandN, s, ...m });
    }
  }
  out.sort((a, b) => b.s - a.s);
  const keep = [];
  for (const r of out) {
    if (keep.some((q) => Math.abs(q.deg - r.deg) < 10 && Math.abs(q.k - r.k) < 0.06 && Math.hypot(q.ox - r.ox, q.oz - r.oz) < 2500)) continue;
    keep.push(r); if (keep.length >= 14) break;
  }
  writeFileSync(new URL('../../renders/sel/ranked.json', import.meta.url), JSON.stringify(keep, null, 1));
  keep.forEach((r, i) => console.log(
    `#${i} s=${r.s.toFixed(2)} k=${r.k} rot=${r.deg} o=(${r.ox.toFixed(0)},${r.oz.toFixed(0)}) bandN=${r.bandN.toFixed(0)} | ` +
    `width ${r.widthU.toFixed(0)}u over ${r.overhangU.toFixed(0)}u area ${r.areaPct.toFixed(1)}% wetZ ${r.wetRowsPct.toFixed(0)}% ` +
    `edgeZ ${r.edgeRowsPct.toFixed(0)}% meanR ${r.meanReachU.toFixed(0)}u maxR ${r.maxReachU.toFixed(0)}u isl ${r.islands} ` +
    `Groot ${r.grootIn ? `${r.grootW.toFixed(0)}x${r.grootH.toFixed(0)}u` : 'no'}`));
  console.log(`evaluated ${out.length} placements`);
}
