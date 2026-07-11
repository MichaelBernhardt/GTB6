import { MAP_WORLD_SIZE } from '../world/mapData';
import type { RoadPoint } from '../world/City';

export interface MapPoint { x: number; z: number; }
export interface MapMarker extends MapPoint { color: string; shape?: 'circle' | 'diamond' | 'house'; }

/** Units-to-pixels factors, ordered widest view to tightest, over the 240px minimap canvas.
 *  'City' is derived from the map footprint so the widest level always frames the whole generated
 *  map (240/scale = MAP_WORLD_SIZE across) whatever the mapgen TARGET_SIZE — though at that scale
 *  the in-game MapView (M key) is the real whole-map view; 'Metro'/'District' cover longer driving
 *  radii, and 'Standard'..'Street' keep the original on-foot fixed scales for local navigation. */
export const MINIMAP_ZOOM_SCALES = [240 / MAP_WORLD_SIZE, 0.02, 0.045, 0.095, 0.2, 0.29, 0.4, 0.54] as const;
export const MINIMAP_ZOOM_NAMES = ['City', 'Metro', 'District', 'Far', 'Wide', 'Standard', 'Close', 'Street'] as const;
export const DEFAULT_MINIMAP_ZOOM = 5; // Standard (on-foot fixed scale)

export function sanitizeMinimapZoom(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < MINIMAP_ZOOM_SCALES.length ? raw : DEFAULT_MINIMAP_ZOOM;
}
/** Step the zoom index (+1 zooms in, -1 zooms out), clamped to the available levels. */
export function stepMinimapZoom(zoom: number, direction: 1 | -1): number {
  return Math.min(MINIMAP_ZOOM_SCALES.length - 1, Math.max(0, sanitizeMinimapZoom(zoom) + direction));
}

export class MinimapView {
  readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;

  constructor() {
    this.canvas.id = 'minimap'; this.canvas.width = 240; this.canvas.height = 240; this.canvas.setAttribute('aria-label', 'Local street map'); this.canvas.setAttribute('role', 'img');
    const context = this.canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
  }

  private roadBounds = new WeakMap<RoadPoint[], { minX: number; maxX: number; minZ: number; maxZ: number }>();

  /** Cached per-path bbox: the generated map has ~4000 road polylines and most are off-screen. */
  private boundsOf(road: RoadPoint[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
    let bounds = this.roadBounds.get(road);
    if (!bounds) {
      bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (const point of road) {
        bounds.minX = Math.min(bounds.minX, point.x); bounds.maxX = Math.max(bounds.maxX, point.x);
        bounds.minZ = Math.min(bounds.minZ, point.z); bounds.maxZ = Math.max(bounds.maxZ, point.z);
      }
      this.roadBounds.set(road, bounds);
    }
    return bounds;
  }

  draw(x: number, z: number, heading: number, allRoads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = [], zoom = DEFAULT_MINIMAP_ZOOM): void {
    const ctx = this.context; const size = this.canvas.width; const scale = MINIMAP_ZOOM_SCALES[sanitizeMinimapZoom(zoom)];
    const viewRadius = (size * 0.75) / scale; // canvas half-diagonal in world units, with rotation slack
    const roads = allRoads.filter((road) => {
      const bounds = this.boundsOf(road);
      return bounds.minX < x + viewRadius && bounds.maxX > x - viewRadius && bounds.minZ < z + viewRadius && bounds.maxZ > z - viewRadius;
    });
    const counter = Math.PI - heading; // undo map rotation so blip shapes stay screen-aligned
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = '#17211f'; ctx.fillRect(0, 0, size, size);
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading - Math.PI); ctx.translate(-x * scale, -z * scale);
    ctx.strokeStyle = '#465451'; ctx.lineWidth = Math.max(2.5, 22 * scale); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    ctx.strokeStyle = '#c8c4ad'; ctx.lineWidth = Math.max(1.2, 7 * scale);
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    for (const marker of markers) {
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
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.fillStyle = '#f7c843'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(-8, 10); ctx.lineTo(0, 6); ctx.lineTo(8, 10); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#f2edda'; ctx.font = '700 11px Arial'; ctx.textAlign = 'center'; ctx.fillText('N', size / 2, 16);
  }
}
