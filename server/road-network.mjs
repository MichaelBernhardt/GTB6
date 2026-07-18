import { readFileSync } from 'node:fs';

const rawMap = JSON.parse(readFileSync(new URL('../src/world/generated/joburg-map.json', import.meta.url), 'utf8'));

const CELL_SIZE = 36;
const SEARCH_REACH = 64;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Server-side copy of the client's road broad phase. The checked-in map is the source of truth on both
 * sides; keeping this module free of Three.js lets the authoritative Node process use it directly.
 */
export class RoadSegmentIndex {
  constructor(roads = rawMap.roads, cellSize = CELL_SIZE, reach = SEARCH_REACH) {
    this.cellSize = cellSize;
    this.reach = reach;
    this.cells = new Map();
    this.segments = [];
    for (const road of roads) {
      for (let index = 0; index < road.points.length - 1; index += 1) {
        const [ax, az] = road.points[index]; const [bx, bz] = road.points[index + 1];
        const segment = { ax, az, bx, bz, half: road.width / 2, road: road.name };
        this.segments.push(segment);
        const pad = segment.half + reach;
        const minX = Math.floor((Math.min(ax, bx) - pad) / cellSize); const maxX = Math.floor((Math.max(ax, bx) + pad) / cellSize);
        const minZ = Math.floor((Math.min(az, bz) - pad) / cellSize); const maxZ = Math.floor((Math.max(az, bz) + pad) / cellSize);
        for (let cx = minX; cx <= maxX; cx += 1) for (let cz = minZ; cz <= maxZ; cz += 1) {
          const key = `${cx},${cz}`; const bucket = this.cells.get(key);
          if (bucket) bucket.push(segment); else this.cells.set(key, [segment]);
        }
      }
    }
  }

  candidates(x, z) { return this.cells.get(`${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`) ?? []; }

  edgeDistance(x, z) {
    let best = this.reach;
    for (const segment of this.candidates(x, z)) {
      const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
      const t = clamp(((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq, 0, 1);
      const distance = Math.hypot(x - (segment.ax + dx * t), z - (segment.az + dz * t)) - segment.half;
      if (distance < best) best = distance;
    }
    return best;
  }

  onRoad(x, z, margin = 0) { return this.edgeDistance(x, z) <= margin; }

  acceptsMove(fromX, fromZ, toX, toZ, footprintMargin = -0.8) {
    const distance = Math.hypot(toX - fromX, toZ - fromZ);
    const samples = Math.max(1, Math.ceil(distance / 1.5));
    for (let sample = 1; sample <= samples; sample += 1) {
      const t = sample / samples;
      if (!this.onRoad(fromX + (toX - fromX) * t, fromZ + (toZ - fromZ) * t, footprintMargin)) return false;
    }
    return true;
  }

  nearestPose(x, z) {
    let best; let bestDistanceSq = Infinity;
    for (const segment of this.candidates(x, z)) {
      const dx = segment.bx - segment.ax; const dz = segment.bz - segment.az; const lengthSq = dx * dx + dz * dz || 1;
      const t = clamp(((x - segment.ax) * dx + (z - segment.az) * dz) / lengthSq, 0, 1);
      const px = segment.ax + dx * t; const pz = segment.az + dz * t;
      const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = { x: px, z: pz, heading: Math.atan2(dx, dz), road: segment.road };
      }
    }
    if (!best) throw new Error(`No generated road near ${x}, ${z}`);
    return best;
  }
}

export const ROAD_INDEX = new RoadSegmentIndex();
