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
  VAAL_BBOX,
  VAAL_SHORE_BBOX,
  VAAL_WATER_RELATION,
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
 * VAAL DAM extract — the real shoreline the map's reservoir is cut from.
 *
 * This is a SECOND, tiny, one-off query, ~70 km SOUTH of the city BBOX, and it exists because
 * synthesising a "Vaal-like" shore never looked like the Vaal: the real dam is a drowned river
 * system whose crenellation is its whole character. Two parts:
 *
 *   1. relation 253822 (`natural=water` + `water=reservoir`) with `out geom`. Its OUTER rings are
 *      the shoreline; its INNER rings are the dam's islands, including Grooteiland (way 6139539),
 *      the 3 km island the annual Round the Island race circles. One `out geom` gets both, so no
 *      node recursion and no second query.
 *   2. `out center tags` over a box around the north shore for the furniture the composition needs
 *      — the dam wall ways, Deneysville / Refengkgotso / Vaal Marina place nodes, the marinas,
 *      slipways, camp sites, beaches, the fuel station and the two wastewater plants.
 *
 * The relation id is pinned deliberately: a bbox query for `natural=water` around the Vaal returns
 * a dozen farm dams too, and pinning keeps the cache key (and therefore the committed cache file)
 * stable. The cache file IS committed (`git add -f`, past .gitignore) so every later build is
 * fully offline and byte-reproducible — this fetch must never run in CI or on a re-build.
 */
export function buildVaalQuery(): string {
  const box = `${VAAL_BBOX.south},${VAAL_BBOX.west},${VAAL_BBOX.north},${VAAL_BBOX.east}`;
  return `
[out:json][timeout:180];
rel(${VAAL_WATER_RELATION});
out geom;
(
  nwr["waterway"="dam"](${box});
  node["place"](${box});
  nwr["man_made"="wastewater_plant"](${box});
  nwr["leisure"~"^(marina|slipway|resort|beach_resort|sports_centre|fishing)$"](${box});
  nwr["tourism"~"^(camp_site|caravan_site|resort|chalet|attraction|picnic_site)$"](${box});
  nwr["natural"="beach"](${box});
  nwr["amenity"="fuel"](${box});
);
out center tags;
`.trim();
}

