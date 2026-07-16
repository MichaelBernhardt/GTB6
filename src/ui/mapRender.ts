/**
 * Shared canvas map renderer — the SINGLE source of truth for drawing the generated Joburg map.
 *
 * Used by BOTH:
 *   - the in-game overlay  src/ui/MapView.ts            (imported as an ES module)
 *   - the dev preview host tools/mapgen/preview.html    (this file's transpiled source is
 *                                                        inline-copied at build time — see
 *                                                        tools/mapgen/preview.ts)
 *
 * The two hosts therefore CANNOT drift: regenerating the preview re-embeds whatever lives here,
 * and a unit test asserts the emitted preview still contains this module's version + source hash.
 *
 * Constraints that keep the inline-copy honest — do not break them:
 *   - PURE canvas 2D over the plain map-JSON shape. NO `three`, NO Game/other-`src` imports.
 *   - Self-contained: only type-level declarations, so the whole file type-strips into one
 *     classic <script> block. (Any real `import` would dangle in the inlined preview.)
 */

/** Bump when the drawing contract changes. Embedded verbatim into the emitted preview. */
export const MAP_RENDER_VERSION = '1.3.0'; // 1.2.0 was claimed twice: corridor-tint removal + snowy hillshade

/** Raw composite metres ASL where the hillshade turns snowy (matches City.SNOWLINE_METRES — the
 *  in-game ground shader whitens the same tops; a unit test keeps the two constants equal). */
export const MAP_SNOWLINE_METRES = 2400;

// ---- Map JSON shape (structural subset this renderer touches) --------------------------------
type Poly2 = [number, number][];
export interface RenderMapData {
  stats: { targetSize: number; metresPerUnit: number; minElevation: number; maxElevation: number };
  roads: Array<{ name: string; width: number; kind: string; points: Poly2 }>;
  tracks: Array<{ name: string; width: number; kind: string; points: Poly2 }>;
  railways: Array<{ name: string; points: Poly2 }>;
  water: Array<{ name: string; points: Poly2 }>;
  landuse: Array<{ name: string; kind: string; points: Poly2 }>;
  districts: Array<{ name: string; x: number; z: number }>;
  landmarks: Array<{ name: string; x: number; z: number }>;
  junctions: Array<{ x: number; z: number }>;
  elevation?: { cols: number; rows: number; x0: number; z0: number; dx: number; dz: number; data: number[] };
  coast?: {
    coastline: Poly2; ocean: Poly2; beaches: Array<{ name: string; points: Poly2 }>;
    harbour: { x: number; z: number };
    /** Corridor band extents (metadata for zoning; the map draws no band tint). */
    corridor: { eastX: number; westX: number; northZ?: number; southZ?: number };
  };
  rural?: { farms: Array<{ x: number; z: number; kind: string }> };
  airport?: {
    runway: { width: number; points: Poly2 }; taxiway: { width: number; points: Poly2 };
    apron: Poly2; buildings: Poly2[];
  };
  port?: { pier: { width: number; points: Poly2 }; apron: Poly2 };
}

/** Camera / viewport for a single frame. viewX/viewZ is the world point at the canvas centre. */
export interface MapCamera { zoom: number; viewX: number; viewZ: number; width: number; height: number; dpr: number }

export interface RenderLayers {
  hillshade: boolean; coast: boolean; corridor: boolean; landuse: boolean; airport: boolean;
  port: boolean; water: boolean; railways: boolean; tracks: boolean; roads: boolean;
  districts: boolean; landmarks: boolean;
}
export interface RenderOptions { layers?: Partial<RenderLayers>; background?: string }

