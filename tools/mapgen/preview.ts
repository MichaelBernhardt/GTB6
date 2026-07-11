import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { CURRENT_JUNCTIONS, CURRENT_ROAD_NETWORK } from './current-network';
import type { JoburgMap } from './types';

/**
 * Build a fully self-contained preview page: canvas renderer with pan/zoom, layer toggles,
 * road-name hover, and an overlay of the current hand-authored in-game network for comparison.
 *
 * SINGLE-SOURCE GUARANTEE: the actual map drawing is NOT written here. The preview inline-copies
 * the transpiled source of src/ui/mapRender.ts — the very module the in-game MapView imports — so
 * the two hosts cannot drift. This file only adds the dev-only host chrome (stats panel, layer
 * toggles, road-name hover, junction dots, old-network overlay) on top of the shared `renderMap`.
 * output.test.ts asserts the emitted preview still embeds this module's version + source hash.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER_PATH = join(HERE, '../../src/ui/mapRender.ts');
const RENDERER_SOURCE = readFileSync(RENDERER_PATH, 'utf8');

/** sha256 (first 12 hex) of the shared renderer source — stamped into the preview and checked in tests. */
export function rendererHash(): string {
  return createHash('sha256').update(RENDERER_SOURCE).digest('hex').slice(0, 12);
}

/** Version constant declared in mapRender.ts, read straight from source (no cross-tsconfig import). */
export function rendererVersion(): string {
  return /MAP_RENDER_VERSION\s*=\s*'([^']+)'/.exec(RENDERER_SOURCE)?.[1] ?? 'unknown';
}

/**
 * Transpile the shared renderer to a classic (non-module) script body: strip TypeScript types and
 * turn `export` declarations into plain top-level declarations so every symbol lands in the inline
 * <script>'s scope (both the exported API and the module-private colour constants the panel reuses).
 */
export function renderMapModuleJs(): string {
  const js = ts.transpileModule(RENDERER_SOURCE, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    fileName: 'mapRender.ts',
  }).outputText;
  return js
    .replace(/^export (const|let|var|function|class|async) /gm, '$1 ')
    .replace(/^export default /gm, '')
    .replace(/^export \{[^}]*\};?\s*$/gm, '');
}

export function buildPreviewHtml(map: JoburgMap): string {
  const mapJson = JSON.stringify(map);
  const currentJson = JSON.stringify({ roads: CURRENT_ROAD_NETWORK, junctions: CURRENT_JUNCTIONS });
  const meta = `/* mapRender v${rendererVersion()} sha256:${rendererHash()} — inlined from src/ui/mapRender.ts, do not edit here */`;
  return TEMPLATE
    .replace('/*__RENDERER__*/', () => `${meta}\n${renderMapModuleJs()}`)
    .replace('"__MAP_DATA__"', () => mapJson)
    .replace('"__CURRENT_NETWORK__"', () => currentJson);
}

const TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Groot Theft Bakkie — Jozi-by-the-Sea Map Preview</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; overflow: hidden; background: #10151c; font-family: system-ui, sans-serif; color: #cfd8e3; }
  #canvas { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
  #canvas.dragging { cursor: grabbing; }
  #panel {
    position: absolute; top: 12px; left: 12px; width: 280px; max-height: calc(100% - 24px); overflow-y: auto;
    background: rgba(16, 21, 28, 0.92); border: 1px solid #2a3542; border-radius: 10px; padding: 14px 16px;
    font-size: 12.5px; line-height: 1.5; backdrop-filter: blur(4px);
  }
  #panel h1 { font-size: 15px; color: #f0b429; margin-bottom: 2px; }
  #panel h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #7a8899; margin: 10px 0 4px; }
  #panel .sub { color: #7a8899; font-size: 11px; margin-bottom: 6px; }
  #stats { display: grid; grid-template-columns: auto auto; gap: 0 10px; }
  #stats .v { text-align: right; font-variant-numeric: tabular-nums; color: #e8eef5; }
  label.toggle { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; padding: 1px 0; }
  label.toggle input { accent-color: #f0b429; }
  .legend-row { display: flex; align-items: center; gap: 8px; padding: 1px 0; }
  .swatch { width: 22px; height: 4px; border-radius: 2px; flex: none; }
  .swatch.dot { width: 10px; height: 10px; border-radius: 50%; }
  #tooltip {
    position: absolute; pointer-events: none; display: none; z-index: 5;
    background: rgba(10, 14, 19, 0.95); border: 1px solid #3a4a5c; border-radius: 6px; padding: 6px 10px;
    font-size: 12.5px; color: #f2f6fa; box-shadow: 0 4px 14px rgba(0,0,0,0.5); white-space: nowrap;
  }
  #tooltip .kind { color: #8fa2b5; font-size: 11px; }
  #attribution { position: absolute; bottom: 8px; left: 12px; font-size: 11px; color: #6b7887; }
  #scalebar { position: absolute; bottom: 26px; right: 16px; font-size: 11px; color: #9fb0c2; text-align: right; }
  #scalebar .bar { height: 3px; background: #9fb0c2; border-radius: 2px; margin-top: 3px; }
  #hint { position: absolute; bottom: 8px; right: 16px; font-size: 11px; color: #6b7887; }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="panel">
  <h1>Groot Theft Bakkie — Jozi-by-the-Sea</h1>
  <div class="sub">OSM Joburg crop + Cape seaboard graft — Phase 2 layout preview</div>
  <h2>Stats</h2>
  <div id="stats"></div>
  <h2>Layers</h2>
  <div id="toggles"></div>
  <h2>Road classes</h2>
  <div id="legend"></div>
</div>
<div id="tooltip"></div>
<div id="scalebar"><span id="scalelabel"></span><div class="bar" id="scalebarline"></div></div>
<div id="attribution">Map data © OpenStreetMap contributors, ODbL · Elevation: SRTM</div>
<div id="hint">drag to pan · scroll to zoom · hover roads for names</div>
<script>
'use strict';
// ===== SHARED RENDERER (single source of truth — see src/ui/mapRender.ts) =====
/*__RENDERER__*/
// ===== DEV PREVIEW HOST (chrome only; all map drawing goes through renderMap above) =====
const MAP = "__MAP_DATA__";
const CURRENT = "__CURRENT_NETWORK__";
const CURRENT_COLOR = '#ff4fd8';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const dpr = window.devicePixelRatio || 1;

const layers = {
  hillshade: { label: 'Terrain hillshade', on: true },
  coast: { label: 'Coast / ocean', on: true },
  corridor: { label: 'Corridor / farmland', on: true },
  landuse: { label: 'Parks / landuse', on: true },
  airport: { label: 'Airport', on: true },
  port: { label: 'Sea port / pier', on: true },
  water: { label: 'Water (game tiers)', on: true },
  railways: { label: 'Railways', on: true },
  tracks: { label: 'Off-road tracks', on: true },
  roads: { label: 'Roads', on: true },
  junctions: { label: 'Junctions', on: false },
  districts: { label: 'District labels', on: true },
  landmarks: { label: 'Landmarks', on: true },
  current: { label: 'Old in-game network', on: false },
};

let zoom, viewX = 0, viewZ = 0;
function cam() { return { zoom, viewX, viewZ, width: window.innerWidth, height: window.innerHeight, dpr }; }
function renderLayers() { const out = {}; for (const k in layers) out[k] = layers[k].on; return out; }
function fitView() { zoom = fitZoom(MAP.stats.targetSize, window.innerWidth, window.innerHeight); viewX = 0; viewZ = 0; }
fitView();

