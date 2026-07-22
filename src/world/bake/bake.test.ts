import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import rawMap from '../generated/joburg-map.json';
import { allBuildings, generateCell } from '../CityGen';
import { allScatteredModels, scatterCell } from '../ModelScatter';
import { buildCityNavPaths, buildVehicleNav, ROAD_NETWORK } from '../City';
import { buildManifest, hashString, packBake, unpackBake, type BakeManifest, type CityBakeData } from './format';
import { currentMapDataHash } from './loader';

/**
 * The bake gate: STALENESS and DETERMINISM in one comparison. The committed artifacts under
 * public/baked/ must decode to exactly the state the current code + map data derive live — so
 * "changed the mapgen/derivation and forgot to `npm run bake`" fails CI here, and a passing run
 * IS the proof that a hydrated boot builds the identical world. See tools/bake/README.md.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const BAKED_DIR = join(REPO, 'public/baked');

const manifest = JSON.parse(readFileSync(join(BAKED_DIR, 'city-manifest.json'), 'utf8')) as BakeManifest;
const binBytes = readFileSync(join(BAKED_DIR, 'city.bin'));
const bin = binBytes.buffer.slice(binBytes.byteOffset, binBytes.byteOffset + binBytes.byteLength) as ArrayBuffer;
const baked: CityBakeData = unpackBake(manifest, bin);

// Live-derive everything the bake covers (module-memoized — shared with the other map suites'
// work when they run in the same worker, ~15s cold).
const liveBuildings = allBuildings();
const liveScatter = allScatteredModels();
const liveVehicleNav = buildVehicleNav(ROAD_NETWORK);

describe('city bake staleness/determinism gate', () => {
  it('was baked from this map data (manifest hash matches the imported map JSON)', () => {
    const liveHash = hashString(JSON.stringify(rawMap));
    expect(currentMapDataHash(), 'Vite build hash drifted from the imported map JSON').toBe(liveHash);
    expect(manifest.mapDataHash, 'map JSON changed since the bake — run `npm run bake` and commit public/baked/').toBe(liveHash);
  });

  it('decodes to the exact live-derived parcel list', () => {
    expect(baked.buildings.length, 'building count drifted — run `npm run bake`').toBe(liveBuildings.length);
    for (let i = 0; i < liveBuildings.length; i++) {
      const live = liveBuildings[i]!; const b = baked.buildings[i]!;
      const same = b.x === live.x && b.z === live.z && b.heading === live.heading
        && b.width === live.width && b.depth === live.depth && b.height === live.height
        && b.style === live.style && b.zone === live.zone && b.variant === live.variant;
      if (!same) expect.fail(`building ${i} differs between bake and live derivation — run \`npm run bake\`: ${JSON.stringify(b)} vs ${JSON.stringify(live)}`);
    }
  });

  it('decodes to the exact live-derived scatter list', () => {
    expect(baked.scatter.length, 'scatter count drifted — run `npm run bake`').toBe(liveScatter.length);
    for (let i = 0; i < liveScatter.length; i++) {
      const live = liveScatter[i]!; const m = baked.scatter[i]!;
      const same = m.name === live.name && m.x === live.x && m.z === live.z
        && m.heading === live.heading && m.seed === live.seed && m.variant === live.variant;
      if (!same) expect.fail(`scatter ${i} differs between bake and live derivation — run \`npm run bake\`: ${JSON.stringify(m)} vs ${JSON.stringify(live)}`);
    }
  });

  it('decodes to the exact live-derived vehicle nav topology', () => {
    expect(baked.vehicleNodeCount, 'vehicle nav node count drifted — run `npm run bake`').toBe(liveVehicleNav.nodes.length);
    expect(baked.vehicleEdges.length).toBe(liveVehicleNav.edges.length);
    for (let i = 0; i < liveVehicleNav.edges.length; i++) {
      const live = liveVehicleNav.edges[i]!; const b = baked.vehicleEdges[i]!;
      if (b.length !== live.length || b.some((target, j) => target !== live[j])) {
        expect.fail(`vehicle nav edges of node ${i} differ between bake and live derivation — run \`npm run bake\``);
      }
    }
  });

  it('pairs baked edges with nodes City can rebuild live (lane resample == builder nodes)', () => {
    // City.adoptBakedVehicleNav rebuilds nodes from buildCityNavPaths().lanes; assert that
    // resample IS the builder's node list, index for index.
    const nodes = buildCityNavPaths(ROAD_NETWORK).lanes.flatMap((lane) => lane.points);
    expect(nodes.length).toBe(liveVehicleNav.nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!; const b = liveVehicleNav.nodes[i]!;
      if (a.x !== b.x || a.z !== b.z) expect.fail(`lane-resampled node ${i} differs from the vehicle nav builder's node`);
    }
  });

  it('round-trips through pack/unpack byte-stably', () => {
    const input = { buildings: liveBuildings, scatter: liveScatter, vehicleNav: liveVehicleNav };
    const freshManifest = buildManifest(input, manifest.mapDataHash, manifest.sourcesHash);
    const packed = packBake(input, freshManifest);
    expect(freshManifest.binBytes).toBe(packed.byteLength);
    // A re-bake of identical inputs must be byte-identical to the committed artifact (no
    // timestamps/randomness) — this is what keeps no-change re-bakes out of git diffs.
    expect(packed.byteLength, 'bin size drifted — run `npm run bake`').toBe(binBytes.byteLength);
    expect(packed.every((byte, i) => byte === binBytes[i]), 'bin bytes drifted — run `npm run bake`').toBe(true);
  });

  it('hydrates a fresh CityGen/ModelScatter to identical cell buckets (the boot path)', async () => {
    vi.resetModules(); // fresh module registry: memos empty, like a real hydrated boot
    const freshCityGen = await import('../CityGen');
    const freshScatterModule = await import('../ModelScatter');
    expect(freshCityGen.hydrateParcels(baked.buildings)).toBe(true);
    expect(freshScatterModule.hydrateScatter(baked.scatter)).toBe(true);
    // Spot-check cells across the map: hydrated buckets must equal live-derived buckets.
    for (const [cx, cz] of [[0, 0], [-3, 2], [4, -4], [-6, -6], [7, 1]] as const) {
      expect(freshCityGen.generateCell(cx, cz)).toEqual(generateCell(cx, cz));
      expect(freshScatterModule.scatterCell(cx, cz)).toEqual(scatterCell(cx, cz));
    }
  });
});
