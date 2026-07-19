/**
 * Boot-time city-bake loader: fetches the baked derivations (public/baked/), validates them
 * against THIS build's map data and format version, and hydrates the derivation memos so the
 * expensive staged passes short-circuit. Every failure path — missing files, corrupt bin,
 * version or map mismatch — returns false and the boot derives live exactly as before; a bad
 * bake can slow a boot down, never break one.
 */
import rawMap from '../generated/joburg-map.json';
import { hashString, unpackBake, type BakeManifest } from './format';
import { hydrateParcels } from '../CityGen';
import { hydrateScatter } from '../ModelScatter';
import { installBakedVehicleNav } from '../City';
import { MAP_WORLD_SIZE } from '../mapData';

export const BAKE_MANIFEST_URL = '/baked/city-manifest.json';
export const BAKE_BIN_URL = '/baked/city.bin';

/** The map-data fingerprint the bake must match — identical computation in tools/bake/index.ts. */
export function currentMapDataHash(): string {
  return hashString(JSON.stringify(rawMap));
}

/**
 * Fetch + validate + hydrate. Resolves true when the whole city bake was adopted (parcels,
 * scatter, both nav graphs), false when the boot should derive live. Never throws.
 * `window.__cityBake` records the outcome for the boot timeline / QA harness.
 */
export async function loadCityBake(): Promise<boolean> {
  let outcome = 'live';
  try {
    const bust = `?v=${__BUILD_HASH__}`; // a redeploy must never hydrate from a stale cached artifact
    const [manifestResponse, binResponse] = await Promise.all([
      fetch(BAKE_MANIFEST_URL + bust), fetch(BAKE_BIN_URL + bust),
    ]);
    if (!manifestResponse.ok || !binResponse.ok) throw new Error(`bake fetch ${manifestResponse.status}/${binResponse.status}`);
    const manifest = await manifestResponse.json() as BakeManifest;
    const bin = await binResponse.arrayBuffer();
    if (manifest.mapDataHash !== currentMapDataHash()) throw new Error('bake was generated from different map data');
    const bake = unpackBake(manifest, bin); // throws on version/size mismatch
    // Cheap sanity before adopting: counts positive and every parcel inside the world bounds.
    if (!bake.buildings.length || !bake.scatter.length || !bake.vehicleEdges.length) throw new Error('bake has empty sections');
    const half = MAP_WORLD_SIZE / 2;
    for (const building of bake.buildings) {
      if (!(Math.abs(building.x) <= half && Math.abs(building.z) <= half)) throw new Error('bake parcel out of world bounds');
    }
    if (!hydrateParcels(bake.buildings) || !hydrateScatter(bake.scatter)) throw new Error('derivations already ran — bake ignored');
    installBakedVehicleNav(bake.vehicleEdges);
    outcome = 'hydrated';
    return true;
  } catch (error) {
    console.warn('[bake] falling back to live city derivation:', error);
    return false;
  } finally {
    (window as unknown as { __cityBake?: string }).__cityBake = outcome;
  }
}
