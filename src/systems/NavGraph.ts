export interface NavPoint { x: number; z: number; }
export interface NavPath { points: NavPoint[]; closed?: boolean; }
export interface NavGraph { nodes: NavPoint[]; edges: number[][]; }

/** Per-direction gate for a junction cross-link A→B. Given the two node indices, the node table and the
 *  per-node forward tangents (unit travel direction along each node's own polyline), return whether the
 *  directed edge A→B should exist. Used by the vehicle graph to keep only legal, on-tar turns. */
export type CrossLinkGate = (from: number, to: number, nodes: NavPoint[], tangents: NavPoint[]) => boolean;
export interface NavBuildOptions {
  /** One-way lanes: consecutive polyline points link forward only (both physical directions are still
   *  covered because each road contributes a forward lane and a reversed one). Default false → symmetric. */
  directed?: boolean;
  /** When present, each within-radius cross-path pair is offered to the gate in BOTH directions and only
   *  accepted directions are added (one-way turn links). Absent → today's symmetric cross-link (ped graph). */
  crossLink?: CrossLinkGate;
}

const GOLDEN = 0.618034;

/** Builds a nav graph from polylines: consecutive points become edges, and nodes on different polylines
 *  within joinRadius are linked so crossing roads form junction connections. Undirected by default; in
 *  `directed` mode along-lane edges are one-way and junction cross-links are gated per-direction by
 *  `crossLink` (see NavBuildOptions). Also returns each node's forward tangent for gate use. */
export function buildNavGraph(paths: NavPath[], joinRadius: number, opts: NavBuildOptions = {}): NavGraph & { tangents: NavPoint[] } {
  const { directed = false, crossLink } = opts;
  const nodes: NavPoint[] = []; const edges: number[][] = []; const pathOf: number[] = []; const tangents: NavPoint[] = [];
  const linkForward = (a: number, b: number): void => {
    const neighbors = edges[a]; if (a === b || !neighbors || neighbors.includes(b)) return;
    neighbors.push(b);
  };
  const linkBoth = (a: number, b: number): void => { linkForward(a, b); linkForward(b, a); };
  const linkAlong = directed ? linkForward : linkBoth;
  paths.forEach((path, pathIndex) => {
    const base = nodes.length; const pts = path.points; const count = pts.length;
    for (const point of pts) { nodes.push({ x: point.x, z: point.z }); edges.push([]); pathOf.push(pathIndex); }
    for (let index = 1; index < count; index++) linkAlong(base + index - 1, base + index);
    if (path.closed && count > 2) linkAlong(base + count - 1, base);
    for (let index = 0; index < count; index++) { // forward tangent in the polyline's own order (the node's travel direction)
      const prev = pts[index - 1] ?? (path.closed ? pts[count - 1] : undefined);
      const next = pts[index + 1] ?? (path.closed ? pts[0] : undefined);
      const from = prev ?? pts[index]!; const to = next ?? pts[index]!;
      const dx = to.x - from.x; const dz = to.z - from.z; const length = Math.hypot(dx, dz) || 1;
      tangents[base + index] = { x: dx / length, z: dz / length };
    }
  });
  const cell = Math.max(1, joinRadius); const grid = new Map<string, number[]>();
  nodes.forEach((node, index) => {
    const key = `${Math.floor(node.x / cell)},${Math.floor(node.z / cell)}`;
    const bucket = grid.get(key); if (bucket) bucket.push(index); else grid.set(key, [index]);
  });
  const radiusSq = joinRadius * joinRadius;
  nodes.forEach((node, index) => {
    const cellX = Math.floor(node.x / cell); const cellZ = Math.floor(node.z / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const other of grid.get(`${cellX + dx},${cellZ + dz}`) ?? []) {
        if (other <= index || pathOf[other] === pathOf[index]) continue; // each unordered pair once
        const candidate = nodes[other]; if (!candidate) continue;
        if ((candidate.x - node.x) ** 2 + (candidate.z - node.z) ** 2 > radiusSq) continue;
        if (!crossLink) { linkBoth(index, other); continue; } // ped graph: symmetric junction link
        if (crossLink(index, other, nodes, tangents)) linkForward(index, other);
        if (crossLink(other, index, nodes, tangents)) linkForward(other, index);
      }
    }
  });
  return { nodes, edges, tangents };
}

