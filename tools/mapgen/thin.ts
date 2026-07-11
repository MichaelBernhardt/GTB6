/**
 * Density thinning + boundary orbital for the game-scale map ("guided by life, not true
 * to life" — owner direction). Two responsibilities:
 *
 *  1. thinParallelRoads: the real CBD street grid is ~70 m pitch, far denser than the
 *     game scale can carry. Minor roads that run parallel to (and close beside) roads we
 *     already keep are dropped, so dense grids decimate to every-other-street while
 *     isolated suburban streets survive. Protected names (parody/anchor streets) and
 *     major classes are never dropped.
 *
 *  2. buildOrbitalRing: roads clipped at the crop boundary must not stop dead. Every
 *     dangling endpoint near the map bounds gets collected into one closed orbital road
 *     that runs just outside the bounds (chamfered corners), so you can drive around the
 *     whole place GTA-style.
 */
import type { Pt } from './types';
import { nodeDegrees, roadLength, type GraphRoad, type RoadNetwork } from './graph';

/** Importance rank per highway class: only lower ranks are thinning candidates. */
export const ROAD_RANK: Record<string, number> = {
  residential: 0,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  tertiary: 2,
  secondary: 3,
  primary: 4,
  trunk: 5,
  motorway: 6,
};

export interface ThinOptions {
  /** A candidate sample is "covered" when a retained, roughly-parallel segment is within this (m). */
  coverageDistance: number;
  /** Fraction of covered samples above which the whole road is dropped. */
  coverageFraction: number;
  /** Sample step along candidate roads (m). */
  sampleStep: number;
  /** Highest rank that may be dropped (inclusive). */
  maxRank: number;
  /** |cos| of the angle between candidate and retained segment above which they count as parallel. */
  parallelCos: number;
  /** Road names that must never be dropped (parody/anchor streets). */
  protectedNames: Set<string>;
}

export interface ThinReport { dropped: number; droppedKm: number; prunedStubs: number; }

interface DirSegment { ax: number; az: number; bx: number; bz: number; dirX: number; dirZ: number; }

class SegmentGrid {
  private cells = new Map<string, DirSegment[]>();
  constructor(private cell: number) {}

