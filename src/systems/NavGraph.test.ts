import { describe, expect, it } from 'vitest';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN } from '../world/City';
import { bridgeIslands, buildNavGraph, components, findPath, nearestNode, ProgressWatchdog, replanInterval, RoutePlanner, STUCK_EPSILON, STUCK_TIMEOUT, type NavGraph } from './NavGraph';

const line = (count: number, spacing: number, x0 = 0, z0 = 0): { x: number; z: number }[] =>
  Array.from({ length: count }, (_, index) => ({ x: x0 + index * spacing, z: z0 }));

describe('buildNavGraph', () => {
  it('links consecutive points along a path and wraps closed loops', () => {
    const open = buildNavGraph([{ points: line(4, 10) }], 5);
    expect(open.nodes).toHaveLength(4);
    expect(open.edges[0]).toEqual([1]);
    expect(open.edges[1]).toEqual(expect.arrayContaining([0, 2]));
    expect(open.edges[3]).toEqual([2]);
    const loop = buildNavGraph([{ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], closed: true }], 5);
    expect(loop.edges[0]).toEqual(expect.arrayContaining([1, 3]));
  });

  it('joins nodes of different paths within the join radius but never beyond it', () => {
    const graph = buildNavGraph([{ points: line(3, 10) }, { points: line(3, 10, 0, 8) }, { points: line(3, 10, 0, 100) }], 9);
    expect(graph.edges[0]).toEqual(expect.arrayContaining([3]));
    expect(graph.edges[0]).not.toEqual(expect.arrayContaining([6]));
    expect(components(graph)).toHaveLength(2);
  });

  it('does not shortcut across non-consecutive points of the same path', () => {
    const hairpin = buildNavGraph([{ points: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 4 }, { x: 0, z: 4 }] }], 6);
    expect(hairpin.edges[0]).toEqual([1]);
  });
});

