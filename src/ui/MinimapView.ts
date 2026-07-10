import type { RoadPoint } from '../world/City';

export interface MapPoint { x: number; z: number; }
export interface MapMarker extends MapPoint { color: string; }

export class MinimapView {
  readonly canvas = document.createElement('canvas');
  private context: CanvasRenderingContext2D;

  constructor() {
    this.canvas.id = 'minimap'; this.canvas.width = 240; this.canvas.height = 240; this.canvas.setAttribute('aria-label', 'Local street map'); this.canvas.setAttribute('role', 'img');
    const context = this.canvas.getContext('2d'); if (!context) throw new Error('Canvas unavailable'); this.context = context;
  }

  draw(x: number, z: number, heading: number, roads: RoadPoint[][], markers: MapMarker[], police: MapPoint[], hostiles: MapPoint[] = []): void {
    const ctx = this.context; const size = this.canvas.width; const scale = 0.29;
    ctx.clearRect(0, 0, size, size); ctx.fillStyle = '#17211f'; ctx.fillRect(0, 0, size, size);
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.rotate(heading - Math.PI); ctx.translate(-x * scale, -z * scale);
    ctx.strokeStyle = '#465451'; ctx.lineWidth = 22 * scale; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    ctx.strokeStyle = '#c8c4ad'; ctx.lineWidth = 7 * scale;
    for (const road of roads) { const first = road[0]; if (!first) continue; ctx.beginPath(); ctx.moveTo(first.x * scale, first.z * scale); for (const point of road.slice(1)) ctx.lineTo(point.x * scale, point.z * scale); ctx.stroke(); }
    for (const marker of markers) { ctx.fillStyle = marker.color; ctx.beginPath(); ctx.arc(marker.x * scale, marker.z * scale, 6, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#111817'; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = '#56b7d7'; for (const unit of police) { ctx.fillRect(unit.x * scale - 4, unit.z * scale - 4, 8, 8); }
    ctx.fillStyle = '#e3533f'; for (const foe of hostiles) { ctx.beginPath(); ctx.arc(foe.x * scale, foe.z * scale, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.fillStyle = '#f7c843'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(-8, 10); ctx.lineTo(0, 6); ctx.lineTo(8, 10); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    ctx.fillStyle = '#f2edda'; ctx.font = '700 11px Arial'; ctx.textAlign = 'center'; ctx.fillText('N', size / 2, 16);
  }
}
