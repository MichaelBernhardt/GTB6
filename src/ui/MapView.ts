import rawMap from '../world/generated/joburg-map.json';
import {
  applyWorldTransform, clampZoom, drawMarker, drawPlayerArrow, markerScreen, renderMap, screenToWorld,
  type MapCamera, type RenderLayers, type RenderMapData,
} from './mapRender';
import type { MapMarker, MapPoint } from './MinimapView';

const MAP = rawMap as unknown as RenderMapData;
type MapRoad = RenderMapData['roads'][number];

/** Squared distance from (px,pz) to segment (ax,az)-(bx,bz). */
function segDistSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax; const dz = bz - az; const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2));
  const cx = ax + dx * t; const cz = az + dz * t;
  return (px - cx) ** 2 + (pz - cz) ** 2;
}

/** Filterable map layers exposed as tick-boxes, in display order. */
const LAYER_TOGGLES: Array<{ key: keyof RenderLayers; label: string }> = [
  { key: 'roads', label: 'Roads' }, { key: 'tracks', label: 'Tracks' }, { key: 'railways', label: 'Railways' },
  { key: 'water', label: 'Water' }, { key: 'coast', label: 'Coast' }, { key: 'landuse', label: 'Land use' },
  { key: 'airport', label: 'Airport' }, { key: 'districts', label: 'Districts' }, { key: 'landmarks', label: 'Landmarks' },
  { key: 'hillshade', label: 'Relief' },
];
/** Zoom the map opens at — a readable neighbourhood view centred on the player.
 *  0.24 at ~0.98 m/unit covers the same real ground the old 0.12 did at 0.49 m/unit. */
const OPEN_ZOOM = 0.24;

/** Keys that close the map overlay. Pure so the gating is testable. */
export const closesMapOverlay = (code: string): boolean => code === 'Escape' || code === 'KeyM';

/** What the overlay's capture-phase keydown handler does with a key press while the map is open.
 *  Close keys are swallowed even on auto-repeat (but only a fresh press closes): closing unsuspends
 *  the game's InputManager, so any leaked repeat of M/Escape would instantly reopen the map or pause. */
export function mapOverlayKeyAction(code: string, repeat: boolean): 'close' | 'swallow' | 'ignore' {
  if (!closesMapOverlay(code)) return 'ignore';
  return repeat ? 'swallow' : 'close';
}

/** Live snapshot the game hands the map each frame it is open. */
export interface MapViewFrame {
  x: number; z: number; heading: number;
  markers: MapMarker[]; police: MapPoint[]; hostiles: MapPoint[];
  cars?: MapPoint[]; peds?: MapPoint[]; // `mapnpcs` debug overlay: every ambient car / ped as a tiny dot (empty/undefined when off)
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
  private pinchDist = 0;
  private pending = false;
  onClose?: () => void;

  private layers: Partial<RenderLayers> = {}; // empty = renderMap defaults (everything on)
  private hovered: MapRoad | undefined;
  private tooltip = document.createElement('div');
  private searchBox = document.createElement('input');
  private results = document.createElement('div');
  private searchIndex: Array<{ name: string; x: number; z: number; kind: 'street' | 'district' | 'landmark' }> = [];

  constructor() {
    this.root.id = 'map-view'; this.root.setAttribute('aria-hidden', 'true');
    this.canvas.className = 'map-view-canvas';
    const hint = document.createElement('div'); hint.className = 'map-view-hint';
    hint.textContent = 'drag to pan · scroll to zoom · hover a street for its name · M / ESC to close';
    const title = document.createElement('div'); title.className = 'map-view-title'; title.textContent = 'CITY MAP';
    this.tooltip.className = 'map-view-tooltip';
    const close = document.createElement('button'); close.className = 'map-view-close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Close map');
    close.addEventListener('click', () => this.onClose?.());
    this.root.append(this.canvas, title, hint, this.tooltip, this.buildSearch(), this.buildFilters(), close);
    const ctx = this.canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable'); this.ctx = ctx;