describe('findPath (A*)', () => {
  const graph = buildNavGraph([{ points: line(6, 10) }], 5);

  it('returns the start node when start equals goal', () => {
    expect(findPath(graph, 2, 2)).toEqual([2]);
  });

  it('finds the shortest node sequence along a line', () => {
    expect(findPath(graph, 0, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(findPath(graph, 4, 1)).toEqual([4, 3, 2, 1]);
  });

  it('prefers the geometrically shorter of two branches', () => {
    // Two routes 0..3: direct detour path (long) versus a second path joined at both ends (short).
    const forked: NavGraph = {
      nodes: [{ x: 0, z: 0 }, { x: 50, z: 80 }, { x: 100, z: 80 }, { x: 150, z: 0 }, { x: 50, z: 0 }, { x: 100, z: 0 }],
      edges: [[1, 4], [0, 2], [1, 3], [2, 5], [0, 5], [3, 4]],
    };
    expect(findPath(forked, 0, 3)).toEqual([0, 4, 5, 3]);
  });

  it('returns undefined for unreachable or invalid nodes', () => {
    const islands = buildNavGraph([{ points: line(3, 10) }, { points: line(3, 10, 0, 500) }], 5);
    expect(findPath(islands, 0, 5)).toBeUndefined();
    expect(findPath(islands, -1, 2)).toBeUndefined();
    expect(findPath(islands, 0, 99)).toBeUndefined();
  });
});

describe('city nav graphs', () => {
  const { lanes, walks } = buildCityNavPaths(ROAD_NETWORK);
  const vehicleNav = bridgeIslands(buildNavGraph(lanes, VEHICLE_NAV_JOIN));
  const pedNav = bridgeIslands(buildNavGraph(walks, PED_NAV_JOIN));

  it('builds one lane pair and one sidewalk pair per road', () => {
    expect(lanes).toHaveLength(ROAD_NETWORK.length * 2);
    expect(walks).toHaveLength(ROAD_NETWORK.length * 2);
  });

  it('produces graphs with hundreds of nodes and edges everywhere', () => {
    expect(vehicleNav.nodes.length).toBeGreaterThan(300);
    expect(pedNav.nodes.length).toBeGreaterThan(200);
    expect(vehicleNav.edges.every((neighbors) => neighbors.length > 0)).toBe(true);
    expect(pedNav.edges.every((neighbors) => neighbors.length > 0)).toBe(true);
  });

  it('is fully connected after bridging (the generated network is one component by construction)', () => {
    // The pipeline guarantees one road component; proximity joins may still leave a couple of
    // offset-lane islands, and bridging must always finish the job.
    const rawComponents = components(buildNavGraph(lanes, VEHICLE_NAV_JOIN));
    expect(rawComponents.length).toBeLessThanOrEqual(4);
    expect(rawComponents[0]!.length).toBeGreaterThan(vehicleNav.nodes.length * 0.98); // main component holds ~everything
    expect(components(vehicleNav)).toHaveLength(1);
    expect(components(pedNav)).toHaveLength(1);
  });

  it('routes across the whole city between distant nodes', () => {
    const start = nearestNode(vehicleNav, -330, 240);
    const goal = nearestNode(vehicleNav, 300, -260);
    const path = findPath(vehicleNav, start, goal);
    expect(path).toBeDefined();
    expect(path!.length).toBeGreaterThan(20);
    expect(path![0]).toBe(start);
    expect(path![path!.length - 1]).toBe(goal);
  });
});

describe('replanInterval', () => {
  it('stays within [1.5, 2) and staggers different units', () => {
    const intervals = Array.from({ length: 8 }, (_, serial) => replanInterval(serial));
    for (const interval of intervals) { expect(interval).toBeGreaterThanOrEqual(1.5); expect(interval).toBeLessThan(2); }
    expect(new Set(intervals.map((interval) => interval.toFixed(3))).size).toBe(8);
  });
});

describe('ProgressWatchdog', () => {
  it('fires only after STUCK_TIMEOUT seconds without STUCK_EPSILON of progress', () => {
    expect(STUCK_TIMEOUT).toBe(10);
    expect(STUCK_EPSILON).toBe(3);
    const watchdog = new ProgressWatchdog();
    expect(watchdog.update(50, 1)).toBe(false); // baseline
    expect(watchdog.update(48, 8)).toBe(false); // 2u closer: below epsilon, stall accrues
    expect(watchdog.update(49, 1.5)).toBe(false); // 9.5s stalled
    expect(watchdog.update(48, 0.6)).toBe(true); // 10.1s: stuck
  });

  it('clears the stall on meaningful progress and on reset()', () => {
    const watchdog = new ProgressWatchdog();
    watchdog.update(50, 1); watchdog.update(50, 8);
    expect(watchdog.update(46, 5)).toBe(false); // beat the best approach by >epsilon: stall cleared
    expect(watchdog.update(46, 9.9)).toBe(false);
    expect(watchdog.update(46, 0.2)).toBe(true);
    watchdog.reset();
    expect(watchdog.update(46, 9.9)).toBe(false); // fresh baseline after reset (waypoint advance, thaw, replan)
  });
});

describe('RoutePlanner budget', () => {
  it('caps budgeted solves per frame and resets on beginFrame', () => {
    const graph = buildNavGraph([{ points: line(10, 10) }], 5);
    const planner = new RoutePlanner(graph, 2, () => 0.99);
    expect(planner.tryPlan(0, 0)).toBeUndefined(); // no frame started yet
    planner.beginFrame();
    expect(planner.tryPlan(0, 0)).toBeDefined();
    expect(planner.tryPlan(0, 0)).toBeDefined();
    expect(planner.tryPlan(0, 0)).toBeUndefined(); // budget spent
    planner.beginFrame();
    expect(planner.tryPlan(0, 0)).toBeDefined();
    expect(planner.plan(0, 0)).toBeDefined(); // unbudgeted spawn-time solves always run
  });

  it('returns waypoints from the current position to the goal node', () => {
    const graph = buildNavGraph([{ points: line(10, 10) }], 5);
    const planner = new RoutePlanner(graph, 2);
    const points = planner.plan(1, 0, 9);
    expect(points?.[0]).toEqual({ x: 0, z: 0 });
    expect(points?.at(-1)).toEqual({ x: 90, z: 0 });
  });
});

describe('RoutePlanner.planTo (road-preferring offroad targets)', () => {
  const graph = buildNavGraph([{ points: line(10, 10) }], 5); // straight road, nodes x = 0..90
  const planner = new RoutePlanner(graph, 2);

  it('rides the graph to the node nearest the target, then appends the exact target as the offroad leg', () => {
    const points = planner.planTo(2, 0, 88, 30)!; // target 30u off the road, far end
    expect(points.at(-1)).toEqual({ x: 88, z: 30 }); // exact target, not a node
    expect(points.at(-2)).toEqual({ x: 90, z: 0 }); // nearest node to the target: road taken all the way
    expect(points.length).toBeGreaterThan(5); // full road traverse, no diagonal beeline across the map
    for (const point of points.slice(0, -1)) expect(graph.nodes).toContainEqual(point); // everything but the last leg stays on the graph
  });

  it('skips the offroad leg when the target already sits on a node', () => {
    const points = planner.planTo(0, 0, 90, 0)!;
    expect(points.at(-1)).toEqual({ x: 90, z: 0 });
    expect(points.at(-2)).toEqual({ x: 80, z: 0 });
  });

  it('shares the per-frame budget through tryPlanTo', () => {
    const budgeted = new RoutePlanner(graph, 1);
    expect(budgeted.tryPlanTo(0, 0, 88, 30)).toBeUndefined(); // no frame started
    budgeted.beginFrame();
    expect(budgeted.tryPlanTo(0, 0, 88, 30)).toBeDefined();
    expect(budgeted.tryPlanTo(0, 0, 88, 30)).toBeUndefined(); // budget spent
  });
});
