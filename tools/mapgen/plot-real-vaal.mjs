/**
 * LOOK AT THE REAL DAM. Renders the cached Vaal water relation filled, north-up, in real metres,
 * with candidate window rectangles overlaid so a stretch can be chosen by eye.
 *
 *   node tools/mapgen/plot-real-vaal.mjs out.png [--win cx,cz,w,h,rotDeg] ...
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

const CACHE = new URL('./cache/', import.meta.url);
const file = readdirSync(CACHE).find((f) => f.startsWith('overpass-vaal-'));
const raw = JSON.parse(readFileSync(new URL(file, CACHE), 'utf8'));
const data = raw.data ?? raw;
const REL = 253822;
const relation = data.elements.find((e) => e.type === 'relation' && e.id === REL);

const ORIGIN = { lat: -26.9, lon: 28.15 };
const R = 6378137;
const project = (lat, lon) => ({
  x: ((lon - ORIGIN.lon) * Math.PI / 180) * R * Math.cos((ORIGIN.lat * Math.PI) / 180),
  z: -((lat - ORIGIN.lat) * Math.PI / 180) * R, // +z = south
});

function chainRings(members) {
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const remaining = members.filter((m) => m.length >= 2).map((m) => [...m]);
  const rings = [];
  while (remaining.length > 0) {
    let chain = remaining.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i];
        if (key(c[0]) === key(chain[chain.length - 1])) chain = chain.concat(c.slice(1));
        else if (key(c[c.length - 1]) === key(chain[chain.length - 1])) chain = chain.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]) === key(chain[0])) chain = c.slice(0, -1).concat(chain);
        else if (key(c[0]) === key(chain[0])) chain = c.slice(1).reverse().concat(chain);
        else continue;
        remaining.splice(i, 1); extended = true; break;
      }
    }
    rings.push(chain);
  }
  return rings.sort((a, b) => b.length - a.length);
}

const outers = chainRings(relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry));
const inners = relation.members.filter((m) => m.role === 'inner' && m.geometry?.length)
  .map((m) => ({ id: m.ref, pts: m.geometry.map((g) => project(g.lat, g.lon)) }));
const rings = outers.map((r) => r.map((g) => project(g.lat, g.lon)));

const LANDMARKS = [
  ['Deneysville', -26.89, 28.0964], ['Refengkgotso', -26.8953, 28.0725],
  ['Dam wall', -26.8722, 28.1119], ['Grooteiland', -26.8671, 28.1726],
  ['MISTY BAY', -26.888104, 28.192121], ['Marina Latata', -26.8753, 28.2003],
  ['Vaal Marina', -26.8744, 28.2311], ['Groenpunt', -26.8261, 28.04],
  ['Oranjeville', -26.9722, 28.2036], ['Jim Fouche', -26.9269, 28.1531],
];

// ---- args
const out = process.argv[2] ?? '/tmp/vaal.png';
const wins = [];
let view = null;
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--win') wins.push(process.argv[++i].split(',').map(Number));
  else if (process.argv[i] === '--view') view = process.argv[++i].split(',').map(Number); // cx,cz,w,h
}

let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (const r of rings) for (const p of r) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
if (view) { minX = view[0] - view[2] / 2; maxX = view[0] + view[2] / 2; minZ = view[1] - view[3] / 2; maxZ = view[1] + view[3] / 2; }
const pad = view ? 0 : 800;
minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
const W = 1800;
const s = W / (maxX - minX);
const H = Math.round((maxZ - minZ) * s);
const px = (p) => [(p.x - minX) * s, (p.z - minZ) * s];

const cv = createCanvas(W, H); const g = cv.getContext('2d');
g.fillStyle = '#e8e2d4'; g.fillRect(0, 0, W, H);
// water
g.fillStyle = '#2f6fa8';
for (const r of rings) { g.beginPath(); r.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.fill(); }
g.fillStyle = '#7ea36a';
for (const isl of inners) { g.beginPath(); isl.pts.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.fill(); }
// island labels
g.font = '12px sans-serif';
for (const isl of inners) {
  const cx = isl.pts.reduce((t, p) => t + p.x, 0) / isl.pts.length, cz = isl.pts.reduce((t, p) => t + p.z, 0) / isl.pts.length;
  const [a, b] = px({ x: cx, z: cz });
  g.fillStyle = '#000'; g.fillText(String(isl.id), a + 4, b);
}
// 1 km grid
g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1;
for (let x = Math.ceil(minX / 1000) * 1000; x < maxX; x += 1000) { const [a] = px({ x, z: 0 }); g.beginPath(); g.moveTo(a, 0); g.lineTo(a, H); g.stroke(); }
for (let z = Math.ceil(minZ / 1000) * 1000; z < maxZ; z += 1000) { const [, b] = px({ x: 0, z }); g.beginPath(); g.moveTo(0, b); g.lineTo(W, b); g.stroke(); }
// landmarks
for (const [name, lat, lon] of LANDMARKS) {
  const [a, b] = px(project(lat, lon));
  g.fillStyle = '#d02020'; g.beginPath(); g.arc(a, b, 5, 0, 7); g.fill();
  g.fillStyle = '#000'; g.font = 'bold 15px sans-serif'; g.fillText(name, a + 8, b + 5);
}
// candidate windows: cx,cz,w,h,rot(deg). Drawn as the rotated rect actually selected.
const COLORS = ['#e01b1b', '#0b8a0b', '#8a0be0', '#e08a0b', '#0b8ae0'];
wins.forEach((w, k) => {
  const [cx, cz, ww, hh, rot] = w;
  const th = (rot * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
  const corners = [[-ww / 2, -hh / 2], [ww / 2, -hh / 2], [ww / 2, hh / 2], [-ww / 2, hh / 2]]
    .map(([u, v]) => ({ x: cx + u * c - v * sn, z: cz + u * sn + v * c }));
  g.strokeStyle = COLORS[k % COLORS.length]; g.lineWidth = 4;
  g.beginPath(); corners.forEach((p, i) => { const [a, b] = px(p); i ? g.lineTo(a, b) : g.moveTo(a, b); }); g.closePath(); g.stroke();
  const [a, b] = px(corners[0]); g.fillStyle = COLORS[k % COLORS.length]; g.font = 'bold 22px sans-serif'; g.fillText(String(k), a + 6, b + 24);
});
g.fillStyle = '#000'; g.font = 'bold 16px sans-serif';
g.fillText(`real Vaal, north up, 1 km grid, origin ${ORIGIN.lat},${ORIGIN.lon}  |  x ${Math.round(minX)}..${Math.round(maxX)} z ${Math.round(minZ)}..${Math.round(maxZ)}`, 10, 22);
writeFileSync(out, cv.toBuffer('image/png'));
console.log('wrote', out, W, 'x', H, 'scale', s.toFixed(4), 'px/m');
console.log('outer rings', rings.length, 'largest', rings[0].length, 'inners', inners.length);
console.log('bbox real m: x', Math.round(minX), Math.round(maxX), 'z', Math.round(minZ), Math.round(maxZ));
