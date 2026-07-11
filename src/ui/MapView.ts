import rawMap from '../world/generated/joburg-map.json';
import {
  clampZoom, drawMarker, drawPlayerArrow, markerScreen, renderMap, screenToWorld,
  type MapCamera, type RenderMapData,
} from './mapRender';
import type { MapMarker, MapPoint } from './MinimapView';

const MAP = rawMap as unknown as RenderMapData;
/** Zoom the map opens at — a readable neighbourhood view centred on the player. */
const OPEN_ZOOM = 0.12;

/** Live snapshot the game hands the map each frame it is open. */
export interface MapViewFrame {
  x: number; z: number; heading: number;
  markers: MapMarker[]; police: MapPoint[]; hostiles: MapPoint[];
}

/**
 * Full-screen in-game city map. Shares its cartography with the dev preview via src/ui/mapRender.ts.
 * Opened with M or the `map` console command; Esc or M closes. While open the game keeps running but
 * its input is suspended by the caller, so the wheel zooms the map instead of cycling weapons.
 */
export class MapView {
  root = document.createElement('div');
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private readonly dpr = window.devicePixelRatio || 1;
  private zoom = OPEN_ZOOM;
  private viewX = 0;
  private viewZ = 0;
  private frame: MapViewFrame = { x: 0, z: 0, heading: Math.PI, markers: [], police: [], hostiles: [] };
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pending = false;
  onClose?: () => void;

  constructor() {
    this.root.id = 'map-view'; this.root.setAttribute('aria-hidden', 'true');
    this.canvas.className = 'map-view-canvas';
    const hint = document.createElement('div'); hint.className = 'map-view-hint';
    hint.textContent = 'drag to pan · scroll to zoom · M / ESC to close';
    const title = document.createElement('div'); title.className = 'map-view-title'; title.textContent = 'CITY MAP';
    this.root.append(this.canvas, title, hint);
    const ctx = this.canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); this.ctx = ctx;

    this.canvas.addEventListener('mousedown', (e) => { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; this.canvas.classList.add('is-dragging'); });
    window.addEventListener('mouseup', () => { this.dragging = false; this.canvas.classList.remove('is-dragging'); });
    window.addEventListener('mousemove', (e) => {
      if (!this.open || !this.dragging) return;
      this.viewX -= (e.clientX - this.lastX) / this.zoom; this.viewZ -= (e.clientY - this.lastY) / this.zoom;
      this.lastX = e.clientX; this.lastY = e.clientY; this.requestDraw();
    });
    this.canvas.addEventListener('wheel', (e) => {
      if (!this.open) return;
      e.preventDefault();
      const before = screenToWorld(e.clientX, e.clientY, this.camera());
      this.zoom = clampZoom(this.zoom * Math.exp(-e.deltaY * 0.0015));
      const after = screenToWorld(e.clientX, e.clientY, this.camera());
      this.viewX += before.x - after.x; this.viewZ += before.z - after.z; // keep cursor anchored
      this.requestDraw();
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.code === 'Escape' || e.code === 'KeyM') { e.preventDefault(); this.onClose?.(); }
    });
    window.addEventListener('resize', () => { if (this.open) this.draw(); });
  }

  get open(): boolean { return this.root.classList.contains('is-visible'); }

  private camera(): MapCamera {
    return { zoom: this.zoom, viewX: this.viewX, viewZ: this.viewZ, width: window.innerWidth, height: window.innerHeight, dpr: this.dpr };
  }

  /** Open the map centred on the player and show the current live frame. */
  show(frame: MapViewFrame): void {
    this.frame = frame; this.zoom = OPEN_ZOOM; this.viewX = frame.x; this.viewZ = frame.z;
    this.root.classList.add('is-visible'); this.root.setAttribute('aria-hidden', 'false');
    this.draw();
  }

  hide(): void { this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true'); }

  /** Feed a fresh live frame while open (markers/player move under the static map). */
  update(frame: MapViewFrame): void { if (!this.open) return; this.frame = frame; this.requestDraw(); }

  private requestDraw(): void {
    if (this.pending) return; this.pending = true;
    requestAnimationFrame(() => { this.pending = false; if (this.open) this.draw(); });
  }

  private draw(): void {
    const cam = this.camera();
    this.canvas.width = Math.round(cam.width * this.dpr); this.canvas.height = Math.round(cam.height * this.dpr);
    const ctx = this.ctx;

    renderMap(ctx, MAP, cam, { background: '#0c1117' });

    // Live game markers, drawn in the minimap's language, in crisp screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    for (const unit of this.frame.police) {
      const p = markerScreen(unit, cam); if (p.onScreen) drawMarker(ctx, p.sx, p.sy, '#56b7d7', 'square', 6);
    }
    for (const foe of this.frame.hostiles) {
      const p = markerScreen(foe, cam); if (p.onScreen) drawMarker(ctx, p.sx, p.sy, '#e3533f', 'circle', 5.5);
    }
    for (const marker of this.frame.markers) {
      const p = markerScreen(marker, cam); if (p.onScreen) drawMarker(ctx, p.sx, p.sy, marker.color, marker.shape ?? 'circle');
    }
    const self = markerScreen(this.frame, cam);
    drawPlayerArrow(ctx, self.sx, self.sy, this.frame.heading);
  }
}