// ---- Palette (mirrors the original preview) --------------------------------------------------
export const ROAD_COLORS: Record<string, string> = {
  motorway: '#ff6b4a', motorway_link: '#c9583f', trunk: '#ff9b45', trunk_link: '#c97e3e',
  primary: '#ffc94d', primary_link: '#c9a244', secondary: '#e8e18a', secondary_link: '#b5b06e',
  tertiary: '#9fd0a8', tertiary_link: '#7fa886', residential: '#8fa0b3',
};
const TRACK_COLORS: Record<string, string> = { track: '#c08a52', path: '#96744e' };
const LANDUSE_COLORS: Record<string, string> = {
  park: '#2e5e3e', golf_course: '#33684a', nature_reserve: '#2a5039', grass: '#2f5c3b',
  forest: '#274f33', wood: '#274f33', scrub: '#3d5a3a', mine_dump: '#7a6a3f', brownfield: '#5c5142',
  aerodrome: '#4a4740',
};
const RUNWAY_COLOR = '#3a3f47';
const TAXIWAY_COLOR = '#585f52';
const AIRPORT_MARK_COLOR = '#e0e6ec';
const PIER_COLOR = '#7c6a55';
const APRON_COLOR = '#6b6f78';
const WATER_COLOR = '#2e6f9e';
const WATER_PREMIUM_COLOR = '#3d89bd';
const OCEAN_COLOR = '#173e63';
const BEACH_COLOR = '#d9c184';
const FARMLAND_COLOR = '#5a4630'; // tilled soil brown, matching the 3D farmland fill (createGrassTexture 'soil')
const DISTRICT_COLOR = '#b9c7d6';
/** Water bodies at least this large (game units^2) get the premium tier styling. */
const PREMIUM_WATER_AREA = 3200;

const KIND_ORDER = ['residential', 'tertiary_link', 'tertiary', 'secondary_link', 'secondary', 'primary_link', 'primary', 'trunk_link', 'trunk', 'motorway_link', 'motorway'];

// ---- Pure geometry helpers (DOM-free, unit-tested) -------------------------------------------
export const MAP_MIN_ZOOM = 0.04; // widest view: frames the whole 18000u parity map in ~720px, same on-screen framing the 36000u map had at 0.02
export const MAP_MAX_ZOOM = 40;

/** Clamp a zoom factor to the renderer's supported range. */
export function clampZoom(zoom: number, min: number = MAP_MIN_ZOOM, max: number = MAP_MAX_ZOOM): number {
  return Math.min(max, Math.max(min, zoom));
}

/** Zoom that frames a square `targetSize` world into the given viewport (with a little padding). */
export function fitZoom(targetSize: number, width: number, height: number, pad = 1.08): number {
  return Math.min(width, height) / (targetSize * pad);
}

/** World (x, z) → canvas CSS pixel (sx, sy). Inverse of {@link screenToWorld}. */
export function worldToScreen(x: number, z: number, cam: MapCamera): { sx: number; sy: number } {
  return { sx: cam.width / 2 + (x - cam.viewX) * cam.zoom, sy: cam.height / 2 + (z - cam.viewZ) * cam.zoom };
}

/** Canvas CSS pixel (sx, sy) → world (x, z). Inverse of {@link worldToScreen}. */
export function screenToWorld(sx: number, sy: number, cam: MapCamera): { x: number; z: number } {
  return { x: cam.viewX + (sx - cam.width / 2) / cam.zoom, z: cam.viewZ + (sy - cam.height / 2) / cam.zoom };
}

/** Screen position of a world marker; `onScreen` false when it falls outside the viewport (+pad). */
export function markerScreen(
  marker: { x: number; z: number }, cam: MapCamera, pad = 24,
): { sx: number; sy: number; onScreen: boolean } {
  const { sx, sy } = worldToScreen(marker.x, marker.z, cam);
  const onScreen = sx >= -pad && sy >= -pad && sx <= cam.width + pad && sy <= cam.height + pad;
  return { sx, sy, onScreen };
}

/** Weapon-cycle scroll only responds while no full-screen map overlay is up. */
export function weaponWheelResponds(mapOpen: boolean): boolean { return !mapOpen; }

/** Device-pixel world transform: world units → device pixels for the current camera. */
export function applyWorldTransform(ctx: CanvasRenderingContext2D, cam: MapCamera): void {
  ctx.setTransform(
    cam.dpr * cam.zoom, 0, 0, cam.dpr * cam.zoom,
    cam.dpr * (cam.width / 2 - cam.viewX * cam.zoom), cam.dpr * (cam.height / 2 - cam.viewZ * cam.zoom),
  );
}

function polyArea(points: Poly2): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!; const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
}

