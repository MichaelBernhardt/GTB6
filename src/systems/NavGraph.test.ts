import { describe, expect, it } from 'vitest';
import { buildCityNavPaths, buildVehicleNav, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN } from '../world/City';
import { MAP_WORLD_SIZE } from '../world/mapData';
import { bridgeIslands, buildNavGraph, components, findPath, nearestNode, ProgressWatchdog, replanInterval, RoutePlanner, STUCK_EPSILON, STUCK_TIMEOUT, stronglyConnectedComponents, weakComponents, type NavGraph } from './NavGraph';

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

  it('exposes a forward tangent per node in the polyline travel direction', () => {
    const g = buildNavGraph([{ points: line(3, 10) }], 5); // along +x
    expect(g.tangents[0]).toEqual({ x: 1, z: 0 });
    expect(g.tangents[2]).toEqual({ x: 1, z: 0 });
  });

  it('directed mode makes along-lane links one-way', () => {
    const g = buildNavGraph([{ points: line(4, 10) }], 5, { directed: true });
    expect(g.edges[0]).toEqual([1]); // forward only
    expect(g.edges[1]).toEqual([2]); // NOT [0, 2] — no back-edge to 0
    expect(g.edges[3]).toEqual([]); // terminus is a sink until a cross/U-turn link is added
  });

  it('directed cross-links are gated per direction by the crossLink predicate', () => {
    // Lane A (nodes 0,1) runs +x at z=0; lane B (nodes 2,3) runs +x at z=2, offset ahead. A's tip (node 1)
    // and B's head (node 2) are 2.83u apart — within radius. The gate accepts a link only when the target
    // sits ahead of the source's own flow, so 1→2 (ahead) is added but 2→1 (behind B's flow) is not.
    const ahead = (from: number, to: number, nodes: { x: number; z: number }[], tangents: { x: number; z: number }[]): boolean => {
      const a = nodes[from]!; const b = nodes[to]!; const t = tangents[from]!;
      const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
      return t.x * dx / len + t.z * dz / len > 0.3;
    };
    const g = buildNavGraph([{ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }] }, { points: [{ x: 12, z: 2 }, { x: 22, z: 2 }] }], 5, { directed: true, crossLink: ahead });
    expect(g.edges[1]).toContain(2); // A→B accepted (B is ahead of A's flow)
    expect(g.edges[2] ?? []).not.toContain(1); // B→A rejected (A is behind B's flow)
  });
});

describe('weakComponents / stronglyConnectedComponents', () => {
  it('weakComponents fuses nodes joined by a one-way edge that an out-edge flood would split', () => {
    // Node 1 → 0 only. Following out-edges, 0 (a sink) and 1 never merge, so components() sees three
    // islands; weakComponents treats the 1→0 edge as bidirectional and fuses {0,1}.
    const graph: NavGraph = { nodes: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 5, z: 0 }], edges: [[], [0], []] };
    expect(weakComponents(graph)).toHaveLength(2); // {0,1}, {2}
    expect(components(graph)).toHaveLength(3); // {0}, {1}, {2}
  });

  it('SCC separates a source lane from a sink lane', () => {
    // 0→1→0 is a cycle (one SCC); 2 only receives, never returns → its own SCC.
    const graph: NavGraph = { nodes: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }], edges: [[1], [0, 2], []] };
    const scc = stronglyConnectedComponents(graph);
    expect(scc[0]).toHaveLength(2); // {0,1}
    expect(scc).toHaveLength(2);
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
    // Probe coords scale with the footprint so the two nodes stay genuinely cross-city at 36000u.
    const s = MAP_WORLD_SIZE / 6000;
    const start = nearestNode(vehicleNav, -330 * s, 240 * s);
    const goal = nearestNode(vehicleNav, 300 * s, -260 * s);
    const path = findPath(vehicleNav, start, goal);
    expect(path).toBeDefined();
    expect(path!.length).toBeGreaterThan(20);
    expect(path![0]).toBe(start);
    expect(path![path!.length - 1]).toBe(goal);
  });
});

