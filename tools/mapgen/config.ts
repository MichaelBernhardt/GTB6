/**
 * Configuration for the Johannesburg OSM map pipeline (Phase 1, offline only).
 * All distances in the PROCESS section are real-world metres (pre-scale);
 * widths and TARGET_SIZE are game world units.
 */

/** Phase-2 driveable crop: CBD up to Sandton, trimmed flanks. [south, west, north, east] */
export const BBOX = { south: -26.23, west: 27.97, north: -26.09, east: 28.09 } as const;

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

/**
 * Target square footprint (game units). The real bbox is fitted inside, aspect preserved.
 * 18000 is the true-parity scale on owner direction: it measures ~0.98 m/unit with the
 * coast+corridor graft — effectively "1 unit = 1 metre", so drive times and block sizes match
 * the real city (the previous 36000 was 0.49 m/u, exactly 2x oversized). ROAD_WIDTHS/
 * TRACK_WIDTHS and the runway/pier/taxiway *widths* stay game-scale (fixed) while the whole
 * layout is map-scale, and every metre-denominated feature below (corridor, runway/pier
 * LENGTHS, dam, ring, meanders) scales with the map automatically because it is converted
 * through fit.scale. A 2-unit-wide car still gets the same two-lane carriageway.
 */
export const TARGET_SIZE = 18000;

/** Game-unit road widths per OSM highway class. */
export const ROAD_WIDTHS: Record<string, number> = {
  motorway: 24,
  motorway_link: 11,
  trunk: 18,
  trunk_link: 10,
  primary: 14,
  primary_link: 8,
  secondary: 11,
  secondary_link: 7,
  tertiary: 9,
  tertiary_link: 6,
  residential: 7,
};

/** Off-road tracks/trails (not part of the connected road graph). */
export const TRACK_WIDTHS: Record<string, number> = {
  track: 5,
  path: 3,
};

/** Landuse polygons smaller than this (square metres) are discarded. */
export const MIN_LANDUSE_AREA_M2 = 15_000;

/**
 * Density thinning ("guided by life, not true to life"): minor roads mostly running
 * parallel within THIN_COVERAGE_DISTANCE_M of an already-retained road are dropped, so
 * the ~70 m CBD grid decimates to a driveable pitch. Parody/anchor street names (the
 * names-overrides keys plus the list below) are never dropped.
 */
export const THIN_COVERAGE_DISTANCE_M = 55;
export const THIN_COVERAGE_FRACTION = 0.62;
export const THIN_SAMPLE_STEP_M = 20;
export const THIN_PARALLEL_COS = 0.8; // ~36 degrees
export const THIN_MAX_RANK = 3; // residential..secondary may be dropped; primary+ never
/** Post-thinning cleanup: dangling minor spurs shorter than this (m) are pruned. */
export const STUB_PRUNE_LENGTH_M = 80;
/** Anchor streets the game placements rely on that are not in names-overrides.json. */
export const PROTECTED_ROAD_NAMES = [
  'Albertina Sisulu Road',
  'Wemmer Jubilee Road',
  'Lilian Ngoyi Street',
  'Wanderers Street',
  'Anderson Street',
  'Von Weilligh Street',
] as const;

/** Boundary orbital: dangling endpoints near the crop edge are joined into one ring road. */
export const RING_BOUNDARY_MARGIN_M = 380;
export const RING_OFFSET_M = 220;
export const RING_CORNER_CHAMFER_M = 260;
export const RING_NAME = 'Egoli Orbital';
export const RING_KIND = 'trunk' as const;

/**
 * Jozi-by-the-Sea: the west edge of the map becomes an Atlantic-style coastline grafted
 * from Cape Town's Sea Point -> Camps Bay seaboard, separated from the Joburg block by a
 * rural farmland corridor ("a little drive between them"). Deliberately fantastical.
 */
export const CAPE_BBOX = { south: -33.93, west: 18.37, north: -33.87, east: 18.42 } as const;
/**
 * Rural corridor width between the Joburg west edge and the coastal strip (metres).
 * Metre-denominated, so it scales with the map: at the 36000 u footprint (~0.49 m/u) the 2700 m
 * corridor is a ~5500 u drive — the "little drive between them" grows proportionally with the
 * scale-up, exactly as intended.
 */
