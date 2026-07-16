import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { renderMapModuleJs } from './preview';
import type { JoburgMap } from './types';

/**
 * Render the generated map to a static PNG — geometry plus terrain hillshade (roads, tracks,
 * railways, water, landuse, coast, airport, port), no labels.
 *
 * Re-runnable any time:   npm run map:png   (or: tsx tools/mapgen/render-png.ts)
 * Options:                --size 1024   --out tools/mapgen/map.png
 *                         --view cx,cz,zoom   (world-unit centre + zoom for close-up crops)
 *
 * Drawing goes through the SAME shared renderer as the game and the HTML preview
 * (src/ui/mapRender.ts). Like preview.ts, we can't import it directly (it lives in the app
 * tsconfig with DOM types), so we reuse preview.ts's transpiled copy and evaluate it with
 * @napi-rs/canvas's Path2D standing in for the browser global.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_JSON = process.env.MAPGEN_OUT ?? join(HERE, '../../src/world/generated/joburg-map.json');

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const size = Number(argOf('--size') ?? 1024);
const outPath = argOf('--out') ?? join(HERE, 'map.png');
if (!Number.isInteger(size) || size < 16 || size > 16384) throw new Error(`--size must be an integer 16..16384, got ${argOf('--size')}`);

interface MapCamera { zoom: number; viewX: number; viewZ: number; width: number; height: number; dpr: number }
interface SharedRenderer {
  renderMap: (ctx: unknown, map: object, cam: MapCamera, opts: { layers: Record<string, boolean> }) => void;
  fitZoom: (targetSize: number, width: number, height: number) => number;
}
// buildHillshade() renders its shading into a `document.createElement('canvas')` — hand the
// evaluated module a minimal shim backed by @napi-rs/canvas so the terrain (and the northern
// mountain range's relief + snow) shows in the PNG exactly as in the game map.
const documentShim = { createElement: () => createCanvas(1, 1) };
const factory = new Function('Path2D', 'document', `${renderMapModuleJs()}\nreturn { renderMap, fitZoom };`);
const { renderMap, fitZoom } = factory(Path2D, documentShim) as SharedRenderer;

const map = JSON.parse(readFileSync(MAP_JSON, 'utf8')) as JoburgMap;

const layers = {
  districts: false, landmarks: false, // no labels
  hillshade: true, coast: true, corridor: true, landuse: true, airport: true, port: true,
  water: true, railways: true, tracks: true, roads: true,
};

const view = argOf('--view')?.split(',').map(Number);
const canvas = createCanvas(size, size);
const cam: MapCamera = {
  zoom: view?.[2] ?? fitZoom(map.stats.targetSize, size, size),
  viewX: view?.[0] ?? 0,
  viewZ: view?.[1] ?? 0,
  width: size,
  height: size,
  dpr: 1,
};
renderMap(canvas.getContext('2d'), map, cam, { layers });

writeFileSync(outPath, canvas.encodeSync('png'));
console.log(`[render-png] wrote ${outPath} (${size}x${size}, ${map.stats.totalRoadKm} km of road)`);
