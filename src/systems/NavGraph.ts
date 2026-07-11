export interface NavPoint { x: number; z: number; }
export interface NavPath { points: NavPoint[]; closed?: boolean; }
export interface NavGraph { nodes: NavPoint[]; edges: number[][]; }

const GOLDEN = 0.618034;

/** Builds an undirected nav graph from polylines: consecutive points become edges, and nodes on
 *  different polylines within joinRadius are linked so crossing roads form junction connections. */
export function buildNavGraph(paths: NavPath[], joinRadius: number): NavGraph {
  const nodes: NavPoint[] = []; const edges: number[][] = []; const pathOf: number[] = [];
  const link = (a: number, b: number): void => {
    const neighbors = edges[a]; if (a === b || !neighbors || neighbors.includes(b)) return;
    neighbors.push(b); edges[b]?.push(a);
  };
  paths.forEach((path, pathIndex) => {
    const base = nodes.length;
    for (const point of path.points) { nodes.push({ x: point.x, z: point.z }); edges.push([]); pathOf.push(pathIndex); }
    for (let index = 1; index < path.points.length; index++) link(base + index - 1, base + index);
    if (path.closed && path.points.length > 2) link(base + path.points.length - 1, base);
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
        if (other <= index || pathOf[other] === pathOf[index]) continue;
        const candidate = nodes[other]; if (!candidate) continue;
        if ((candidate.x - node.x) ** 2 + (candidate.z - node.z) ** 2 <= radiusSq) link(index, other);
      }
    }
  });
  return { nodes, edges };
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
  while (heapNode.length) {
    const current = pop();
    if (current === goal) {
      const path: number[] = []; for (let node = goal; node >= 0; node = cameFrom[node] ?? -1) path.push(node);
      return path.reverse();
    }
    if (current < 0 || settled[current]) continue;
    settled[current] = 1;
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

/** Connected components (each an array of node indices), largest first. Used to verify/document graph islands. */
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

/** Links every island to the largest component through its closest node pair, so the whole graph is
 *  reachable (the hand-authored network leaves Palmera Crescent floating ~25u from Mercado Way). */
export function bridgeIslands(graph: NavGraph): NavGraph {
  const parts = components(graph); const main = parts[0];
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

/** Budgeted A* front-end shared by the agents of one system: at most perFrame solves per beginFrame(). */
export class RoutePlanner {
  private budget = 0;
  constructor(private graph: NavGraph, private perFrame = 2, private random: () => number = Math.random) {}

  beginFrame(): void { this.budget = this.perFrame; }
  get nodes(): readonly NavPoint[] { return this.graph.nodes; }
  nearest(x: number, z: number): number { return nearestNode(this.graph, x, z); }
  node(index: number): NavPoint | undefined { return this.graph.nodes[index]; }
  randomGoal(): number { return this.graph.nodes.length ? Math.floor(this.random() * this.graph.nodes.length) : -1; }

  /** Unbudgeted solve (spawn-time setup). Goal defaults to a random node. */
  plan(fromX: number, fromZ: number, goal = this.randomGoal()): NavPoint[] | undefined {
    const start = nearestNode(this.graph, fromX, fromZ);
    const path = start < 0 || goal < 0 ? undefined : findPath(this.graph, start, goal);
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
