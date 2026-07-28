/**
 * One-off: draw the REAL Vaal outer ring in the game-oriented frame (+x = real north = game east,
 * +z = real east = game south) with arc-length ticks and the named landmarks, so a strip can be
 * chosen by LOOKING at the dendritic arms rather than by guessing anchor coordinates.
 *
 *   npx tsx tools/mapgen/plot-vaal.ts <out.png> [arcFromKm arcToKm]
 */
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { fetchVaal } from './overpass';
import { toVaalFrame } from './vaal';
import { VAAL_WATER_RELATION } from './config';
import type { OsmRelation, Pt } from './types';

function chainRings(members: Array<Array<{ lat: number; lon: number }>>): Array<Array<{ lat: number; lon: number }>> {
  const key = (p: { lat: number; lon: number }): string => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const remaining = members.filter((m) => m.length >= 2).map((m) => [...m]);
  const rings: Array<Array<{ lat: number; lon: number }>> = [];
  while (remaining.length > 0) {
    let chain = remaining.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const c = remaining[i]!;
        if (key(c[0]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(1));
        else if (key(c[c.length - 1]!) === key(chain[chain.length - 1]!)) chain = chain.concat(c.slice(0, -1).reverse());
        else if (key(c[c.length - 1]!) === key(chain[0]!)) chain = c.slice(0, -1).concat(chain);
        else if (key(c[0]!) === key(chain[0]!)) chain = c.slice(1).reverse().concat(chain);
        else continue;
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    rings.push(chain);
  }
  return rings.sort((a, b) => b.length - a.length);
}

const LANDMARKS: Array<{ name: string; lat: number; lon: number }> = [
  { name: 'Deneysville', lat: -26.89, lon: 28.0964 },
  { name: 'Refengkgotso', lat: -26.8953, lon: 28.0725 },
  { name: 'Dam wall', lat: -26.8722, lon: 28.1119 },
  { name: 'Grooteiland', lat: -26.8671, lon: 28.1726 },
  { name: 'MISTY BAY', lat: -26.888104, lon: 28.192121 },
  { name: 'Marina Latata', lat: -26.8753, lon: 28.2003 },
  { name: 'Vaal Marina', lat: -26.8744, lon: 28.2311 },
  { name: 'Groenpunt', lat: -26.8261, lon: 28.04 },
  { name: 'Sewage', lat: -26.8188, lon: 28.0517 },
];

async function main(): Promise<void> {
  const out = process.argv[2] ?? '/tmp/vaal.png';
  const arcFrom = process.argv[3] ? Number(process.argv[3]) * 1000 : 0;
  const arcTo = process.argv[4] ? Number(process.argv[4]) * 1000 : Infinity;
  const { data } = await fetchVaal({ refresh: false });
  const relation = data.elements.find((e): e is OsmRelation => e.type === 'relation' && e.id === VAAL_WATER_RELATION)!;
  const outer = relation.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry!);
  const ring: Pt[] = chainRings(outer)[0]!.map((g) => toVaalFrame(g.lat, g.lon));

  // Re-order so index 0 is the current SHORE_START, walking forward (= north shore west->east).
  const start = toVaalFrame(-26.923059, 28.100699);
  let s0 = 0; let bd = Infinity;
  ring.forEach((p, i) => { const d = (p.x - start.x) ** 2 + (p.z - start.z) ** 2; if (d < bd) { bd = d; s0 = i; } });
  const walk = ring.map((_, k) => ring[(s0 + k) % ring.length]!);
  const cum = [0];
  for (let i = 1; i < walk.length; i++) cum.push(cum[i - 1]! + Math.hypot(walk[i]!.x - walk[i - 1]!.x, walk[i]!.z - walk[i - 1]!.z));

  const sel = walk.filter((_, i) => cum[i]! >= arcFrom && cum[i]! <= arcTo);
  const box = sel.length > 2 ? sel : walk;
  const minX = Math.min(...box.map((p) => p.x)); const maxX = Math.max(...box.map((p) => p.x));
  const minZ = Math.min(...box.map((p) => p.z)); const maxZ = Math.max(...box.map((p) => p.z));
  const pad = 1500;
  const W = 1800; const H = 1400;
  const sc = Math.min((W - 40) / (maxX - minX + 2 * pad), (H - 40) / (maxZ - minZ + 2 * pad));
  // Draw with the GAME orientation: frame x -> screen right (game east), frame z -> screen down.
  const sx = (p: Pt): number => 20 + (p.x - minX + pad) * sc;
  const sy = (p: Pt): number => 20 + (p.z - minZ + pad) * sc;

  const cv = createCanvas(W, H);
  const g = cv.getContext('2d');
  g.fillStyle = '#101418'; g.fillRect(0, 0, W, H);
  // Whole ring, FILLED — so land vs water is unambiguous rather than inferred from travel direction.
  g.fillStyle = '#12384f';
  g.beginPath(); walk.forEach((p, i) => (i ? g.lineTo(sx(p), sy(p)) : g.moveTo(sx(p), sy(p)))); g.closePath(); g.fill();
  g.strokeStyle = '#2a4a63'; g.lineWidth = 1; g.stroke();
  // Selected run, bright.
  g.strokeStyle = '#7fd4ff'; g.lineWidth = 2;
  g.beginPath();
  let started = false;
  walk.forEach((p, i) => {
    if (cum[i]! < arcFrom || cum[i]! > arcTo) { started = false; return; }
    if (!started) { g.moveTo(sx(p), sy(p)); started = true; } else g.lineTo(sx(p), sy(p));
  });
  g.stroke();
  // Arc ticks every 2 km.
  g.fillStyle = '#ffd479'; g.font = '11px sans-serif';
  let next = 0;
  for (let i = 0; i < walk.length; i++) {
    if (cum[i]! < next) continue;
    next += 2000;
    if (cum[i]! < arcFrom - 4000 || cum[i]! > arcTo + 4000) continue;
    g.fillRect(sx(walk[i]!) - 2, sy(walk[i]!) - 2, 4, 4);
    g.fillText(`${(cum[i]! / 1000).toFixed(0)}`, sx(walk[i]!) + 4, sy(walk[i]!) - 4);
  }
  // Landmarks.
  g.font = 'bold 13px sans-serif';
  for (const l of LANDMARKS) {
    const p = toVaalFrame(l.lat, l.lon);
    g.fillStyle = '#ff6b6b';
    g.beginPath(); g.arc(sx(p), sy(p), 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.fillText(l.name, sx(p) + 8, sy(p) + 4);
  }
  g.fillStyle = '#9fb3c8'; g.font = '13px sans-serif';
  g.fillText('screen right = frame +x = real NORTH = GAME EAST    screen down = frame +z = real EAST = GAME SOUTH', 20, H - 14);
  writeFileSync(out, cv.toBuffer('image/png'));
  console.log(`wrote ${out}  (arc ${(arcFrom / 1000).toFixed(0)}..${arcTo === Infinity ? 'end' : (arcTo / 1000).toFixed(0)} km)`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
