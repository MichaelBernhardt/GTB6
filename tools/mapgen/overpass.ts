import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BBOX,
  CAPE_BBOX,
  CBD_CENTER,
  LANDMARK_NAME_REGEX,
  OVERPASS_ENDPOINTS,
  OVERPASS_USER_AGENT,
  RESIDENTIAL_RADIUS_M,
} from './config';
import type { OsmNode, OsmResponse } from './types';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cache');

const bbox = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

/**
 * One combined query for everything Phase 1 needs. Ways are fetched with
 * `out body` + node recursion so we keep OSM node ids (needed for topology);
 * landmarks use `out center` so buildings collapse to a point.
 */
export function buildQuery(): string {
  return `
[out:json][timeout:180];
(
  way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link)$"](${bbox});
  way["highway"="residential"](around:${RESIDENTIAL_RADIUS_M},${CBD_CENTER.lat},${CBD_CENTER.lon});
  way["highway"~"^(track|path)$"](${bbox});
  way["railway"~"^(rail|light_rail|subway)$"](${bbox});
  way["natural"="water"](${bbox});
  way["water"~"^(lake|reservoir|pond|basin)$"](${bbox});
  relation["natural"="water"](${bbox});
  way["leisure"~"^(park|golf_course|nature_reserve)$"](${bbox});
  relation["leisure"~"^(park|golf_course|nature_reserve)$"](${bbox});
  way["landuse"~"^(grass|forest|quarry|brownfield)$"](${bbox});
  relation["landuse"~"^(quarry)$"](${bbox});
  way["natural"~"^(wood|scrub)$"](${bbox});
  way["man_made"="spoil_heap"](${bbox});
)->.geo;
.geo out body;
.geo >;
out skel qt;
node["place"~"^(suburb|quarter|neighbourhood)$"](${bbox});
out body;
(
  nwr["name"~"${LANDMARK_NAME_REGEX}",i](${bbox});
  nwr["railway"="station"]["network"~"Gautrain",i](${bbox});
  nwr["station"="subway"]["operator"~"Gautrain",i](${bbox});
);
out center;
`.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOnce(endpoint: string, query: string): Promise<OsmResponse> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'User-Agent': OVERPASS_USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) {
    throw new Error(`Overpass ${endpoint} responded ${response.status} ${response.statusText}`);
  }
  const json = (await response.json()) as OsmResponse;
  if (!Array.isArray(json.elements)) throw new Error(`Overpass ${endpoint} returned no elements array`);
  return json;
}

/**
 * Fetch the OSM extract, with disk cache (keyed by query hash), a single
 * polite retry on the primary endpoint, then the kumi.systems mirror.
 */
