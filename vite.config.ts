import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// The deployed git release, stamped into the build for a subtle version marker on the menu. Heroku exposes the
// deploy commit as SOURCE_VERSION; locally we ask git; anything unversioned falls back to 'dev'.
const buildHash = (() => {
  if (process.env.SOURCE_VERSION) return process.env.SOURCE_VERSION.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'dev'; }
})();
// Keep this byte-for-byte equivalent to bake/format.hashString. The bake test compares the injected
// value with that canonical implementation, so either side changing alone fails CI.
function hashString(text: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
const mapDataHash = hashString(JSON.stringify(JSON.parse(readFileSync(resolve(import.meta.dirname, 'src/world/generated/joburg-map.json'), 'utf8'))));

/** Stable cache boundaries for the two unusually large, slow-changing dependencies. Three ships its
 *  renderer and core as separate modules already; preserving that boundary avoids one monolithic parse.
 *  The generated map is data rather than executable app code and changes only when mapgen is rerun. */
function manualChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');
  if (path.endsWith('/node_modules/three/build/three.core.js')) return 'three-core';
  if (path.endsWith('/node_modules/three/build/three.module.js')) return 'three-webgl';
  if (/\/node_modules\/three\/examples\/jsm\/(?:postprocessing\/GTAOPass|shaders\/(?:GTAOShader|PoissonDenoiseShader)|math\/SimplexNoise)\.js$/.test(path)) return 'three-gtao';
  if (path.includes('/node_modules/three/examples/jsm/postprocessing/') || /\/node_modules\/three\/examples\/jsm\/shaders\/(?:CopyShader|LuminosityHighPassShader|OutputShader)\.js$/.test(path)) return 'three-postprocessing';
  if (path.includes('/node_modules/three/examples/jsm/')) return 'three-addons';
  if (path.endsWith('/src/world/generated/joburg-map.json')) return 'joburg-map-data';
  if (path.endsWith('/src/systems/NavGraph.ts')) return 'navigation';
  if (path.endsWith('/src/world/BuildingArchitecture.ts')) return 'world-geometry';
  if (/(?:StableRandom|coast|powerGrid|ChunkVisibility)\.ts$/.test(path)) return 'world-runtime';
  if (path.endsWith('/src/systems/Console.ts')) return 'game-tools';
  if (/(?:FlightSystem|SkyfallSystem|TaxiJobSystem|CourierJobSystem|LivingCitySystem|TrainRide|TrafficAvoidance|FearSystem|BumpSystem|WantedSystem|LoadSheddingSystem)\.ts$/.test(path)) return 'gameplay-rules';
  if (path.endsWith('/src/config.ts') || /\/src\/core\/(?:CameraController|GameRules|SaveManager|DrinkRules)\.ts$/.test(path) || path.endsWith('/src/ui/MinimapView.ts') || path.endsWith('/src/systems/Teleport.ts')) return 'simulation';
  // World and simulation modules are tightly connected, so keep them together instead of forcing
  // fragile directory-level cycles. They form a stable cache unit separate from UI/game orchestration.
  if (path.includes('/src/world/') || path.includes('/src/systems/') || path.includes('/src/story/') || path.includes('/src/entities/')) return 'simulation';
  return undefined;
}

export default defineConfig({
  define: { __BUILD_HASH__: JSON.stringify(buildHash), __MAP_DATA_HASH__: JSON.stringify(mapDataHash) },
  server: { host: '0.0.0.0', proxy: { '/multiplayer': { target: 'ws://127.0.0.1:4173', ws: true } } },
  build: {
    target: 'es2022',
    // joburg-map-data is a generated, gzip-friendly data literal with its own stricter 1 MB budget;
    // tools/check-bundle.mjs keeps every executable chunk below Vite's normal 500 kB threshold.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      input: { game: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin/index.html') },
      output: { manualChunks: manualChunk, onlyExplicitManualChunks: true },
    },
  },
  // The map/lifecycle suites are intentionally CPU-heavy. Letting Vitest match a many-core CI host
  // one worker-for-core starves those tests past their per-case wall-clock limits despite doing the
  // same deterministic work; four workers keeps the full production gate fast and stable.
  test: { environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'], maxWorkers: 4 },
});
