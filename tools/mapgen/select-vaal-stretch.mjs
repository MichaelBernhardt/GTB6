/**
 * SELECT, DON'T SQUASH — design-time search for the stretch of the REAL Vaal whose shoreline fits
 * the map's west band under ONE uniform scale, ONE rotation and ONE translation.
 *
 * The band is specified by the line inside the real dam that will become the map's WEST EDGE.
 * Requirements, all measured against the old ocean nobody complained about:
 *   - water reaches that line at nearly every latitude (no dry gap at the world's west edge);
 *   - the strip `overhang` west of the line is wet (nothing off-map is ever a far shore);
 *   - water never reaches more than `reachMax` east of the line (that is the whole budget);
 *   - the mean reach lands near the old ocean's, so the water area matches.
 * Grooteiland inside the band and a lively reach profile break the ties.
 *
 *   node tools/mapgen/select-vaal-stretch.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const CACHE = new URL('./cache/', import.meta.url);
const raw = JSON.parse(readFileSync(new URL(readdirSync(CACHE).find((f) => f.startsWith('overpass-vaal-')), CACHE), 'utf8'));
const data = raw.data ?? raw;
const relation = data.elements.find((e) => e.type === 'relation' && e.id === 253822);
const ORIGIN = { lat: -26.9, lon: 28.15 };
const RE = 6378137;
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
const outers = chainRings(relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry))
  .map((r) => r.map((g) => project(g.lat, g.lon)));
const inners = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length)
  .map((m) => ({ id: m.ref, pts: m.geometry.map((g) => project(g.lat, g.lon)) }));
const G = inners.find((i) => i.id === 6139539);
const grootC = { x: G.pts.reduce((t, p) => t + p.x, 0) / G.pts.length, z: G.pts.reduce((t, p) => t + p.z, 0) / G.pts.length };

// ---- base raster (north-up) -------------------------------------------------------------------
const CELL = 60;
let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
for (const r of outers) for (const p of r) { bx0 = Math.min(bx0, p.x); bx1 = Math.max(bx1, p.x); bz0 = Math.min(bz0, p.z); bz1 = Math.max(bz1, p.z); }
const PAD = 14000;
bx0 -= PAD; bx1 += PAD; bz0 -= PAD; bz1 += PAD;
const BW = Math.ceil((bx1 - bx0) / CELL), BH = Math.ceil((bz1 - bz0) / CELL);
const base = new Uint8Array(BW * BH);
function fill(poly, val, W, H, ox, oz, buf) {
  let y0 = Infinity, y1 = -Infinity;
  for (const p of poly) { y0 = Math.min(y0, p.z); y1 = Math.max(y1, p.z); }
  const r0 = Math.max(0, Math.floor((y0 - oz) / CELL)), r1 = Math.min(H - 1, Math.ceil((y1 - oz) / CELL));
  for (let r = r0; r <= r1; r++) {
    const z = oz + (r + 0.5) * CELL; const xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.z > z) !== (b.z > z)) xs.push(a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - ox) / CELL - 0.5)), c1 = Math.min(W - 1, Math.floor((xs[k + 1] - ox) / CELL - 0.5));
      for (let c = c0; c <= c1; c++) buf[r * W + c] = val;
    }
  }
}
for (const r of outers) fill(r, 1, BW, BH, bx0, bz0, base);
for (const i of inners) fill(i.pts, 0, BW, BH, bx0, bz0, base);
console.log(`base raster ${BW}x${BH} @${CELL}m`);

// ---- budget, in MAP metres (1.36 m per game unit) ---------------------------------------------
const MPU = 1.36;
const OVERHANG = 920 * MPU;    // wet strip west of the world edge  (old ocean: 9.4% of the width)
const REACH_MEAN = 775 * MPU;  // mean water reach east of it       (old ocean: 7.9% water area)
const CAPS = (process.env.CAPS ? process.env.CAPS.split(',').map(Number) : [1180]);
const HEIGHTS = (process.env.HEIGHT ?? '16200').split(',').map(Number); // hugging length along the west edge, map m

const KS = process.env.KS ? process.env.KS.split(',').map(Number) : [0.28, 0.34, 0.40, 0.46, 0.54, 0.62];
const bestPerK = new Map();
const stats = new Map();
const results = [];
const rot = new Uint8Array(BW * BH);       // rotated mask, reused
const prevW = new Int32Array(BW * BH);     // per row: largest col <= c that is water (-1 none)

for (let deg = 0; deg < 360; deg += 8) {
  const th = deg * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
  // rotated frame: column index = v (map +x, east/inland), row index = u (map +z, south)
  // world = centre + (v)*(cs,sn) + (u)*(-sn,cs)
  const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
  rot.fill(0);
  for (let r = 0; r < BH; r++) {
    const u = (r - BH / 2 + 0.5) * CELL;
    for (let c = 0; c < BW; c++) {
      const v = (c - BW / 2 + 0.5) * CELL;
      const wx = cx + v * cs - u * sn, wz = cz + v * sn + u * cs;
      const bc = ((wx - bx0) / CELL) | 0, br = ((wz - bz0) / CELL) | 0;
      if (bc >= 0 && br >= 0 && bc < BW && br < BH) rot[r * BW + c] = base[br * BW + bc];
    }
  }
  for (let r = 0; r < BH; r++) {
    const o = r * BW;
    let c = 0;
    while (c < BW) {
      if (!rot[o + c]) { prevW[o + c] = -1; c++; continue; }
      let e = c; while (e + 1 < BW && rot[o + e + 1]) e++;
      for (let i = c; i <= e; i++) prevW[o + i] = e;   // end of the run this cell belongs to
      c = e + 1;
    }
  }
  // Grooteiland in the rotated frame
  const gdx = grootC.x - cx, gdz = grootC.z - cz;
  const gv = gdx * cs + gdz * sn, gu = -gdx * sn + gdz * cs;
  const gc = gv / CELL + BW / 2, gr = gu / CELL + BH / 2;

  for (const k of KS) for (const CAPU of CAPS) {
    const REACH_MAX = CAPU * MPU;
    const skey0 = `k${k} cap${CAPU}`;

    const over = OVERHANG / k, rMean = REACH_MEAN / k, rMax = REACH_MAX / k;
    const S = Math.round((rMax * 3.0) / CELL);          // scan window, cells
    const oc = Math.round(over / CELL);
    const rMaxC = rMax / CELL;
    // per-cell reach in cells, and the three prefix sums we need down each column
    const sumR = new Float64Array(BW * (BH + 1));
    const cntBad = new Int32Array(BW * (BH + 1));
    const cntEdge = new Int32Array(BW * (BH + 1));
    const cntOver = new Int32Array(BW * (BH + 1));
    const cntEO = new Int32Array(BW * (BH + 1));
    const cntTurn = new Int32Array(BW * (BH + 1));
    const prevD = new Float64Array(BW); const prevDelta = new Float64Array(BW);
    for (let r = 0; r < BH; r++) {
      const o = r * BW, oo = r * BW, on = (r + 1) * BW;
      for (let c = 0; c < BW; c++) {
        const w = prevW[o + c];
        const reach = w >= c ? w - c : 0;
        const edge = rot[o + c] ? 1 : 0;
        const ov = (c - oc >= 0 && rot[o + c - oc] && rot[o + Math.max(0, c - (oc >> 1))]) ? 1 : 0;
        const d = reach - prevD[c]; const turn = (r > 1 && d * prevDelta[c] < 0) ? 1 : 0;
        prevDelta[c] = d; prevD[c] = reach;
        sumR[on + c] = sumR[oo + c] + reach;
        cntBad[on + c] = cntBad[oo + c] + (reach > rMaxC ? 1 : 0);
        cntEdge[on + c] = cntEdge[oo + c] + edge;
        cntOver[on + c] = cntOver[oo + c] + ov;
        cntEO[on + c] = cntEO[oo + c] + (edge && ov ? 1 : 0);
        cntTurn[on + c] = cntTurn[oo + c] + turn;
      }
    }
    for (const HEIGHT of HEIGHTS) {
    const skey = `${skey0} H${HEIGHT}`;
    if (!stats.has(skey)) stats.set(skey, { tot: 0, edge: 0, over: 0, bad: 0, eo: 0 });
    const stat = stats.get(skey);
    const rowsN = Math.round((HEIGHT / k) / CELL);
    if (rowsN >= BH - 4) continue;
    const stepR = Math.max(4, Math.round(600 / CELL));
    const stepC = Math.max(4, Math.round(600 / CELL));
    for (let r0 = 0; r0 + rowsN < BH; r0 += stepR) {
      const a = r0 * BW, b = (r0 + rowsN) * BW;
      for (let c = oc + 2; c < BW - S - 2; c += stepC) {
        const nEdge = cntEdge[b + c] - cntEdge[a + c];
        const nOver = cntEO[b + c] - cntEO[a + c];   // wet edge AND wet overhang
        const nBad = cntBad[b + c] - cntBad[a + c];
        const mean = (sumR[b + c] - sumR[a + c]) / rowsN * CELL;
        stat.tot++;
        // Where the water MEETS the world's west edge it must keep going west past the clip line.
        // Where it does not, that latitude is honest dry land and needs no overhang at all.
        if (nEdge >= rowsN * 0.35) stat.edge++;
        if (nEdge > 0 && nOver / nEdge >= 0.95) stat.over++;
        if (nBad <= rowsN * 0.02) stat.bad++;
        if (nEdge < rowsN * 0.30 || nOver < nEdge * 0.95 || nBad > rowsN * 0.02) continue;
        stat.eo++;
        const turns = cntTurn[b + c] - cntTurn[a + c];
        const inG = gr > r0 + rowsN * 0.04 && gr < r0 + rowsN * 0.96 && gc > c - oc && gc < c + rMaxC;
        // SOFT score: hard requirements become steep penalties so the best near-miss is still visible.
        const score = (inG ? 3 : 0) + (turns / rowsN) * 1.6 + (nEdge / rowsN) * 6
          - Math.abs(mean - rMean) / rMean * 0.6;
        // world coords of the band origin (the west-edge line's north end)
        const v = (c - BW / 2 + 0.5) * CELL, u = (r0 - BH / 2 + 0.5) * CELL;
        const cand = { k, deg, H: HEIGHT, cap: CAPU, ox: cx + v * cs - u * sn, oz: cz + v * sn + u * cs, mean, turns: turns / rowsN,
          edge: nEdge / rowsN, over: nOver / rowsN, bad: nBad / rowsN, groot: inG ? 1 : 0, score };
        results.push(cand);
        const bkey = `${k}|${CAPU}|${HEIGHT}`;
        const bk = bestPerK.get(bkey);
        if (!bk || cand.score > bk.score) bestPerK.set(bkey, cand);
      }
    }
    }
  }
  if (deg % 48 === 0) console.log(`rot ${deg} -> ${results.length} candidates`);
}
results.sort((a, b) => b.score - a.score);
const keep = [];
for (const r of results) {
  if (keep.some((q) => q.k === r.k && q.H === r.H && Math.abs(q.deg - r.deg) < 12 && Math.hypot(q.ox - r.ox, q.oz - r.oz) < 2500)) continue;
  keep.push(r); if (keep.length >= 400) break;
}
writeFileSync(new URL('../../renders/sel/candidates.json', import.meta.url), JSON.stringify(keep, null, 1));
const fmt = (r, i) =>
  `#${i} score ${r.score.toFixed(2)} H=${r.H} cap=${r.cap}u k=${r.k} rot=${r.deg} line0=(${r.ox.toFixed(0)},${r.oz.toFixed(0)}) ` +
  `meanReach=${(r.mean * r.k / MPU).toFixed(0)}u edge=${(r.edge * 100).toFixed(0)}% over=${(r.over * 100).toFixed(0)}% ` +
  `over-cap=${(r.bad * 100).toFixed(1)}% turns=${r.turns.toFixed(2)} groot=${r.groot}`;
keep.slice(0, 8).forEach((r, i) => console.log(fmt(r, i)));
console.log(`wrote ${keep.length} candidates`);
console.log('--- filter funnel (windows passing each test) ---');
[...stats.entries()].forEach(([k, s2]) => console.log(`${k}: tot ${s2.tot} edge>=90% ${s2.edge} over>=88% ${s2.over} reach-ok ${s2.bad} edge&over ${s2.eo}`));
console.log('--- best per scale ---');
[...bestPerK.entries()].forEach(([k, r]) => console.log(fmt(r, `k${k}`)));
