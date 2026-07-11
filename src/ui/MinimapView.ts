import type { RoadPoint } from '../world/City';

export interface MapPoint { x: number; z: number; }
export interface MapMarker extends MapPoint { color: string; shape?: 'circle' | 'diamond' | 'house'; }

/** Metres-to-pixels factors, ordered widest view to tightest. Index 2 matches the original fixed scale. */
export const MINIMAP_ZOOM_SCALES = [0.14, 0.2, 0.29, 0.4, 0.54] as const;
export const MINIMAP_ZOOM_NAMES = ['Far', 'Wide', 'Standard', 'Close', 'Street'] as const;
export const DEFAULT_MINIMAP_ZOOM = 2; // Standard

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

export class MinimapView {
  readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;

  constructor() {
    this.canvas.id = 'minimap'; this.canvas.width = 240; this.canvas.height = 240; this.canvas.setAttribute('aria-label', 'Local street map'); this.canvas.setAttribute('role', 'img');
    const context = this.canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
  }

  draw(x: number, z: number, heading: number, roads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = [], zoom = DEFAULT_MINIMAP_ZOOM): void {
    const ctx = this.context; const size = this.canvas.width; const scale = MINIMAP_ZOOM_SCALES[sanitizeMinimapZoom(zoom)];
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
    // Compass rose: an outward arrowhead + upright 'N' riding the minimap edge, tracking true north as the map rotates.
    const phi = minimapNorthAngle(heading); const dirX = Math.sin(phi); const dirY = -Math.cos(phi); const ring = size / 2 - 22;
    ctx.save(); ctx.translate(size / 2 + dirX * ring, size / 2 + dirY * ring); ctx.rotate(phi);
    ctx.fillStyle = '#e0402f'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5, 3); ctx.lineTo(-5, 3); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#f2edda'; ctx.font = '700 11px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', size / 2 + dirX * (ring - 13), size / 2 + dirY * (ring - 13));
  }
}
