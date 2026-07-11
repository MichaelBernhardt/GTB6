import { describe, expect, it } from 'vitest';
import { connectedComponents, nodeDegrees, type RoadNetwork } from './graph';
import { buildOrbitalRing, pruneShortStubs, thinParallelRoads } from './thin';
import type { Pt, RoadKind } from './types';

/** Grid-net builder: E-W streets every `pitch` metres crossed by N-S avenues at both ends and middle. */
function gridNet(rows: number, pitch: number, length: number): RoadNetwork {
  const nodes = new Map<number, Pt>();
  const roads: RoadNetwork['roads'] = [];
  let id = 0;
  const columns = [0, length / 2, length];
  const rowNodeIds: number[][] = [];
  for (let row = 0; row < rows; row++) {
    const ids = columns.map((x) => { nodes.set(id, { x, z: row * pitch }); return id++; });
    rowNodeIds.push(ids);
    roads.push({ name: `Street ${row}`, kind: 'residential' as RoadKind, width: 7, nodeIds: ids });
  }
  for (let column = 0; column < columns.length; column++) {
    const ids = rowNodeIds.map((row) => row[column]);
    roads.push({ name: `Avenue ${column}`, kind: 'primary' as RoadKind, width: 14, nodeIds: ids });
  }
  return { nodes, roads };
}

const thinOptions = {
  coverageDistance: 55,
  coverageFraction: 0.62,
  sampleStep: 20,
  parallelCos: 0.8,
  maxRank: 3,
  protectedNames: new Set<string>(),
};

describe('thinParallelRoads', () => {
  it('decimates a dense parallel grid to a wider pitch while keeping the majors', () => {
    const net = gridNet(7, 40, 400); // 40 m pitch: far too dense for game scale
    const report = thinParallelRoads(net, thinOptions);
    expect(report.dropped).toBeGreaterThanOrEqual(2);
    const names = new Set(net.roads.map((road) => road.name));
    expect(names.has('Avenue 0') && names.has('Avenue 1') && names.has('Avenue 2')).toBe(true); // primaries never drop
    expect(net.roads.filter((road) => road.kind === 'residential').length).toBeLessThan(7);
    expect(connectedComponents(net)).toHaveLength(1); // the degree guard keeps the grid connected
  });

  it('never drops protected (parody/anchor) street names', () => {
    const net = gridNet(7, 40, 400);
    const protectedNames = new Set(['Street 2', 'Street 3', 'Street 4']);
    thinParallelRoads(net, { ...thinOptions, protectedNames });
    const names = new Set(net.roads.map((road) => road.name));
    for (const name of protectedNames) expect(names.has(name), name).toBe(true);
  });

  it('keeps well-spaced streets alone', () => {
    const net = gridNet(4, 200, 400); // 200 m pitch: healthy suburban spacing
    const report = thinParallelRoads(net, thinOptions);
    expect(report.dropped).toBe(0);
  });
});

describe('pruneShortStubs', () => {
  it('removes short dangling spurs but keeps long dead-end streets', () => {
    const net = gridNet(3, 200, 400);
    let id = 1000;
    const anchor = net.roads[0]!.nodeIds[1]!; // mid-node of Street 0
    net.nodes.set(id, { x: 210, z: 30 });
    net.roads.push({ name: 'Stubby', kind: 'residential' as RoadKind, width: 7, nodeIds: [anchor, id++] });
    net.nodes.set(id, { x: 210, z: 350 });
    net.roads.push({ name: 'Long Close', kind: 'residential' as RoadKind, width: 7, nodeIds: [anchor, id++] });
    const pruned = pruneShortStubs(net, 80, new Set());
    expect(pruned).toBe(1);
    const names = new Set(net.roads.map((road) => road.name));
    expect(names.has('Stubby')).toBe(false);
    expect(names.has('Long Close')).toBe(true);
  });
});

describe('buildOrbitalRing', () => {
  it('joins boundary stubs into one closed orbital with no dead ends at the edge', () => {
    // Four roads leaving the area, plus one deep-interior cul-de-sac that must NOT join the ring.
    const nodes = new Map<number, Pt>([
      [0, { x: 0, z: 400 }], [1, { x: 1000, z: 400 }],
      [2, { x: 0, z: 800 }], [3, { x: 1000, z: 800 }],
      [4, { x: 500, z: 600 }], [5, { x: 500, z: 590 }],
    ]);
    const net: RoadNetwork = {
      nodes,
      roads: [
        { name: 'West Out', kind: 'primary' as RoadKind, width: 14, nodeIds: [4, 0] },
        { name: 'East Out', kind: 'primary' as RoadKind, width: 14, nodeIds: [4, 1] },
        { name: 'North West Out', kind: 'secondary' as RoadKind, width: 11, nodeIds: [4, 2] },
        { name: 'North East Out', kind: 'secondary' as RoadKind, width: 11, nodeIds: [4, 3] },
        { name: 'Interior Close', kind: 'residential' as RoadKind, width: 7, nodeIds: [4, 5] },
      ],
    };
    const report = buildOrbitalRing(net, { boundaryMargin: 120, ringOffset: 100, cornerChamfer: 40, name: 'Test Orbital', kind: 'trunk', width: 18 });
    expect(report.built).toBe(true);
    expect(report.stubs).toBe(4);
    expect(net.roads.filter((road) => road.name === 'Test Orbital').length).toBeGreaterThanOrEqual(5); // ring + 4 spurs
    expect(connectedComponents(net)).toHaveLength(1);
    // No degree-1 endpoints near the (expanded) bounds any more.
    const degree = nodeDegrees(net);
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const point of net.nodes.values()) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z); }
    for (const road of net.roads) {
      for (const end of [road.nodeIds[0]!, road.nodeIds[road.nodeIds.length - 1]!]) {
        if ((degree.get(end) ?? 0) > 1) continue;
        const point = net.nodes.get(end)!;
        const edge = Math.min(point.x - minX, maxX - point.x, point.z - minZ, maxZ - point.z);
        expect(edge, road.name).toBeGreaterThan(150);
      }
    }
  });

  it('does nothing when there are no boundary stubs', () => {
    const net = gridNet(3, 200, 400);
    // A closed grid: every endpoint is a junction (degree >= 2), so nothing qualifies.
    const report = buildOrbitalRing(net, { boundaryMargin: 50, ringOffset: 100, cornerChamfer: 40, name: 'Test Orbital', kind: 'trunk', width: 18 });
    expect(report.built).toBe(false);
  });
});