export async function fetchOsm(options: { refresh?: boolean } = {}): Promise<{ data: OsmResponse; cacheFile: string; fromCache: boolean }> {
  const query = buildQuery();
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `overpass-${hash}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    const data = JSON.parse(readFileSync(cacheFile, 'utf8')) as OsmResponse;
    return { data, cacheFile, fromCache: true };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastError: unknown;
  const attempts: Array<{ endpoint: string; delayMs: number }> = [
    { endpoint: OVERPASS_ENDPOINTS[0], delayMs: 0 },
    { endpoint: OVERPASS_ENDPOINTS[0], delayMs: 15_000 }, // single polite retry
    { endpoint: OVERPASS_ENDPOINTS[1], delayMs: 5_000 }, // mirror fallback
  ];
  for (const attempt of attempts) {
    if (attempt.delayMs > 0) await sleep(attempt.delayMs);
    try {
      console.log(`[overpass] querying ${attempt.endpoint} ...`);
      const data = await requestOnce(attempt.endpoint, query);
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`[overpass] got ${data.elements.length} elements, cached to ${cacheFile}`);
      return { data, cacheFile, fromCache: false };
    } catch (error) {
      lastError = error;
      console.warn(`[overpass] attempt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All Overpass attempts failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Rail stations/halts in the main bbox — a separate small query so the big extract cache stays valid. */
export function buildStationsQuery(): string {
  return `
[out:json][timeout:90];
node["railway"~"^(station|halt)$"](${bbox});
out body;
`.trim();
}

/**
 * Fetch railway=station/halt nodes (cached like the main extract). Stations are an OPTIONAL
 * garnish — the pipeline synthesizes stops regardless — so unlike fetchOsm this returns null
 * instead of throwing when every endpoint fails (offline map:build keeps working).
 */
export async function fetchStations(options: { refresh?: boolean } = {}): Promise<{ nodes: OsmNode[]; fromCache: boolean } | null> {
  const query = buildStationsQuery();
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `overpass-stations-${hash}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    const data = JSON.parse(readFileSync(cacheFile, 'utf8')) as OsmResponse;
    return { nodes: data.elements.filter((e): e is OsmNode => e.type === 'node'), fromCache: true };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[overpass] querying rail stations via ${endpoint} ...`);
      const data = await requestOnce(endpoint, query);
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`[overpass] got ${data.elements.length} station nodes, cached to ${cacheFile}`);
      return { nodes: data.elements.filter((e): e is OsmNode => e.type === 'node'), fromCache: false };
    } catch (error) {
      console.warn(`[overpass] station attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(5_000);
    }
  }
  console.warn('[overpass] rail stations unavailable (offline?) — the pipeline will synthesize all stops');
  return null;
}

/** Cape Town Atlantic-seaboard extract for the Jozi-by-the-Sea coast graft. */
export function buildCapeQuery(): string {
  const box = `${CAPE_BBOX.south},${CAPE_BBOX.west},${CAPE_BBOX.north},${CAPE_BBOX.east}`;
  return `
[out:json][timeout:120];
(
  way["natural"="coastline"](${box});
  way["natural"="beach"](${box});
  relation["natural"="beach"](${box});
)->.geo;
.geo out body;
.geo >;
out skel qt;
node["place"~"^(suburb|quarter|neighbourhood)$"](${box});
out body;
`.trim();
}

/** Fetch the Cape seaboard extract with the same disk cache + retry policy as the main extract. */
export async function fetchCape(options: { refresh?: boolean } = {}): Promise<{ data: OsmResponse; fromCache: boolean }> {
  const query = buildCapeQuery();
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `overpass-cape-${hash}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    return { data: JSON.parse(readFileSync(cacheFile, 'utf8')) as OsmResponse, fromCache: true };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[overpass] querying Cape seaboard via ${endpoint} ...`);
      const data = await requestOnce(endpoint, query);
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`[overpass] got ${data.elements.length} Cape elements, cached to ${cacheFile}`);
      return { data, fromCache: false };
    } catch (error) {
      lastError = error;
      console.warn(`[overpass] Cape attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(8_000);
    }
  }
  throw new Error(`Cape seaboard fetch failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Building-density teaser: count building ways around each district centre
 * with one `out count` per district (no geometry download). Returns counts
 * in district order, or null if the query fails (density is optional).
 */
export async function fetchBuildingCounts(
  districts: Array<{ name: string; lat: number; lon: number }>,
  radiusM: number,
): Promise<number[] | null> {
  if (districts.length === 0) return [];
  const statements = districts
    .map((d) => `way["building"](around:${radiusM},${d.lat.toFixed(5)},${d.lon.toFixed(5)});out count;`)
    .join('\n');
  const query = `[out:json][timeout:240];\n${statements}`;
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `buildings-${hash}.json`);
  if (existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as number[];
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[overpass] counting buildings around ${districts.length} districts via ${endpoint} ...`);
      const data = await requestOnce(endpoint, query);
      const counts = data.elements
        .filter((e) => (e as { type: string }).type === 'count')
        .map((e) => Number((e as unknown as { tags: { total: string } }).tags.total));
      if (counts.length !== districts.length) throw new Error(`expected ${districts.length} counts, got ${counts.length}`);
      writeFileSync(cacheFile, JSON.stringify(counts));
      return counts;
    } catch (error) {
      console.warn(`[overpass] building count failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(10_000);
    }
  }
  return null;
}
