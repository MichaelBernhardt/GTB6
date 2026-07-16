import { describe, expect, it } from 'vitest';
import { resolveDeadEnds, type DeadEndOptions } from './deadends';
import { nodeDegrees, type RoadNetwork } from './graph';
import type { Pt, RoadKind } from './types';

const OPTIONS: DeadEndOptions = {
  joinDistance: 1000,
  connectDistance: 300,
  pruneLength: 450,
  pruneLengthMajor: 160,
  culDeSacNames: new Set(['Kaapstad Quay']),
};

/** Tiny network builder: roads as point lists; shared coordinates share a node id. */
function makeNet(roads: Array<{ name: string; kind?: RoadKind; points: Pt[] }>): RoadNetwork {
  const net: RoadNetwork = { nodes: new Map(), roads: [] };
  const idOf = new Map<string, number>();
  let nextId = 0;
  for (const road of roads) {
    const nodeIds = road.points.map((p) => {
      const key = `${p.x},${p.z}`;
      let id = idOf.get(key);
      if (id === undefined) { id = nextId++; idOf.set(key, id); net.nodes.set(id, { ...p }); }
      return id;
    });
    net.roads.push({ name: road.name, kind: road.kind ?? 'residential', width: 7, nodeIds });
  }
  return net;
}

function danglingCount(net: RoadNetwork): number {
  const degree = nodeDegrees(net);
  let count = 0;
  for (const road of net.roads) {
    for (const end of [road.nodeIds[0]!, road.nodeIds[road.nodeIds.length - 1]!]) {
      if ((degree.get(end) ?? 0) === 1) count++;
    }
  }
  return count;
}

describe('resolveDeadEnds', () => {
  it('joins two nearby dangling ends into a loop with an arc, named after the higher-ranked parent', () => {
    const net = makeNet([
      { name: 'Base', points: [{ x: 0, z: 0 }, { x: 1000, z: 0 }] },
      { name: 'West Leg', kind: 'secondary', points: [{ x: 0, z: 0 }, { x: 20, z: 500 }, { x: 60, z: 900 }] },
      { name: 'East Leg', points: [{ x: 1000, z: 0 }, { x: 980, z: 500 }, { x: 940, z: 900 }] },
    ]);
    const report = resolveDeadEnds(net, OPTIONS);
    expect(report.joined).toBe(1);
    expect(danglingCount(net)).toBe(0);
    const connector = net.roads[net.roads.length - 1]!;
    expect(connector.name).toBe('West Leg'); // secondary outranks residential
    expect(connector.kind).toBe('secondary');
    expect(connector.nodeIds.length).toBeGreaterThan(2); // an arc, not a ruler line
  });

  it('refuses to join when the arc would cross an existing road', () => {
    const net = makeNet([
      { name: 'Base', points: [{ x: 0, z: 0 }, { x: 1000, z: 0 }] },
      { name: 'West Leg', points: [{ x: 0, z: 0 }, { x: 20, z: 500 }, { x: 60, z: 900 }] },
      { name: 'East Leg', points: [{ x: 1000, z: 0 }, { x: 980, z: 500 }, { x: 940, z: 900 }] },
      // A wall between the two dangling ends: the join must be skipped, the ends then truncate.
      { name: 'Wall', points: [{ x: 500, z: 0 }, { x: 500, z: 2000 }] },
    ]);
    const report = resolveDeadEnds(net, OPTIONS);
    expect(report.joined).toBe(0);
  });

  it('ties a lone dangling end into a nearby road with a T-connector junction', () => {
    const net = makeNet([
      { name: 'Main', points: [{ x: 0, z: 0 }, { x: 2000, z: 0 }] },
      // Ends 200 m short of Main, pointing at it; anchored at a junction on a second road.
      { name: 'Spur', points: [{ x: 1000, z: 800 }, { x: 1000, z: 200 }] },
      { name: 'Anchor', points: [{ x: 500, z: 800 }, { x: 1000, z: 800 }, { x: 1500, z: 800 }] },
    ]);
    const spurEnd = net.roads.find((road) => road.name === 'Spur')!.nodeIds[1]!;
    const report = resolveDeadEnds(net, OPTIONS);
    expect(report.connected).toBe(1);
    expect(nodeDegrees(net).get(spurEnd) ?? 0).toBeGreaterThanOrEqual(2); // the spur end now ties into Main
    // Main gained a junction vertex where the connector tied in.
    const main = net.roads.find((road) => road.name === 'Main')!;
    expect(main.nodeIds.length).toBe(3);
  });

  it('truncates a short dangling tail back to the last junction, keeps long deliberate tails', () => {
    const net = makeNet([
      { name: 'Main', points: [{ x: 0, z: 0 }, { x: 2000, z: 0 }] },
      { name: 'Cross', points: [{ x: 1000, z: -500 }, { x: 1000, z: 0 }, { x: 1000, z: 500 }] },
      // Through road with a 300 m tail past its junction with Cross: tail goes, spine stays.
      { name: 'Tail', points: [{ x: 0, z: 500 }, { x: 1000, z: 500 }, { x: 1300, z: 500 }] },
    ]);
    // Give every road a far-end junction except the tails under test.
    net.roads.push({ name: 'Frame', kind: 'residential', width: 7, nodeIds: [net.roads[0]!.nodeIds[0]!, net.roads[1]!.nodeIds[0]!, net.roads[2]!.nodeIds[0]!] });
    const before = net.roads.find((road) => road.name === 'Tail')!.nodeIds.length;
    const report = resolveDeadEnds(net, { ...OPTIONS, joinDistance: 0, connectDistance: 0 });
    expect(before).toBe(3);
    expect(report.truncated).toBeGreaterThanOrEqual(1);
    const tail = net.roads.find((road) => road.name === 'Tail')!;
    expect(tail.nodeIds.length).toBe(2); // (0,500)-(1000,500) survives; the 300 m stub is gone
  });

  it('leaves protected cul-de-sacs alone', () => {
    const net = makeNet([
      { name: 'Main', points: [{ x: 0, z: 0 }, { x: 2000, z: 0 }] },
      { name: 'Kaapstad Quay', points: [{ x: 1000, z: 0 }, { x: 1000, z: 300 }] },
    ]);
    const report = resolveDeadEnds(net, { ...OPTIONS, joinDistance: 0, connectDistance: 0 });
    expect(report.truncated).toBe(0);
    expect(net.roads.some((road) => road.name === 'Kaapstad Quay')).toBe(true);
    expect(report.remaining).toBe(2); // Main's own free ends — the quay is excluded from the census
  });
});
