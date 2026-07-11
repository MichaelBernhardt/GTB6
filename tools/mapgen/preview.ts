import { CURRENT_JUNCTIONS, CURRENT_ROAD_NETWORK } from './current-network';
import type { JoburgMap } from './types';

/**
 * Build a fully self-contained preview page: canvas renderer with pan/zoom,
 * layer toggles, hillshade, road-name hover, and an overlay of the current
 * hand-authored in-game network for comparison.
 */
export function buildPreviewHtml(map: JoburgMap): string {
  const mapJson = JSON.stringify(map);
  const currentJson = JSON.stringify({ roads: CURRENT_ROAD_NETWORK, junctions: CURRENT_JUNCTIONS });
  return TEMPLATE.replace('"__MAP_DATA__"', mapJson).replace('"__CURRENT_NETWORK__"', currentJson);
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
const MAP = "__MAP_DATA__";
const CURRENT = "__CURRENT_NETWORK__";

const ROAD_COLORS = {
  motorway: '#ff6b4a', motorway_link: '#c9583f',
  trunk: '#ff9b45', trunk_link: '#c97e3e',
  primary: '#ffc94d', primary_link: '#c9a244',
  secondary: '#e8e18a', secondary_link: '#b5b06e',
  tertiary: '#9fd0a8', tertiary_link: '#7fa886',
  residential: '#8fa0b3',
};
const TRACK_COLORS = { track: '#c08a52', path: '#96744e' };
const LANDUSE_COLORS = {
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
const FARMLAND_COLOR = '#6d7a3a';
const DISTRICT_COLOR = '#b9c7d6';
const CURRENT_COLOR = '#ff4fd8';
/** Water bodies at least this large (game units^2) get the premium wavy/reflective tier in-game. */
const PREMIUM_WATER_AREA = 3200;

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
function fitView() {
  const size = MAP.stats.targetSize;
  zoom = Math.min(window.innerWidth, window.innerHeight) / (size * 1.08);
  viewX = 0; viewZ = 0;
}
fitView();

// ---- Prebuilt geometry ------------------------------------------------------
function pathOf(lines) {
  const p = new Path2D();
  for (const line of lines) {
    const pts = line.points;
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
  }
  return p;
}
function polyPathOf(polys) {
  const p = new Path2D();
  for (const poly of polys) {
    const pts = poly.points;
    p.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]);
    p.closePath();
  }
  return p;
}
const roadsByKind = {};
for (const road of MAP.roads) (roadsByKind[road.kind] ||= []).push(road);
const roadPaths = Object.entries(roadsByKind).map(([kind, roads]) => ({
  kind, width: roads[0].width, path: pathOf(roads),
}));
const KIND_ORDER = ['residential','tertiary_link','tertiary','secondary_link','secondary','primary_link','primary','trunk_link','trunk','motorway_link','motorway'];
roadPaths.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
const trackPathsByKind = {};
for (const t of MAP.tracks) (trackPathsByKind[t.kind] ||= []).push(t);
const trackPaths = Object.entries(trackPathsByKind).map(([kind, ts]) => ({ kind, width: ts[0].width, path: pathOf(ts) }));
const landusePaths = {};
for (const area of MAP.landuse) { if (area.kind !== 'farmland') (landusePaths[area.kind] ||= []).push(area); }
const landusePathList = Object.entries(landusePaths).map(([kind, areas]) => ({ kind, path: polyPathOf(areas) }));
function polyArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area / 2);
}
const premiumWater = MAP.water.filter(w => polyArea(w.points) >= PREMIUM_WATER_AREA);
const pondWater = MAP.water.filter(w => polyArea(w.points) < PREMIUM_WATER_AREA);
const premiumWaterPath = premiumWater.length ? polyPathOf(premiumWater) : null;
const pondWaterPath = pondWater.length ? polyPathOf(pondWater) : null;
const railPath = MAP.railways.length ? pathOf(MAP.railways) : null;
// Composite coast + corridor geometry.
const COAST = MAP.coast || null;
const RURAL = MAP.rural || null;
const oceanPath = COAST ? polyPathOf([{ points: COAST.ocean }]) : null;
const coastlinePath = COAST ? pathOf([{ points: COAST.coastline }]) : null;
const beachPath = COAST && COAST.beaches.length ? polyPathOf(COAST.beaches) : null;
// Farmland lives in landuse but toggles with the corridor layer.
const farmlandPath = (() => {
  const fields = MAP.landuse.filter(a => a.kind === 'farmland');
  return fields.length ? polyPathOf(fields) : null;
})();
// Airport + sea-port geometry (kept out of the road graph).
const AIRPORT = MAP.airport || null;
const PORT = MAP.port || null;
const runwayPath = AIRPORT ? pathOf([AIRPORT.runway]) : null;
const taxiwayPath = AIRPORT ? pathOf([AIRPORT.taxiway]) : null;
const airportApronPath = AIRPORT ? polyPathOf([{ points: AIRPORT.apron }]) : null;
const airportBuildingsPath = AIRPORT ? polyPathOf(AIRPORT.buildings.map(b => ({ points: b }))) : null;
const pierPath = PORT ? pathOf([PORT.pier]) : null;
const portApronPath = PORT ? polyPathOf([{ points: PORT.apron }]) : null;
const currentPath = pathOf(CURRENT.roads.map(r => r.closed ? { points: [...r.points, r.points[0]].map(p => [p.x, p.z]) } : { points: r.points.map(p => [p.x, p.z]) }));
const junctionPath = new Path2D();
for (const j of MAP.junctions) { junctionPath.moveTo(j.x + 2.5, j.z); junctionPath.arc(j.x, j.z, 2.5, 0, Math.PI * 2); }

