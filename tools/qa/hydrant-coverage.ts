/**
 * Fire-hydrant COVERAGE audit — design pass for defect B ("I can't find any hydrants").
 *
 * Extends tools/qa/hydrant-sites.ts (same headless City, same DOM stub, same replay-the-real-guards
 * discipline) with the one thing that tool cannot answer: what an ARC-LENGTH placement pass would do,
 * as opposed to a modulus over a global index into city.roadsidePoints.
 *
 *   npx tsx tools/qa/hydrant-coverage.ts
 */
import type { RoadsidePoint } from '../../src/world/City';
import type { PropCollider, PropKind } from '../../src/systems/PropSystem';

function installDomStub(): void {
  const noop = (): void => {};
  const gradient = { addColorStop: noop };
  const context = (): unknown => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    fillRect: noop, strokeRect: noop, clearRect: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
    arc: noop, ellipse: noop, quadraticCurveTo: noop, bezierCurveTo: noop, fill: noop, stroke: noop, save: noop,
    restore: noop, translate: noop, rotate: noop, scale: noop, clip: noop, setTransform: noop, drawImage: noop,
    fillText: noop, strokeText: noop, putImageData: noop,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => gradient, createRadialGradient: () => gradient, createPattern: () => null,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  });
  const element = (tag: string): unknown => ({
    nodeName: tag.toUpperCase(), style: {}, width: 1, height: 1,
    addEventListener: noop, removeEventListener: noop, setAttribute: noop, appendChild: noop, removeChild: noop,
    getContext: () => context(),
  });
  const stub = { createElement: element, createElementNS: (_ns: string, tag: string) => element(tag) };
  (globalThis as { document?: unknown }).document = stub;
}
installDomStub();

const THREE = await import('three');
const {
  City, ROAD_NETWORK, ROAD_SAMPLE_SPACING, ROADSIDE_OFFSET, STREETLAMP_SPACING, STREETLAMP_MIN_WIDTH,
  districtAt, sampleRoadPath,
} = await import('../../src/world/City');
const {
  HYDRANT_FLANGE_RADIUS, HYDRANT_KERB_DISTANCE, BENCH_VERGE_DISTANCE, BIN_VERGE_DISTANCE,
} = await import('../../src/world/UrbanInfrastructure');
const { METRES_PER_UNIT, distanceToRailwayCorridor } = await import('../../src/world/mapData');
const { TRANSIT_STOPS } = await import('../../src/world/placements');

const HYDRANT_SPACING = 1.2;          // the shipped same-pass guard
const PARTS_PER_PROP = 6;
const BLOCK_PROBE = HYDRANT_FLANGE_RADIUS + 0.1;
const ROAD_PROBE = HYDRANT_FLANGE_RADIUS + 0.06;

const scene = new THREE.Scene();
const started = Date.now();
const city = new City(scene, 'low', false);
const shipped = city.props.props.filter((prop) => prop.kind === 'hydrant');
console.log(`built the city headlessly in ${((Date.now() - started) / 1000).toFixed(1)}s`
  + ` — ${city.roadsidePoints.length} roadside points, ${city.streetlampPoints.length} lamp anchors,`
  + ` ${city.props.props.length} props, ${shipped.length} hydrants`);
console.log(`scale: 1 u = ${METRES_PER_UNIT} m; lamp pitch ${STREETLAMP_SPACING} u = ${(STREETLAMP_SPACING * METRES_PER_UNIT).toFixed(0)} m;`
  + ` road sample spacing ${ROAD_SAMPLE_SPACING} u`);

const median = (v: number[]): number => quantile(v, 0.5);
const quantile = (values: number[], p: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
};