    this.canvas.addEventListener('mousedown', (e) => { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; this.canvas.classList.add('is-dragging'); });
    window.addEventListener('mouseup', () => { this.dragging = false; this.canvas.classList.remove('is-dragging'); });
    window.addEventListener('mousemove', (e) => {
      if (!this.open) return;
      if (this.dragging) {
        this.viewX -= (e.clientX - this.lastX) / this.zoom; this.viewZ -= (e.clientY - this.lastY) / this.zoom;
        this.lastX = e.clientX; this.lastY = e.clientY; this.tooltip.style.display = 'none'; this.requestDraw();
      } else this.hover(e.clientX, e.clientY);
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
    window.addEventListener('resize', () => { if (this.open) this.draw(); });

    // Touch: one finger pans, two fingers pinch-zoom (anchored on the pinch midpoint), and a
    // visible close button stands in for M/Esc. All additive — desktop mouse paths untouched.
    this.canvas.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; if (!this.open || !t) return;
      e.preventDefault(); this.tooltip.style.display = 'none';
      if (e.touches.length >= 2) { this.dragging = false; this.pinchDist = Math.hypot(e.touches[1]!.clientX - t.clientX, e.touches[1]!.clientY - t.clientY); }
      else { this.dragging = true; this.lastX = t.clientX; this.lastY = t.clientY; }
    }, { passive: false });
    this.canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; if (!this.open || !t) return;
      e.preventDefault();
      if (e.touches.length >= 2 && this.pinchDist > 0) {
        const second = e.touches[1]!;
        const dist = Math.hypot(second.clientX - t.clientX, second.clientY - t.clientY);
        const midX = (t.clientX + second.clientX) / 2; const midY = (t.clientY + second.clientY) / 2;
        const before = screenToWorld(midX, midY, this.camera());
        this.zoom = clampZoom(this.zoom * (dist / this.pinchDist)); this.pinchDist = dist;
        const after = screenToWorld(midX, midY, this.camera());
        this.viewX += before.x - after.x; this.viewZ += before.z - after.z;
        this.requestDraw();
      } else if (this.dragging) {
        this.viewX -= (t.clientX - this.lastX) / this.zoom; this.viewZ -= (t.clientY - this.lastY) / this.zoom;
        this.lastX = t.clientX; this.lastY = t.clientY; this.requestDraw();
      }
    }, { passive: false });
    this.canvas.addEventListener('touchend', (e) => { if (e.touches.length === 0) { this.dragging = false; this.pinchDist = 0; } });
  }

  /** Capture-phase keydown, registered only while the map is open. The game's InputManager also
   *  listens on window (bubble phase): preventDefault + stopImmediatePropagation here guarantees the
   *  closing M/Escape press never reaches it — otherwise closing unsuspends input inside the same
   *  event dispatch and the very press that closed the map re-opens it (M) or pauses the game (Esc). */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (document.activeElement === this.searchBox) { // typing a street name — don't let 'M' close the map
      if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.searchBox.blur(); this.clearResults(); }
      return; // every other key belongs to the input
    }
    const action = mapOverlayKeyAction(e.code, e.repeat);
    if (action === 'ignore') return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (action === 'close') this.onClose?.();
  };

  get open(): boolean { return this.root.classList.contains('is-visible'); }

  private camera(): MapCamera {
    return { zoom: this.zoom, viewX: this.viewX, viewZ: this.viewZ, width: window.innerWidth, height: window.innerHeight, dpr: this.dpr };
  }

  /** Open the map centred on the player and show the current live frame. */
  show(frame: MapViewFrame): void {
    this.frame = frame; this.zoom = OPEN_ZOOM; this.viewX = frame.x; this.viewZ = frame.z;
    this.hovered = undefined; this.tooltip.style.display = 'none';
    this.buildStreetIndex();
    this.root.classList.add('is-visible'); this.root.setAttribute('aria-hidden', 'false');
    window.addEventListener('keydown', this.onKeyDown, true); // capture: runs before the game's window listeners
    this.draw();
  }

  hide(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.dragging = false; this.canvas.classList.remove('is-dragging');
    this.hovered = undefined; this.tooltip.style.display = 'none'; this.searchBox.blur(); this.clearResults();
    this.root.classList.remove('is-visible'); this.root.setAttribute('aria-hidden', 'true');
  }

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

    renderMap(ctx, MAP, cam, { background: '#0c1117', layers: this.layers });

    // Hovered street: trace it in world space, over the cartography but under the live markers.
    if (this.hovered) {
      applyWorldTransform(ctx, cam);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max((this.hovered.width || 10) + 4, 3 / this.zoom);
      ctx.globalAlpha = 0.8; ctx.beginPath();
      const pts = this.hovered.points;
      ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // Live game markers, drawn in the minimap's language, in crisp screen space.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawNpcDots(ctx, cam); // `mapnpcs` debug layer, under the mission markers/player
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

  /** `mapnpcs` debug overlay: a tiny dot per ambient car (magenta) / ped (deep blue). Batched by colour —
   *  one path + fill for the whole set — so hundreds of dots stay cheap; no per-dot stroke. */
  private drawNpcDots(ctx: CanvasRenderingContext2D, cam: MapCamera): void {
    const dots = (points: MapPoint[] | undefined, color: string, radius: number): void => {
      if (!points?.length) return;
      ctx.fillStyle = color; ctx.beginPath();
      for (const point of points) {
        const p = markerScreen(point, cam); if (!p.onScreen) continue;
        ctx.moveTo(p.sx + radius, p.sy); ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2); // moveTo first so each dot is its own sub-path
      }
      ctx.fill();
    };
    dots(this.frame.peds, '#1e40ff', 1.8); // deep blue
    dots(this.frame.cars, '#ff33cc', 2.2); // magenta, a touch larger so cars read over the ped swarm
  }

  /** Search box + results dropdown: jump the map to a street by name (GTA-style). */
  private buildSearch(): HTMLElement {
    const wrap = document.createElement('div'); wrap.className = 'map-view-search';
    this.searchBox.type = 'text'; this.searchBox.placeholder = 'Search a street…'; this.searchBox.spellcheck = false;
    this.searchBox.className = 'map-view-search-input';
    this.results.className = 'map-view-search-results';
    this.searchBox.addEventListener('input', () => this.runSearch(this.searchBox.value));
    wrap.addEventListener('mousedown', (e) => e.stopPropagation()); // clicking the search must not start a map drag
    wrap.addEventListener('wheel', (e) => e.stopPropagation());
    wrap.append(this.searchBox, this.results);
    return wrap;
  }

  /** Layer tick-boxes (default all on). */
  private buildFilters(): HTMLElement {
    const panel = document.createElement('div'); panel.className = 'map-view-filters';
    for (const { key, label } of LAYER_TOGGLES) {
      const row = document.createElement('label'); row.className = 'map-view-filter';
      const box = document.createElement('input'); box.type = 'checkbox'; box.checked = true;
      box.addEventListener('change', () => { this.layers[key] = box.checked; this.requestDraw(); });
      row.append(box, document.createTextNode(label));
      panel.append(row);
    }
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    return panel;
  }

  /** Searchable places — streets, districts/suburbs and landmarks — each with a jump point. Built once. */
  private buildStreetIndex(): void {
    if (this.searchIndex.length) return;
    const streets = new Map<string, { x: number; z: number }>();
    for (const road of MAP.roads) {
      if (!road.name || streets.has(road.name)) continue;
      const mid = road.points[Math.floor(road.points.length / 2)]!;
      streets.set(road.name, { x: mid[0], z: mid[1] });
    }
    this.searchIndex = [
      ...[...streets.entries()].map(([name, p]) => ({ name, ...p, kind: 'street' as const })),
      ...MAP.districts.map((d) => ({ name: d.name, x: d.x, z: d.z, kind: 'district' as const })),
      ...MAP.landmarks.map((l) => ({ name: l.name, x: l.x, z: l.z, kind: 'landmark' as const })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  private runSearch(query: string): void {
    const q = query.trim().toLowerCase();
    this.clearResults();
    if (q.length < 2) return;
    // Prefix matches first (what you're typing toward), then substring; districts/landmarks sort ahead of streets.
    const rank = (m: { name: string; kind: string }): number =>
      (m.name.toLowerCase().startsWith(q) ? 0 : 2) + (m.kind === 'street' ? 1 : 0);
    const matches = this.searchIndex.filter((s) => s.name.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b)).slice(0, 8);
    for (const m of matches) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'map-view-result';
      row.innerHTML = `<span>${m.name.replace(/</g, '&lt;')}</span><span class="map-view-result-kind">${m.kind}</span>`;
      row.addEventListener('click', () => { this.jumpTo(m.x, m.z, m.kind); this.searchBox.value = m.name; this.clearResults(); this.searchBox.blur(); });
      this.results.append(row);
    }
    this.results.classList.toggle('is-open', matches.length > 0);
  }

  private clearResults(): void { this.results.replaceChildren(); this.results.classList.remove('is-open'); }

  /** Centre the map on a place and zoom in — wider for a district/suburb, tighter for a street or landmark. */
  private jumpTo(x: number, z: number, kind: 'street' | 'district' | 'landmark' = 'street'): void {
    this.viewX = x; this.viewZ = z; this.zoom = clampZoom(kind === 'district' ? 0.35 : 1.4); this.requestDraw();
  }

  /** Nearest street under the cursor → tooltip + highlight. */
  private hover(sx: number, sy: number): void {
    const w = screenToWorld(sx, sy, this.camera());
    const threshSq = (8 / this.zoom) ** 2;
    let best: MapRoad | undefined; let bestSq = threshSq;
    if (this.layers.roads !== false) for (const road of MAP.roads) {
      const pts = road.points;
      for (let i = 1; i < pts.length; i++) {
        const d = segDistSq(w.x, w.z, pts[i - 1]![0], pts[i - 1]![1], pts[i]![0], pts[i]![1]);
        if (d < bestSq) { bestSq = d; best = road; }
      }
    }
    const changed = best?.name !== this.hovered?.name;
    this.hovered = best;
    if (best?.name) {
      this.tooltip.style.display = 'block';
      this.tooltip.style.left = `${sx + 14}px`; this.tooltip.style.top = `${sy + 12}px`;
      this.tooltip.textContent = best.name;
    } else this.tooltip.style.display = 'none';
    if (changed) this.requestDraw();
  }
}
