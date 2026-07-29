export interface NamedRoad {
  name: string;
  points: ReadonlyArray<{ x: number; z: number }>;
}

interface NamedSegment {
  name: string;
  ax: number; az: number;
  bx: number; bz: number;
}

export interface NearbyStreet { name: string; distance: number; }

function segmentDistanceSq(x: number, z: number, segment: NamedSegment): number {
  const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az;
  const lengthSq = dx * dx + dz * dz || 1;
  const along = Math.max(0, Math.min(1, ((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq));
  const closestX = segment.ax + dx * along; const closestZ = segment.az + dz * along;
  return (x - closestX) ** 2 + (z - closestZ) ** 2;
}

/** Static grid over named road segments. A HUD lookup visits only the few blocks around the player,
 * not all four thousand Johannesburg roads every frame. */
export class StreetNameIndex {
  private cells = new Map<string, NamedSegment[]>();

  constructor(roads: readonly NamedRoad[], private readonly cellSize = 180) {
    for (const road of roads) {
      const name = road.name.trim();
      if (!name || /^(unnamed|water\b)/i.test(name)) continue;
      for (let index = 1; index < road.points.length; index++) {
        const from = road.points[index - 1]!; const to = road.points[index]!;
        const segment = { name, ax: from.x, az: from.z, bx: to.x, bz: to.z };
        const minX = Math.floor(Math.min(from.x, to.x) / cellSize); const maxX = Math.floor(Math.max(from.x, to.x) / cellSize);
        const minZ = Math.floor(Math.min(from.z, to.z) / cellSize); const maxZ = Math.floor(Math.max(from.z, to.z) / cellSize);
        for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
          const key = `${cx},${cz}`; const bucket = this.cells.get(key);
          if (bucket) bucket.push(segment); else this.cells.set(key, [segment]);
        }
      }
    }
  }

  nearest(x: number, z: number, maxDistance = 60): NearbyStreet | undefined {
    if (!Number.isFinite(x) || !Number.isFinite(z) || maxDistance <= 0) return undefined;
    const minX = Math.floor((x - maxDistance) / this.cellSize); const maxX = Math.floor((x + maxDistance) / this.cellSize);
    const minZ = Math.floor((z - maxDistance) / this.cellSize); const maxZ = Math.floor((z + maxDistance) / this.cellSize);
    const seen = new Set<NamedSegment>();
    let nearest: NamedSegment | undefined; let nearestSq = maxDistance * maxDistance;
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      for (const segment of this.cells.get(`${cx},${cz}`) ?? []) {
        if (seen.has(segment)) continue; seen.add(segment);
        const distanceSq = segmentDistanceSq(x, z, segment);
        if (distanceSq <= nearestSq) { nearest = segment; nearestSq = distanceSq; }
      }
    }
    return nearest ? { name: nearest.name, distance: Math.sqrt(nearestSq) } : undefined;
  }
}
