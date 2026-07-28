import { describe, expect, it } from 'vitest';
import { findPath, RoadClosures, roadClosures, RoutePlanner, type NavGraph } from './NavGraph';

/**
 * The runtime closure overlay. A blockade must be able to shut a road without anybody rewriting the
 * baked `edges` array — see the RoadClosures docblock for why an infinite toll is the wrong answer.
 *
 * The test grid is a 5×3 ladder: three parallel east-west lanes joined at every rung, so there is
 * always a way around and the detour is measurable.
 *
 *   0—1—2—3—4      (z = 0)
 *   | | | | |
 *   5—6—7—8—9      (z = 1)
 *   | | | | |
 *  10 11 12 13 14  (z = 2)
 */
function ladder(): NavGraph {
  const nodes = []; const edges: number[][] = [];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 5; column++) { nodes.push({ x: column, z: row }); edges.push([]); }
  const link = (a: number, b: number): void => { edges[a]!.push(b); edges[b]!.push(a); };
  for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) link(row * 5 + column, row * 5 + column + 1);
  for (let row = 0; row < 2; row++) for (let column = 0; column < 5; column++) link(row * 5 + column, (row + 1) * 5 + column);
  return { nodes, edges };
}

describe('RoadClosures', () => {
  it('starts inert and costs nothing', () => {
    const closures = new RoadClosures();
    expect(closures.active).toBe(false);
    expect(closures.tollAt(0, 0)).toBe(0);
    expect(closures.crosses([{ x: 0, z: 0 }])).toBe(false);
  });

  it('tolls only inside the circle, and stacks overlaps', () => {
    const closures = new RoadClosures();
    closures.open({ id: 'a', x: 0, z: 0, radius: 2, toll: 100 });
    closures.open({ id: 'b', x: 1, z: 0, radius: 2, toll: 50 });
    expect(closures.tollAt(0, 0)).toBe(150); // inside both
    expect(closures.tollAt(2.5, 0)).toBe(50); // inside b only
    expect(closures.tollAt(9, 9)).toBe(0);
  });

  it('replaces by id rather than accumulating duplicates', () => {
    const closures = new RoadClosures();
    closures.open({ id: 'a', x: 0, z: 0, radius: 2, toll: 100 });
    closures.open({ id: 'a', x: 0, z: 0, radius: 2, toll: 10 });
    expect(closures.count).toBe(1);
    expect(closures.tollAt(0, 0)).toBe(10);
  });

  it('rejects a degenerate closure instead of poisoning every solve', () => {
    const closures = new RoadClosures();
    closures.open({ id: 'a', x: 0, z: 0, radius: 0, toll: 100 });
    closures.open({ id: 'b', x: 0, z: 0, radius: 5, toll: Number.POSITIVE_INFINITY });
    expect(closures.active).toBe(false);
  });

  it('bumps a stamp on every change, which is how a driver mid-route notices', () => {
    const closures = new RoadClosures();
    const start = closures.stamp;
    closures.open({ id: 'a', x: 0, z: 0, radius: 2, toll: 5 });
    expect(closures.stamp).not.toBe(start);
    const opened = closures.stamp;
    closures.close('nope');
    expect(closures.stamp).toBe(opened); // closing something that was never open changes nothing
    closures.close('a');
    expect(closures.stamp).not.toBe(opened);
  });

  it('spots a closure on the not-yet-driven tail of an existing route only', () => {
    const closures = new RoadClosures();
    closures.open({ id: 'a', x: 4, z: 0, radius: 1, toll: 5 });
    const route = [{ x: 0, z: 0 }, { x: 2, z: 0 }, { x: 4, z: 0 }];
    expect(closures.crosses(route, 0)).toBe(true);
    expect(closures.crosses(route, 3)).toBe(false); // already past it
  });
});

describe('findPath with a closure', () => {
  const graph = ladder();

  it('takes the straight lane when nothing is closed', () => {
    const closures = new RoadClosures();
    expect(findPath(graph, 0, 4, undefined, undefined, closures)).toEqual([0, 1, 2, 3, 4]);
  });

  it('routes around a closed circle without the edges array being touched', () => {
    const before = JSON.stringify(graph.edges);
    const closures = new RoadClosures();
    closures.open({ id: 'blockade', x: 2, z: 0, radius: 0.6, toll: 500 });
    const path = findPath(graph, 0, 4, undefined, undefined, closures);
    expect(path).toBeDefined();
    expect(path).not.toContain(2); // node 2 sits inside the circle
    expect(path![0]).toBe(0); expect(path![path!.length - 1]).toBe(4);
    expect(JSON.stringify(graph.edges)).toBe(before); // the baked graph is untouched
  });

  it('still gets through when the ONLY way home is closed — a finite toll never strands a driver', () => {
    // A single corridor: 0—1—2, with 1 shut. There is no detour at all.
    const line: NavGraph = { nodes: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], edges: [[1], [0, 2], [1]] };
    const closures = new RoadClosures();
    closures.open({ id: 'blockade', x: 1, z: 0, radius: 0.5, toll: 900 });
    expect(findPath(line, 0, 2, undefined, undefined, closures)).toEqual([0, 1, 2]);
  });

  it('lifting the closure restores the straight lane', () => {
    const closures = new RoadClosures();
    closures.open({ id: 'blockade', x: 2, z: 0, radius: 0.6, toll: 500 });
    closures.close('blockade');
    expect(findPath(graph, 0, 4, undefined, undefined, closures)).toEqual([0, 1, 2, 3, 4]);
  });

  it('defaults to the shared overlay, so a system that closes a road reaches every planner at once', () => {
    roadClosures.clear();
    const planner = new RoutePlanner(graph, 8, () => 0);
    expect(planner.plan(0, 0, 4)?.map((point) => point.x)).toEqual([0, 1, 2, 3, 4]);
    roadClosures.open({ id: 'blockade', x: 2, z: 0, radius: 0.6, toll: 500 });
    const detour = planner.plan(0, 0, 4);
    expect(detour?.some((point) => point.x === 2 && point.z === 0)).toBe(false);
    roadClosures.clear();
    expect(planner.plan(0, 0, 4)?.map((point) => point.x)).toEqual([0, 1, 2, 3, 4]);
  });
});
