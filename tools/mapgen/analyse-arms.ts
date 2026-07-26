/**
 * One-off analysis: walk the REAL Vaal outer ring in the game-oriented frame and list the
 * northward drowned valleys (which become the map's EASTWARD arms), so the strip can be cut
 * around two or three of them rather than around one broad open lobe.
 *
 *   npx tsx tools/mapgen/analyse-arms.ts
 */
import { fetchVaal } from './overpass';
import { toVaalFrame } from './vaal';
import { VAAL_WATER_RELATION } from './config';
import type { OsmRelation, Pt } from './types';

function chainRings(members: Array<Array<{ lat: number; lon: number }>>): Array<Array<{ lat: number; lon: number }>> {
  const key = (p: { lat: number; lon: number }): string => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const remaining = members.filter((m) => m.length >= 2).map((m) => [...m]);
  const rings: Array<Array<{ lat: number; lon: number }>> = [];
  while (remaining.length > 0) {
    let chain = remaining.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i]!;
        if (key(c[0]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(1));
        else if (key(c[c.length - 1]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]!) === key(chain[0]!)) chain = c.slice(0, -1).concat(chain);
        else if (key(c[0]!) === key(chain[0]!)) chain = c.slice(1).reverse().concat(chain);
        else continue;
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    rings.push(chain);
  }
  return rings.sort((a, b) => b.length - a.length);
}

const LANDMARKS: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Deneysville', lat: -26.89, lon: 28.0964 },
  { name: 'Refengkgotso', lat: -26.8953, lon: 28.0725 },
  { name: 'DamWall(1938)', lat: -26.8722, lon: 28.1119 },
  { name: 'AnchorCreekMarina', lat: -26.8926, lon: 28.1096 },
  { name: 'DeneysCroc', lat: -26.8813, lon: 28.0934 },
  { name: 'Grooteiland', lat: -26.8671, lon: 28.1726 },
  { name: 'MISTY BAY', lat: -26.888104, lon: 28.192121 },
  { name: 'BayshoreMarinaFuel', lat: -26.8823, lon: 28.1951 },
  { name: 'MarinaLatata', lat: -26.8753, lon: 28.2003 },
  { name: 'VaalMarina', lat: -26.8744, lon: 28.2311 },
  { name: 'Groenpunt', lat: -26.8261, lon: 28.04 },
  { name: 'Middelbult', lat: -26.8372, lon: 28.0494 },
  { name: 'WastewaterPlant', lat: -26.8188, lon: 28.0517 },
  { name: 'SHORE_START(cur)', lat: -26.923059, lon: 28.100699 },
  { name: 'SHORE_MID(cur)', lat: -26.836396, lon: 28.198531 },
  { name: 'SHORE_END(cur)', lat: -26.882543, lon: 28.258109 },
];