// Dev-only geometry the shared renderer does not draw (junction dots + the old hand-authored network).
const junctionPath = new Path2D();
for (const j of MAP.junctions) { junctionPath.moveTo(j.x + 2.5, j.z); junctionPath.arc(j.x, j.z, 2.5, 0, Math.PI * 2); }
const currentPath = pathOf(CURRENT.roads.map(r => r.closed ? { points: [...r.points, r.points[0]].map(p => [p.x, p.z]) } : { points: r.points.map(p => [p.x, p.z]) }));
const premiumWaterCount = MAP.water.filter(w => polyArea(w.points) >= 3200).length;

let hovered = null;
function resize() {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  draw();
}
function draw() {
  const c = cam();
  renderMap(ctx, MAP, c, { layers: renderLayers() });
  // Dev overlays, drawn in world space on top of the shared cartography.
  applyWorldTransform(ctx, c);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (hovered) {
    const p = pathOf([hovered]);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max((hovered.width || 10) + 4, 3 / zoom);
    ctx.globalAlpha = 0.85; ctx.stroke(p); ctx.globalAlpha = 1;
  }
  if (layers.junctions.on) { ctx.fillStyle = '#ffe08a'; ctx.fill(junctionPath); }
  if (layers.current.on) {
    ctx.strokeStyle = CURRENT_COLOR; ctx.lineWidth = Math.max(6, 2.5 / zoom);
    ctx.globalAlpha = 0.9; ctx.stroke(currentPath); ctx.globalAlpha = 1;
    ctx.fillStyle = CURRENT_COLOR;
    for (const j of CURRENT.junctions) { ctx.beginPath(); ctx.arc(j.x, j.z, Math.max(8, 4 / zoom), 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawScalebar();
}
function drawScalebar() {
  const targetPx = 120;
  const metres = targetPx / zoom * MAP.stats.metresPerUnit;
  const nice = [100, 200, 500, 1000, 2000, 5000, 10000].reduce((a, b) => Math.abs(b - metres) < Math.abs(a - metres) ? b : a);
  const px = nice / MAP.stats.metresPerUnit * zoom;
  document.getElementById('scalelabel').textContent = nice >= 1000 ? (nice / 1000) + ' km' : nice + ' m';
  document.getElementById('scalebarline').style.width = px.toFixed(0) + 'px';
}

// ---- Interaction --------------------------------------------------------------
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.classList.add('dragging'); });
window.addEventListener('mouseup', () => { dragging = false; canvas.classList.remove('dragging'); });
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    viewX -= (e.clientX - lastX) / zoom; viewZ -= (e.clientY - lastY) / zoom;
    lastX = e.clientX; lastY = e.clientY; tooltip.style.display = 'none';
    requestAnimationFrame(draw);
  } else hover(e);
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = screenToWorld(e.clientX, e.clientY, cam());
  zoom = clampZoom(zoom * Math.exp(-e.deltaY * 0.0015));
  const after = screenToWorld(e.clientX, e.clientY, cam());
  viewX += before.x - after.x; viewZ += before.z - after.z;
  requestAnimationFrame(draw);
}, { passive: false });
window.addEventListener('dblclick', () => { fitView(); draw(); });

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az; const l2 = dx * dx + dz * dz;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / l2; t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qz = az + t * dz; return Math.hypot(px - qx, pz - qz);
}
function hover(e) {
  const w = screenToWorld(e.clientX, e.clientY, cam());
  const threshold = 8 / zoom; let best = null, bestD = threshold;
  const scan = (items, isTrack) => {
    for (const item of items) {
      const pts = item.points;
      for (let i = 1; i < pts.length; i++) {
        const d = segDist(w.x, w.z, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
        if (d < bestD) { bestD = d; best = { ...item, isTrack }; }
      }
    }
  };
  if (layers.roads.on) scan(MAP.roads, false);
  if (layers.tracks.on) scan(MAP.tracks, true);
  const changed = (best && best.name) !== (hovered && hovered.name);
  hovered = best;
  if (best) {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 14) + 'px'; tooltip.style.top = (e.clientY + 12) + 'px';
    tooltip.innerHTML = '<b>' + escapeHtml(best.name) + '</b><br><span class="kind">' + best.kind +
      (best.unpaved ? ' · unpaved' : '') + ' · width ' + best.width + '</span>';
  } else tooltip.style.display = 'none';
  if (changed) requestAnimationFrame(draw);
}
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- Panel ----------------------------------------------------------------------
function buildPanel() {
  const s = MAP.stats;
  const rows = [
    ['Road network', s.totalRoadKm + ' km'],
    ['Road polylines', s.roadCount],
    ['Junctions', s.junctionCount],
    ['Off-road tracks', s.trackCount + ' (' + s.trackKm + ' km)'],
    ['Landuse polygons', s.landuseCount],
    ['Water bodies', s.waterCount + ' (' + premiumWaterCount + ' premium tier)'],
    ['Districts', s.districtCount],
    ['Landmarks', s.landmarkCount],
    ['Islands bridged', s.bridgedIslands],
    ['Islands dropped', s.droppedIslands + ' (' + s.droppedIslandKm + ' km)'],
    ['Elevation', s.minElevation + '–' + s.maxElevation + ' m'],
    ['Footprint', s.targetSize + ' units (1 u = ' + s.metresPerUnit + ' m)'],
  ];
  if (s.oceanKm2 !== undefined) {
    rows.push(['Ocean', s.oceanKm2 + ' km²'], ['Land', s.landKm2 + ' km²'],
      ['Corridor width', s.corridorWidthUnits + ' u (' + Math.round(s.corridorWidthUnits * s.metresPerUnit / 100) / 10 + ' km)'],
      ['Beaches', (MAP.coast ? MAP.coast.beaches.length : 0)],
      ['Farm buildings', (MAP.rural ? MAP.rural.farms.length : 0)]);
  }
  if (MAP.airport) rows.push(['Airport', MAP.airport.name]);
  if (MAP.port) rows.push(['Sea port', MAP.port.name]);
  const damNames = MAP.water.filter(w => polyArea(w.points) >= 3200).map(w => w.name);
  if (damNames.length) rows.push(['Dams / lakes', damNames.slice(0, 3).join(', ') + (damNames.length > 3 ? '…' : '')]);
  document.getElementById('stats').innerHTML = rows.map(([k, v]) =>
    '<div>' + k + '</div><div class="v">' + v + '</div>').join('');
  const toggles = document.getElementById('toggles');
  for (const key of Object.keys(layers)) {
    const layer = layers[key];
    const label = document.createElement('label'); label.className = 'toggle';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = layer.on;
    input.addEventListener('change', () => { layer.on = input.checked; draw(); });
    label.append(input, document.createTextNode(layer.label));
    toggles.append(label);
  }
  const legend = document.getElementById('legend');
  const entries = [
    ...['motorway','trunk','primary','secondary','tertiary','residential'].map(k => [ROAD_COLORS[k], k]),
    ['#c08a52', 'track / path (unpaved)'],
    ['#173e63', 'ocean'],
    ['#d9c184', 'beach'],
    ['#3d89bd', 'dam / lake (premium water tier)'],
    ['#2e6f9e', 'pond (cheap water tier)'],
    ['#6d7a3a', 'farmland (corridor)'],
    ['#3a3f47', 'runway / taxiway (airport)'],
    ['#7c6a55', 'pier (sea port)'],
    ['#2e5e3e', 'park / green'],
    ['#7a6a3f', 'mine dump / quarry'],
    [CURRENT_COLOR, 'old in-game network'],
  ];
  legend.innerHTML = entries.map(([c, n]) =>
    '<div class="legend-row"><span class="swatch" style="background:' + c + '"></span>' + n + '</div>').join('');
}
buildPanel();
window.addEventListener('resize', resize);
resize();
</script>
</body>
</html>
`;