/** Fetch the Vaal Dam extract with the same disk cache + retry policy as the Cape extract. */
export async function fetchVaal(options: { refresh?: boolean } = {}): Promise<{ data: OsmResponse; fromCache: boolean }> {
  const query = buildVaalQuery();
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `overpass-vaal-${hash}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    return { data: JSON.parse(readFileSync(cacheFile, 'utf8')) as OsmResponse, fromCache: true };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[overpass] querying Vaal Dam via ${endpoint} ...`);
      const data = await requestOnce(endpoint, query);
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`[overpass] got ${data.elements.length} Vaal elements, cached to ${cacheFile}`);
      return { data, fromCache: false };
    } catch (error) {
      lastError = error;
      console.warn(`[overpass] Vaal attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(8_000);
    }
  }
  throw new Error(`Vaal Dam fetch failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * VAAL NORTH SHORE infrastructure — the THIRD one-off query, and the answer to "it doesn't have the
 * roads from Misty Bay".
 *
 * fetchVaal above brings the WATER (relation 253822) plus a thin garnish of point furniture. It
 * brings no roads and no buildings, so every settlement on the dam — Deneysville, Refengkgotso,
 * Misty Bay, Vaal Marina — arrives as blank land wearing a district label. This query brings the
 * land side: every highway class down to service/track/unclassified, buildings, leisure and tourism
 * (marinas, slipways, resorts, camp sites, caravan parks), natural=beach, landuse, amenities,
 * waterways and place nodes, over VAAL_SHORE_BBOX.
 *
 * Shape of the output, and why:
 *   1. ways -> `>` -> `out skel qt` FIRST, then `.geow out body`. Ways keep their `nodes[]` id list
 *      (the road graph joins ways at shared node ids, so `out geom` would not do), and the skel pass
 *      supplies the coordinates. Skel is emitted BEFORE the tagged bodies because processOsm does
 *      `osmNodes.set(id, element)` — last write wins, so any node that is both tagged and a way
 *      member must arrive tagged last.
 *   2. tagged standalone nodes with `out body`. `node["name"]` is in that union deliberately and is
 *      not redundant: the dam's two yacht clubs (Deneysville Yacht Club 1037554914, Deneysville
 *      Aquatic Club 1037554922), Aeolians Yacht Club and NSRI Station 22 are mapped as nodes
 *      carrying a `name` and NOTHING ELSE, so a key-driven union silently drops exactly the
 *      waterfront landmarks this query exists to fetch. It costs 77 nodes over this box.
 *   3. multipolygon relations with `out geom` (self-contained; no second recursion), MINUS the
 *      pinned dam relation, whose 29k-point geometry is already in the fetchVaal cache and would
 *      otherwise be duplicated verbatim into this one.
 *
 * Same contract as the other one-offs: the cache file is committed with `git add -f` past
 * .gitignore, so this must never run in CI or on a re-build — every later build logs "(from cache)".
 */
export function buildVaalShoreQuery(): string {
  const box = `${VAAL_SHORE_BBOX.south},${VAAL_SHORE_BBOX.west},${VAAL_SHORE_BBOX.north},${VAAL_SHORE_BBOX.east}`;
  return `
[out:json][timeout:300];
(
  way["highway"](${box});
  way["railway"](${box});
  way["waterway"](${box});
  way["building"](${box});
  way["natural"](${box});
  way["landuse"](${box});
  way["leisure"](${box});
  way["tourism"](${box});
  way["amenity"](${box});
  way["man_made"](${box});
  way["place"](${box});
  way["power"](${box});
  way["aeroway"](${box});
  way["barrier"](${box});
)->.geow;
.geow >->.geon;
.geon out skel qt;
.geow out body;
(
  node["place"](${box});
  node["highway"](${box});
  node["amenity"](${box});
  node["tourism"](${box});
  node["leisure"](${box});
  node["shop"](${box});
  node["natural"](${box});
  node["man_made"](${box});
  node["waterway"](${box});
  node["emergency"](${box});
  node["office"](${box});
  node["power"](${box});
  node["aeroway"](${box});
  node["sport"](${box});
  node["name"](${box});
);
out body;
(
  (
    relation["natural"](${box});
    relation["landuse"](${box});
    relation["leisure"](${box});
    relation["tourism"](${box});
    relation["amenity"](${box});
    relation["waterway"](${box});
    relation["building"](${box});
    relation["place"](${box});
    relation["aeroway"](${box});
  );
  - rel(${VAAL_WATER_RELATION});
);
out geom;
`.trim();
}

/** Fetch the Vaal north-shore infrastructure extract (same disk cache + retry policy as fetchVaal). */
export async function fetchVaalShore(options: { refresh?: boolean } = {}): Promise<{ data: OsmResponse; fromCache: boolean }> {
  const query = buildVaalShoreQuery();
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 16);
  const cacheFile = join(CACHE_DIR, `overpass-vaalshore-${hash}.json`);
  if (!options.refresh && existsSync(cacheFile)) {
    return { data: JSON.parse(readFileSync(cacheFile, 'utf8')) as OsmResponse, fromCache: true };
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`[overpass] querying Vaal north shore via ${endpoint} ...`);
      const data = await requestOnce(endpoint, query);
      writeFileSync(cacheFile, JSON.stringify(data));
      console.log(`[overpass] got ${data.elements.length} Vaal shore elements, cached to ${cacheFile}`);
      return { data, fromCache: false };
    } catch (error) {
      lastError = error;
      console.warn(`[overpass] Vaal shore attempt failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(8_000);
    }
  }
  throw new Error(`Vaal north shore fetch failed. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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
