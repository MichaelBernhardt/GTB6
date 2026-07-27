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
 *  The generated map is data rather than executable app code and changes only when mapgen is rerun.
 *
 *  THE ONE RULE: a chunk lifted out of `simulation` must be a GENUINE LEAF — no module in it may
 *  import, directly or transitively, any module left in `simulation`. A single back-edge makes the two
 *  chunks mutually dependent, and there is then no order in which the browser can initialise them: the
 *  bundle boots into "Cannot access 'X' before initialization" while every HTTP request succeeds and
 *  every unit test passes. Rollup only *warns* ("Circular chunk: a -> b -> a"), so onwarn below turns
 *  that warning into a build failure and tools/check-bundle.mjs re-proves it against the emitted files.
 *
 *  The layering, strictly downward — each layer may only import layers below it:
 *    joburg-map-data                                  generated map literal, imports nothing
 *    world-data      -> joburg-map-data               map/site lookups derived from it
 *    game-config     -> world-data                    tuning constants + the pure rules over them
 *    world-runtime                                    seedless helpers, imports nothing but three
 *    world-materials -> world-runtime                 the shared procedural material factory
 *    world-geometry  -> world-materials, world-data   code-built scenery
 *    navigation / game-tools                          standalone
 *    gameplay-rules  -> game-config, world-data       pure systems + the eager feature plumbing
 *    vehicle-models  -> all of the above              code-built vehicle geometry
 *    simulation      -> all of the above              the tightly-connected world/entity core
 *    Game            -> everything                    orchestration */
function manualChunk(id: string): string | undefined {
  const path = id.replace(/\\/g, '/');
  if (path.endsWith('/node_modules/three/build/three.core.js')) return 'three-core';
  if (path.endsWith('/node_modules/three/build/three.module.js')) return 'three-webgl';
  if (/\/node_modules\/three\/examples\/jsm\/(?:postprocessing\/GTAOPass|shaders\/(?:GTAOShader|PoissonDenoiseShader)|math\/SimplexNoise)\.js$/.test(path)) return 'three-gtao';
  if (path.includes('/node_modules/three/examples/jsm/postprocessing/') || /\/node_modules\/three\/examples\/jsm\/shaders\/(?:CopyShader|LuminosityHighPassShader|OutputShader)\.js$/.test(path)) return 'three-postprocessing';
  if (path.includes('/node_modules/three/examples/jsm/')) return 'three-addons';
  if (path.endsWith('/src/world/generated/joburg-map.json')) return 'joburg-map-data';
  if (path.endsWith('/src/systems/NavGraph.ts')) return 'navigation';
  // Fat, slow-changing scenery builders. Both reach down only into world-materials/world-data/three,
  // so `simulation` importing them stays a one-way edge.
  if (/\/src\/world\/(?:BuildingArchitecture|Airport)\.ts$/.test(path)) return 'world-geometry';
  if (/(?:StableRandom|coast|powerGrid|ChunkVisibility)\.ts$/.test(path)) return 'world-runtime';
  // The shared material factory sits between world-runtime and everything that builds scenery; keeping
  // it out of `simulation` is what lets world-geometry and vehicle-models be leaves at all.
  if (path.endsWith('/src/world/ProceduralMaterials.ts')) return 'world-materials';
  if (path.endsWith('/src/systems/Console.ts')) return 'game-tools';
  // Pure map/site data: leaves whose only imports are the generated map chunk, each other, or types.
  // They carry no scene objects and nothing in `simulation` is imported back, so lifting them out of
  // `simulation` frees real bytes against the per-chunk CODE_LIMIT without creating a chunk cycle.
  // coordTransform belongs here and not in `simulation`: placements imports it, and that single
  // back-edge was enough to make world-data and simulation mutually uninitialisable.
  if (/\/src\/world\/(?:mapData|beachfront|placements|coordTransform|data\/manicured|data\/zoning)\.ts$/.test(path)) return 'world-data';
  // Feature plumbing that MUST be eager: the registry, the host, the interaction ladder, the save
  // sanitizer, and any top-level `<id>.state.ts`. Matches ONE path segment under src/features/ only —
  // feature bodies live in src/features/<id>/ and must match NO rule so they stay lazy async chunks.
  if (/\/src\/features\/[^/]+\.ts$/.test(path)) return 'gameplay-rules';
  if (/(?:FlightSystem|SkyfallSystem|TaxiJobSystem|CourierJobSystem|LivingCitySystem|TrainRide|TrainSystem|TrafficAvoidance|FearSystem|BumpSystem|WantedSystem|LoadSheddingSystem|MeleeSystem|PoliceKnowledge|PedRagdoll|NpcCatalog)\.ts$/.test(path)) return 'gameplay-rules';
  // The code-built vehicle geometry is a fat, slow-changing leaf: its own cache unit keeps the
  // simulation chunk inside tools/check-bundle.mjs's 500 kB executable budget.
  if (/\/src\/entities\/(?:BikeAssets|Plane)\.ts$/.test(path)) return 'vehicle-models';
  // Tuning constants and the three pure modules layered straight on top of them. They must NOT sit in
  // `simulation`: gameplay-rules (TrainSystem -> GameRules) and vehicle-models (BikeAssets -> config,
  // Plane -> Teleport) read them, and those reads were two of the three chunk cycles.
  if (path.endsWith('/src/config.ts') || /\/src\/(?:core\/GameRules|systems\/Teleport)\.ts$/.test(path)) return 'game-config';
  if (/\/src\/core\/(?:CameraController|SaveManager|DrinkRules)\.ts$/.test(path) || path.endsWith('/src/ui/MinimapView.ts')) return 'simulation';
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
      // A chunk cycle is a shipped crash, not advice. Rollup only warns, the build stays green, every
      // test stays green, and the production page dies on load with "Cannot access 'X' before
      // initialization". Fail the build where the cycle is created, with the cycle path in the message.
      onwarn(warning, defaultHandler) {
        if (warning.code === 'CIRCULAR_CHUNK') {
          throw new Error(`${warning.message}\nA chunk lifted out of "simulation" must be a genuine leaf: nothing in it may import back. See the layering comment above manualChunk() in vite.config.ts.`);
        }
        defaultHandler(warning);
      },
    },
  },
  // The map/lifecycle suites are intentionally CPU-heavy. Letting Vitest match a many-core CI host
  // one worker-for-core starves those tests past their per-case wall-clock limits despite doing the
  // same deterministic work; four workers keeps the full production gate fast and stable.
  test: { environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'], maxWorkers: 4 },
});