export function nearestNode(graph: NavGraph, x: number, z: number): number {
  let best = -1; let bestDistance = Infinity;
  for (let index = 0; index < graph.nodes.length; index++) {
    const node = graph.nodes[index]; if (!node) continue;
    const distance = (node.x - x) ** 2 + (node.z - z) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = index; }
  }
  return best;
}

/** A* over the nav graph with a binary heap open list. Returns node indices start..goal, or undefined if unreachable. */
/** Upper bound on nodes A* will settle before declaring a goal unreachable. Generous for any local route
 *  (ambient wander goals settle a few hundred at most) but far below the full graph, so a mis-aimed or
 *  cross-island goal costs a bounded slice instead of the whole city. */
export const MAX_PATH_EXPANSIONS = 4000;

export function findPath(graph: NavGraph, start: number, goal: number): number[] | undefined {
  const { nodes, edges } = graph; const count = nodes.length;
  if (start < 0 || goal < 0 || start >= count || goal >= count) return undefined;
  if (start === goal) return [start];
  const goalNode = nodes[goal]; if (!goalNode) return undefined;
  const gScore = new Float64Array(count).fill(Infinity); gScore[start] = 0;
  const cameFrom = new Int32Array(count).fill(-1);
  const settled = new Uint8Array(count);
  const heapNode: number[] = []; const heapCost: number[] = [];
  const push = (node: number, cost: number): void => {
    let index = heapNode.length; heapNode.push(node); heapCost.push(cost);
    while (index > 0) {
      const parent = (index - 1) >> 1; if ((heapCost[parent] ?? 0) <= cost) break;
      heapNode[index] = heapNode[parent] ?? 0; heapCost[index] = heapCost[parent] ?? 0;
      heapNode[parent] = node; heapCost[parent] = cost; index = parent;
    }
  };
  const pop = (): number => {
    const top = heapNode[0] ?? -1; const lastNode = heapNode.pop(); const lastCost = heapCost.pop();
    if (heapNode.length && lastNode !== undefined && lastCost !== undefined) {
      heapNode[0] = lastNode; heapCost[0] = lastCost; let index = 0;
      for (;;) {
        const left = index * 2 + 1; const right = left + 1; let smallest = index;
        if (left < heapNode.length && (heapCost[left] ?? Infinity) < (heapCost[smallest] ?? Infinity)) smallest = left;
        if (right < heapNode.length && (heapCost[right] ?? Infinity) < (heapCost[smallest] ?? Infinity)) smallest = right;
        if (smallest === index) break;
        const swapNode = heapNode[smallest] ?? 0; const swapCost = heapCost[smallest] ?? 0;
        heapNode[smallest] = heapNode[index] ?? 0; heapCost[smallest] = heapCost[index] ?? 0;
        heapNode[index] = swapNode; heapCost[index] = swapCost; index = smallest;
      }
    }
    return top;
  };
  const heuristic = (index: number): number => { const node = nodes[index]; return node ? Math.hypot(goalNode.x - node.x, goalNode.z - node.z) : 0; };
  push(start, heuristic(start));
  let settledCount = 0;
  while (heapNode.length) {
    const current = pop();
    if (current === goal) {
      const path: number[] = []; for (let node = goal; node >= 0; node = cameFrom[node] ?? -1) path.push(node);
      return path.reverse();
    }
    if (current < 0 || settled[current]) continue;
    settled[current] = 1;
    // Hard cap on work: a goal that isn't found within this many settled nodes is treated as unreachable
    // rather than letting one solve scan the whole ~40k-node graph. Ambient wander goals are local, so a real
    // route settles far fewer than this; the cap only bites pathological far/unreachable goals.
    if (++settledCount > MAX_PATH_EXPANSIONS) return undefined;
    const currentNode = nodes[current]; if (!currentNode) continue;
    for (const neighbor of edges[current] ?? []) {
      if (settled[neighbor]) continue;
      const neighborNode = nodes[neighbor]; if (!neighborNode) continue;
      const tentative = (gScore[current] ?? Infinity) + Math.hypot(neighborNode.x - currentNode.x, neighborNode.z - currentNode.z);
      if (tentative >= (gScore[neighbor] ?? Infinity)) continue;
      gScore[neighbor] = tentative; cameFrom[neighbor] = current; push(neighbor, tentative + heuristic(neighbor));
    }
  }
  return undefined;
}

