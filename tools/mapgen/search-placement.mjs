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
// EXACTLY tools/mapgen/projection.ts makeProjector(VAAL_ORIGIN) — same constant, same signs, so a
// placement chosen here lands where the build puts it rather than 0.2% away from it.
const ORIGIN = { lat: -26.9, lon: 28.15 }; const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const project = (lat, lon) => ({ x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: (ORIGIN.lat - lat) * M_PER_DEG_LAT });
const unproject = (x, z) => ({ lat: ORIGIN.lat - z / M_PER_DEG_LAT, lon: ORIGIN.lon + x / M_PER_DEG_LON });
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
// Match what the build actually clips at (DAM_OVERHANG_M): the budget is measured off the
// same box the map will show, or the search is grading a picture nobody will see.
const OVERHANG = Number(process.env.OVERHANG_U ?? 700) * MPU, NCLIP = HALF + 1400 * MPU, WCLIP = -HALF - OVERHANG;
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

/**
 * THE NAMED PLACES THE PLACEMENT HAS TO CONTAIN, in the same projected frame.
 * Misty Bay is the one the owner named twice and gave a coordinate for, because OSM does not label
 * it; Grooteiland is the one he named by name and it carries the Round the Island race, so it has
 * to sit far enough off the west edge that a boat can get round the outside of it.
 */
const MISTY = project(-26.888104, 28.192121);
const GROOT_ID = 6139539;
/** A boat needs a channel, not a chink: Grooteiland's west shore must clear the world edge by this
 *  many units (~520 m) so the Round the Island race can actually go round the outside. */
const GROOT_CLEAR_U = 380;
/** Misty Bay must be properly inland of the west edge, not clinging to it: its streets run inland
 *  and its beaches face the water, and both have to be on the map. */