// ---------------------------------------------------------------------------------------------
// 1. THE 0.605 QUESTION — exact closest pair among the shipped hydrants, and what the guard promises.
// ---------------------------------------------------------------------------------------------
const closestPair = (spots: Array<{ x: number; z: number }>): { d: number; a: number; b: number } => {
  const cell = 20; const grid = new Map<string, number[]>();
  spots.forEach((s, i) => {
    const key = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`;
    const b = grid.get(key); if (b) b.push(i); else grid.set(key, [i]);
  });
  let best = Infinity; let ba = -1; let bb = -1;
  spots.forEach((s, i) => {
    const cx = Math.floor(s.x / cell); const cz = Math.floor(s.z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (j <= i) continue;
        const d = Math.hypot(spots[j]!.x - s.x, spots[j]!.z - s.z);
        if (d < best) { best = d; ba = i; bb = j; }
      }
    }
  });
  return { d: best, a: ba, b: bb };
};
const shippedPair = closestPair(shipped);
console.log('\n=== 1. THE "0.605 u TWIN HYDRANT" ===');
console.log(`  closest hydrant pair, centre to centre: ${shippedPair.d.toFixed(4)} u`
  + ` (guard: spacedFrom(${HYDRANT_SPACING}) — so centres can legally be ${HYDRANT_SPACING} apart)`);
console.log(`  the same pair, collider edge to collider edge (registry radius 0.3 each): ${(shippedPair.d - 0.6).toFixed(4)} u`);
console.log(`  the same pair, FLANGE edge to flange edge (${HYDRANT_FLANGE_RADIUS.toFixed(3)} each): ${(shippedPair.d - 2 * HYDRANT_FLANGE_RADIUS).toFixed(4)} u`);
if (shippedPair.a >= 0) {
  const a = shipped[shippedPair.a]!; const b = shipped[shippedPair.b]!;
  console.log(`  at (${a.x.toFixed(1)}, ${a.z.toFixed(1)}) and (${b.x.toFixed(1)}, ${b.z.toFixed(1)}) — ${districtAt(a.x, a.z)}`);
}
const nearestNeighbour = shipped.map((a, i) => {
  let best = Infinity;
  shipped.forEach((b, j) => { if (i !== j) best = Math.min(best, Math.hypot(a.x - b.x, a.z - b.z)); });
  return best;
});
for (const limit of [1.5, 2, 3, 5, 8, 12, 20]) {
  console.log(`  pairs closer than ${String(limit).padStart(4)} u apart: `
    + `${nearestNeighbour.filter((d) => d < limit).length} hydrants have a neighbour within ${limit} u`);
}

// ---------------------------------------------------------------------------------------------
// 2. THE ARC-LENGTH PASS — buildStreetlampPoints' mechanism, parameterised.
// ---------------------------------------------------------------------------------------------
interface Anchor extends RoadsidePoint { road: string; arc: number; roadIndex: number; hx: number; hz: number; slid: number }

const atKerb = (p: RoadsidePoint, kerb: number): { hx: number; hz: number } => ({
  hx: p.x + p.inwardX * (ROADSIDE_OFFSET - kerb),
  hz: p.z + p.inwardZ * (ROADSIDE_OFFSET - kerb),
});
const isBlocked = (x: number, z: number, radius: number): boolean =>
  city.collides(x, z, radius) || city.isReserved(x, z, radius) || distanceToRailwayCorridor(x, z) < radius + 0.6;

/** One station on a road: the verge point + inward normal at arc distance `arc` on `side`. */
const stationAt = (
  source: Array<{ x: number; z: number }>, cum: number[], width: number, arc: number, side: -1 | 1,
): RoadsidePoint | undefined => {
  if (arc < 0 || arc > cum[cum.length - 1]!) return undefined;
  let segment = 0;
  while (segment < cum.length - 2 && cum[segment + 1]! < arc) segment++;
  const start = source[segment]!; const end = source[segment + 1]!;
  const dx = end.x - start.x; const dz = end.z - start.z; const length = Math.hypot(dx, dz);
  if (length < 1e-4) return undefined;
  const t = (arc - cum[segment]!) / length;
  const normalX = -dz / length; const normalZ = dx / length;
  const offset = width / 2 + ROADSIDE_OFFSET;
  return {
    x: start.x + dx * t + normalX * offset * side,
    z: start.z + dz * t + normalZ * offset * side,
    inwardX: -normalX * side, inwardZ: -normalZ * side, width,
  };
};

interface PassOptions {
  pitch: number;
  /** extra arc offset of the first station, on top of pitch/2 — keeps hydrants off the lamp stations */
  phase: number;
  minWidth: number;
  kerb: number;
  /** max arc slide either way when the anchor's own spot is unusable; 0 = drop it like the lamps do */
  slide: number;
  slideStep: number;
  /** legibility separation: no two hydrants closer than this (0 = the shipped 1.2 dedupe only) */
  separation: number;
  /** guarantee at least one station per road, even one shorter than pitch/2 */
  everyRoad: boolean;
  /** measure the ceiling: what coverage looks like if the pavement-drawn gate were not needed */
  ignorePaving?: boolean;
  /** isBlocked() probe radius. Shipped = flange + 0.1 (a collision guard). Bigger = a legibility guard. */
  probe?: number;
  /** stations at phase + n*pitch (fixed phase) instead of pitch/2 + phase — makes a pitch retune nested */
  fixedPhase?: boolean;
}

interface PassResult { placed: Anchor[]; stations: number; rescued: number; dropped: number; why: Record<string, number>; emptyRoads: Array<{ name: string; length: number }> }

const runArcPass = (options: PassOptions): PassResult => {
  const placed: Anchor[] = [];
  const cell = Math.max(4, options.separation);
  const grid = new Map<string, Anchor[]>();
  const nearby = (x: number, z: number, reach: number): Anchor[] => {
    const out: Anchor[] = []; const span = Math.ceil(reach / cell);
    const cx = Math.floor(x / cell); const cz = Math.floor(z / cell);
    for (let dx = -span; dx <= span; dx++) for (let dz = -span; dz <= span; dz++) out.push(...(grid.get(`${cx + dx},${cz + dz}`) ?? []));
    return out;
  };
  let stations = 0; let rescued = 0; let dropped = 0;
  const why: Record<string, number> = { offEnd: 0, unpaved: 0, blocked: 0, onRoad: 0, tooClose: 0 };
  const emptyRoads: Array<{ name: string; length: number }> = [];
  ROAD_NETWORK.forEach((definition, roadIndex) => {
    if (definition.width < options.minWidth) return;
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    const source = closed ? [...sampled, sampled[0]!] : sampled;
    const cum = [0];
    for (let i = 0; i < source.length - 1; i++) cum.push(cum[i]! + Math.hypot(source[i + 1]!.x - source[i]!.x, source[i + 1]!.z - source[i]!.z));
    const total = cum[cum.length - 1]!;
    if (total < 1e-3) return;
    let side: -1 | 1 = 1;
    let onThisRoad = 0;
    const nominal = options.fixedPhase ? options.phase : options.pitch / 2 + options.phase;
    const first = options.everyRoad ? Math.min(nominal, total / 2) : nominal;
    for (let arc = first; arc <= total; arc += options.pitch) {
      stations++;
      const trials: number[] = [0];
      for (let step = options.slideStep; step <= options.slide; step += options.slideStep) trials.push(step, -step);
      let done = false; let cause = 'offEnd';
      for (const delta of trials) {
        const point = stationAt(source, cum, definition.width, arc + delta, side);
        if (!point) continue;
        if (!options.ignorePaving && !city.isPavementDrawn(point)) { cause = 'unpaved'; continue; }
        const { hx, hz } = atKerb(point, options.kerb);
        if (isBlocked(hx, hz, options.probe ?? BLOCK_PROBE)) { cause = 'blocked'; continue; }
        if (city.isOnRoad(hx, hz, ROAD_PROBE)) { cause = 'onRoad'; continue; }
        const reach = Math.max(HYDRANT_SPACING, options.separation);
        if (nearby(hx, hz, reach).some((other) => Math.hypot(other.hx - hx, other.hz - hz) < reach)) { cause = 'tooClose'; continue; }
        const anchor: Anchor = { ...point, road: definition.name, arc: arc + delta, roadIndex, hx, hz, slid: delta };
        placed.push(anchor);
        const key = `${Math.floor(hx / cell)},${Math.floor(hz / cell)}`;
        const bucket = grid.get(key); if (bucket) bucket.push(anchor); else grid.set(key, [anchor]);
        if (delta !== 0) rescued++;
        onThisRoad++;
        done = true; break;
      }
      if (!done) { dropped++; why[cause] = (why[cause] ?? 0) + 1; }
      side = side === 1 ? -1 : 1;
    }
    if (onThisRoad === 0) emptyRoads.push({ name: definition.name, length: total });
  });
  return { placed, stations, rescued, dropped, why, emptyRoads };
};

// ---------------------------------------------------------------------------------------------
// 3. COVERAGE METRICS
// ---------------------------------------------------------------------------------------------
const pavement = city.roadsidePoints; // the network the player walks: every verge anchor
const districtOf = pavement.map((p) => districtAt(p.x, p.z));

const nearestField = (spots: Array<{ x: number; z: number }>): number[] => {
  const cell = 64; const grid = new Map<string, Array<{ x: number; z: number }>>();
  for (const s of spots) {
    const key = `${Math.floor(s.x / cell)},${Math.floor(s.z / cell)}`;
    const b = grid.get(key); if (b) b.push(s); else grid.set(key, [s]);
  }
  return pavement.map((p) => {
    const cx = Math.floor(p.x / cell); const cz = Math.floor(p.z / cell);
    for (let reach = 1; reach <= 80; reach++) {
      let best = Infinity;
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        for (const s of grid.get(`${cx + dx},${cz + dz}`) ?? []) best = Math.min(best, Math.hypot(s.x - p.x, s.z - p.z));
      }
      if (best <= (reach - 1) * cell || (best < Infinity && reach >= 80)) return best;
    }
    return Infinity;
  });
};

/** Along-road coverage: the gap between consecutive hydrants on the same road, in arc length. */
const arcGaps = (placed: Anchor[]): number[] => {
  const byRoad = new Map<number, number[]>();
  for (const a of placed) {
    const b = byRoad.get(a.roadIndex); if (b) b.push(a.arc); else byRoad.set(a.roadIndex, [a.arc]);
  }
  const gaps: number[] = [];
  for (const arcs of byRoad.values()) {
    arcs.sort((x, y) => x - y);
    for (let i = 1; i < arcs.length; i++) gaps.push(arcs[i]! - arcs[i - 1]!);
  }
  return gaps;
};

const roadLength = (() => {
  let total = 0;
  for (const definition of ROAD_NETWORK) {
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    const source = closed ? [...sampled, sampled[0]!] : sampled;
    for (let i = 0; i < source.length - 1; i++) total += Math.hypot(source[i + 1]!.x - source[i]!.x, source[i + 1]!.z - source[i]!.z);
  }
  return total;
})();
console.log(`\nroad network: ${(roadLength / 1000).toFixed(1)} k units of centreline = ${(roadLength * METRES_PER_UNIT / 1000).toFixed(0)} km real`);

/** Walk-up distribution for any set of spots, on the same sample and the same metric as the sweep. */
const reportField = (label: string, spots: Array<{ x: number; z: number }>): void => {
  const walk = nearestField(spots);
  console.log(`  ${label.padEnd(46)} ${String(spots.length).padStart(5)} hydrants`
    + `  median ${median(walk).toFixed(0).padStart(3)}  p90 ${quantile(walk, 0.9).toFixed(0).padStart(3)}`
    + `  p99 ${quantile(walk, 0.99).toFixed(0).padStart(3)}  max ${Math.max(...walk).toFixed(0).padStart(3)} u`
    + `  >100u ${(100 * walk.filter((d) => d > 100).length / walk.length).toFixed(2).padStart(5)}%`
    + `  >150u ${(100 * walk.filter((d) => d > 150).length / walk.length).toFixed(2).padStart(5)}%`);
};

const spotsOf = (placed: Anchor[]): Array<{ x: number; z: number }> => placed.map((a) => ({ x: a.hx, z: a.hz }));

const summarise = (label: string, result: PassResult): void => {
  const { placed, stations, rescued, dropped } = result;
  const spots = spotsOf(placed);
  const walk = nearestField(spots);
  const gaps = arcGaps(placed);
  const beyond100 = walk.filter((d) => d > 100).length;
  const beyond150 = walk.filter((d) => d > 150).length;
  const pair = closestPair(spots);
  console.log(`\n  ${label}`);
  console.log(`    stations ${stations}  placed ${placed.length}  (slid ${rescued}, dropped ${dropped})`
    + `  instances ${placed.length * PARTS_PER_PROP}  one per ${(roadLength / placed.length).toFixed(0)} u`
    + ` = ${(roadLength / placed.length * METRES_PER_UNIT).toFixed(0)} m of street`);
  console.log(`    walk-up (straight line, all ${pavement.length} pavement points): median ${median(walk).toFixed(0)}`
    + `  p90 ${quantile(walk, 0.9).toFixed(0)}  p99 ${quantile(walk, 0.99).toFixed(0)}  max ${Math.max(...walk).toFixed(0)} u`);
  console.log(`    tail: >100 u ${beyond100} pts (${(100 * beyond100 / walk.length).toFixed(2)}%)`
    + `   >150 u ${beyond150} pts (${(100 * beyond150 / walk.length).toFixed(2)}%)`
    + `   within 50 u ${(100 * walk.filter((d) => d <= 50).length / walk.length).toFixed(1)}%`);
  console.log(`    same-road arc gap: median ${median(gaps).toFixed(0)}  p99 ${quantile(gaps, 0.99).toFixed(0)}  max ${Math.max(...gaps).toFixed(0)} u`);
  console.log(`    closest hydrant pair ${pair.d.toFixed(3)} u`);
  console.log(`    stations lost to: ${Object.entries(result.why).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const empties = result.emptyRoads;
  console.log(`    roads with no hydrant at all: ${empties.length} of ${ROAD_NETWORK.length}`
    + ` (longest ${empties.length ? Math.max(...empties.map((r) => r.length)).toFixed(0) : 0} u,`
    + ` total ${(empties.reduce((s, r) => s + r.length, 0) / 1000).toFixed(1)} k u = ${(100 * empties.reduce((s, r) => s + r.length, 0) / roadLength).toFixed(1)}% of the network)`);
  // per-district tail
  const byDistrict = new Map<string, number[]>();
  walk.forEach((d, i) => {
    const key = districtOf[i]!;
    const b = byDistrict.get(key); if (b) b.push(d); else byDistrict.set(key, [d]);
  });
  const worst = [...byDistrict.entries()]
    .filter(([, v]) => v.length >= 20)
    .map(([name, v]) => ({ name, median: median(v), p90: quantile(v, 0.9), max: Math.max(...v), n: v.length }))
    .sort((a, b) => b.median - a.median);
  console.log(`    districts with a median walk-up over 60 u: ${worst.filter((d) => d.median > 60).length} of ${worst.length}`
    + `   over 100 u: ${worst.filter((d) => d.median > 100).length}`);
  console.log(`    worst five districts by median: ${worst.slice(0, 5).map((d) => `${d.name} ${d.median.toFixed(0)}/${d.max.toFixed(0)}`).join(', ')}`);
};

console.log('\n=== 1b. THE TWO SHIPPED BASELINES, on this script\'s own walk-up metric ===');
reportField('shipped: stride 11, kerbside (what was rejected)', shipped.map((h) => ({ x: h.x, z: h.z })));

console.log('\n=== 2. ARC-LENGTH PITCH SWEEP (alternating kerbs, phase = half a lamp span, slide rescue on) ===');
console.log('  pitch is arc length between consecutive stations on one road; sides alternate, so the same-kerb pitch is 2x.');
const base: Omit<PassOptions, 'pitch'> = {
  phase: STREETLAMP_SPACING / 2, minWidth: STREETLAMP_MIN_WIDTH, kerb: HYDRANT_KERB_DISTANCE,
  slide: 8, slideStep: 2, separation: 0, everyRoad: true,
};
const sweep = [STREETLAMP_SPACING * 2, STREETLAMP_SPACING * 3, STREETLAMP_SPACING * 4, STREETLAMP_SPACING * 5, STREETLAMP_SPACING * 6, STREETLAMP_SPACING * 8];
for (const pitch of sweep) {
  const result = runArcPass({ ...base, pitch });
  summarise(`pitch ${pitch} u (${(pitch * METRES_PER_UNIT).toFixed(0)} m real, ${(pitch / STREETLAMP_SPACING).toFixed(0)} lamp spans)`, result);
}

console.log('\n=== 3. WHAT EACH PIECE OF THE MECHANISM BUYS (at the 3-lamp-span pitch, 78 u) ===');
const pitch3 = STREETLAMP_SPACING * 3;
for (const variant of [
  { label: 'no slide rescue (drop like the lamps do)', options: { ...base, pitch: pitch3, slide: 0 } },
  { label: 'slide +/- 8 u', options: { ...base, pitch: pitch3 } },
  { label: 'slide +/- 16 u', options: { ...base, pitch: pitch3, slide: 16 } },
  { label: 'slide +/- pitch/2 (38 u, the widest that keeps stations ordered)', options: { ...base, pitch: pitch3, slide: 38 } },
  { label: 'no everyRoad guarantee', options: { ...base, pitch: pitch3, everyRoad: false } },
  { label: 'separation 12 u (legibility guard)', options: { ...base, pitch: pitch3, separation: 12 } },
  { label: 'separation 26 u (one lamp span)', options: { ...base, pitch: pitch3, separation: 26 } },
  { label: 'CEILING: no isPavementDrawn gate at all', options: { ...base, pitch: pitch3, ignorePaving: true } },
  { label: 'recommended: slide 38, separation 12', options: { ...base, pitch: pitch3, slide: 38, separation: 12 } },
]) {
  const r = runArcPass(variant.options as PassOptions);
  summarise(variant.label, r);
}

// ---------------------------------------------------------------------------------------------
// 4. COLLISION ARGUMENT — separation from every other family, for the recommended pass.
// ---------------------------------------------------------------------------------------------
const recommended = runArcPass({ ...base, pitch: pitch3, slide: 38, separation: 12 });
console.log('\n=== 4. COLLISION / SEPARATION, recommended pass ===');
const propCell = 8;
const cells = new Map<string, PropCollider[]>();
for (const prop of city.props.props) {
  if (prop.kind === 'hydrant') continue; // the shipped hydrants are not in this scheme
  const key = `${Math.floor(prop.x / propCell)},${Math.floor(prop.z / propCell)}`;
  const b = cells.get(key); if (b) b.push(prop); else cells.set(key, [prop]);
}
const nearestOf = (kind: PropKind, x: number, z: number): { d: number; prop?: PropCollider } => {
  let best = Infinity; let found: PropCollider | undefined;
  const cx = Math.floor(x / propCell); const cz = Math.floor(z / propCell);
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    for (const p of cells.get(`${cx + dx},${cz + dz}`) ?? []) {
      if (p.kind !== kind) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) { best = d; found = p; }
    }
  }
  return { d: best, prop: found };
};
const families: PropKind[] = ['streetlight', 'bench', 'bin', 'post', 'shrub', 'tree', 'sign', 'signal', 'shelter'];
console.log('  family        closest hydrant-to-prop centre distance | overlaps (centres closer than r_prop + 0.345 flange)');
for (const kind of families) {
  let closest = Infinity; let overlaps = 0; let worstAt = '';
  for (const a of recommended.placed) {
    const { d, prop } = nearestOf(kind, a.hx, a.hz);
    if (!prop) continue;
    if (d < closest) { closest = d; worstAt = `${a.road} (${a.hx.toFixed(0)}, ${a.hz.toFixed(0)})`; }
    if (d < prop.radius + HYDRANT_FLANGE_RADIUS) overlaps++;
  }
  console.log(`  ${kind.padEnd(12)} ${(closest === Infinity ? NaN : closest).toFixed(3).padStart(8)} u   overlaps ${overlaps}   at ${worstAt}`);
}
console.log(`  (lateral geometry: hydrant ${HYDRANT_KERB_DISTANCE} beyond the kerb; lamp ${ROADSIDE_OFFSET}, bin ${BIN_VERGE_DISTANCE},`
  + ` bench ${BENCH_VERGE_DISTANCE}, cabinet ${(ROADSIDE_OFFSET + 1.35).toFixed(2)}, shrub/tree ${(ROADSIDE_OFFSET + 2.1).toFixed(2)},`
  + ` street-life root ${(ROADSIDE_OFFSET + 3.15).toFixed(2)})`);

// passes that run AFTER buildFireHydrants and do NOT consult isBlocked
console.log('\n  passes that register props AFTER the hydrant pass:');
let shelterHits = 0; let shelterClosest = Infinity;
for (const stop of TRANSIT_STOPS) {
  for (const a of recommended.placed) {
    const d = Math.hypot(stop.x - a.hx, stop.z - a.hz);
    shelterClosest = Math.min(shelterClosest, d);
    if (d < 2.7 + HYDRANT_FLANGE_RADIUS) shelterHits++;
  }
}
console.log(`    buildTransitStops (${TRANSIT_STOPS.length} shelters, guard = isRoad(2.8) only, NO isBlocked):`
  + ` closest hydrant ${shelterClosest.toFixed(2)} u, inside a shelter footprint ${shelterHits}`);
let postClosest = Infinity;
for (const prop of city.props.props) {
  if (prop.kind !== 'post') continue;
  for (const a of recommended.placed) postClosest = Math.min(postClosest, Math.hypot(prop.x - a.hx, prop.z - a.hz));
}
console.log(`    buildEtollGantries pylons + cabinets ('post'): closest ${postClosest.toFixed(2)} u`);

// street-life interaction: can a kerbside hydrant ever block a street-life root?
const streetLifeRootStep = 3.15;
console.log(`    buildNeighbourhoodStreetLife root is ${(ROADSIDE_OFFSET + streetLifeRootStep).toFixed(2)} u beyond the kerb and probes 2.35;`
  + ` a hydrant at ${HYDRANT_KERB_DISTANCE} is ${(ROADSIDE_OFFSET + streetLifeRootStep - HYDRANT_KERB_DISTANCE).toFixed(2)} u away`
  + ` — needs < ${(2.35 + 0.3).toFixed(2)} to block, so hydrant COUNT cannot move street-life density.`);

console.log('\n=== 4b. PER-DISTRICT TAIL, recommended pass (districts with >=20 pavement points, worst 18 by p99) ===');
{
  const walk = nearestField(spotsOf(recommended.placed));
  const byDistrict = new Map<string, number[]>();
  walk.forEach((d, i) => { const k = districtOf[i]!; const b = byDistrict.get(k); if (b) b.push(d); else byDistrict.set(k, [d]); });
  const rows = [...byDistrict.entries()].filter(([, v]) => v.length >= 20).map(([name, v]) => ({
    name, n: v.length, median: median(v), p90: quantile(v, 0.9), p99: quantile(v, 0.99),
    max: Math.max(...v), over100: v.filter((d) => d > 100).length,
  })).sort((a, b) => b.p99 - a.p99);
  console.log('  district                  pts  median   p90   p99   max  >100u');
  for (const r of rows.slice(0, 18)) {
    console.log(`  ${r.name.padEnd(24)} ${String(r.n).padStart(5)} ${r.median.toFixed(0).padStart(7)}`
      + `${r.p90.toFixed(0).padStart(6)}${r.p99.toFixed(0).padStart(6)}${r.max.toFixed(0).padStart(6)}${String(r.over100).padStart(7)}`);
  }
  console.log(`  districts with a median over 60 u: ${rows.filter((r) => r.median > 60).length} of ${rows.length};`
    + ` with any point over 150 u: ${rows.filter((r) => r.max > 150).length}`);
}

console.log('\n=== 4c. THE OWN-SPOT PROBE: collision guard vs legibility guard ===');
console.log('  closest centre distance from a hydrant to each other family, as the probe radius grows.');
const familyProbe: PropKind[] = ['streetlight', 'bench', 'bin', 'post', 'shrub', 'sign', 'signal'];
const closestByFamily = (spots: Array<{ x: number; z: number }>): { row: string; overlaps: number } => {
  let overlaps = 0;
  const cells2 = new Map<string, PropCollider[]>();
  for (const prop of city.props.props) {
    if (prop.kind === 'hydrant') continue;
    const key = `${Math.floor(prop.x / 8)},${Math.floor(prop.z / 8)}`;
    const b = cells2.get(key); if (b) b.push(prop); else cells2.set(key, [prop]);
  }
  const best = new Map<PropKind, number>();
  for (const spot of spots) {
    const cx = Math.floor(spot.x / 8); const cz = Math.floor(spot.z / 8);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const prop of cells2.get(`${cx + dx},${cz + dz}`) ?? []) {
        const d = Math.hypot(prop.x - spot.x, prop.z - spot.z);
        if (d < (best.get(prop.kind) ?? Infinity)) best.set(prop.kind, d);
        if (d < prop.radius + HYDRANT_FLANGE_RADIUS) overlaps++;
      }
    }
  }
  return { row: familyProbe.map((k) => (best.get(k) ?? NaN).toFixed(2).padStart(8)).join(''), overlaps };
};
console.log(`  probe   placed${familyProbe.map((k) => k.padStart(8)).join('')}  overlaps`);
{
  const shippedRow = closestByFamily(shipped.map((h) => ({ x: h.x, z: h.z })));
  console.log(`  0.445*   ${String(shipped.length).padStart(5)}${shippedRow.row}   ${shippedRow.overlaps}   (* the shipped stride-11 set, for comparison)`);
  for (const probe of [BLOCK_PROBE, 0.75, 1.0, 1.4]) {
    const r = runArcPass({ ...base, pitch: pitch3, slide: 38, separation: 12, probe });
    const row = closestByFamily(spotsOf(r.placed));
    const walk = nearestField(spotsOf(r.placed));
    console.log(`  ${probe.toFixed(3).padStart(5)}    ${String(r.placed.length).padStart(5)}${row.row}   ${row.overlaps}`
      + `   | median ${median(walk).toFixed(0)} p99 ${quantile(walk, 0.99).toFixed(0)} >100u ${(100 * walk.filter((d) => d > 100).length / walk.length).toFixed(2)}%`);
  }
}

