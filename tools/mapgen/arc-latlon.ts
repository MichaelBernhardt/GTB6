/** One-off: lat/lon of the real Vaal outer ring at a given arc distance from the current SHORE_START. */
import { fetchVaal } from './overpass';
import { toVaalFrame } from './vaal';
import { VAAL_WATER_RELATION } from './config';
import type { OsmRelation } from './types';

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
        remaining.splice(i, 1); extended = true; break;
      }
    }
    rings.push(chain);
  }
  return rings.sort((a, b) => b.length - a.length);
}

const { data } = await fetchVaal({ refresh: false });
const rel = data.elements.find((e): e is OsmRelation => e.type === 'relation' && e.id === VAAL_WATER_RELATION)!;
const ringLL = chainRings(rel.members.filter((m) => m.role === 'outer' && m.geometry?.length).map((m) => m.geometry!))[0]!;
const start = toVaalFrame(-26.923059, 28.100699);
let s0 = 0; let bd = Infinity;
ringLL.forEach((g, i) => { const p = toVaalFrame(g.lat, g.lon); const d = (p.x - start.x) ** 2 + (p.z - start.z) ** 2; if (d < bd) { bd = d; s0 = i; } });
const walkLL = ringLL.map((_, k) => ringLL[(s0 + k) % ringLL.length]!);
const walk = walkLL.map((g) => toVaalFrame(g.lat, g.lon));
const cum = [0];
for (let i = 1; i < walk.length; i++) cum.push(cum[i - 1]! + Math.hypot(walk[i]!.x - walk[i - 1]!.x, walk[i]!.z - walk[i - 1]!.z));
for (const arg of process.argv.slice(2)) {
  const target = Number(arg) * 1000;
  let best = 0;
  for (let i = 0; i < cum.length; i++) if (Math.abs(cum[i]! - target) < Math.abs(cum[best]! - target)) best = i;
  const g = walkLL[best]!;
  console.log(`arc ${arg} km -> lat ${g.lat.toFixed(6)}, lon ${g.lon.toFixed(6)}   frame x(N)=${walk[best]!.x.toFixed(0)} z(E)=${walk[best]!.z.toFixed(0)}  idx ${best}`);
}
