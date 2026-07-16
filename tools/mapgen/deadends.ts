/**
 * Dead-end resolution (owner: clipped roads "just lead to nowhere / dead end ... Some of those
 * straggling road ends could be joined together to form loops. Some could just be removed back
 * to the last intersection.") Three phases over every dangling endpoint (degree 1), in order:
 *
 *  1. JOIN — pairs of dangling ends close together are connected with a gentle arc, turning
 *     two stubs into a loop. Guarded: the arc must not double back on either road and must not
 *     cross any existing road.
 *  2. CONNECT — a lone dangling end near another road's segment gets a short T-connector into
 *     a new junction vertex on that road (slip roads / clipped ramps rejoin the grid).
 *  3. TRUNCATE — whatever still dangles gets its tail cut back to the last real junction, when
 *     the tail is short enough to be noise rather than a deliberate feature.
 *
 * Legit cul-de-sacs (quays, farm lanes, apron access — CUL_DE_SAC_NAMES) are left alone.
 */
import { smoothCurve } from './coast';
import {
  buildSegmentGrid,
  nodeDegrees,
  projectOnSegment,
  pruneOrphanNodes,
  type GraphRoad,
  type RoadNetwork,
  type SegmentRef,
} from './graph';
import { ROAD_RANK } from './thin';
import type { Pt } from './types';

export interface DeadEndOptions {
  /** Dangling endpoint pairs closer than this (m) may be joined into a loop. */
  joinDistance: number;
  /** Dangling ends within this (m) of another road get a T-connector. */
  connectDistance: number;
  /** Dangling tails shorter than this (m) are truncated back to the last junction. */
  pruneLength: number;
  /** Truncation limit for primary-and-up roads (they earn their dead ends more often). */
  pruneLengthMajor: number;
  /** Road names allowed to end dead (quays, slipways, farm lanes). */
  culDeSacNames: Set<string>;
}

export interface DeadEndReport {
  joined: number;
  connected: number;
  truncated: number;
  droppedRoads: number;
  remaining: number;
}

interface DanglingEnd {
  road: GraphRoad;
  /** 0 = the road's first node dangles, 1 = the last. */
  end: 0 | 1;
  nodeId: number;
  p: Pt;
  /** Unit tangent pointing OUT of the road at the dangling end. */
  tx: number;
  tz: number;
}

function danglingEnds(net: RoadNetwork, culDeSac: Set<string>): DanglingEnd[] {
  const degree = nodeDegrees(net);
  const out: DanglingEnd[] = [];
  for (const road of net.roads) {
    if (culDeSac.has(road.name) || road.nodeIds.length < 2) continue;
    for (const end of [0, 1] as const) {
      const nodeId = end === 0 ? road.nodeIds[0]! : road.nodeIds[road.nodeIds.length - 1]!;
      if ((degree.get(nodeId) ?? 0) !== 1) continue;
      const p = net.nodes.get(nodeId)!;
      const inner = net.nodes.get(end === 0 ? road.nodeIds[1]! : road.nodeIds[road.nodeIds.length - 2]!)!;
      const length = Math.hypot(p.x - inner.x, p.z - inner.z) || 1;
      out.push({ road, end, nodeId, p, tx: (p.x - inner.x) / length, tz: (p.z - inner.z) / length });
    }
  }
  return out;
}

