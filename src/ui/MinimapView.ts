import { MAP_WORLD_SIZE } from '../world/mapData';
import type { RoadPoint } from '../world/City';

export interface MapPoint { x: number; z: number; }
export interface MapMarker extends MapPoint { color: string; shape?: 'circle' | 'diamond' | 'house'; objective?: boolean; area?: number; }

/** Units-to-pixels factors, ordered widest view to tightest, over the 240px minimap canvas.
 *  'City' is derived from the map footprint so the widest level always frames the whole generated
 *  map (240/scale = MAP_WORLD_SIZE across) whatever the mapgen TARGET_SIZE — though at that scale
 *  the in-game MapView (M key) is the real whole-map view; 'Metro'/'District' cover longer driving
 *  radii, and 'Standard'..'Street' keep the original on-foot fixed scales for local navigation. */
export const MINIMAP_ZOOM_SCALES = [240 / MAP_WORLD_SIZE, 0.02, 0.045, 0.095, 0.2, 0.29, 0.4, 0.54] as const;
export const MINIMAP_ZOOM_NAMES = ['City', 'Metro', 'District', 'Far', 'Wide', 'Standard', 'Close', 'Street'] as const;
export const DEFAULT_MINIMAP_ZOOM = 5; // Standard (on-foot fixed scale)

/** Screen-space bearing to TRUE north on the player-up minimap: 0 = straight up, growing clockwise.
 *  The map content is rotated by (heading - PI), so world north (-Z) sweeps to that same screen angle;
 *  when the player faces north (heading = PI) it lands at the top, and it tracks real north as they turn. */
export function minimapNorthAngle(heading: number): number {
  return heading - Math.PI;
}

export function sanitizeMinimapZoom(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < MINIMAP_ZOOM_SCALES.length ? raw : DEFAULT_MINIMAP_ZOOM;
}
/** Step the zoom index (+1 zooms in, -1 zooms out), clamped to the available levels. */
export function stepMinimapZoom(zoom: number, direction: 1 | -1): number {
  return Math.min(MINIMAP_ZOOM_SCALES.length - 1, Math.max(0, sanitizeMinimapZoom(zoom) + direction));
}

/** Spatial index over immutable road polylines. The minimap used to scan all ~4,000 roads every
 *  rendered frame; this returns only roads touching the view's grid cells and de-duplicates long
 *  roads that span several cells. The returned key changes only when the queried cell rectangle
 *  changes, allowing the caller to retain one combined Path2D while moving inside those cells. */
export class MinimapRoadIndex {
  private cells = new Map<string, number[]>();
  private marks: Uint32Array;
  private generation = 0;
  private minCellX = Infinity;
  private maxCellX = -Infinity;
  private minCellZ = Infinity;
  private maxCellZ = -Infinity;

  constructor(readonly roads: RoadPoint[][], private cellSize = 512) {
    this.marks = new Uint32Array(roads.length);
    roads.forEach((road, index) => {
      if (!road.length) return;
      let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
      for (const point of road) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
      }
      const minCellX = Math.floor(minX / cellSize); const maxCellX = Math.floor(maxX / cellSize);
      const minCellZ = Math.floor(minZ / cellSize); const maxCellZ = Math.floor(maxZ / cellSize);
      this.minCellX = Math.min(this.minCellX, minCellX); this.maxCellX = Math.max(this.maxCellX, maxCellX);
      this.minCellZ = Math.min(this.minCellZ, minCellZ); this.maxCellZ = Math.max(this.maxCellZ, maxCellZ);
      for (let cx = minCellX; cx <= maxCellX; cx++) for (let cz = minCellZ; cz <= maxCellZ; cz++) {
        const key = `${cx},${cz}`; const bucket = this.cells.get(key);
        if (bucket) bucket.push(index); else this.cells.set(key, [index]);
      }
    });
  }

  query(x: number, z: number, radius: number, out: RoadPoint[][]): string {
    out.length = 0;
    this.generation = (this.generation + 1) >>> 0;
    if (this.generation === 0) { this.marks.fill(0); this.generation = 1; }
    if (!Number.isFinite(this.minCellX)) return 'empty';
    const minX = Math.max(this.minCellX, Math.floor((x - radius) / this.cellSize));
    const maxX = Math.min(this.maxCellX, Math.floor((x + radius) / this.cellSize));
    const minZ = Math.max(this.minCellZ, Math.floor((z - radius) / this.cellSize));
    const maxZ = Math.min(this.maxCellZ, Math.floor((z + radius) / this.cellSize));
    if (minX > maxX || minZ > maxZ) return 'empty';
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) {
      for (const index of this.cells.get(`${cx},${cz}`) ?? []) {
        if (this.marks[index] === this.generation) continue;
        this.marks[index] = this.generation; out.push(this.roads[index]!);
      }
    }
    return `${minX},${maxX},${minZ},${maxZ}`;
  }
}

export class MinimapView {
  readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;
  private visibleRoads: RoadPoint[][] = [];
  private roadIndex?: MinimapRoadIndex;
  private roadPath = new Path2D();
  private roadPathKey = '';

  constructor() {
    this.canvas.id = 'minimap'; this.canvas.width = 240; this.canvas.height = 240; this.canvas.setAttribute('aria-label', 'Local street map'); this.canvas.setAttribute('role', 'img');
    const context = this.canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
  }