// ---- Prebuilt, cached per-map geometry -------------------------------------------------------
interface Prebuilt {
  roadPaths: Array<{ kind: string; width: number; path: Path2D }>;
  trackPaths: Array<{ kind: string; width: number; path: Path2D }>;
  landusePaths: Array<{ kind: string; path: Path2D }>;
  premiumWaterPath: Path2D | null;
  pondWaterPath: Path2D | null;
  railPath: Path2D | null;
  oceanPath: Path2D | null;
  coastlinePath: Path2D | null;
  beachPath: Path2D | null;
  farmlandPath: Path2D | null;
  runwayPath: Path2D | null;
  taxiwayPath: Path2D | null;
  airportApronPath: Path2D | null;
  airportBuildingsPath: Path2D | null;
  pierPath: Path2D | null;
  portApronPath: Path2D | null;
  hillshade: { canvas: HTMLCanvasElement; x: number; z: number; w: number; h: number } | null;
}
const CACHE = new WeakMap<RenderMapData, Prebuilt>();

function pathOf(lines: Array<{ points: Poly2 }>): Path2D {
  const p = new Path2D();
  for (const line of lines) {
    const pts = line.points; if (!pts.length) continue;
    p.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]![0], pts[i]![1]);
  }
  return p;
}
function polyPathOf(polys: Array<{ points: Poly2 }>): Path2D {
  const p = new Path2D();
  for (const poly of polys) {
    const pts = poly.points; if (!pts.length) continue;
    p.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]![0], pts[i]![1]);
    p.closePath();
  }
  return p;
}

