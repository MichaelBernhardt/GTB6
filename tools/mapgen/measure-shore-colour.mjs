/**
 * WHAT THE DAM SHORE ACTUALLY RENDERS AS (C5).
 *
 * Not source hexes. This runs the REAL texture generator (src/world/ProceduralMaterials.ts, with
 * @napi-rs/canvas standing in for the DOM canvas exactly as tools/mapgen/render-png.ts already
 * does), reads every texel back out of the generated bitmap, and multiplies it by the REAL vertex
 * colour that src/world/coast.ts shoreColourAt() produces for each band. `color: 0xffffff` +
 * `vertexColors: true` + `map` is precisely `gl_FragColor.rgb = vertexColor * texel` before
 * lighting, so the mean over the texture IS the rendered surface colour of that band under flat
 * white light. Saturation is HSV S, the number that made the old shore read as golden.
 *
 *   node tools/mapgen/measure-shore-colour.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

globalThis.document = { createElement: () => createCanvas(256, 256) };
globalThis.window = globalThis;
void register;

const { createSurfaceTexture } = await import(pathToFileURL('/tmp/mapshrink/src/world/ProceduralMaterials.ts').href);
const coast = await import(pathToFileURL('/tmp/mapshrink/src/world/coast.ts').href);

/** Mean linear-ish (sRGB byte / 255) colour of a generated CanvasTexture's bitmap. */
function textureMean(kind) {
  const texture = createSurfaceTexture(kind, 1);
  const canvas = texture.image;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  const n = data.length / 4;
  return [r / n / 255, g / n / 255, b / n / 255];
}

const hex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const sat = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx === 0 ? 0 : (mx - mn) / mx; };

const maps = { sand: textureMean('sand'), dambed: textureMean('dambed') };
console.log('TEXTURE MEANS (read back from the generated bitmap, 256x256):');
for (const [k, v] of Object.entries(maps)) {
  console.log(`  ${k.padEnd(7)} ${hex(v)}  rgb ${v.map((x) => x.toFixed(3)).join(', ')}  saturation ${sat(v).toFixed(3)}`);
}

const OCEAN_Y = coast.OCEAN_Y;
const bands = [{ minZ: -1e9, maxZ: -1e8 }]; // z far from any beach -> the natural shore palette
const sandBands = [{ minZ: -10, maxZ: 10 }]; // inside a resort beach band
const cases = [
  ['SUBMERGED_BED   (0.6u under water)', OCEAN_Y - 0.6, 0, bands],
  ['HIGH_WATER_MARK (0.3u above)', OCEAN_Y + 0.3, 0, bands],
  ['DRAWDOWN_GRIT   (1.3u above)', OCEAN_Y + 1.3, 0, bands],
  ['RESORT_SAND     (0.3u above, in a beach band)', OCEAN_Y + 0.3, 0, sandBands],
];
for (const [label, mapName] of [['OLD (bed drawn with the beach `sand` map)', 'sand'], ['NEW (bed drawn with the neutral `dambed` map)', 'dambed']]) {
  console.log(`\n${label}:`);
  for (const [name, y, z, b] of cases) {
    const v = coast.shoreColourAt(y, z, OCEAN_Y, b);
    const m = maps[mapName];
    const out = [v[0] * m[0], v[1] * m[1], v[2] * m[2]];
    console.log(`  ${name.padEnd(46)} vertex ${hex(v)} x map -> RENDERED ${hex(out)}  saturation ${sat(out).toFixed(3)}`);
  }
}

// ---- Strand width on foot ------------------------------------------------------------------
// City.analyticTerrainHeightAt's seaward profile, re-derived here from the shipped constants.
const src = await import(pathToFileURL('/tmp/mapshrink/src/world/City.ts').href).catch(() => null);
if (src) {
  const { BEACH_INLAND, BEACH_TOP_Y, WATERLINE_OFFSET } = src;
  const rise = (dx) => BEACH_TOP_Y + (OCEAN_Y - BEACH_TOP_Y) * (dx / (BEACH_INLAND - WATERLINE_OFFSET)) - OCEAN_Y;
  const widthFor = (r0, r1) => {
    const span = BEACH_INLAND - WATERLINE_OFFSET;
    const solve = (r) => (r >= BEACH_TOP_Y - OCEAN_Y ? 0 : span * (1 - r / (BEACH_TOP_Y - OCEAN_Y)));
    return Math.abs(solve(r0) - solve(r1));
  };
  void rise;
  console.log(`\nSTRAND WIDTH (from the shipped City profile: crest ${BEACH_INLAND}u inland, waterline ${WATERLINE_OFFSET}u):`);
  console.log(`  bathtub ring    ${widthFor(0, coast.HIGH_WATER_RISE).toFixed(0)} u`);
  console.log(`  drawdown grit   ${widthFor(coast.HIGH_WATER_RISE, BEACH_TOP_Y - OCEAN_Y).toFixed(0)} u`);
  console.log(`  waterline->grass ${(BEACH_INLAND - WATERLINE_OFFSET).toFixed(0)} u total (${((BEACH_INLAND - WATERLINE_OFFSET) * 1.33).toFixed(0)} m)`);
}