console.log('\n=== 4d. MONOTONICITY — the metric that failed the stride change (19 -> 11 made 25% of the pavement WORSE) ===');
const compare = (label: string, from: Array<{ x: number; z: number }>, to: Array<{ x: number; z: number }>): void => {
  const a = nearestField(from); const b = nearestField(to);
  let better = 0; let worse = 0; let worse50 = 0; let sameish = 0; let worstDelta = 0; let worstAt = '';
  a.forEach((before, i) => {
    const after = b[i]!;
    if (after < before - 0.5) better++;
    else if (after > before + 0.5) { worse++; if (after - before > 50) worse50++; if (after - before > worstDelta) { worstDelta = after - before; worstAt = `${districtOf[i]} ${before.toFixed(0)} -> ${after.toFixed(0)}`; } }
    else sameish++;
  });
  console.log(`  ${label}`);
  console.log(`    closer ${(100 * better / a.length).toFixed(1)}%   unchanged ${(100 * sameish / a.length).toFixed(1)}%`
    + `   FARTHER ${(100 * worse / a.length).toFixed(2)}%   farther by >50 u ${(100 * worse50 / a.length).toFixed(2)}%`
    + `   worst regression ${worstDelta.toFixed(0)} u (${worstAt})`);
};
const pitch104 = runArcPass({ ...base, pitch: STREETLAMP_SPACING * 4, slide: 52, separation: 12 });
const pitch78 = recommended;
const pitch52 = runArcPass({ ...base, pitch: STREETLAMP_SPACING * 2, slide: 26, separation: 12 });
compare('arc pitch 104 -> 78 (a pitch refinement)', spotsOf(pitch104.placed), spotsOf(pitch78.placed));
compare('arc pitch 78 -> 52 (a later retune, if the owner wants more)', spotsOf(pitch78.placed), spotsOf(pitch52.placed));
compare('shipped stride 11 -> arc pitch 78 (what this design would do to the branch)', shipped.map((h) => ({ x: h.x, z: h.z })), spotsOf(pitch78.placed));
console.log('  with a FIXED station phase (arc = 13 + n*pitch) instead of pitch/2, so a pitch retune is a refinement:');
const fixed78 = runArcPass({ ...base, pitch: pitch3, slide: 38, separation: 12, fixedPhase: true });
const fixed104 = runArcPass({ ...base, pitch: STREETLAMP_SPACING * 4, slide: 52, separation: 12, fixedPhase: true });
const fixed52 = runArcPass({ ...base, pitch: STREETLAMP_SPACING * 2, slide: 26, separation: 12, fixedPhase: true });
compare('fixed-phase pitch 104 -> 78', spotsOf(fixed104.placed), spotsOf(fixed78.placed));
compare('fixed-phase pitch 104 -> 52 (nested: 52 divides 104)', spotsOf(fixed104.placed), spotsOf(fixed52.placed));
{
  const walk = nearestField(spotsOf(fixed78.placed));
  console.log(`  fixed-phase pitch 78: ${fixed78.placed.length} hydrants  median ${median(walk).toFixed(0)}  p90 ${quantile(walk, 0.9).toFixed(0)}`
    + `  p99 ${quantile(walk, 0.99).toFixed(0)}  max ${Math.max(...walk).toFixed(0)}  >100u ${(100 * walk.filter((d) => d > 100).length / walk.length).toFixed(2)}%`);
}

