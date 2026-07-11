import { describe, expect, it } from 'vitest';
import {
  bridgeIslands,
  connectedComponents,
  findJunctions,
  snapEndpointsToSegments,
  snapNodes,
  type RoadNetwork,
} from './graph';
import type { Pt } from './types';

function net(nodes: Record<number, Pt>, roads: Array<{ name: string; nodeIds: number[] }>): RoadNetwork {
  return {
    nodes: new Map(Object.entries(nodes).map(([id, p]) => [Number(id), p])),
    roads: roads.map((r) => ({ name: r.name, kind: 'primary' as const, width: 24, nodeIds: r.nodeIds })),
  };
}

describe('snapNodes', () => {
  it('merges endpoints within the snap distance into one shared node', () => {
    const network = net(
      { 1: { x: 0, z: 0 }, 2: { x: 100, z: 0 }, 3: { x: 105, z: 0 }, 4: { x: 200, z: 0 } },
      [{ name: 'A', nodeIds: [1, 2] }, { name: 'B', nodeIds: [3, 4] }],
    );
    const merged = snapNodes(network, 12);
    expect(merged).toBe(1);
    const endA = network.roads[0].nodeIds[1];
    const endB = network.roads[1].nodeIds[0];
    expect(endA).toBe(endB);
    expect(network.nodes.get(endA)!.x).toBeCloseTo(102.5); // centroid
    expect(connectedComponents(network)).toHaveLength(1);
  });

  it('does not merge nodes farther apart than the snap distance', () => {
    const network = net(
      { 1: { x: 0, z: 0 }, 2: { x: 100, z: 0 }, 3: { x: 120, z: 0 }, 4: { x: 200, z: 0 } },
      [{ name: 'A', nodeIds: [1, 2] }, { name: 'B', nodeIds: [3, 4] }],
    );
    expect(snapNodes(network, 12)).toBe(0);
    expect(connectedComponents(network)).toHaveLength(2);
  });
});

describe('snapEndpointsToSegments', () => {
  it('repairs a near-miss T-junction by inserting a vertex into the crossing road', () => {
    // Road B ends 5 m short of road A's midsection.
    const network = net(
      { 1: { x: 0, z: 0 }, 2: { x: 200, z: 0 }, 3: { x: 100, z: 5 }, 4: { x: 100, z: 150 } },
      [{ name: 'A', nodeIds: [1, 2] }, { name: 'B', nodeIds: [3, 4] }],
    );
    const snaps = snapEndpointsToSegments(network, 12);
    expect(snaps).toBe(1);
    expect(network.roads[0].nodeIds).toHaveLength(3); // vertex inserted into A
    expect(connectedComponents(network)).toHaveLength(1);
    const junction = network.roads[1].nodeIds[0];
    expect(network.roads[0].nodeIds).toContain(junction);
    expect(network.nodes.get(junction)!.z).toBeCloseTo(0);
  });

  it('leaves already-connected endpoints alone', () => {
    const network = net(
      { 1: { x: 0, z: 0 }, 2: { x: 100, z: 0 }, 3: { x: 100, z: 100 } },
      [{ name: 'A', nodeIds: [1, 2] }, { name: 'B', nodeIds: [2, 3] }],
    );
    expect(snapEndpointsToSegments(network, 12)).toBe(0);
  });
});

describe('bridgeIslands', () => {
  it('bridges an island within reach and produces ONE component', () => {
    const network = net(
      {
        1: { x: 0, z: 0 }, 2: { x: 1000, z: 0 }, 3: { x: 2000, z: 0 }, // main (2 km)
        10: { x: 500, z: 40 }, 11: { x: 500, z: 300 }, // island 40 m off the main road
      },
      [{ name: 'Main', nodeIds: [1, 2, 3] }, { name: 'Island', nodeIds: [10, 11] }],
    );
    const report = bridgeIslands(network, 60);
    expect(report.bridged).toBe(1);
    expect(report.droppedIslands).toBe(0);
    expect(connectedComponents(network)).toHaveLength(1);
  });

  it('drops unreachable islands and reports them', () => {
    const network = net(
      {
        1: { x: 0, z: 0 }, 2: { x: 1000, z: 0 },
        10: { x: 500, z: 5000 }, 11: { x: 600, z: 5000 }, // 5 km away
      },
      [{ name: 'Main', nodeIds: [1, 2] }, { name: 'Far Island Rd', nodeIds: [10, 11] }],
    );
    const report = bridgeIslands(network, 60);
    expect(report.droppedIslands).toBe(1);
    expect(report.droppedKm).toBeCloseTo(0.1);
    expect(report.droppedSamples).toContain('Far Island Rd');
    expect(network.roads.map((r) => r.name)).toEqual(['Main']);
    expect(connectedComponents(network)).toHaveLength(1);
  });

  it('keeps the LARGEST component as main', () => {
    const network = net(
      {
        1: { x: 0, z: 0 }, 2: { x: 100, z: 0 }, // short island
        10: { x: 0, z: 9000 }, 11: { x: 3000, z: 9000 }, 12: { x: 6000, z: 9000 }, // long main
      },
      [{ name: 'Shorty', nodeIds: [1, 2] }, { name: 'Longhaul', nodeIds: [10, 11, 12] }],
    );
    bridgeIslands(network, 60);
    expect(network.roads.map((r) => r.name)).toEqual(['Longhaul']);
  });
});

describe('findJunctions', () => {
  it('reports nodes shared by two or more roads with their names', () => {
    const network = net(
      { 1: { x: 0, z: 0 }, 2: { x: 100, z: 0 }, 3: { x: 100, z: 100 }, 4: { x: 200, z: 0 } },
      [{ name: 'Bree Street', nodeIds: [1, 2] }, { name: 'Jan Smuts Avenue', nodeIds: [2, 3] }, { name: 'Loose End', nodeIds: [4, 3] }],
    );
    const junctions = findJunctions(network);
    expect(junctions).toHaveLength(2);
    const at2 = junctions.find((j) => j.nodeId === 2)!;
    expect(at2.roads).toEqual(['Bree Street', 'Jan Smuts Avenue']);
  });
});