function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const cross = (ox: number, oz: number, px: number, pz: number, qx: number, qz: number): number =>
    (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(c.x, c.z, d.x, d.z, a.x, a.z);
  const d2 = cross(c.x, c.z, d.x, d.z, b.x, b.z);
  const d3 = cross(a.x, a.z, b.x, b.z, c.x, c.z);
  const d4 = cross(a.x, a.z, b.x, b.z, d.x, d.z);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Minimum clearance (m) between a join arc and any foreign road before the join is vetoed. */
const ARC_CLEARANCE_M = 12;

/** True when polyline `pts` crosses — or brushes within ARC_CLEARANCE_M of — any existing road
 *  segment (the two parent roads excluded). Near-misses count: a loop arc that grazes a third
 *  road reads as an overlap on the map even if the segments never mathematically intersect. */
function crossesNetwork(net: RoadNetwork, grid: Map<string, SegmentRef[]>, cell: number, pts: Pt[], skipRoads: Set<GraphRoad>): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!; const b = pts[i + 1]!;
    const minGX = Math.floor(Math.min(a.x, b.x) / cell); const maxGX = Math.floor(Math.max(a.x, b.x) / cell);
    const minGZ = Math.floor(Math.min(a.z, b.z) / cell); const maxGZ = Math.floor(Math.max(a.z, b.z) / cell);
    for (let gx = minGX; gx <= maxGX; gx++) for (let gz = minGZ; gz <= maxGZ; gz++) {
      for (const ref of grid.get(`${gx},${gz}`) ?? []) {
        const road = net.roads[ref.roadIndex];
        if (!road || skipRoads.has(road) || ref.segIndex >= road.nodeIds.length - 1) continue;
        const c = net.nodes.get(road.nodeIds[ref.segIndex]!);
        const d = net.nodes.get(road.nodeIds[ref.segIndex + 1]!);
        if (!c || !d) continue;
        if (segmentsIntersect(a, b, c, d)) return true;
        // Touches and grazes (an interior arc vertex ON or beside the foreign segment).
        if (i > 0 && projectOnSegment(a, c, d).distance < ARC_CLEARANCE_M) return true;
        if (i < pts.length - 2 && projectOnSegment(b, c, d).distance < ARC_CLEARANCE_M) return true;
      }
    }
  }
  return false;
}

/** Deterministic per-pair arc bow (no RNG — same map in, same map out). */
function bowSign(a: Pt, b: Pt): number {
  const h = Math.sin(a.x * 0.013 + b.z * 0.017) * 43758.5453;
  return (h - Math.floor(h)) > 0.5 ? 1 : -1;
}