describe('directed vehicle nav (buildVehicleNav)', () => {
  const vehicleNav = buildVehicleNav(ROAD_NETWORK);

  it('leaves no dead-end sink (every node keeps an out-edge via lane flow or terminus U-turn)', () => {
    expect(vehicleNav.nodes.length).toBeGreaterThan(300);
    expect(vehicleNav.edges.every((neighbors) => neighbors.length > 0)).toBe(true);
  });

  it('is one weakly-connected island and almost entirely one strongly-connected drivable component', () => {
    expect(weakComponents(vehicleNav)).toHaveLength(1); // every lane reachable after bridging
    const scc = stronglyConnectedComponents(vehicleNav);
    expect(scc[0]!.length / vehicleNav.nodes.length).toBeGreaterThan(0.99); // ~all nodes mutually reachable; strays are watchdog-rehomed
  });

  it('routes across the whole city on one-way lanes', () => {
    const s = MAP_WORLD_SIZE / 6000;
    const start = nearestNode(vehicleNav, -330 * s, 240 * s);
    const goal = nearestNode(vehicleNav, 300 * s, -260 * s);
    const path = findPath(vehicleNav, start, goal);
    expect(path).toBeDefined();
    expect(path![0]).toBe(start);
    expect(path![path!.length - 1]).toBe(goal);
  });

  it('keeps to the left of travel (South-African handedness invariant)', () => {
    // A straight road heading +Z. With +Y up, the left of +Z travel is +X (left = up × forward). Lane A is
    // authored at offset -0.23W, which must land on that +X side and advance +Z — pins the sign so a future
    // offsetRoadPath flip is caught here rather than in-game.
    const { lanes } = buildCityNavPaths([{ name: 'probe', width: 10, points: [{ x: 0, z: 0 }, { x: 0, z: 200 }] }]);
    const laneA = lanes[0]!;
    expect(laneA.points[0]!.x).toBeGreaterThan(0); // +X = left of +Z travel
    expect(laneA.points[1]!.z).toBeGreaterThan(laneA.points[0]!.z); // travels forward, +Z
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

describe('RoutePlanner solve accounting (perf HUD)', () => {
  it('counts real A* solves and accumulates their wall-time', () => {
    const graph = buildNavGraph([{ points: line(10, 10) }], 5);
    const planner = new RoutePlanner(graph, 5);
    expect(planner.solves).toBe(0);
    expect(planner.solveMs).toBe(0);
    planner.plan(0, 0, 9);
    planner.plan(0, 0, 5);
    expect(planner.solves).toBe(2); // two genuine findPath runs
    expect(planner.solveMs).toBeGreaterThanOrEqual(0);
  });

  it('does not count a call that never reaches A* (empty graph, no goal node)', () => {
    const planner = new RoutePlanner({ nodes: [], edges: [] }, 5);
    expect(planner.plan(0, 0)).toBeUndefined(); // randomGoal() = -1 on an empty graph → short-circuits before findPath
    expect(planner.solves).toBe(0);
    expect(planner.solveMs).toBe(0);
  });
});

describe('RoutePlanner.goalNear (local goals)', () => {
  it('returns a node near the query point, never the far end of a long road', () => {
    const graph = buildNavGraph([{ points: line(300, 40) }], 5); // a 12000u road, nodes x = 0..11960
    const planner = new RoutePlanner(graph, 2, () => 0.5);
    const node = planner.node(planner.goalNear(100, 0))!;
    expect(node).toBeDefined();
    expect(Math.abs(node.x - 100)).toBeLessThan(1600); // within the local search box (~1200u + a cell), never the 12000u far end
  });

  it('falls back to a citywide node only when nothing sits nearby', () => {
    const graph = buildNavGraph([{ points: line(5, 20) }], 5); // a tiny cluster near the origin
    const planner = new RoutePlanner(graph, 2, () => 0);
    expect(planner.goalNear(50_000, 50_000)).toBeGreaterThanOrEqual(0); // miles away → still yields a valid goal
  });

  it('biases the goal into a cone toward a supplied point (player-ward traffic)', () => {
    const graph: NavGraph = { nodes: [{ x: 300, z: 0 }, { x: -300, z: 0 }, { x: 0, z: 300 }, { x: 0, z: -300 }], edges: [[], [], [], []] };
    const planner = new RoutePlanner(graph, 2, () => 0);
    // player far along +x: only the +x node is inside the ~70° cone, so it must be chosen despite the others being equally near
    expect(planner.goalNear(0, 0, { x: 5000, z: 0 })).toBe(0);
    // no bias: any local node is fair game (first gathered candidate under random()=0)
    expect([0, 1, 2, 3]).toContain(planner.goalNear(0, 0));
    // player essentially on top of the car (< GOAL_BIAS_MIN): bias is skipped, no convergence on him
    expect([0, 1, 2, 3]).toContain(planner.goalNear(0, 0, { x: 40, z: 0 }));
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

describe('cross-city scripted routes (planFar)', () => {
  // The per-frame cap (4000 settled nodes) exists for traffic replans; scripted mission routes
  // legitimately cross the city and must use the citywide cap — the QA harness caught Zoo Lake →
  // Wemmer and CBD → Kelvin Yard reported unreachable through plan().
  it('routes between far mission anchors that the frame-capped plan() gives up on', async () => {
    const { CANDICE_START, TERMINAL_SPOT, KELVIN_GATE_SPOT, VUSI_START } = await import('../world/placements');
    const planner = new RoutePlanner(buildVehicleNav(), 2);
    for (const [from, to] of [[CANDICE_START, TERMINAL_SPOT], [VUSI_START, KELVIN_GATE_SPOT]] as const) {
      const far = planner.planFar(from.x, from.z, to.x, to.z);
      expect(far?.length ?? 0, `route ${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toBeGreaterThan(2);
    }
  });
});