const MISTY_CLEAR_U = 500;
const MAX_REACH_U = Number(process.env.MAX_REACH_U ?? 0);

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
  const edgeWet = new Uint8Array(N);            // is the WORLD'S WEST BOUNDARY itself wet at this row?
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
    if (inW(-HALF + 25)) { edgeRows++; edgeWet[r] = 1; if (inW(WCLIP + 25) && inW((WCLIP - HALF) / 2)) overOk++; }
  }
  // R3. 38% of the west boundary wet, in two 1.6 km dry runs at the corners, read as empty veld
  // with a ruler-straight termination. What we want is a mostly-wet edge with SHORT dry wraps at
  // the two corners — so grade the longest dry run as well as the total, and reward having land at
  // both corners rather than one long dry half.
  let longestDry = 0, run = 0;
  for (let r = 0; r < N; r++) { if (edgeWet[r]) run = 0; else { run++; if (run > longestDry) longestDry = run; } }
  const dryRunU = (longestDry / N) * 2 * HALF / MPU;
  const cornerN = !edgeWet[2], cornerS = !edgeWet[N - 3];

  const g = isles.find((i) => i.id === GROOT_ID);
  let gw = 0, gh = 0, gIn = false, gClearU = 0;
  if (g) { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const p of g.pts) { a = Math.min(a, p.x); b = Math.max(b, p.x); c = Math.min(c, p.z); d = Math.max(d, p.z); }
    gw = (b - a) / MPU; gh = (d - c) / MPU;
    const gcx = (a + b) / 2, gcz = (c + d) / 2;
    const insideFrac = Math.max(0, Math.min(b, HALF) - Math.max(a, -HALF)) / Math.max(1, b - a);
    // R4. The whole ring has to be inside the square with a navigable channel on the OUTSIDE too,
    // so the west shore's clearance from the world edge is the number that matters, not the centre.
    gClearU = (a - (-HALF)) / MPU;
    gIn = insideFrac > 0.97 && gClearU >= GROOT_CLEAR_U
      && gcx < HALF * 0.9 && gcz > -HALF + 400 && gcz < HALF - 400; }

  // R2. Misty Bay by coordinate: it must land inside the square, clear of the west edge, and on
  // water (it is a bay) — measured, not assumed, because the last corridor simply missed it.
  const mp = toMap(MISTY);
  const mistyClearU = (mp.x - (-HALF)) / MPU;
  const mistyIn = mp.x > -HALF && mp.x < HALF * 0.55 && Math.abs(mp.z) < HALF - 900 * MPU
    && mistyClearU >= MISTY_CLEAR_U;

  return { widthU: (mxx - mnx) / MPU, overhangU: (-HALF - mnx) / MPU, areaPct: 100 * wet / (N * N),
    overOkPct: edgeRows ? 100 * overOk / edgeRows : 0,
    wetZPct: 100 * wetRows / N, edgeZPct: 100 * edgeRows / N, meanReachU: wetRows ? (sumReach / wetRows) / MPU : 0,
    maxReachU: maxReach === -Infinity ? 0 : maxReach / MPU, islands: isles.length, holes,
    dryRunU, wrapBoth: cornerN && cornerS,
    grootW: gw, grootH: gh, grootIn: gIn, grootClearU: gClearU,
    mistyIn, mistyClearU, mistyU: { x: mp.x / MPU, z: mp.z / MPU } };
}
function score(m) {
  if (!m) return -1e9;
  // HARD gates, not soft weights: the owner named both places, and four passes have now shipped a
  // good-looking score with one of them missing. A candidate that loses them is not a candidate.
  if (!m.grootIn || !m.mistyIn) return -1e9;
  // Optional hard ceiling on how deep the deepest drowned valley may bite (units). The old ocean
  // reached ~1,110 u; a dendritic dam legitimately reaches further, but past the corridor's west
  // edge it stops being a valley and starts flooding the farm frontage. MAX_REACH_U=... to gate.
  if (MAX_REACH_U && m.maxReachU > MAX_REACH_U) return -1e9;
  // CALIBRATED ON THE OLD OCEAN, which nobody ever complained about: it wet 7.9% of the world
  // square and reached about 1,100 units in. So water AREA is a target, not something to minimise —
  // the rejected build was at 4.2%, i.e. too DRY, which is the same fact as R3's 62%-dry west edge.
  // One deep drowned valley is wanted (that is what the Vaal is); a uniformly deep band is not, so
  // the mean reach is graded hard and the max reach loosely.
  return Math.min(84, m.edgeZPct) * 0.34                  // R3: waterfront, but not a 100% wet wall
    + (m.wrapBoth ? 5 : 0)                                // land wrapping over BOTH corners
    - Math.max(0, m.dryRunU - 900) / 100 * 2.0            // ...in short wraps, not 1.6 km dead runs
    - Math.abs(m.areaPct - 8.2) * 2.4                     // the old ocean's own wetted area
    - Math.max(0, m.meanReachU - 1250) / 100 * 3.0        // the band stays a band
    - Math.max(0, m.maxReachU - 2600) / 100 * 1.6         // ...but one valley may run deep
    - Math.max(0, m.widthU - 3300) / 100 * 1.6
    + Math.min(3.0, (m.grootClearU - GROOT_CLEAR_U) / 300) * 2.0   // room to sail round the island
    + Math.min(3.0, (m.mistyClearU - MISTY_CLEAR_U) / 300) * 2.0   // room for the resort town
    - Math.max(0, Math.abs(m.grootH - 950) - 400) / 100 * 1.2
    + Math.min(6, m.islands) * 0.5
    + Math.min(60, m.holes) * 0.04                        // peninsulas & islets crossing the scanline
    - Math.max(0, 90 - m.overOkPct) * 0.03;
}

// Probe one placement instead of searching:  PROBE=k,deg,cx,cz node tools/mapgen/search-placement.mjs
if (process.env.PROBE) {
  const [k, deg, cx, cz] = process.env.PROBE.split(',').map(Number);
  const m = evaluate(fine, k, deg, cx, cz, 320);
  console.log(JSON.stringify({ k, deg, cx, cz, anchor: unproject(cx, cz), score: score(m), ...m }, null, 1));
  process.exit(0);
}

