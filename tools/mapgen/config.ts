/**
 * Configuration for the Johannesburg OSM map pipeline (Phase 1, offline only).
 * All distances in the PROCESS section are real-world metres (pre-scale);
 * widths and TARGET_SIZE are game world units.
 */

/** Bounding box covering Johannesburg CBD up to Sandton. [south, west, north, east] */
export const BBOX = { south: -26.28, west: 27.95, north: -26.05, east: 28.12 } as const;

/** Approximate centre of the Joburg CBD (Rissik & Commissioner area). */
export const CBD_CENTER = { lat: -26.205, lon: 28.043 } as const;

/** Residential streets are only fetched within this radius (m) of the CBD centre. */
export const RESIDENTIAL_RADIUS_M = 2000;

/** Douglas-Peucker simplification tolerance in metres. */
export const SIMPLIFY_TOLERANCE_M = 8;

/** Junction nodes closer than this (metres) are snapped together. */
export const SNAP_DISTANCE_M = 12;

/**
 * Disconnected sub-networks (islands) whose nearest node is within this
 * distance (metres) of the main component get bridged with a connector
 * segment instead of being dropped.
 */
export const BRIDGE_DISTANCE_M = 60;

/** Roads shorter than this (metres, whole polyline) are discarded as noise. */
export const MIN_ROAD_LENGTH_M = 25;

/** Water polygons smaller than this (square metres) are discarded. */
export const MIN_WATER_AREA_M2 = 4000;

/** Target square footprint (game units). The real bbox is fitted inside, aspect preserved. */
export const TARGET_SIZE = 3000;

/** Game-unit road widths per OSM highway class. */
export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 32,
  motorway_link: 16,
  trunk: 28,
  trunk_link: 14,
  primary: 24,
  primary_link: 12,
  secondary: 18,
  secondary_link: 10,
  tertiary: 14,
  tertiary_link: 8,
  residential: 10,
};

/** Off-road tracks/trails (not part of the connected road graph). */
export const TRACK_WIDTHS: Record<string, number> = {
  track: 6,
  path: 3.5,
};

/** Landuse polygons smaller than this (square metres) are discarded. */
export const MIN_LANDUSE_AREA_M2 = 15_000;

/** Elevation grid resolution (cols x rows over the bbox). */
export const ELEVATION_COLS = 96;
export const ELEVATION_ROWS = 96;

/** Open elevation API (SRTM 90 m) — batched, cached, polite. */
export const ELEVATION_ENDPOINT = 'https://api.opentopodata.org/v1/srtm90m';
export const ELEVATION_BATCH_SIZE = 100;
export const ELEVATION_REQUEST_INTERVAL_MS = 1100;

/** Overpass endpoints: primary, then a politely-used mirror fallback. */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

export const OVERPASS_USER_AGENT = 'groot-theft-bakkie-mapgen/1.0 (offline map pipeline; contact repo owner)';

/** Landmark name patterns fetched from OSM (case-insensitive regex, anchored by Overpass). */
export const LANDMARK_NAME_REGEX =
  'Ponte Tower|Ponte City|Hillbrow Tower|Constitution Hill|FNB Stadium|Soccer City';

/** Landmarks must match this exactly (or be stations) — filters out matches like "Soccer City ticket office". */
export const LANDMARK_CANONICAL = /^(ponte tower|ponte city|hillbrow tower|constitution hill|fnb stadium|soccer city)$/i;

/** Default district radius (metres) when only a place node is available. */
export const DISTRICT_RADIUS_M = 700;