// ---- Hillshade --------------------------------------------------------------
const hs = (() => {
  const e = MAP.elevation;
  if (!e || e.data.every(v => v === e.data[0])) return null;
  const c = document.createElement('canvas');
  c.width = e.cols; c.height = e.rows;
  const g = c.getContext('2d');
  const img = g.createImageData(e.cols, e.rows);
  const min = MAP.stats.minElevation, max = Math.max(MAP.stats.maxElevation, min + 1);
  const cell = Math.abs(e.dx) * MAP.stats.metresPerUnit; // metres per grid step
  const at = (col, row) => e.data[Math.max(0, Math.min(e.rows - 1, row)) * e.cols + Math.max(0, Math.min(e.cols - 1, col))];
  for (let row = 0; row < e.rows; row++) {
    for (let col = 0; col < e.cols; col++) {
      const dzdx = (at(col + 1, row) - at(col - 1, row)) / (2 * cell);
      const dzdy = (at(col, row + 1) - at(col, row - 1)) / (2 * cell);
      // Light from the northwest, gentle exaggeration.
      let shade = 0.72 - 2.2 * (dzdx * -0.707 + dzdy * -0.707);
      shade = Math.max(0.25, Math.min(1.15, shade));
      const t = (at(col, row) - min) / (max - min);
      const base = [46 + 44 * t, 56 + 40 * t, 52 + 30 * t];
      const i = (row * e.cols + col) * 4;
      img.data[i] = base[0] * shade;
      img.data[i + 1] = base[1] * shade;
      img.data[i + 2] = base[2] * shade;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return { canvas: c, x: e.x0 - e.dx / 2, z: e.z0 - e.dz / 2, w: e.dx * e.cols, h: e.dz * e.rows };
})();

// ---- Rendering ---------------------------------------------------------------
function resize() {
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  draw();
}
let hovered = null;
function worldTransform() {
  ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom,
    dpr * (window.innerWidth / 2 - viewX * zoom), dpr * (window.innerHeight / 2 - viewZ * zoom));
}
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#10151c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  worldTransform();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  if (layers.hillshade.on && hs) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(hs.canvas, hs.x, hs.z, hs.w, hs.h);
    ctx.restore();
  }
  if (layers.coast.on && COAST) {
    if (oceanPath) { ctx.fillStyle = OCEAN_COLOR; ctx.globalAlpha = 0.92; ctx.fill(oceanPath); ctx.globalAlpha = 1; }
    if (beachPath) { ctx.fillStyle = BEACH_COLOR; ctx.globalAlpha = 0.9; ctx.fill(beachPath); ctx.globalAlpha = 1; }
    if (coastlinePath) { ctx.strokeStyle = '#8fc7e8'; ctx.lineWidth = Math.max(3, 1.6 / zoom); ctx.stroke(coastlinePath); }
    // Harbour anchor.
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath(); ctx.arc(COAST.harbour.x, COAST.harbour.z, Math.max(9, 5 / zoom), 0, Math.PI * 2); ctx.fill();
  }
  if (layers.corridor.on && COAST) {
    // The rural band between the Joburg block and the coast.
    ctx.save();
    ctx.fillStyle = '#3d4a2c'; ctx.globalAlpha = 0.28;
    ctx.fillRect(COAST.corridor.westX, -MAP.stats.targetSize, COAST.corridor.eastX - COAST.corridor.westX, MAP.stats.targetSize * 2);
    ctx.globalAlpha = 1;
    ctx.setLineDash([26, 18]);
    ctx.strokeStyle = '#5c6b3f'; ctx.lineWidth = Math.max(2, 1.2 / zoom);
    ctx.beginPath();
    ctx.moveTo(COAST.corridor.eastX, -MAP.stats.targetSize); ctx.lineTo(COAST.corridor.eastX, MAP.stats.targetSize);
    ctx.moveTo(COAST.corridor.westX, -MAP.stats.targetSize); ctx.lineTo(COAST.corridor.westX, MAP.stats.targetSize);
    ctx.stroke(); ctx.setLineDash([]);
    ctx.restore();
    if (farmlandPath) {
      ctx.fillStyle = FARMLAND_COLOR; ctx.globalAlpha = 0.55; ctx.fill(farmlandPath); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#8a934f'; ctx.lineWidth = Math.max(1.5, 1 / zoom); ctx.stroke(farmlandPath); // fence lines
    }
    if (RURAL) {
      for (const farm of RURAL.farms) {
        ctx.fillStyle = farm.kind === 'windmill' ? '#c9d4dd' : farm.kind === 'silo' ? '#b8a884' : '#a5643c';
        const r = Math.max(5, 3 / zoom);
        ctx.fillRect(farm.x - r, farm.z - r, r * 2, r * 2);
      }
    }
  }
  if (layers.landuse.on) {
    for (const { kind, path } of landusePathList) {
      ctx.fillStyle = LANDUSE_COLORS[kind] || '#31543a';
      ctx.globalAlpha = kind === 'mine_dump' ? 0.85 : 0.55;
      ctx.fill(path);
    }
    ctx.globalAlpha = 1;
  }
  if (layers.airport.on && AIRPORT) {
    if (airportApronPath) { ctx.fillStyle = APRON_COLOR; ctx.globalAlpha = 0.75; ctx.fill(airportApronPath); ctx.globalAlpha = 1; }
    if (airportBuildingsPath) { ctx.fillStyle = AIRPORT_MARK_COLOR; ctx.globalAlpha = 0.9; ctx.fill(airportBuildingsPath); ctx.globalAlpha = 1; }
    if (runwayPath) {
      ctx.strokeStyle = RUNWAY_COLOR; ctx.lineWidth = Math.max(AIRPORT.runway.width, 2 / zoom); ctx.stroke(runwayPath);
      ctx.strokeStyle = '#e8ecf0'; ctx.lineWidth = Math.max(1, 0.6 / zoom); ctx.setLineDash([18, 14]); ctx.stroke(runwayPath); ctx.setLineDash([]); // centreline
    }
    if (taxiwayPath) { ctx.strokeStyle = TAXIWAY_COLOR; ctx.lineWidth = Math.max(AIRPORT.taxiway.width, 1.6 / zoom); ctx.stroke(taxiwayPath); }
  }
  if (layers.port.on && PORT) {
    if (portApronPath) { ctx.fillStyle = APRON_COLOR; ctx.globalAlpha = 0.8; ctx.fill(portApronPath); ctx.globalAlpha = 1; }
    if (pierPath) { ctx.strokeStyle = PIER_COLOR; ctx.lineWidth = Math.max(PORT.pier.width, 1.6 / zoom); ctx.stroke(pierPath); }
  }
  if (layers.water.on) {
    if (pondWaterPath) { ctx.fillStyle = WATER_COLOR; ctx.fill(pondWaterPath); }
    if (premiumWaterPath) {
      ctx.fillStyle = WATER_PREMIUM_COLOR; ctx.fill(premiumWaterPath);
      ctx.strokeStyle = '#7fc4ea'; ctx.lineWidth = Math.max(2, 1.2 / zoom); ctx.stroke(premiumWaterPath); // premium tier: waves + reflections in-game
    }
  }
  if (layers.railways.on && railPath) {
    ctx.strokeStyle = '#5c6b7c'; ctx.lineWidth = Math.max(2, 1.5 / zoom); ctx.setLineDash([12, 8]);
    ctx.stroke(railPath); ctx.setLineDash([]);
  }
  if (layers.tracks.on) {
    for (const { kind, width, path } of trackPaths) {
      ctx.strokeStyle = TRACK_COLORS[kind]; ctx.lineWidth = Math.max(width, 1.2 / zoom);
      ctx.setLineDash([10, 7]); ctx.stroke(path);
    }
    ctx.setLineDash([]);
  }
  if (layers.roads.on) {
    for (const { kind, width, path } of roadPaths) {
      ctx.strokeStyle = ROAD_COLORS[kind] || '#8fa0b3';
      ctx.lineWidth = Math.max(width, 1.4 / zoom);
      ctx.stroke(path);
    }
  }
  if (hovered) {
    const p = pathOf([hovered]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max((hovered.width || 10) + 4, 3 / zoom);
    ctx.globalAlpha = 0.85; ctx.stroke(p); ctx.globalAlpha = 1;
  }
  if (layers.junctions.on) { ctx.fillStyle = '#ffe08a'; ctx.fill(junctionPath); }
  if (layers.current.on) {
    ctx.strokeStyle = CURRENT_COLOR; ctx.lineWidth = Math.max(6, 2.5 / zoom);
    ctx.globalAlpha = 0.9; ctx.stroke(currentPath); ctx.globalAlpha = 1;
    ctx.fillStyle = CURRENT_COLOR;
    for (const j of CURRENT.junctions) { ctx.beginPath(); ctx.arc(j.x, j.z, Math.max(8, 4 / zoom), 0, Math.PI * 2); ctx.fill(); }
  }

  // Screen-space labels.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x) => window.innerWidth / 2 + (x - viewX) * zoom;
  const sy = (z) => window.innerHeight / 2 + (z - viewZ) * zoom;
  if (layers.districts.on && zoom > 0.12) {
    ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    for (const d of MAP.districts) {
      const x = sx(d.x), y = sy(d.z);
      if (x < -50 || y < -20 || x > window.innerWidth + 50 || y > window.innerHeight + 20) continue;
      ctx.fillStyle = 'rgba(16,21,28,0.65)';
      const w = ctx.measureText(d.name.toUpperCase()).width;
      ctx.fillRect(x - w / 2 - 3, y - 9, w + 6, 13);
      ctx.fillStyle = DISTRICT_COLOR;
      ctx.fillText(d.name.toUpperCase(), x, y + 1);
    }
  }
  if (layers.landmarks.on) {
    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'left';
    for (const l of MAP.landmarks) {
      const x = sx(l.x), y = sy(l.z);
      if (x < -100 || y < -20 || x > window.innerWidth + 100 || y > window.innerHeight + 20) continue;
      drawStar(x, y, 6, '#ffd75e');
      if (zoom > 0.1) {
        ctx.fillStyle = '#ffd75e';
        ctx.fillText(l.name, x + 9, y + 4);
      }
    }
  }
  drawScalebar();
}
function drawStar(x, y, r, color) {
  ctx.save(); ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx[i === 0 ? 'moveTo' : 'lineTo'](x + rad * Math.cos(a), y + rad * Math.sin(a));
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
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
    viewX -= (e.clientX - lastX) / zoom;
    viewZ -= (e.clientY - lastY) / zoom;
    lastX = e.clientX; lastY = e.clientY;
    tooltip.style.display = 'none';
    requestAnimationFrame(draw);
  } else {
    hover(e);
  }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.exp(-e.deltaY * 0.0015);
  const wx = viewX + (e.clientX - window.innerWidth / 2) / zoom;
  const wz = viewZ + (e.clientY - window.innerHeight / 2) / zoom;
  zoom = Math.min(40, Math.max(0.02, zoom * factor));
  viewX = wx - (e.clientX - window.innerWidth / 2) / zoom;
  viewZ = wz - (e.clientY - window.innerHeight / 2) / zoom;
  requestAnimationFrame(draw);
}, { passive: false });
window.addEventListener('dblclick', () => { fitView(); draw(); });

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (pz - az) * dz) / l2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qz = az + t * dz;
  return Math.hypot(px - qx, pz - qz);
}
function hover(e) {
  const wx = viewX + (e.clientX - window.innerWidth / 2) / zoom;
  const wz = viewZ + (e.clientY - window.innerHeight / 2) / zoom;
  const threshold = 8 / zoom;
  let best = null, bestD = threshold;
  const scan = (items, isTrack) => {
    for (const item of items) {
      const pts = item.points;
      for (let i = 1; i < pts.length; i++) {
        const d = segDist(wx, wz, pts[i-1][0], pts[i-1][1], pts[i][0], pts[i][1]);
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
    tooltip.style.left = (e.clientX + 14) + 'px';
    tooltip.style.top = (e.clientY + 12) + 'px';
    tooltip.innerHTML = '<b>' + escapeHtml(best.name) + '</b><br><span class="kind">' + best.kind +
      (best.unpaved ? ' · unpaved' : '') + ' · width ' + best.width + '</span>';
  } else {
    tooltip.style.display = 'none';
  }
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
    ['Water bodies', s.waterCount + ' (' + premiumWater.length + ' premium tier)'],
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
  const damNames = MAP.water.filter(w => polyArea(w.points) >= PREMIUM_WATER_AREA).map(w => w.name);
  if (damNames.length) rows.push(['Dams / lakes', damNames.slice(0, 3).join(', ') + (damNames.length > 3 ? '…' : '')]);
  document.getElementById('stats').innerHTML = rows.map(([k, v]) =>
    '<div>' + k + '</div><div class="v">' + v + '</div>').join('');
  const toggles = document.getElementById('toggles');
  for (const [key, layer] of Object.entries(layers)) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.checked = layer.on;
    input.addEventListener('change', () => { layer.on = input.checked; draw(); });
    label.append(input, document.createTextNode(layer.label));
    toggles.append(label);
  }
  const legend = document.getElementById('legend');
  const entries = [
    ...['motorway','trunk','primary','secondary','tertiary','residential'].map(k => [ROAD_COLORS[k], k]),
    [TRACK_COLORS.track, 'track / path (unpaved)'],
    [OCEAN_COLOR, 'ocean'],
    [BEACH_COLOR, 'beach'],
    [WATER_PREMIUM_COLOR, 'dam / lake (premium water tier)'],
    [WATER_COLOR, 'pond (cheap water tier)'],
    [FARMLAND_COLOR, 'farmland (corridor)'],
    [RUNWAY_COLOR, 'runway / taxiway (airport)'],
    [PIER_COLOR, 'pier (sea port)'],
    [LANDUSE_COLORS.park, 'park / green'],
    [LANDUSE_COLORS.mine_dump, 'mine dump / quarry'],
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