  draw(x: number, z: number, heading: number, allRoads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = [], zoom = DEFAULT_MINIMAP_ZOOM): void {
    const ctx = this.context; const size = this.canvas.width; const scale = MINIMAP_ZOOM_SCALES[sanitizeMinimapZoom(zoom)];
    const viewRadius = (size * 0.75) / scale; // canvas half-diagonal in world units, with rotation slack
    if (this.roadIndex?.roads !== allRoads) { this.roadIndex = new MinimapRoadIndex(allRoads); this.roadPathKey = ''; }
    const roads = this.visibleRoads;
    const pathKey = this.roadIndex.query(x, z, viewRadius, roads);
    if (pathKey !== this.roadPathKey) {
      const path = new Path2D();
      for (const road of roads) {
        const first = road[0]; if (!first) continue;
        path.moveTo(first.x, first.z);
        for (let index = 1; index < road.length; index++) { const point = road[index]!; path.lineTo(point.x, point.z); }
      }
      this.roadPath = path; this.roadPathKey = pathKey;
    }
    const counter = Math.PI - heading; // undo map rotation so blip shapes stay screen-aligned
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = '#17211f'; ctx.fillRect(0, 0, size, size);
    // Roads are one retained path and therefore two strokes total (outline + surface), rather than
    // two canvas draw calls per visible polyline. A world-space scale keeps the retained path reusable.
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading - Math.PI); ctx.scale(scale, scale); ctx.translate(-x, -z);
    ctx.strokeStyle = '#465451'; ctx.lineWidth = Math.max(2.5 / scale, 22); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke(this.roadPath);
    ctx.strokeStyle = '#c8c4ad'; ctx.lineWidth = Math.max(1.2 / scale, 7); ctx.stroke(this.roadPath); ctx.restore();

    // Blips stay screen-sized under the original rotation-only transform.
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading - Math.PI); ctx.translate(-x * scale, -z * scale);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const marker of markers) {
      if (marker.objective) continue; // drawn after restore in screen space, so it can pin to the edge
      if (marker.area) { // riddle search circle: a region to comb, deliberately not a point
        ctx.save(); ctx.translate(marker.x * scale, marker.z * scale);
        ctx.fillStyle = 'rgba(245, 197, 66, 0.12)'; ctx.strokeStyle = 'rgba(245, 197, 66, 0.65)'; ctx.lineWidth = 2; ctx.setLineDash([7, 5]);
        ctx.beginPath(); ctx.arc(0, 0, marker.area * scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.restore(); continue;
      }
      ctx.save(); ctx.translate(marker.x * scale, marker.z * scale); ctx.rotate(counter);
      ctx.fillStyle = marker.color; ctx.strokeStyle = '#111817'; ctx.lineWidth = 2; ctx.beginPath();
      if (marker.shape === 'diamond') { ctx.moveTo(0, -6.5); ctx.lineTo(6.5, 0); ctx.lineTo(0, 6.5); ctx.lineTo(-6.5, 0); ctx.closePath(); }
      else if (marker.shape === 'house') { ctx.moveTo(0, -7.5); ctx.lineTo(6, -1.5); ctx.lineTo(6, 6); ctx.lineTo(-6, 6); ctx.lineTo(-6, -1.5); ctx.closePath(); }
      else ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke(); ctx.restore();
    }
    ctx.fillStyle = '#56b7d7'; for (const unit of police) { ctx.save(); ctx.translate(unit.x * scale, unit.z * scale); ctx.rotate(counter); ctx.fillRect(-4, -4, 8, 8); ctx.restore(); }
    ctx.fillStyle = '#e3533f'; for (const foe of hostiles) { ctx.beginPath(); ctx.arc(foe.x * scale, foe.z * scale, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    // The mission objective NEVER disappears: in range it's a big ringed diamond at its spot; out of
    // range it pins to the minimap edge in its true direction with an outward arrowhead.
    for (const marker of markers) {
      if (!marker.objective) continue;
      const angle = heading - Math.PI; const cosA = Math.cos(angle); const sinA = Math.sin(angle);
      const dx = (marker.x - x) * scale; const dz = (marker.z - z) * scale;
      let sx = dx * cosA - dz * sinA; let sy = dx * sinA + dz * cosA;
      const range = Math.hypot(sx, sy); const maxRange = size / 2 - 16; const pinned = range > maxRange;
      if (pinned) { sx *= maxRange / range; sy *= maxRange / range; }
      ctx.save(); ctx.translate(size / 2 + sx, size / 2 + sy);
      ctx.fillStyle = marker.color; ctx.strokeStyle = '#f6f1de'; ctx.lineWidth = 2.5; ctx.beginPath();
      ctx.moveTo(0, -8); ctx.lineTo(8, 0); ctx.lineTo(0, 8); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      if (pinned) { ctx.rotate(Math.atan2(sy, sx) + Math.PI / 2); ctx.fillStyle = '#f6f1de'; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(5.5, -8); ctx.lineTo(-5.5, -8); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.fillStyle = '#f7c843'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(-8, 10); ctx.lineTo(0, 6); ctx.lineTo(8, 10); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    // Compass rose: an outward arrowhead + upright 'N' riding the minimap edge, tracking true north as the map rotates.
    const phi = minimapNorthAngle(heading); const dirX = Math.sin(phi); const dirY = -Math.cos(phi); const ring = size / 2 - 22;
    ctx.save(); ctx.translate(size / 2 + dirX * ring, size / 2 + dirY * ring); ctx.rotate(phi);
    ctx.fillStyle = '#e0402f'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#f2edda'; ctx.font = '700 11px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', size / 2 + dirX * (ring - 13), size / 2 + dirY * (ring - 13));
  }
}