/** Deterministic 2-D value noise in [0, 1] for the snowline dither (self-contained — no imports). */
function snowNoise(x: number, z: number): number {
  const h = (ix: number, iz: number): number => { const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453; return s - Math.floor(s); };
  const ix = Math.floor(x); const iz = Math.floor(z);
  const fx = x - ix; const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx); const uz = fz * fz * (3 - 2 * fz);
  const a = h(ix, iz); const b = h(ix + 1, iz); const c = h(ix, iz + 1); const d = h(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function buildHillshade(map: RenderMapData): Prebuilt['hillshade'] {
  const e = map.elevation;
  if (!e || e.data.every((v) => v === e.data[0])) return null;
  const c = document.createElement('canvas');
  c.width = e.cols; c.height = e.rows;
  const g = c.getContext('2d'); if (!g) return null;
  const img = g.createImageData(e.cols, e.rows);
  const min = map.stats.minElevation; const max = Math.max(map.stats.maxElevation, min + 1);
  const cell = Math.abs(e.dx) * map.stats.metresPerUnit;
  const at = (col: number, row: number): number =>
    e.data[Math.max(0, Math.min(e.rows - 1, row)) * e.cols + Math.max(0, Math.min(e.cols - 1, col))]!;
  for (let row = 0; row < e.rows; row++) {
    for (let col = 0; col < e.cols; col++) {
      const dzdx = (at(col + 1, row) - at(col - 1, row)) / (2 * cell);
      const dzdy = (at(col, row + 1) - at(col, row - 1)) / (2 * cell);
      let shade = 0.72 - 2.2 * (dzdx * -0.707 + dzdy * -0.707);
      shade = Math.max(0.25, Math.min(1.15, shade));
      const t = (at(col, row) - min) / (max - min);
      let r = 46 + 44 * t; let bg = 56 + 40 * t; let bb = 52 + 30 * t;
      // Snowy tops: blend toward white above the (noise-dithered) snowline, keeping the relief shading.
      const metres = at(col, row); // grid values are metres ASL already
      const dither = (snowNoise(col * 0.31, row * 0.31) * 0.7 + snowNoise(col * 1.17, row * 1.17) * 0.3 - 0.5) * 240;
      const snow = Math.max(0, Math.min(1, (metres - (MAP_SNOWLINE_METRES + dither)) / 150));
      if (snow > 0) { r += (236 - r) * snow; bg += (241 - bg) * snow; bb += (247 - bb) * snow; shade = Math.min(1.15, shade + 0.22 * snow); }
      const i = (row * e.cols + col) * 4;
      img.data[i] = r * shade; img.data[i + 1] = bg * shade; img.data[i + 2] = bb * shade; img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, x: e.x0 - e.dx / 2, z: e.z0 - e.dz / 2, w: e.dx * e.cols, h: e.dz * e.rows };
}

function prebuild(map: RenderMapData): Prebuilt {
  const cached = CACHE.get(map); if (cached) return cached;

  const roadsByKind: Record<string, RenderMapData['roads']> = {};
  for (const road of map.roads) (roadsByKind[road.kind] ||= []).push(road);
  const roadPaths = Object.entries(roadsByKind)
    .map(([kind, roads]) => ({ kind, width: roads[0]!.width, path: pathOf(roads) }))
    .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  const tracksByKind: Record<string, RenderMapData['tracks']> = {};
  for (const t of map.tracks) (tracksByKind[t.kind] ||= []).push(t);
  const trackPaths = Object.entries(tracksByKind).map(([kind, ts]) => ({ kind, width: ts[0]!.width, path: pathOf(ts) }));

  const landuseByKind: Record<string, RenderMapData['landuse']> = {};
  for (const area of map.landuse) if (area.kind !== 'farmland') (landuseByKind[area.kind] ||= []).push(area);
  const landusePaths = Object.entries(landuseByKind).map(([kind, areas]) => ({ kind, path: polyPathOf(areas) }));

  const premiumWater = map.water.filter((w) => polyArea(w.points) >= PREMIUM_WATER_AREA);
  const pondWater = map.water.filter((w) => polyArea(w.points) < PREMIUM_WATER_AREA);
  const coast = map.coast ?? null;
  const farmFields = map.landuse.filter((a) => a.kind === 'farmland');
  const airport = map.airport ?? null;
  const port = map.port ?? null;

  const built: Prebuilt = {
    roadPaths, trackPaths, landusePaths,
    premiumWaterPath: premiumWater.length ? polyPathOf(premiumWater) : null,
    pondWaterPath: pondWater.length ? polyPathOf(pondWater) : null,
    railPath: map.railways.length ? pathOf(map.railways) : null,
    oceanPath: coast ? polyPathOf([{ points: coast.ocean }]) : null,
    coastlinePath: coast ? pathOf([{ points: coast.coastline }]) : null,
    beachPath: coast && coast.beaches.length ? polyPathOf(coast.beaches) : null,
    farmlandPath: farmFields.length ? polyPathOf(farmFields) : null,
    runwayPath: airport ? pathOf([airport.runway]) : null,
    taxiwayPath: airport ? pathOf([airport.taxiway]) : null,
    airportApronPath: airport ? polyPathOf([{ points: airport.apron }]) : null,
    airportBuildingsPath: airport ? polyPathOf(airport.buildings.map((b) => ({ points: b }))) : null,
    pierPath: port ? pathOf([port.pier]) : null,
    portApronPath: port ? polyPathOf([{ points: port.apron }]) : null,
    hillshade: buildHillshade(map),
  };
  CACHE.set(map, built);
  return built;
}

const DEFAULT_LAYERS: RenderLayers = {
  hillshade: true, coast: true, corridor: true, landuse: true, airport: true, port: true,
  water: true, railways: true, tracks: true, roads: true, districts: true, landmarks: true,
};

/**
 * Draw the full base cartography (terrain, coast, landuse, water, roads, labels) for one frame.
 * Host-specific overlays (player arrow, live markers, dev clutter) are layered on top by the
 * caller — see {@link drawPlayerArrow} / {@link drawMarker}.
 */
export function renderMap(ctx: CanvasRenderingContext2D, map: RenderMapData, cam: MapCamera, opts: RenderOptions = {}): void {
  const layers = { ...DEFAULT_LAYERS, ...opts.layers };
  const g = prebuild(map);
  const zoom = cam.zoom;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = opts.background ?? '#10151c';
  ctx.fillRect(0, 0, cam.width * cam.dpr, cam.height * cam.dpr);
  applyWorldTransform(ctx, cam);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  if (layers.hillshade && g.hillshade) {
    ctx.save(); ctx.globalAlpha = 0.55; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(g.hillshade.canvas, g.hillshade.x, g.hillshade.z, g.hillshade.w, g.hillshade.h); ctx.restore();
  }
  if (layers.coast && map.coast) {
    if (g.oceanPath) { ctx.fillStyle = OCEAN_COLOR; ctx.globalAlpha = 0.92; ctx.fill(g.oceanPath); ctx.globalAlpha = 1; }
    if (g.beachPath) { ctx.fillStyle = BEACH_COLOR; ctx.globalAlpha = 0.9; ctx.fill(g.beachPath); ctx.globalAlpha = 1; }
    if (g.coastlinePath) { ctx.strokeStyle = '#8fc7e8'; ctx.lineWidth = Math.max(3, 1.6 / zoom); ctx.stroke(g.coastlinePath); }
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath(); ctx.arc(map.coast.harbour.x, map.coast.harbour.z, Math.max(9, 5 / zoom), 0, Math.PI * 2); ctx.fill();
  }
  if (layers.corridor && map.coast) {
    // No band tint or dashed boundary: the corridor is communicated by its farmland fields and
    // veld — a straight-edged administrative rectangle read as an artifact on the map (owner).
    if (g.farmlandPath) {
      ctx.fillStyle = FARMLAND_COLOR; ctx.globalAlpha = 0.55; ctx.fill(g.farmlandPath); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#7a6244'; ctx.lineWidth = Math.max(1.5, 1 / zoom); ctx.stroke(g.farmlandPath);
    }
    if (map.rural) {
      for (const farm of map.rural.farms) {
        ctx.fillStyle = farm.kind === 'windmill' ? '#c9d4dd' : farm.kind === 'silo' ? '#b8a884' : '#a5643c';
        const r = Math.max(5, 3 / zoom);
        ctx.fillRect(farm.x - r, farm.z - r, r * 2, r * 2);
      }
    }
  }
  if (layers.landuse) {
    for (const { kind, path } of g.landusePaths) {
      ctx.fillStyle = LANDUSE_COLORS[kind] || '#31543a';
      ctx.globalAlpha = kind === 'mine_dump' ? 0.85 : 0.55;
      ctx.fill(path);
    }
    ctx.globalAlpha = 1;
  }
  if (layers.airport && map.airport) {
    if (g.airportApronPath) { ctx.fillStyle = APRON_COLOR; ctx.globalAlpha = 0.75; ctx.fill(g.airportApronPath); ctx.globalAlpha = 1; }
    if (g.airportBuildingsPath) { ctx.fillStyle = AIRPORT_MARK_COLOR; ctx.globalAlpha = 0.9; ctx.fill(g.airportBuildingsPath); ctx.globalAlpha = 1; }
    if (g.runwayPath) {
      ctx.strokeStyle = RUNWAY_COLOR; ctx.lineWidth = Math.max(map.airport.runway.width, 2 / zoom); ctx.stroke(g.runwayPath);
      ctx.strokeStyle = '#e8ecf0'; ctx.lineWidth = Math.max(1, 0.6 / zoom); ctx.setLineDash([18, 14]); ctx.stroke(g.runwayPath); ctx.setLineDash([]);
    }
    if (g.taxiwayPath) { ctx.strokeStyle = TAXIWAY_COLOR; ctx.lineWidth = Math.max(map.airport.taxiway.width, 1.6 / zoom); ctx.stroke(g.taxiwayPath); }
  }
  if (layers.port && map.port) {
    if (g.portApronPath) { ctx.fillStyle = APRON_COLOR; ctx.globalAlpha = 0.8; ctx.fill(g.portApronPath); ctx.globalAlpha = 1; }
    if (g.pierPath) { ctx.strokeStyle = PIER_COLOR; ctx.lineWidth = Math.max(map.port.pier.width, 1.6 / zoom); ctx.stroke(g.pierPath); }
  }
  if (layers.water) {
    if (g.pondWaterPath) { ctx.fillStyle = WATER_COLOR; ctx.fill(g.pondWaterPath); }
    if (g.premiumWaterPath) {
      ctx.fillStyle = WATER_PREMIUM_COLOR; ctx.fill(g.premiumWaterPath);
      ctx.strokeStyle = '#7fc4ea'; ctx.lineWidth = Math.max(2, 1.2 / zoom); ctx.stroke(g.premiumWaterPath);
    }
  }
  if (layers.railways && g.railPath) {
    ctx.strokeStyle = '#5c6b7c'; ctx.lineWidth = Math.max(2, 1.5 / zoom); ctx.setLineDash([12, 8]);
    ctx.stroke(g.railPath); ctx.setLineDash([]);
  }
  if (layers.tracks) {
    for (const { kind, width, path } of g.trackPaths) {
      ctx.strokeStyle = TRACK_COLORS[kind] || '#c08a52'; ctx.lineWidth = Math.max(width, 1.2 / zoom);
      ctx.setLineDash([10, 7]); ctx.stroke(path);
    }
    ctx.setLineDash([]);
  }
  if (layers.roads) {
    for (const { kind, width, path } of g.roadPaths) {
      ctx.strokeStyle = ROAD_COLORS[kind] || '#8fa0b3'; ctx.lineWidth = Math.max(width, 1.4 / zoom);
      ctx.stroke(path);
    }
  }

  // Screen-space labels (crisp text, independent of world zoom).
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  if (layers.districts && zoom > 0.05) {
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center';
    for (const d of map.districts) {
      const { sx, sy, onScreen } = markerScreen(d, cam, 50);
      if (!onScreen) continue;
      const label = d.name.toUpperCase();
      const w = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(16,21,28,0.65)'; ctx.fillRect(sx - w / 2 - 3, sy - 9, w + 6, 13);
      ctx.fillStyle = DISTRICT_COLOR; ctx.fillText(label, sx, sy + 1);
    }
  }
  if (layers.landmarks) {
    ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'left';
    for (const l of map.landmarks) {
      const { sx, sy, onScreen } = markerScreen(l, cam, 100);
      if (!onScreen) continue;
      drawStar(ctx, sx, sy, 6, '#ffd75e');
      if (zoom > 0.1) { ctx.fillStyle = '#ffd75e'; ctx.fillText(l.name, sx + 9, sy + 4); }
    }
  }
}

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.save(); ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx[i === 0 ? 'moveTo' : 'lineTo'](x + rad * Math.cos(a), y + rad * Math.sin(a));
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
}

/**
 * Draw a live game marker in the minimap's visual language, in screen space.
 * Shapes mirror {@link MinimapView}: gold mission circles, teal shop diamonds, safehouse houses.
 */
export function drawMarker(
  ctx: CanvasRenderingContext2D, sx: number, sy: number, color: string,
  shape: 'circle' | 'diamond' | 'house' | 'square' = 'circle', size = 7,
): void {
  ctx.save(); ctx.translate(sx, sy);
  ctx.fillStyle = color; ctx.strokeStyle = '#111817'; ctx.lineWidth = 2; ctx.beginPath();
  const s = size;
  if (shape === 'diamond') { ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0); ctx.closePath(); }
  else if (shape === 'house') { ctx.moveTo(0, -s * 1.1); ctx.lineTo(s * 0.85, -s * 0.2); ctx.lineTo(s * 0.85, s * 0.85); ctx.lineTo(-s * 0.85, s * 0.85); ctx.lineTo(-s * 0.85, -s * 0.2); ctx.closePath(); }
  else if (shape === 'square') { ctx.rect(-s * 0.8, -s * 0.8, s * 1.6, s * 1.6); }
  else ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill(); ctx.stroke(); ctx.restore();
}

/**
 * Draw the player arrow at a screen position on the north-up map, pointing along the player's
 * facing. World forward is (sin h, cos h); an up-pointing arrow rotates by (π − heading) onto it.
 */
export function drawPlayerArrow(ctx: CanvasRenderingContext2D, sx: number, sy: number, heading: number, size = 15): void {
  ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.PI - heading);
  ctx.fillStyle = '#f7c843'; ctx.strokeStyle = '#101615'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(-size * 0.62, size * 0.77); ctx.lineTo(0, size * 0.46); ctx.lineTo(size * 0.62, size * 0.77); ctx.closePath();
  ctx.fill(); ctx.stroke(); ctx.restore();
}