/** Connected components (each an array of node indices), largest first. Floods OUT-edges only, so on an
 *  undirected graph this is the connected components; on a directed graph it yields reachable sets (use
 *  weakComponents for island detection there). */
export function components(graph: NavGraph): number[][] {
  const seen = new Uint8Array(graph.nodes.length); const result: number[][] = [];
  for (let index = 0; index < graph.nodes.length; index++) {
    if (seen[index]) continue;
    const component: number[] = []; const stack = [index]; seen[index] = 1;
    while (stack.length) {
      const node = stack.pop(); if (node === undefined) break;
      component.push(node);
      for (const neighbor of graph.edges[node] ?? []) if (!seen[neighbor]) { seen[neighbor] = 1; stack.push(neighbor); }
    }
    result.push(component);
  }
  return result.sort((a, b) => b.length - a.length);
}

/** Weakly-connected components: treats every edge as bidirectional, so an edge A→B links A and B into
 *  one island regardless of direction. On a directed graph this is the correct notion of "islands"
 *  (bridgeIslands needs it to guarantee reachability); on an undirected graph it equals components(). */
export function weakComponents(graph: NavGraph): number[][] {
  const count = graph.nodes.length;
  const back: number[][] = Array.from({ length: count }, () => []); // reverse adjacency so the flood walks both ways
  for (let node = 0; node < count; node++) for (const neighbor of graph.edges[node] ?? []) back[neighbor]?.push(node);
  const seen = new Uint8Array(count); const result: number[][] = [];
  for (let index = 0; index < count; index++) {
    if (seen[index]) continue;
    const component: number[] = []; const stack = [index]; seen[index] = 1;
    while (stack.length) {
      const node = stack.pop(); if (node === undefined) break;
      component.push(node);
      for (const neighbor of graph.edges[node] ?? []) if (!seen[neighbor]) { seen[neighbor] = 1; stack.push(neighbor); }
      for (const neighbor of back[node] ?? []) if (!seen[neighbor]) { seen[neighbor] = 1; stack.push(neighbor); }
    }
    result.push(component);
  }
  return result.sort((a, b) => b.length - a.length);
}

/** Strongly-connected components (Kosaraju, iterative), largest first: nodes mutually reachable following
 *  edge direction. A car can only reach goals inside its own SCC, so a healthy directed traffic graph is
 *  ~one giant SCC; a small stray SCC is a source/sink lane that would strand a car. Test-facing. */