// Refine one placement in its own neighbourhood, in MAP axes (so "300 units further east" means
// what it says):  LOCAL=k,deg,cx,cz node tools/mapgen/search-placement.mjs
if (process.env.LOCAL) {
  const [k0, deg0, cx0, cz0] = process.env.LOCAL.split(',').map(Number);
  const rows = [];
  for (const dk of [-0.03, -0.015, 0, 0.015, 0.03]) {
    for (const dd of [-6, -3, 0, 3, 6]) {
      for (const mx of [-300, -150, 0, 150, 300]) {
        for (const mz of [-900, -600, -300, 0, 300, 600, 900]) {
          const k = +(k0 + dk).toFixed(4), deg = (deg0 + dd + 360) % 360;
          const th = (deg * Math.PI) / 180;
          // map (+x east, +z south) -> real, undone: a map offset of (mx,mz) units means the anchor
          // moves by -(offset/k) along the rotated basis.
          const vx = (mx * MPU) / k, uz = (mz * MPU) / k;
          const cx = cx0 - (vx * Math.cos(th) - uz * Math.sin(th));
          const cz = cz0 - (vx * Math.sin(th) + uz * Math.cos(th));
          const m = evaluate(fine, k, deg, cx, cz, 240);
          if (!m) continue;
          rows.push({ k, deg, cx, cz, mx, mz, s: score(m), ...m });
        }
      }
    }
  }
  rows.sort((a, b) => b.s - a.s);
  rows.slice(0, 14).forEach((r, i) => console.log(
    `#${i} s=${r.s.toFixed(2)} k=${r.k} rot=${r.deg} d=(${r.mx},${r.mz})u | width ${r.widthU.toFixed(0)}u area ${r.areaPct.toFixed(1)}% ` +
    `edgeZ ${r.edgeZPct.toFixed(0)}% dryRun ${r.dryRunU.toFixed(0)}u wrap ${r.wrapBoth ? 'N+S' : 'one'} meanR ${r.meanReachU.toFixed(0)}u ` +
    `maxR ${r.maxReachU.toFixed(0)}u isl ${r.islands} Groot ${r.grootW.toFixed(0)}x${r.grootH.toFixed(0)} clear ${r.grootClearU.toFixed(0)}u ` +
    `Misty clear ${r.mistyClearU.toFixed(0)}u | DAM_ANCHOR { lat: ${unproject(r.cx, r.cz).lat.toFixed(6)}, lon: ${unproject(r.cx, r.cz).lon.toFixed(6)} }`));
  process.exit(0);
}

const out = [];
const KS = [0.22, 0.26, 0.30, 0.34, 0.40, 0.46, 0.52];
for (const k of KS) for (let deg = 0; deg < 360; deg += 6) {
  for (let gx = -13000; gx <= 14000; gx += 700) for (let gz = -12000; gz <= 11000; gz += 700) {
    const m = evaluate(coarse, k, deg, gx, gz, 110);
    if (!m || m.wetZPct < 25) continue;
    // The coarse ring is simplified at 55 m, so the hard gates are applied LOOSELY here and
    // strictly in the refine pass — otherwise a near-miss on the island clearance kills a
    // neighbourhood the jiggle would have walked into.
    if (m.grootW <= 0 || m.grootClearU < GROOT_CLEAR_U - 450 || m.mistyClearU < MISTY_CLEAR_U - 450) continue;
    if (MAX_REACH_U && m.maxReachU > MAX_REACH_U + 250) continue;
    if (m.mistyU.x * MPU > HALF * 0.62 || Math.abs(m.mistyU.z * MPU) > HALF - 800 * MPU) continue;
    const s = Math.min(84, m.edgeZPct) * 0.34 - Math.abs(m.areaPct - 8.2) * 2.4
      - Math.max(0, m.meanReachU - 1250) / 100 * 3.0 - Math.max(0, m.widthU - 3300) / 100 * 1.6
      + Math.min(6, m.islands) * 0.5;
    out.push({ k, deg, cx: gx, cz: gz, s });
  }
}
out.sort((a, b) => b.s - a.s);
console.error(`coarse pass: ${out.length} scoring placements`);
// refine the leaders at full resolution with a local jiggle
const refined = [];
const seen = new Set();
for (const c of out.slice(0, 420)) {
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
  `dryRun ${r.dryRunU.toFixed(0)}u wrap ${r.wrapBoth ? 'N+S' : 'one'} ` +
  `meanR ${r.meanReachU.toFixed(0)}u maxR ${r.maxReachU.toFixed(0)}u overOk ${r.overOkPct.toFixed(0)}% isl ${r.islands} holes ${r.holes} ` +
  `Groot ${r.grootW.toFixed(0)}x${r.grootH.toFixed(0)}u clear ${r.grootClearU.toFixed(0)}u | ` +
  `Misty clear ${r.mistyClearU.toFixed(0)}u | DAM_ANCHOR { lat: ${unproject(r.cx, r.cz).lat.toFixed(6)}, lon: ${unproject(r.cx, r.cz).lon.toFixed(6)} }`));