console.log('\n  WHERE THE TAIL IS. The 12 pavement points farthest from any hydrant, recommended pass:');
{
  const walk = nearestField(spotsOf(recommended.placed));
  const order = walk.map((d, i) => ({ d, i })).sort((a, b) => b.d - a.d).slice(0, 12);
  for (const { d, i } of order) {
    const point = pavement[i]!;
    console.log(`    ${d.toFixed(0).padStart(4)} u   ${districtOf[i]!.padEnd(22)} at (${point.x.toFixed(0)}, ${point.z.toFixed(0)})  road width ${point.width}`);
  }
}
for (const [label, r] of [['pitch 52 + slide 26 + sep 12', pitch52], ['pitch 78 + slide 38 + sep 12', pitch78], ['pitch 104 + slide 52 + sep 12', pitch104]] as const) {
  const walk = nearestField(spotsOf(r.placed));
  console.log(`  ${label.padEnd(32)} ${String(r.placed.length).padStart(5)} hydrants  ${r.placed.length * PARTS_PER_PROP} instances`
    + `  median ${median(walk).toFixed(0)}  p90 ${quantile(walk, 0.9).toFixed(0)}  p99 ${quantile(walk, 0.99).toFixed(0)}`
    + `  max ${Math.max(...walk).toFixed(0)}  >100u ${(100 * walk.filter((d) => d > 100).length / walk.length).toFixed(2)}%`
    + `  >150u ${(100 * walk.filter((d) => d > 150).length / walk.length).toFixed(2)}%`
    + `  one per ${(roadLength / r.placed.length * METRES_PER_UNIT).toFixed(0)} m of street`);
}