async function main(): Promise<void> {
  const { data } = await fetchVaal({ refresh: false });
  const relation = data.elements.find((e): e is OsmRelation => e.type === 'relation' && e.id === VAAL_WATER_RELATION)!;
  const outer = relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry!);
  const rings = chainRings(outer);
  const ringLL = rings[0]!;
  const ring: Pt[] = ringLL.map((g) => toVaalFrame(g.lat, g.lon));
  console.log(`outer ring ${ring.length} pts`);

  const nearestIndex = (q: Pt): number => {
    let best = 0; let bestD = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const d = (ring[i]!.x - q.x) ** 2 + (ring[i]!.z - q.z) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  // Index of each landmark's nearest shore vertex, so a chosen cut can be described in real names.
  const marks = LANDMARKS.map((l) => {
    const p = toVaalFrame(l.lat, l.lon);
    const i = nearestIndex(p);
    return { ...l, p, i, d: Math.hypot(ring[i]!.x - p.x, ring[i]!.z - p.z) };
  });

  // Walk the ring from the current START forwards through MID; that is the run direction that
  // travels the north shore west -> east (game north -> south).
  const startI = marks.find((m) => m.name === 'SHORE_START(cur)')!.i;
  const n = ring.length;
  const order: number[] = [];
  for (let k = 0; k < n; k++) order.push((startI + k) % n);
  // Direction check: MID must come before END going forward.
  const midI = marks.find((m) => m.name === 'SHORE_MID(cur)')!.i;
  const endI = marks.find((m) => m.name === 'SHORE_END(cur)')!.i;
  const fwd = (i: number): number => (i - startI + n) % n;
  const forwardIsRight = fwd(midI) < fwd(endI);
  console.log(`start ${startI} mid ${midI} (${fwd(midI)} fwd) end ${endI} (${fwd(endI)} fwd) -> forward=${forwardIsRight}`);

  const walk: Pt[] = forwardIsRight ? order.map((i) => ring[i]!) : order.map((i) => ring[(startI - fwd(i) + n) % n]!);
  // Cumulative arc + running stats along the walk, from START, over the full ring.
  const cum: number[] = [0];
  for (let i = 1; i < walk.length; i++) cum.push(cum[i - 1]! + Math.hypot(walk[i]!.x - walk[i - 1]!.x, walk[i]!.z - walk[i - 1]!.z));

  console.log('\n== LANDMARKS along the forward walk from SHORE_START ==');
  const walkIndexOf = (ringIdx: number): number => (forwardIsRight ? fwd(ringIdx) : (startI - ringIdx + n) % n);
  for (const m of marks.sort((a, b) => walkIndexOf(a.i) - walkIndexOf(b.i))) {
    const w = walkIndexOf(m.i);
    console.log(
      `  ${(cum[w]! / 1000).toFixed(2).padStart(7)} km  idx ${String(w).padStart(6)}  ` +
      `frame x(N)=${walk[w]!.x.toFixed(0).padStart(7)} z(E)=${walk[w]!.z.toFixed(0).padStart(7)}  ` +
      `${m.name} (${m.d.toFixed(0)} m off shore)`,
    );
  }

  // ---- ARM DETECTION -------------------------------------------------------------
  // An arm of water reaching NORTH (game east) shows as a stretch where the shore x rises to a
  // local maximum and comes back. Score each candidate head by (depth north of the local base)
  // and report the mouth width in z (game north-south) and the neighbouring land.
  const WIN = 4000; // metres of arc either side used to define the arm's "base"
  const heads: Array<{ w: number; x: number; z: number; depth: number; mouthZ: number; arc: number }> = [];
  for (let i = 1; i < walk.length - 1; i++) {
    if (!(walk[i]!.x > walk[i - 1]!.x && walk[i]!.x >= walk[i + 1]!.x)) continue;
    // Walk out both ways until the arc window is spent; the base is the lowest x reached.
    let lo = i; let hi = i;
    while (lo > 0 && cum[i]! - cum[lo]! < WIN) lo--;
    while (hi < walk.length - 1 && cum[hi]! - cum[i]! < WIN) hi++;
    let baseL = Infinity; let baseR = Infinity;
    let zL = walk[i]!.z; let zR = walk[i]!.z;
    for (let k = lo; k <= i; k++) if (walk[k]!.x < baseL) { baseL = walk[k]!.x; zL = walk[k]!.z; }
    for (let k = i; k <= hi; k++) if (walk[k]!.x < baseR) { baseR = walk[k]!.x; zR = walk[k]!.z; }
    const depth = walk[i]!.x - Math.max(baseL, baseR);
    if (depth < 900) continue;
    heads.push({ w: i, x: walk[i]!.x, z: walk[i]!.z, depth, mouthZ: Math.abs(zR - zL), arc: cum[i]! });
  }
  // Keep only the deepest head inside each 3 km of arc.
  heads.sort((a, b) => b.depth - a.depth);
  const kept: typeof heads = [];
  for (const h of heads) if (!kept.some((k) => Math.abs(k.arc - h.arc) < 3000)) kept.push(h);
  kept.sort((a, b) => a.arc - b.arc);
  console.log(`\n== NORTHWARD ARMS (>= 900 m deep, +/-${WIN} m arc window) — these become EAST arms ==`);
  for (const h of kept) {
    const nearest = marks.reduce((best, m) => (Math.hypot(m.p.x - h.x, m.p.z - h.z) < Math.hypot(best.p.x - h.x, best.p.z - h.z) ? m : best), marks[0]!);
    console.log(
      `  arc ${(h.arc / 1000).toFixed(2).padStart(7)} km  head x(N)=${h.x.toFixed(0).padStart(7)} z(E)=${h.z.toFixed(0).padStart(7)}  ` +
      `depth ${h.depth.toFixed(0).padStart(5)} m  mouth ${h.mouthZ.toFixed(0).padStart(5)} m  near ${nearest.name} (${Math.hypot(nearest.p.x - h.x, nearest.p.z - h.z).toFixed(0)} m)`,
    );
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
