import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BBOX,
  ELEVATION_BATCH_SIZE,
  ELEVATION_COLS,
  ELEVATION_ENDPOINT,
  ELEVATION_REQUEST_INTERVAL_MS,
  ELEVATION_ROWS,
  OVERPASS_USER_AGENT,
} from './config';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cache');

export interface ElevationSamples {
  cols: number;
  rows: number;
  /** Row-major from the north-west corner, metres above sea level. */
  data: number[];
  source: string;
}

/** Cell-centre lat/lon for each sample, row-major from the north-west. */
export function gridLocations(): Array<{ lat: number; lon: number }> {
  const locations: Array<{ lat: number; lon: number }> = [];
  for (let row = 0; row < ELEVATION_ROWS; row++) {
    const lat = BBOX.north - ((row + 0.5) * (BBOX.north - BBOX.south)) / ELEVATION_ROWS;
    for (let col = 0; col < ELEVATION_COLS; col++) {
      const lon = BBOX.west + ((col + 0.5) * (BBOX.east - BBOX.west)) / ELEVATION_COLS;
      locations.push({ lat, lon });
    }
  }
  return locations;
}

/** Replace SRTM voids (null) with the nearest previous valid sample. */
export function fillVoids(data: Array<number | null>): number[] {
  const valid = data.filter((v): v is number => v !== null && Number.isFinite(v));
  const fallback = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  let previous = fallback;
  return data.map((v) => {
    if (v !== null && Number.isFinite(v)) {
      previous = v;
      return v;
    }
    return previous;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function flatGrid(reason: string): ElevationSamples {
  console.warn(`[elevation] ${reason} — emitting flat grid with TODO source marker`);
  return {
    cols: ELEVATION_COLS,
    rows: ELEVATION_ROWS,
    data: new Array(ELEVATION_COLS * ELEVATION_ROWS).fill(0),
    source: `flat placeholder (${reason}) TODO: refetch SRTM`,
  };
}

/**
 * Fetch the SRTM 90 m grid from opentopodata.org in polite batches
 * (<=100 points, >=1.1 s apart), with disk cache. Falls back to a flat
 * grid rather than failing the pipeline.
 */
export async function fetchElevationGrid(): Promise<ElevationSamples> {
  const locations = gridLocations();
  const hash = createHash('sha256')
    .update(JSON.stringify({ BBOX, ELEVATION_COLS, ELEVATION_ROWS, ELEVATION_ENDPOINT }))
    .digest('hex')
    .slice(0, 16);
  const cacheFile = join(CACHE_DIR, `elevation-${hash}.json`);
  if (existsSync(cacheFile)) {
    console.log(`[elevation] using cache ${cacheFile}`);
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as ElevationSamples;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const raw: Array<number | null> = [];
  const batches = Math.ceil(locations.length / ELEVATION_BATCH_SIZE);
  console.log(`[elevation] fetching ${locations.length} samples in ${batches} batches from ${ELEVATION_ENDPOINT}`);
  for (let b = 0; b < batches; b++) {
    const slice = locations.slice(b * ELEVATION_BATCH_SIZE, (b + 1) * ELEVATION_BATCH_SIZE);
    const body = JSON.stringify({ locations: slice.map((l) => `${l.lat.toFixed(5)},${l.lon.toFixed(5)}`).join('|') });
    let batchResults: Array<number | null> | null = null;
    for (let attempt = 0; attempt < 2 && !batchResults; attempt++) {
      try {
        if (b > 0 || attempt > 0) await sleep(ELEVATION_REQUEST_INTERVAL_MS * (attempt + 1));
        const response = await fetch(ELEVATION_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': OVERPASS_USER_AGENT },
          body,
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as { results?: Array<{ elevation: number | null }> };
        if (!json.results || json.results.length !== slice.length) throw new Error('bad results length');
        batchResults = json.results.map((r) => r.elevation);
      } catch (error) {
        console.warn(`[elevation] batch ${b + 1}/${batches} attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!batchResults) return flatGrid(`elevation API unreachable at batch ${b + 1}/${batches}`);
    raw.push(...batchResults);
    if ((b + 1) % 10 === 0) console.log(`[elevation] ${b + 1}/${batches} batches done`);
  }
  const samples: ElevationSamples = {
    cols: ELEVATION_COLS,
    rows: ELEVATION_ROWS,
    data: fillVoids(raw).map((v) => Math.round(v)),
    source: 'SRTM 90 m via opentopodata.org',
  };
  writeFileSync(cacheFile, JSON.stringify(samples));
  console.log(`[elevation] cached to ${cacheFile}`);
  return samples;
}
