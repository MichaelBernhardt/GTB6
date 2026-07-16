import type { Pt, RoadKind } from './types';
import { polylineLength } from './projection';

/** A road as a sequence of node ids into the shared node table. */
export interface GraphRoad {
  name: string;
  kind: RoadKind;
  width: number;
  nodeIds: number[];
}

/** Mutable working network: shared nodes + roads referencing them. */
export interface RoadNetwork {
  nodes: Map<number, Pt>;
  roads: GraphRoad[];
}

export interface IslandReport {
  bridged: number;
  droppedIslands: number;
  droppedKm: number;
  droppedSamples: string[];
}

class UnionFind {
  private parent = new Map<number, number>();

  find(a: number): number {
    let root = a;
    while (this.parent.has(root)) root = this.parent.get(root)!;
    while (a !== root) {
      const next = this.parent.get(a)!;
      this.parent.set(a, root);
      a = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function gridKey(x: number, z: number, cell: number): string {
  return `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
}

function* neighbourKeys(x: number, z: number, cell: number): Generator<string> {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) yield `${gx + dx},${gz + dz}`;
}

function roadPoints(net: RoadNetwork, road: GraphRoad): Pt[] {
  return road.nodeIds.map((id) => net.nodes.get(id)!);
}

export function roadLength(net: RoadNetwork, road: GraphRoad): number {
  return polylineLength(roadPoints(net, road));
}

/** Node ids that are endpoints of a road or used by two or more roads. */
export function connectorNodeIds(net: RoadNetwork): Set<number> {
  const usage = new Map<number, number>();
  const connectors = new Set<number>();
  for (const road of net.roads) {
    if (road.nodeIds.length === 0) continue;
    connectors.add(road.nodeIds[0]);
    connectors.add(road.nodeIds[road.nodeIds.length - 1]);
    for (const id of new Set(road.nodeIds)) usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  for (const [id, count] of usage) if (count >= 2) connectors.add(id);
  return connectors;
}

/**
 * Snap connector nodes (endpoints + shared nodes) within `snapDistance` of
 * each other into a single node at their centroid. Returns merged count.
 */
export function snapNodes(net: RoadNetwork, snapDistance: number): number {
  const connectors = [...connectorNodeIds(net)];
  const grid = new Map<string, number[]>();
  for (const id of connectors) {
    const p = net.nodes.get(id)!;
    const key = gridKey(p.x, p.z, snapDistance);
    let bucket = grid.get(key);
    if (!bucket) grid.set(key, (bucket = []));
    bucket.push(id);
  }
  const uf = new UnionFind();
  for (const id of connectors) {
    const p = net.nodes.get(id)!;
    for (const key of neighbourKeys(p.x, p.z, snapDistance)) {
      for (const other of grid.get(key) ?? []) {
        if (other === id) continue;
        const q = net.nodes.get(other)!;
        if (Math.hypot(p.x - q.x, p.z - q.z) <= snapDistance) uf.union(id, other);
      }
    }
  }
  // Gather clusters and move each representative to the cluster centroid.
  const clusters = new Map<number, number[]>();
  for (const id of connectors) {
    const root = uf.find(id);
    let members = clusters.get(root);
    if (!members) clusters.set(root, (members = []));
    members.push(id);
  }
  const remap = new Map<number, number>();
  let merged = 0;
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    let sx = 0, sz = 0;
    for (const id of members) {
      const p = net.nodes.get(id)!;
      sx += p.x;
      sz += p.z;
    }
    net.nodes.set(root, { x: sx / members.length, z: sz / members.length });
    for (const id of members) {
      if (id !== root) {
        remap.set(id, root);
        merged++;
      }
    }
  }
  if (remap.size > 0) remapRoadNodes(net, remap);
  return merged;
}

function remapRoadNodes(net: RoadNetwork, remap: Map<number, number>): void {
  for (const road of net.roads) {
    const mapped = road.nodeIds.map((id) => remap.get(id) ?? id);
    // Collapse runs of the same node produced by merging.
    road.nodeIds = mapped.filter((id, i) => i === 0 || id !== mapped[i - 1]);
  }
  for (const id of remap.keys()) net.nodes.delete(id);
}

export interface SegmentRef {
  roadIndex: number;
  segIndex: number;
}

export function buildSegmentGrid(net: RoadNetwork, cell: number): Map<string, SegmentRef[]> {
  const grid = new Map<string, SegmentRef[]>();
  net.roads.forEach((road, roadIndex) => {
    for (let s = 0; s < road.nodeIds.length - 1; s++) {
      const a = net.nodes.get(road.nodeIds[s])!;
      const b = net.nodes.get(road.nodeIds[s + 1])!;
      const minGX = Math.floor(Math.min(a.x, b.x) / cell);
      const maxGX = Math.floor(Math.max(a.x, b.x) / cell);
      const minGZ = Math.floor(Math.min(a.z, b.z) / cell);
      const maxGZ = Math.floor(Math.max(a.z, b.z) / cell);
      for (let gx = minGX; gx <= maxGX; gx++) {
        for (let gz = minGZ; gz <= maxGZ; gz++) {
          const key = `${gx},${gz}`;
          let bucket = grid.get(key);
          if (!bucket) grid.set(key, (bucket = []));
          bucket.push({ roadIndex, segIndex: s });
        }
      }
    }
  });
  return grid;
}

export function projectOnSegment(p: Pt, a: Pt, b: Pt): { point: Pt; t: number; distance: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq));
  const point = { x: a.x + t * dx, z: a.z + t * dz };
  return { point, t, distance: Math.hypot(p.x - point.x, p.z - point.z) };
}

/**
 * Snap dangling road endpoints onto nearby segments of OTHER roads within
 * `snapDistance`, inserting a junction vertex into the target road (classic
 * T-junction repair for near-miss geometry). Returns number of snaps.
 */
export function snapEndpointsToSegments(net: RoadNetwork, snapDistance: number): number {
  const cell = Math.max(snapDistance * 4, 50);
  const degree = nodeDegrees(net);
  let nextId = maxNodeId(net) + 1;
  let snaps = 0;
  const grid = buildSegmentGrid(net, cell);
  net.roads.forEach((road, roadIndex) => {
    for (const end of [0, road.nodeIds.length - 1]) {
      const endId = road.nodeIds[end];
      if ((degree.get(endId) ?? 0) > 1) continue; // already connected
      const p = net.nodes.get(endId)!;
      let best: { ref: SegmentRef; point: Pt; distance: number } | null = null;
      for (const key of neighbourKeys(p.x, p.z, cell)) {
        for (const ref of grid.get(key) ?? []) {
          if (ref.roadIndex === roadIndex) continue;
          const target = net.roads[ref.roadIndex];
          const a = net.nodes.get(target.nodeIds[ref.segIndex]);
          const b = net.nodes.get(target.nodeIds[ref.segIndex + 1]);
          if (!a || !b) continue;
          const hit = projectOnSegment(p, a, b);
          if (hit.distance <= snapDistance && (!best || hit.distance < best.distance)) {
            best = { ref, point: hit.point, distance: hit.distance };
          }
        }
      }
      if (!best) continue;
      const target = net.roads[best.ref.roadIndex];
      const aId = target.nodeIds[best.ref.segIndex];
      const bId = target.nodeIds[best.ref.segIndex + 1];
      const a = net.nodes.get(aId)!;
      const b = net.nodes.get(bId)!;
      // Reuse an existing segment endpoint if the projection lands on it.
      const nearA = Math.hypot(best.point.x - a.x, best.point.z - a.z) < 0.5;
      const nearB = Math.hypot(best.point.x - b.x, best.point.z - b.z) < 0.5;
      let junctionId: number;
      if (nearA) junctionId = aId;
      else if (nearB) junctionId = bId;
      else {
        junctionId = nextId++;
        net.nodes.set(junctionId, best.point);
        target.nodeIds.splice(best.ref.segIndex + 1, 0, junctionId);
        // Grid entries for the split segment are stale but only slightly;
        // acceptable because snapDistance << cell size.
      }
      if (junctionId !== endId) {
        road.nodeIds[end] = junctionId;
        if (road.nodeIds.length >= 2 && road.nodeIds[end] === road.nodeIds[end === 0 ? 1 : road.nodeIds.length - 2]) {
          // Degenerate single-segment collapse; restore original endpoint.
          road.nodeIds[end] = endId;
          continue;
        }
        degree.set(junctionId, (degree.get(junctionId) ?? 0) + 1);
        snaps++;
      }
    }
  });
  return snaps;
}

export function nodeDegrees(net: RoadNetwork): Map<number, number> {
  const degree = new Map<number, number>();
  for (const road of net.roads) {
    for (let i = 0; i < road.nodeIds.length; i++) {
      const bump = i === 0 || i === road.nodeIds.length - 1 ? 1 : 2;
      degree.set(road.nodeIds[i], (degree.get(road.nodeIds[i]) ?? 0) + bump);
    }
  }
  return degree;
}

function maxNodeId(net: RoadNetwork): number {
  let max = 0;
  for (const id of net.nodes.keys()) if (id > max) max = id;
  return max;
}

export interface Component {
  roadIndices: number[];
  nodeIds: Set<number>;
  lengthM: number;
}

/** Connected components over shared node ids, largest (by road km) first. */
export function connectedComponents(net: RoadNetwork): Component[] {
  const uf = new UnionFind();
  for (const road of net.roads) {
    for (let i = 1; i < road.nodeIds.length; i++) uf.union(road.nodeIds[i - 1], road.nodeIds[i]);
  }
  const byRoot = new Map<number, Component>();
  net.roads.forEach((road, index) => {
    if (road.nodeIds.length === 0) return;
    const root = uf.find(road.nodeIds[0]);
    let component = byRoot.get(root);
    if (!component) byRoot.set(root, (component = { roadIndices: [], nodeIds: new Set(), lengthM: 0 }));
    component.roadIndices.push(index);
    for (const id of road.nodeIds) component.nodeIds.add(id);
    component.lengthM += roadLength(net, road);
  });
  return [...byRoot.values()].sort((a, b) => b.lengthM - a.lengthM);
}

/**
 * Keep the largest component; islands whose nearest node is within
 * `bridgeDistance` of the main component are reconnected by moving that node
 * onto the closest main-component point (node or segment projection).
 * Everything else is dropped. Repeats until stable.
 */
export function bridgeIslands(net: RoadNetwork, bridgeDistance: number): IslandReport {
  const report: IslandReport = { bridged: 0, droppedIslands: 0, droppedKm: 0, droppedSamples: [] };
  for (let pass = 0; pass < 12; pass++) {
    const components = connectedComponents(net);
    if (components.length <= 1) break;
    const main = components[0];
    const cell = Math.max(bridgeDistance * 2, 100);
    const grid = buildSegmentGrid(net, cell);
    let nextId = maxNodeId(net) + 1;
    let bridgedThisPass = 0;
    for (const island of components.slice(1)) {
      let best: { islandId: number; ref: SegmentRef; distance: number } | null = null;
      for (const islandId of island.nodeIds) {
        const p = net.nodes.get(islandId);
        if (!p) continue;
        for (const key of neighbourKeys(p.x, p.z, cell)) {
          for (const ref of grid.get(key) ?? []) {
            const road = net.roads[ref.roadIndex];
            if (!main.nodeIds.has(road.nodeIds[0])) continue; // only bridge to main
            const a = net.nodes.get(road.nodeIds[ref.segIndex]);
            const b = net.nodes.get(road.nodeIds[ref.segIndex + 1]);
            if (!a || !b) continue;
            const hit = projectOnSegment(p, a, b);
            if (hit.distance <= bridgeDistance && (!best || hit.distance < best.distance)) {
              best = { islandId, ref, distance: hit.distance };
            }
          }
        }
      }
      if (!best) continue;
      // Fuse: insert (or reuse) a junction vertex on the main road at the
      // projection point, then merge the island node into it.
      const target = net.roads[best.ref.roadIndex];
      if (best.ref.segIndex >= target.nodeIds.length - 1) continue; // stale after earlier splice
      const aId = target.nodeIds[best.ref.segIndex];
      const bId = target.nodeIds[best.ref.segIndex + 1];
      const p = net.nodes.get(best.islandId)!;
      const hit = projectOnSegment(p, net.nodes.get(aId)!, net.nodes.get(bId)!);
      if (hit.distance > bridgeDistance) continue; // ref went stale after an earlier splice
      let junctionId: number;
      if (hit.t < 0.02) junctionId = aId;
      else if (hit.t > 0.98) junctionId = bId;
      else {
        junctionId = nextId++;
        net.nodes.set(junctionId, hit.point);
        target.nodeIds.splice(best.ref.segIndex + 1, 0, junctionId);
      }
      remapRoadNodes(net, new Map([[best.islandId, junctionId]]));
      bridgedThisPass++;
    }
    if (bridgedThisPass === 0) break;
    report.bridged += bridgedThisPass;
  }
  // Drop whatever is still disconnected.
  const components = connectedComponents(net);
  if (components.length > 1) {
    const keep = new Set(components[0].roadIndices);
    for (const island of components.slice(1)) {
      report.droppedIslands++;
      report.droppedKm += island.lengthM / 1000;
      for (const index of island.roadIndices.slice(0, 2)) {
        const name = net.roads[index].name;
        if (name && !report.droppedSamples.includes(name) && report.droppedSamples.length < 25) {
          report.droppedSamples.push(name);
        }
      }
    }
    net.roads = net.roads.filter((_, index) => keep.has(index));
    pruneOrphanNodes(net);
  }
  return report;
}

export function pruneOrphanNodes(net: RoadNetwork): void {
  const used = new Set<number>();
  for (const road of net.roads) for (const id of road.nodeIds) used.add(id);
  for (const id of [...net.nodes.keys()]) if (!used.has(id)) net.nodes.delete(id);
}

/** Junctions: nodes used by >= 2 roads, with the (deduped) names that meet there. */
export function findJunctions(net: RoadNetwork): Array<{ nodeId: number; roads: string[] }> {
  const roadsAtNode = new Map<number, Set<string>>();
  const roadCountAtNode = new Map<number, number>();
  for (const road of net.roads) {
    for (const id of new Set(road.nodeIds)) {
      let names = roadsAtNode.get(id);
      if (!names) roadsAtNode.set(id, (names = new Set()));
      names.add(road.name);
      roadCountAtNode.set(id, (roadCountAtNode.get(id) ?? 0) + 1);
    }
  }
  const junctions: Array<{ nodeId: number; roads: string[] }> = [];
  for (const [nodeId, count] of roadCountAtNode) {
    if (count >= 2) junctions.push({ nodeId, roads: [...roadsAtNode.get(nodeId)!].sort() });
  }
  return junctions;
}
