/**
 * TRUTHFUL placement search: for a dense grid of (uniform scale, rotation, translation) it applies
 * the similarity to the REAL Vaal water polygon, clips it to the off-map box, and measures exactly
 * what the world square would show. No deformation anywhere — selection is the only lever.
 *
 *   node tools/mapgen/search-placement.mjs > renders/sel/placements.txt
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
  while (rem.length) { let ch = rem.shift(); let ext = true;
    while (ext) { ext = false;
      for (let i = 0; i < rem.length; i++) { const c = rem[i];
        if (key(c[0]) === key(ch[ch.length - 1])) ch = ch.concat(c.slice(1));
        else if (key(c[c.length - 1]) === key(ch[ch.length - 1])) ch = ch.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]) === key(ch[0])) ch = c.slice(0, -1).concat(ch);
        else if (key(c[0]) === key(ch[0])) ch = c.slice(1).reverse().concat(ch);
        else continue;
        rem.splice(i, 1); ext = true; break; } }
    rings.push(ch); }
  return rings.sort((a, b) => b.length - a.length);
}
function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dz = B.z - A.z; const L = Math.hypot(dx, dz) || 1;
    let bi = -1, bd = tol;
    for (let i = a + 1; i < b; i++) { const P = pts[i]; const d = Math.abs((P.x - A.x) * dz - (P.z - A.z) * dx) / L; if (d > bd) { bd = d; bi = i; } }
    if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); } }
  return pts.filter((_, i) => keep[i]);
}
function dpRing(ring, tol) {
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = (ring[i].x - ring[0].x) ** 2 + (ring[i].z - ring[0].z) ** 2; if (d > fd) { fd = d; far = i; } }
  return dp(ring.slice(0, far + 1), tol).concat(dp(ring.slice(far), tol).slice(1));
}
const outerFull = chainRings(relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry))[0]
  .map((g) => project(g.lat, g.lon));
const innersFull = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length)
  .map((m) => ({ id: m.ref, pts: m.geometry.map((g) => project(g.lat, g.lon)) }));
const coarse = { outer: dpRing(outerFull, 55), inners: innersFull.map((i) => ({ id: i.id, pts: dpRing(i.pts, 40) })) };
const fine = { outer: dpRing(outerFull, 12), inners: innersFull.map((i) => ({ id: i.id, pts: dpRing(i.pts, 8) })) };
console.error(`outer ${outerFull.length} -> coarse ${coarse.outer.length} / fine ${fine.outer.length}`);

const MPU = 1.36, WORLD_U = 9806, HALF = WORLD_U * MPU / 2;
const OVERHANG = 920 * MPU, NCLIP = HALF + 1400 * MPU, WCLIP = -HALF - OVERHANG;
function clipPoly(poly) {
  const planes = [
    [(p) => p.x >= WCLIP, (a, b) => ({ x: WCLIP, z: a.z + (b.z - a.z) * ((WCLIP - a.x) / (b.x - a.x)) })],
    [(p) => p.z >= -NCLIP, (a, b) => ({ x: a.x + (b.x - a.x) * ((-NCLIP - a.z) / (b.z - a.z)), z: -NCLIP })],
    [(p) => p.z <= NCLIP, (a, b) => ({ x: a.x + (b.x - a.x) * ((NCLIP - a.z) / (b.z - a.z)), z: NCLIP })],
  ];
  let cur = poly;
  for (const [inside, inter] of planes) { const next = [];
    for (let j = 0; j < cur.length; j++) { const a = cur[(j + cur.length - 1) % cur.length], b = cur[j];
      const ia = inside(a), ib = inside(b);
      if (ib) { if (!ia) next.push(inter(a, b)); next.push(b); } else if (ia) next.push(inter(a, b)); }
    cur = next; if (!cur.length) break; }
  return cur;
}
const spans = (poly, z) => { const xs = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j];
    if ((a.z > z) !== (b.z > z)) xs.push(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)); }
  return xs.sort((p, q) => p - q); };

function evaluate(src, k, deg, cx, cz, N) {
  const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  // (cx,cz) real -> map (-HALF, 0): the midpoint of the world's west edge
  const toMap = (p) => { const dx = p.x - cx, dz = p.z - cz;
    return { x: -HALF + (dx * cs + dz * sn) * k, z: (-dx * sn + dz * cs) * k }; };
  const water = clipPoly(src.outer.map(toMap));
  if (water.length < 3) return null;
  const isles = src.inners.map((i) => ({ id: i.id, pts: clipPoly(i.pts.map(toMap)) })).filter((i) => i.pts.length >= 3);
  let mnx = Infinity, mxx = -Infinity;
  for (const p of water) { mnx = Math.min(mnx, p.x); mxx = Math.max(mxx, p.x); }
  let wet = 0, wetRows = 0, edgeRows = 0, maxReach = -Infinity, sumReach = 0, holes = 0, overOk = 0;
  for (let r = 0; r < N; r++) {
    const z = -HALF + 2 * HALF * (r + 0.5) / N;
    const wx = spans(water, z); const ix = isles.map((s) => spans(s.pts, z));
    if (!wx.length) continue;
    const inW = (x) => { let hit = false;
      for (let i = 0; i + 1 < wx.length; i += 2) if (x >= wx[i] && x <= wx[i + 1]) { hit = true; break; }
      if (!hit) return false;
      for (const s of ix) for (let i = 0; i + 1 < s.length; i += 2) if (x >= s[i] && x <= s[i + 1]) return false;
      return true; };
    let rowWet = false, reach = -Infinity, prevWet = false, flips = 0;
    for (let c = 0; c < N; c++) {
      const x = -HALF + 2 * HALF * (c + 0.5) / N;
      const w = inW(x);
      if (w) { wet++; rowWet = true; reach = x; }
      if (w !== prevWet) flips++;
      prevWet = w;
    }
    if (rowWet) { wetRows++; sumReach += reach + HALF; if (reach + HALF > maxReach) maxReach = reach + HALF; holes += Math.max(0, flips - 2); }
    if (inW(-HALF + 25)) { edgeRows++; if (inW(WCLIP + 25) && inW((WCLIP - HALF) / 2)) overOk++; }
  }
  const g = isles.find((i) => i.id === 6139539);
  let gw = 0, gh = 0, gIn = false;
  if (g) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of g.pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
    gw = (b - a) / MPU; gh = (d - c) / MPU;
    const gcx = (a + b) / 2, gcz = (c + d) / 2;
    const insideFrac = Math.max(0, Math.min(b, HALF) - Math.max(a, -HALF)) / Math.max(1, b - a);
    gIn = gcx > -HALF + 150 && gcx < HALF * 0.9 && gcz > -HALF + 200 && gcz < HALF - 200 && insideFrac > 0.55; }
  return { widthU: (mxx - mnx) / MPU, overhangU: (-HALF - mnx) / MPU, areaPct: 100 * wet / (N * N),
    overOkPct: edgeRows ? 100 * overOk / edgeRows : 0,
    wetZPct: 100 * wetRows / N, edgeZPct: 100 * edgeRows / N, meanReachU: wetRows ? (sumReach / wetRows) / MPU : 0,
    maxReachU: maxReach === -Infinity ? 0 : maxReach / MPU, islands: isles.length, holes,
    grootW: gw, grootH: gh, grootIn: gIn };
}
function score(m) {
  if (!m) return -1e9;
  return m.edgeZPct * 0.13
    + m.areaPct * 1.15
    + (m.grootIn ? 7 : 0)
    - (m.grootIn ? Math.max(0, Math.abs(m.grootH - 950) - 350) / 100 * 1.4 : 0)
    + Math.min(5, m.islands) * 0.4
    + Math.min(60, m.holes) * 0.035                       // peninsulas & islets crossing the scanline
    - Math.max(0, m.widthU - 2150) / 100 * 2.6
    - Math.max(0, m.maxReachU - 1350) / 100 * 2.2
    - Math.max(0, 650 - m.overhangU) / 100 * 1.5
    - Math.max(0, 95 - m.overOkPct) * 0.10;
}

const out = [];
const KS = [0.34, 0.40, 0.46, 0.52, 0.60];
for (const k of KS) for (let deg = 0; deg < 360; deg += 6) {
  for (let gx = -13000; gx <= 14000; gx += 700) for (let gz = -12000; gz <= 11000; gz += 700) {
    const m = evaluate(coarse, k, deg, gx, gz, 110);
    if (!m || m.wetZPct < 25) continue;
    const s = score(m);
    if (s > 0) out.push({ k, deg, cx: gx, cz: gz, s });
  }
}
out.sort((a, b) => b.s - a.s);
console.error(`coarse pass: ${out.length} scoring placements`);
// refine the leaders at full resolution with a local jiggle
const refined = [];
const seen = new Set();
for (const c of out.slice(0, 260)) {
  for (const dk of [0.92, 1, 1.09]) for (const dd of [-3, 0, 3]) for (const dx of [-450, 0, 450]) for (const dz of [-450, 0, 450]) {
    const k = +(c.k * dk).toFixed(4), deg = (c.deg + dd + 360) % 360;
    const th = deg * Math.PI / 180;
    const cx = c.cx + dx * Math.cos(th) - dz * Math.sin(th), cz = c.cz + dx * Math.sin(th) + dz * Math.cos(th);
    const key = `${k}|${deg}|${Math.round(cx / 200)}|${Math.round(cz / 200)}`;
    if (seen.has(key)) continue; seen.add(key);
    const m = evaluate(fine, k, deg, cx, cz, 260);
    if (!m) continue;
    refined.push({ k, deg, cx, cz, s: score(m), ...m });
  }
}
refined.sort((a, b) => b.s - a.s);
const keep = [];
for (const r of refined) {
  if (keep.some((q) => Math.abs(q.deg - r.deg) < 12 && Math.abs(q.k - r.k) < 0.07 && Math.hypot(q.cx - r.cx, q.cz - r.cz) < 2200)) continue;
  keep.push(r); if (keep.length >= 16) break;
}
writeFileSync(new URL('../../renders/sel/placements.json', import.meta.url), JSON.stringify(keep, null, 1));
keep.forEach((r, i) => console.log(
  `#${i} s=${r.s.toFixed(2)} k=${r.k} rot=${r.deg} c=(${r.cx.toFixed(0)},${r.cz.toFixed(0)}) | width ${r.widthU.toFixed(0)}u ` +
  `over ${r.overhangU.toFixed(0)}u area ${r.areaPct.toFixed(1)}% wetZ ${r.wetZPct.toFixed(0)}% edgeZ ${r.edgeZPct.toFixed(0)}% ` +
  `meanR ${r.meanReachU.toFixed(0)}u maxR ${r.maxReachU.toFixed(0)}u overOk ${r.overOkPct.toFixed(0)}% isl ${r.islands} holes ${r.holes} ` +
  `Groot ${r.grootIn ? `${r.grootW.toFixed(0)}x${r.grootH.toFixed(0)}u` : (r.grootW ? 'partial' : 'no')}`));