// ---------------------------------------------------------------------------------------------
// 5. RISK-CATEGORY (district) PITCH — SANS 10090 table 9 spaces by risk, not by road class.
// ---------------------------------------------------------------------------------------------
console.log('\n=== 5. ROAD CLASS vs DISTRICT ===');
const byWidth = new Map<number, number>();
for (const a of recommended.placed) byWidth.set(a.width, (byWidth.get(a.width) ?? 0) + 1);
console.log(`  recommended pass by road width: ${[...byWidth.entries()].sort((a, b) => a[0] - b[0]).map(([w, n]) => `w${w}:${n}`).join('  ')}`);
console.log(`  narrowest road in the network is ${Math.min(...ROAD_NETWORK.map((r) => r.width))} u, and STREETLAMP_MIN_WIDTH is ${STREETLAMP_MIN_WIDTH},`
  + ' so "every lit street" and "every street" are the same set — the width gate is a no-op, which is the point.');


// ---------------------------------------------------------------------------------------------
// 6. THE RECOMMENDATION, in full.
// ---------------------------------------------------------------------------------------------
console.log('\n=== 6. RECOMMENDED MECHANISM: arc-length stations, phase = one lamp span, slide = pitch/2, separation 12, probe 1.4 ===');
const finalOptions = (pitch: number): PassOptions => ({
  pitch, phase: STREETLAMP_SPACING, minWidth: STREETLAMP_MIN_WIDTH, kerb: HYDRANT_KERB_DISTANCE,
  slide: pitch / 2, slideStep: 2, separation: 12, everyRoad: true, fixedPhase: true, probe: 1.4,
});
for (const spans of [2, 3, 4]) {
  const pitch = STREETLAMP_SPACING * spans;
  const r = runArcPass(finalOptions(pitch));
  summarise(`pitch ${pitch} u = ${spans} lamp spans (${(pitch * METRES_PER_UNIT).toFixed(0)} m real)`, r);
}