export const CORRIDOR_WIDTH_M = 2700;
/** Coastal road sits this far inland of the waterline. */
export const COAST_ROAD_SETBACK_M = 260;
/** North-south stretch applied to the Cape strip so it covers more of the west edge. */
export const COAST_STRETCH_Z = 1.35;
/** The ocean fill extends this far west of the coastline. */
export const OCEAN_EXTENT_M = 2600;
export const COASTAL_ROAD_NAME = 'Victoria Road';
/** Corridor connector roads (creative geography, hence the in-game names straight away). */
export const CORRIDOR_LINKS = [
  { name: 'Madiba Meander', kind: 'trunk' },
  { name: 'Rooibos Route', kind: 'secondary' },
] as const;
export const FRONTAGE_ROAD_NAME = 'Plaaspad';
/** Renamed to "Ouma se Padstal" via names-overrides.json. */
export const PADSTAL_NAME = 'Padstal';
export const HARBOUR_DISTRICT_NAME = 'Kaapstad Quay';

/**
 * Organic curvature applied to the synthetic roads (owner: "far too straight ... a bit more
 * meandering and organic"). Perpendicular fBm offset (amplitude in METRES; 1 unit ~= 3.75 m,
 * so the orbital's ~220 m ≈ 59 u sits in the requested ±40-80 u band), tapered to zero at
 * every junction attachment point, then Chaikin-smoothed. Keyed by road name.
 */
export interface MeanderSpec {
  amplitude: number;
  wavelength: number;
  octaves: number;
  step: number;
  taper: number;
  chaikin: number;
}
export const MEANDER_SPECS: Record<string, MeanderSpec> = {
  'Egoli Orbital': { amplitude: 220, wavelength: 2600, octaves: 3, step: 90, taper: 260, chaikin: 2 },
  Plaaspad: { amplitude: 120, wavelength: 1600, octaves: 2, step: 80, taper: 170, chaikin: 2 },
  'Madiba Meander': { amplitude: 150, wavelength: 2100, octaves: 2, step: 100, taper: 280, chaikin: 1 },
  'Rooibos Route': { amplitude: 130, wavelength: 1900, octaves: 2, step: 100, taper: 280, chaikin: 1 },
  Melkweg: { amplitude: 90, wavelength: 1400, octaves: 2, step: 90, taper: 160, chaikin: 1 },
  'Kraal Close': { amplitude: 90, wavelength: 1400, octaves: 2, step: 90, taper: 160, chaikin: 1 },
};
/** Synthetic-road polylines shorter than this many vertices are spurs, not the spine — left straight. */
export const MEANDER_MIN_VERTICES = 5;

/** Regional airport in the southern farmland corridor. Base name is parodied via overrides. */
export const AIRPORT_NAME = 'OR Tambourine Field';
export const AIRPORT_ACCESS_ROAD_NAME = 'Aviator Avenue';
/**
 * Runway length (metres). Metre-denominated, so it scales with the map: at ~0.49 m/u the 1250 m
 * runway is ~2550 u long (up from ~425 u at the old 6000 footprint) — the runway *width* stays
 * game-scale (14 u, set in process.ts), so planes get a long, proportionate strip rather than a
 * postage stamp on the enlarged map.
 */
export const AIRPORT_RUNWAY_LENGTH_M = 1250;
export const AIRPORT_RUNWAY_BEARING_RAD = 0.32; // gentle NE-SW tilt

/** Small sea port / pier on the NW coast (distinct from Kaapstad Quay near the CBD). */
export const PORT_NAME = 'Seepunt Pier';
export const PORT_ACCESS_ROAD_NAME = 'Sloepbaai Road';
export const PORT_PIER_LENGTH_M = 620;

/** Reservoir / dam near the NE suburb edge (premium water tier, organic shoreline). */
export const LAKE_NAME = 'Egoli Dam';
export const LAKE_RADIUS_M = 720;
export const LAKESIDE_TRACK_NAME = 'Dam wal';

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