  add(a: Pt, b: Pt): void {
    const length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    const segment: DirSegment = { ax: a.x, az: a.z, bx: b.x, bz: b.z, dirX: (b.x - a.x) / length, dirZ: (b.z - a.z) / length };
    const minX = Math.floor(Math.min(a.x, b.x) / this.cell); const maxX = Math.floor(Math.max(a.x, b.x) / this.cell);
    const minZ = Math.floor(Math.min(a.z, b.z) / this.cell); const maxZ = Math.floor(Math.max(a.z, b.z) / this.cell);
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      const key = `${cx},${cz}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(segment); else this.cells.set(key, [segment]);
    }
  }

  addRoad(net: RoadNetwork, road: GraphRoad): void {
    for (let index = 0; index < road.nodeIds.length - 1; index++) {
      const a = net.nodes.get(road.nodeIds[index]); const b = net.nodes.get(road.nodeIds[index + 1]);
      if (a && b) this.add(a, b);
    }
  }

  /** True when a roughly-parallel segment sits within `distance` of the sample. */
  coveredBy(x: number, z: number, dirX: number, dirZ: number, distance: number, parallelCos: number): boolean {
    const gx = Math.floor(x / this.cell); const gz = Math.floor(z / this.cell);
    const reach = Math.ceil(distance / this.cell);
    for (let cx = gx - reach; cx <= gx + reach; cx++) for (let cz = gz - reach; cz <= gz + reach; cz++) {
      for (const segment of this.cells.get(`${cx},${cz}`) ?? []) {
        if (Math.abs(segment.dirX * dirX + segment.dirZ * dirZ) < parallelCos) continue;
        const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq));
        if (Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)) <= distance) return true;
      }
    }
    return false;
  }
}

function sampleRoad(net: RoadNetwork, road: GraphRoad, step: number): Array<{ x: number; z: number; dirX: number; dirZ: number }> {
  const samples: Array<{ x: number; z: number; dirX: number; dirZ: number }> = [];
  for (let index = 0; index < road.nodeIds.length - 1; index++) {
    const a = net.nodes.get(road.nodeIds[index]); const b = net.nodes.get(road.nodeIds[index + 1]);
    if (!a || !b) continue;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const dirX = (b.x - a.x) / (length || 1); const dirZ = (b.z - a.z) / (length || 1);
    const steps = Math.max(1, Math.round(length / step));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      samples.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dirX, dirZ });
    }
  }
  return samples;
}

/**
 * Drops minor roads that mostly duplicate a nearby parallel retained road. Retained roads
 * accumulate: candidates are processed majors-first so the survivors of one class shield
 * the next class down, decimating dense grids to a driveable pitch.
 */
export function thinParallelRoads(net: RoadNetwork, options: ThinOptions): ThinReport {
  const report: ThinReport = { dropped: 0, droppedKm: 0, prunedStubs: 0 };
  const grid = new SegmentGrid(Math.max(options.coverageDistance * 2, 100));
  const isProtected = (road: GraphRoad): boolean =>
    (ROAD_RANK[road.kind] ?? 0) > options.maxRank || options.protectedNames.has(road.name);
  const candidates: Array<{ road: GraphRoad; length: number }> = [];
  for (const road of net.roads) {
    if (isProtected(road)) grid.addRoad(net, road);
    else candidates.push({ road, length: roadLength(net, road) });
  }
  // Majors first, longer first: spines get retained, the short parallel in-fill gets dropped.
  candidates.sort((a, b) => (ROAD_RANK[b.road.kind] ?? 0) - (ROAD_RANK[a.road.kind] ?? 0) || b.length - a.length);
  // Live degrees guard connectivity: a road may only be dropped while both its endpoints
  // remain proper junctions (>= 3 incident segments), so through-routes never sever.
  const degree = nodeDegrees(net);
  const dropped = new Set<GraphRoad>();
  for (const { road, length } of candidates) {
    const first = road.nodeIds[0]; const last = road.nodeIds[road.nodeIds.length - 1];
    if ((degree.get(first) ?? 0) < 3 || (degree.get(last) ?? 0) < 3) { grid.addRoad(net, road); continue; }
    const samples = sampleRoad(net, road, options.sampleStep);
    if (samples.length === 0) continue;
    let covered = 0;
    for (const sample of samples) {
      if (grid.coveredBy(sample.x, sample.z, sample.dirX, sample.dirZ, options.coverageDistance, options.parallelCos)) covered++;
    }
    if (covered / samples.length >= options.coverageFraction) {
      dropped.add(road);
      report.dropped++;
      report.droppedKm += length / 1000;
      for (let index = 0; index < road.nodeIds.length; index++) {
        const bump = index === 0 || index === road.nodeIds.length - 1 ? 1 : 2;
        degree.set(road.nodeIds[index], (degree.get(road.nodeIds[index]) ?? bump) - bump);
      }
    } else {
      grid.addRoad(net, road);
    }
  }
  net.roads = net.roads.filter((road) => !dropped.has(road));
  return report;
}

/** Drops short dangling spurs left behind by thinning (repeat passes settle chains). */
export function pruneShortStubs(net: RoadNetwork, maxLength: number, protectedNames: Set<string>): number {
  let pruned = 0;
  for (let pass = 0; pass < 3; pass++) {
    const degree = nodeDegrees(net);
    const before = net.roads.length;
    net.roads = net.roads.filter((road) => {
      if (protectedNames.has(road.name) || (ROAD_RANK[road.kind] ?? 0) >= 4) return true;
      const first = road.nodeIds[0]; const last = road.nodeIds[road.nodeIds.length - 1];
      const dangling = (degree.get(first) ?? 0) <= 1 || (degree.get(last) ?? 0) <= 1;
      return !(dangling && roadLength(net, road) < maxLength);
    });
    const removed = before - net.roads.length;
    pruned += removed;
    if (removed === 0) break;
  }
  return pruned;
}

export interface RingOptions {
  /** Dangling endpoints closer than this (m) to the map bounds join the orbital. */
  boundaryMargin: number;
  /** The orbital runs this far (m) outside the map bounds. */
  ringOffset: number;
  /** Corner chamfer length (m) so the orbital corners drive smoothly. */
  cornerChamfer: number;
  name: string;
  kind: GraphRoad['kind'];
  width: number;
  /** Leave the west edge open (the coastal highway takes that side): the orbital becomes a C. */
  openAcrossWest?: boolean;
}

export interface RingReport { stubs: number; built: boolean; }

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number; }

function netBounds(net: RoadNetwork): Bounds {
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const point of net.nodes.values()) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
  }
  return { minX, maxX, minZ, maxZ };
}

/** Perimeter parameter (clockwise from the north-west corner) of a point on the ring rectangle. */
function perimeterParam(rect: Bounds, point: Pt): number {
  const w = rect.maxX - rect.minX; const h = rect.maxZ - rect.minZ;
  // Distances to each side decide which side the point sits on.
  const dLeft = point.x - rect.minX; const dRight = rect.maxX - point.x;
  const dTop = point.z - rect.minZ; const dBottom = rect.maxZ - point.z;
  const minimum = Math.min(dLeft, dRight, dTop, dBottom);
  if (minimum === dTop) return point.x - rect.minX; // north edge, west -> east
  if (minimum === dRight) return w + (point.z - rect.minZ); // east edge, north -> south
  if (minimum === dBottom) return w + h + (rect.maxX - point.x); // south edge, east -> west
  return w + h + w + (rect.maxZ - point.z); // west edge, south -> north
}

/** Point on the rectangle at perimeter parameter t (same orientation as perimeterParam). */
function perimeterPoint(rect: Bounds, t: number): Pt {
  const w = rect.maxX - rect.minX; const h = rect.maxZ - rect.minZ;
  const total = 2 * (w + h);
  let s = ((t % total) + total) % total;
  if (s < w) return { x: rect.minX + s, z: rect.minZ };
  s -= w;
  if (s < h) return { x: rect.maxX, z: rect.minZ + s };
  s -= h;
  if (s < w) return { x: rect.maxX - s, z: rect.maxZ };
  s -= w;
  return { x: rect.minX, z: rect.maxZ - s };
}

/** Corner parameters (clockwise) of the ring rectangle. */
function cornerParams(rect: Bounds): number[] {
  const w = rect.maxX - rect.minX; const h = rect.maxZ - rect.minZ;
  return [0, w, w + h, w + h + w];
}

/**
 * Builds one closed orbital road just outside the map bounds, spurred into every dangling
 * boundary endpoint, so no road stops dead at the crop edge. Returns the stub count.
 */
export function buildOrbitalRing(net: RoadNetwork, options: RingOptions): RingReport {
  const bounds = netBounds(net);
  if (!Number.isFinite(bounds.minX)) return { stubs: 0, built: false };
  const degree = nodeDegrees(net);
  const stubIds: number[] = [];
  const seen = new Set<number>();
  for (const road of net.roads) {
    for (const end of [road.nodeIds[0], road.nodeIds[road.nodeIds.length - 1]]) {
      if (end === undefined || seen.has(end) || (degree.get(end) ?? 0) !== 1) continue;
      const point = net.nodes.get(end);
      if (!point) continue;
      const dWest = point.x - bounds.minX;
      const dOther = Math.min(bounds.maxX - point.x, point.z - bounds.minZ, bounds.maxZ - point.z);
      // Open-west mode: stubs that belong to the west edge (the coast) stay out of the ring —
      // quays and slipways are allowed to end at the water.
      if (options.openAcrossWest && dWest < dOther) continue;
      if (Math.min(dWest, dOther) <= options.boundaryMargin) { stubIds.push(end); seen.add(end); }
    }
  }
  if (stubIds.length < 2) return { stubs: stubIds.length, built: false };

  const rect: Bounds = {
    minX: bounds.minX - options.ringOffset, maxX: bounds.maxX + options.ringOffset,
    minZ: bounds.minZ - options.ringOffset, maxZ: bounds.maxZ + options.ringOffset,
  };
  let nextId = 0;
  for (const id of net.nodes.keys()) if (id >= nextId) nextId = id + 1;
  const addNode = (point: Pt): number => { const id = nextId++; net.nodes.set(id, point); return id; };

  const total = 2 * (rect.maxX - rect.minX + rect.maxZ - rect.minZ);
  let stubs = stubIds
    .map((id) => ({ id, t: perimeterParam(rect, net.nodes.get(id)!) }))
    .sort((a, b) => a.t - b.t);

  // Open-west mode: the coastal highway owns the west side, so the orbital is a C shape.
  // Find the stub gap whose perimeter arc crosses the middle of the west edge and cut there.
  let closed = true;
  if (options.openAcrossWest && stubs.length >= 2) {
    const w = rect.maxX - rect.minX; const h = rect.maxZ - rect.minZ;
    const westMid = 2 * w + h + h / 2; // param of (minX, midZ) on the clockwise walk
    for (let index = 0; index < stubs.length; index++) {
      const current = stubs[index]!; const next = stubs[(index + 1) % stubs.length]!;
      const end = next.t > current.t ? next.t : next.t + total;
      if ((westMid > current.t && westMid < end) || (westMid + total > current.t && westMid + total < end)) {
        stubs = [...stubs.slice(index + 1), ...stubs.slice(0, index + 1)];
        closed = false;
        break;
      }
    }
  }

  // Ring vertices: each stub's projection onto the rectangle, with chamfered corner points between.
  const corners = cornerParams(rect);
  const ringNodeIds: number[] = [];
  for (let index = 0; index < stubs.length; index++) {
    const current = stubs[index]; const next = stubs[(index + 1) % stubs.length];
    const projectionId = addNode(perimeterPoint(rect, current.t));
    ringNodeIds.push(projectionId);
    // Spur from the orbital into the dangling endpoint.
    net.roads.push({ name: options.name, kind: options.kind, width: options.width, nodeIds: [projectionId, current.id] });
    if (!closed && index === stubs.length - 1) break; // open orbital: the last stub is an end, not a wrap
    // Chamfered corner vertices between this projection and the next (wrapping), in walk order.
    const end = next.t > current.t ? next.t : next.t + total;
    const between: number[] = [];
    for (const corner of corners) for (const wrapped of [corner, corner + total]) {
      if (wrapped > current.t + 1 && wrapped < end - 1) between.push(wrapped);
    }
    between.sort((a, b) => a - b);
    for (const corner of between) {
      ringNodeIds.push(addNode(perimeterPoint(rect, corner - options.cornerChamfer)));
      ringNodeIds.push(addNode(perimeterPoint(rect, corner + options.cornerChamfer)));
    }
  }
  if (ringNodeIds.length >= 2) {
    const nodeIds = closed ? [...ringNodeIds, ringNodeIds[0]] : ringNodeIds;
    net.roads.push({ name: options.name, kind: options.kind, width: options.width, nodeIds });
  }
  return { stubs: stubs.length, built: true };
}