const FINAL_PITCH = STREETLAMP_SPACING * 3;
const finalPass = runArcPass(finalOptions(FINAL_PITCH));
const finalSpots = spotsOf(finalPass.placed);
console.log('\n  --- the chosen pitch, in detail ---');
{
  const walk = nearestField(finalSpots);
  const byDistrict = new Map<string, number[]>();
  walk.forEach((d, i) => { const k = districtOf[i]!; const b = byDistrict.get(k); if (b) b.push(d); else byDistrict.set(k, [d]); });
  const rows = [...byDistrict.entries()].filter(([, v]) => v.length >= 20).map(([name, v]) => ({
    name, n: v.length, median: median(v), p90: quantile(v, 0.9), p99: quantile(v, 0.99),
    max: Math.max(...v), over100: v.filter((d) => d > 100).length,
  })).sort((a, b) => b.max - a.max);
  console.log('  worst 15 districts by max walk-up:');
  console.log('  district                  pts  median   p90   p99   max  >100u');
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.name.padEnd(24)} ${String(r.n).padStart(5)} ${r.median.toFixed(0).padStart(7)}`
      + `${r.p90.toFixed(0).padStart(6)}${r.p99.toFixed(0).padStart(6)}${r.max.toFixed(0).padStart(6)}${String(r.over100).padStart(7)}`);
  }
  console.log(`  districts (>=20 pts): ${rows.length}; median over 60 u: ${rows.filter((r) => r.median > 60).length};`
    + ` any point over 100 u: ${rows.filter((r) => r.max > 100).length}; over 150 u: ${rows.filter((r) => r.max > 150).length}`);
  console.log(`  citywide: ${finalPass.placed.length} hydrants, ${finalPass.placed.length * PARTS_PER_PROP} instances,`
    + ` one per ${(roadLength / finalPass.placed.length).toFixed(0)} u = ${(roadLength / finalPass.placed.length * METRES_PER_UNIT).toFixed(0)} m of street`);
  console.log(`  >100 u: ${walk.filter((d) => d > 100).length} of ${walk.length} points (${(100 * walk.filter((d) => d > 100).length / walk.length).toFixed(2)}%);`
    + ` >150 u: ${walk.filter((d) => d > 150).length} (${(100 * walk.filter((d) => d > 150).length / walk.length).toFixed(2)}%);`
    + ` >200 u: ${walk.filter((d) => d > 200).length}`);
  const row = closestByFamily(finalSpots);
  console.log(`  closest other-family prop: ${familyProbe.map((k, i) => `${k} ${row.row.trim().split(/\s+/)[i]}`).join(', ')}; overlaps ${row.overlaps}`);
  console.log(`  closest hydrant pair: ${closestPair(finalSpots).d.toFixed(3)} u`);
}
compare('  shipped stride 11 -> the recommendation', shipped.map((h) => ({ x: h.x, z: h.z })), finalSpots);
compare('  the recommendation -> a later retune to 2 lamp spans (52 u)', finalSpots, spotsOf(runArcPass(finalOptions(STREETLAMP_SPACING * 2)).placed));
compare('  the recommendation -> a later retune to 4 lamp spans (104 u)', finalSpots, spotsOf(runArcPass(finalOptions(STREETLAMP_SPACING * 4)).placed));
{
  const tally = new Map<number, number>();
  for (const a of finalPass.placed) tally.set(a.width, (tally.get(a.width) ?? 0) + 1);
  const narrow = [...tally.entries()].filter(([w]) => w < 9).reduce((sum, [, n]) => sum + n, 0);
  console.log(`  by road width: ${[...tally.entries()].sort((a, b) => a[0] - b[0]).map(([w, n]) => `w${w}:${n}`).join('  ')}`);
  console.log(`  on streets narrower than the old width>=9 gate: ${narrow} of ${finalPass.placed.length}`
    + ` = ${(100 * narrow / finalPass.placed.length).toFixed(1)}%`);
  console.log(`  prop registry after the swap: ${city.props.props.length - shipped.length + finalPass.placed.length}`
    + ` (was ${city.props.props.length} with ${shipped.length} hydrants)`);
}

console.log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