export function stronglyConnectedComponents(graph: NavGraph): number[][] {
  const count = graph.nodes.length; const edges = graph.edges;
  const back: number[][] = Array.from({ length: count }, () => []);
  for (let node = 0; node < count; node++) for (const neighbor of edges[node] ?? []) back[neighbor]?.push(node);
  const order: number[] = []; const seen = new Uint8Array(count);
  for (let start = 0; start < count; start++) { // pass 1: push nodes in order of finish time (iterative DFS)
    if (seen[start]) continue;
    const stack: Array<[number, number]> = [[start, 0]]; seen[start] = 1;
    while (stack.length) {
      const frame = stack[stack.length - 1]!; const [node, next] = frame;
      const outs = edges[node] ?? [];
      let advanced = false;
      for (let i = next; i < outs.length; i++) { const neighbor = outs[i]!; if (!seen[neighbor]) { seen[neighbor] = 1; frame[1] = i + 1; stack.push([neighbor, 0]); advanced = true; break; } }
      if (!advanced) { order.push(node); stack.pop(); }
    }
  }
  const assigned = new Uint8Array(count); const result: number[][] = [];
  for (let i = order.length - 1; i >= 0; i--) { // pass 2: DFS the transpose in reverse finish order
    const root = order[i]!; if (assigned[root]) continue;
    const component: number[] = []; const stack = [root]; assigned[root] = 1;
    while (stack.length) {
      const node = stack.pop()!; component.push(node);
      for (const neighbor of back[node] ?? []) if (!assigned[neighbor]) { assigned[neighbor] = 1; stack.push(neighbor); }
    }
    result.push(component);
  }
  return result.sort((a, b) => b.length - a.length);
}

/** Links every island to the largest component through its closest node pair, so the whole graph is
 *  reachable (the hand-authored network leaves Palmera Crescent floating ~25u from Mercado Way). */
export function bridgeIslands(graph: NavGraph): NavGraph {
  const parts = weakComponents(graph); const main = parts[0]; // weak: a one-way link still fuses two nodes into one island
  if (!main) return graph;
  for (const island of parts.slice(1)) {
    let bestMain = -1; let bestIsland = -1; let bestDistance = Infinity;
    for (const islandIndex of island) {
      const islandNode = graph.nodes[islandIndex]; if (!islandNode) continue;
      for (const mainIndex of main) {
        const mainNode = graph.nodes[mainIndex]; if (!mainNode) continue;
        const distance = (mainNode.x - islandNode.x) ** 2 + (mainNode.z - islandNode.z) ** 2;
        if (distance < bestDistance) { bestDistance = distance; bestMain = mainIndex; bestIsland = islandIndex; }
      }
    }
    if (bestMain >= 0 && bestIsland >= 0) { graph.edges[bestMain]?.push(bestIsland); graph.edges[bestIsland]?.push(bestMain); }
  }
  return graph;
}

/** Staggered replan interval in [base, base + spread): units with different serials replan on different frames. */
export function replanInterval(serial: number, base = 1.5, spread = 0.5): number {
  return base + ((serial * GOLDEN) % 1) * spread;
}

/** Seconds of no meaningful progress toward the current waypoint before an agent abandons its route. */
export const STUCK_TIMEOUT = 10;
/** Progress must beat the best distance achieved so far by this many units to count as meaningful. */
export const STUCK_EPSILON = 3;

/** Progress watchdog: feed it the distance to the current waypoint every frame; fires (returns true) once
 *  STUCK_TIMEOUT seconds pass without closing in by STUCK_EPSILON on the best approach so far. Reset it
 *  whenever the goal changes: waypoint advance, replan, state change, freeze/thaw. */
export class ProgressWatchdog {
  private best = Infinity;
  private stalled = 0;

  reset(): void { this.best = Infinity; this.stalled = 0; }

  update(distance: number, dt: number): boolean {
    if (distance < this.best - STUCK_EPSILON) { this.best = distance; this.stalled = 0; return false; }
    this.stalled += dt;
    return this.stalled >= STUCK_TIMEOUT;
  }
}

/** Node-grid cell for goalNear, and how many cells out to gather candidates (≈ 4 × 150u ≈ 600u range) — a
 *  car's destination stays local so each solve is cheap and reachable; the census bubble handles distribution. */
const GOAL_CELL = 150;
const GOAL_REACH_CELLS = 4;