export function resolveDeadEnds(net: RoadNetwork, options: DeadEndOptions): DeadEndReport {
  const report: DeadEndReport = { joined: 0, connected: 0, truncated: 0, droppedRoads: 0, remaining: 0 };
  let nextId = 0;
  for (const id of net.nodes.keys()) if (id >= nextId) nextId = id + 1;
  const addNode = (p: Pt): number => { const id = nextId++; net.nodes.set(id, p); return id; };
  const cell = 300;

  // ---- Phase 1: JOIN nearby dangling pairs into loops -------------------------------------
  {
    const ends = danglingEnds(net, options.culDeSacNames);
    const grid = buildSegmentGrid(net, cell);
    const pairs: Array<{ i: number; j: number; d: number }> = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i]!; const b = ends[j]!;
        if (a.road === b.road) continue; // a road folding onto itself is a paperclip, not a loop
        const d = Math.hypot(a.p.x - b.p.x, a.p.z - b.p.z);
        if (d > options.joinDistance || d < 1) continue;
        // The connector must not double back hard on either end (no hairpins onto yourself).
        const dirX = (b.p.x - a.p.x) / d; const dirZ = (b.p.z - a.p.z) / d;
        if (a.tx * dirX + a.tz * dirZ < -0.25 || b.tx * -dirX + b.tz * -dirZ < -0.25) continue;
        pairs.push({ i, j, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const used = new Set<number>();
    for (const { i, j, d } of pairs) {
      if (used.has(i) || used.has(j)) continue;
      const a = ends[i]!; const b = ends[j]!;
      // Gentle arc: midpoint bowed perpendicular by ~18% of the gap (deterministic side).
      const mx = (a.p.x + b.p.x) / 2; const mz = (a.p.z + b.p.z) / 2;
      const nx = -(b.p.z - a.p.z) / d; const nz = (b.p.x - a.p.x) / d;
      const bow = bowSign(a.p, b.p) * d * 0.18;
      const arc = smoothCurve([a.p, { x: mx + nx * bow, z: mz + nz * bow }, b.p], 60);
      if (crossesNetwork(net, grid, cell, arc, new Set([a.road, b.road]))) continue;
      // Continue the higher-ranked parent so the loop reads as that road carrying on.
      const parent = (ROAD_RANK[a.road.kind] ?? 0) >= (ROAD_RANK[b.road.kind] ?? 0) ? a.road : b.road;
      const nodeIds = arc.map((p, index) => {
        if (index === 0) return a.nodeId;
        if (index === arc.length - 1) return b.nodeId;
        return addNode(p);
      });
      net.roads.push({ name: parent.name, kind: parent.kind, width: parent.width, nodeIds });
      used.add(i); used.add(j);
      report.joined++;
    }
  }

  // ---- Phase 2: CONNECT lone ends to a nearby road segment --------------------------------
  {
    const ends = danglingEnds(net, options.culDeSacNames);
    const grid = buildSegmentGrid(net, Math.max(options.connectDistance * 2, cell));
    const gcell = Math.max(options.connectDistance * 2, cell);
    for (const end of ends) {
      let best: { ref: SegmentRef; point: Pt; t: number; distance: number } | null = null;
      const gx = Math.floor(end.p.x / gcell); const gz = Math.floor(end.p.z / gcell);
      for (let cx = gx - 1; cx <= gx + 1; cx++) for (let cz = gz - 1; cz <= gz + 1; cz++) {
        for (const ref of grid.get(`${cx},${cz}`) ?? []) {
          const target = net.roads[ref.roadIndex];
          if (!target || target === end.road || ref.segIndex >= target.nodeIds.length - 1) continue;
          const a = net.nodes.get(target.nodeIds[ref.segIndex]!);
          const b = net.nodes.get(target.nodeIds[ref.segIndex + 1]!);
          if (!a || !b) continue;
          const hit = projectOnSegment(end.p, a, b);
          if (hit.distance <= options.connectDistance && hit.distance > 8 && (!best || hit.distance < best.distance)) {
            best = { ref, point: hit.point, t: hit.t, distance: hit.distance };
          }
        }
      }
      if (!best) continue;
      // Don't connect backwards: the tie-in should carry the road onwards, not U-turn it.
      const d = best.distance;
      const dirX = (best.point.x - end.p.x) / d; const dirZ = (best.point.z - end.p.z) / d;
      if (end.tx * dirX + end.tz * dirZ < -0.25) continue;
      const target = net.roads[best.ref.roadIndex]!;
      const aId = target.nodeIds[best.ref.segIndex]!;
      const bId = target.nodeIds[best.ref.segIndex + 1]!;
      let junctionId: number;
      if (best.t < 0.05) junctionId = aId;
      else if (best.t > 0.95) junctionId = bId;
      else {
        junctionId = addNode(best.point);
        target.nodeIds.splice(best.ref.segIndex + 1, 0, junctionId);
        // Grid refs into this road shift by one — acceptable staleness, guarded by the length check.
      }
      if (junctionId === end.nodeId) continue;
      net.roads.push({ name: end.road.name, kind: end.road.kind, width: end.road.width, nodeIds: [end.nodeId, junctionId] });
      report.connected++;
    }
  }

  // ---- Phase 3: TRUNCATE leftover dangling tails back to the last junction -----------------
  for (let pass = 0; pass < 3; pass++) {
    const degree = nodeDegrees(net);
    let changed = 0;
    const survivors: GraphRoad[] = [];
    for (const road of net.roads) {
      if (options.culDeSacNames.has(road.name) || road.nodeIds.length < 2) { survivors.push(road); continue; }
      const limit = (ROAD_RANK[road.kind] ?? 0) >= 4 ? options.pruneLengthMajor : options.pruneLength;
      for (const end of [0, 1] as const) {
        const ids = road.nodeIds;
        const endId = end === 0 ? ids[0]! : ids[ids.length - 1]!;
        if ((degree.get(endId) ?? 0) !== 1) continue;
        // Walk inward to the first junction (a node other roads also touch).
        let arc = 0;
        let cut = -1;
        const stepOf = (k: number): number => (end === 0 ? k : ids.length - 1 - k);
        for (let k = 1; k < ids.length; k++) {
          const prev = net.nodes.get(ids[stepOf(k - 1)]!)!;
          const here = net.nodes.get(ids[stepOf(k)]!)!;
          arc += Math.hypot(here.x - prev.x, here.z - prev.z);
          if (arc > limit) break;
          if ((degree.get(ids[stepOf(k)]!) ?? 0) >= 3) { cut = k; break; }
        }
        if (cut === -1) continue;
        road.nodeIds = end === 0 ? ids.slice(cut) : ids.slice(0, ids.length - cut);
        changed++;
        report.truncated++;
      }
      if (road.nodeIds.length >= 2) survivors.push(road);
      else { report.droppedRoads++; changed++; }
    }
    net.roads = survivors;
    if (changed === 0) break;
  }

  pruneOrphanNodes(net);
  report.remaining = danglingEnds(net, options.culDeSacNames).length;
  return report;
}