/** Budgeted A* front-end shared by the agents of one system: at most perFrame solves per beginFrame(). */
export class RoutePlanner {
  private budget = 0;
  private nodeGrid?: Map<string, number[]>; // lazily-built spatial index over graph nodes, for goalNear
  /** Cumulative count of real A* solves and the wall-time spent in them. The on-screen perf HUD reads the
   *  per-second delta; only genuine findPath runs are counted (budget short-circuits and cache hits are not). */
  solves = 0;
  solveMs = 0;
  constructor(private graph: NavGraph, private perFrame = 2, private random: () => number = Math.random) {}

  beginFrame(): void { this.budget = this.perFrame; }
  get nodes(): readonly NavPoint[] { return this.graph.nodes; }
  nearest(x: number, z: number): number { return nearestNode(this.graph, x, z); }
  node(index: number): NavPoint | undefined { return this.graph.nodes[index]; }
  randomGoal(): number { return this.graph.nodes.length ? Math.floor(this.random() * this.graph.nodes.length) : -1; }

  /** A random graph node within ~GOAL_REACH cells of (x, z): a nearby, near-certainly-reachable goal so a car's
   *  route is a short local A* rather than a citywide solve. Widens the search if the area is sparse, and only
   *  falls back to a fully-random citywide node when nothing sits nearby. */
  goalNear(x: number, z: number): number {
    const grid = (this.nodeGrid ??= this.buildNodeGrid());
    const cx = Math.floor(x / GOAL_CELL); const cz = Math.floor(z / GOAL_CELL);
    for (let reach = GOAL_REACH_CELLS; reach <= GOAL_REACH_CELLS + 6; reach++) {
      const candidates: number[] = [];
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        const bucket = grid.get(`${cx + dx},${cz + dz}`); if (bucket) candidates.push(...bucket);
      }
      if (candidates.length) return candidates[Math.floor(this.random() * candidates.length)]!;
    }
    return this.randomGoal();
  }

  private buildNodeGrid(): Map<string, number[]> {
    const grid = new Map<string, number[]>();
    this.graph.nodes.forEach((node, index) => {
      const key = `${Math.floor(node.x / GOAL_CELL)},${Math.floor(node.z / GOAL_CELL)}`;
      const bucket = grid.get(key); if (bucket) bucket.push(index); else grid.set(key, [index]);
    });
    return grid;
  }

  /** Unbudgeted solve (spawn-time setup). Goal defaults to a random node. */
  plan(fromX: number, fromZ: number, goal = this.randomGoal()): NavPoint[] | undefined {
    const start = nearestNode(this.graph, fromX, fromZ);
    if (start < 0 || goal < 0) return undefined;
    const started = performance.now();
    const path = findPath(this.graph, start, goal);
    this.solveMs += performance.now() - started; this.solves += 1;
    return path?.map((index) => this.graph.nodes[index]).filter((point): point is NavPoint => Boolean(point));
  }

  /** Budgeted solve for per-frame replans; returns undefined without solving once the frame budget is spent. */
  tryPlan(fromX: number, fromZ: number, goal?: number): NavPoint[] | undefined {
    if (this.budget <= 0) return undefined;
    this.budget -= 1;
    return this.plan(fromX, fromZ, goal);
  }

  /** Road-preferring route to an arbitrary point: rides the graph to the node NEAREST the target, then
   *  appends the exact target as a final offroad leg — never a beeline while a road path gets close. */
  planTo(fromX: number, fromZ: number, toX: number, toZ: number): NavPoint[] | undefined {
    const points = this.plan(fromX, fromZ, nearestNode(this.graph, toX, toZ));
    if (!points?.length) return points;
    const last = points[points.length - 1];
    if (last && (last.x - toX) ** 2 + (last.z - toZ) ** 2 > 1) points.push({ x: toX, z: toZ });
    return points;
  }

  /** Budgeted planTo for per-frame replans (chases, ped wander): shares the same frame budget. */
  tryPlanTo(fromX: number, fromZ: number, toX: number, toZ: number): NavPoint[] | undefined {
    if (this.budget <= 0) return undefined;
    this.budget -= 1;
    return this.planTo(fromX, fromZ, toX, toZ);
  }
}
