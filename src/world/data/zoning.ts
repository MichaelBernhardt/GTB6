/**
 * Zoning layer (owner's rule A: source → destination). Every point of the generated map is
 * classified into a land-use zone purely from committed data — the OSM map JSON (district
 * densities, landuse/water polygons) plus the curated district lists below. No hand-placed
 * coordinates: change a name list or a threshold and the whole city re-zones deterministically.
 *
 * The zone drives Stage-1 procedural massing (parcel size, building style, density) and is the
 * extension point Stage 2/3 read for manicured POIs, farms and beachfront. Pure data + pure
 * functions (no three.js) so tests and the headless build script can consume it freely.
 */
import {
  AERODROME_POLYGONS,
  DIRT_POLYGONS,
  DISTRICT_CENTERS,
  FARM_POLYGONS,
  GREEN_POLYGONS,
  nearestDistrict,
  pointInAnyPolygon,
  WATER_POLYGONS,
  type DistrictCenter,
} from '../mapData';

export type Zone =
  | 'commercial-highrise' // CBD / Sandton towers
  | 'commercial-strip'    // arterial retail in dense districts
  | 'residential'         // the suburban bulk of the map
  | 'industrial'          // sheds & yards (industrial belt)
  | 'estate'              // low-density wealthy villas (Sandhurst-class)
  | 'rural'               // corridor farmland
  | 'none';               // parks, water, airport, mine dumps — unbuilt

/** Every zone, in the order the summary reports them. */
export const ZONES: readonly Zone[] = [
  'commercial-highrise', 'commercial-strip', 'residential', 'industrial', 'estate', 'rural', 'none',
];

/**
 * Wealthy low-density districts that mass as walled estates/mansions instead of terraced houses.
 * Curated from the generated place-node names (Sandhurst, Houghton, the northern old-money belt).
 */
export const ESTATE_DISTRICTS: ReadonlySet<string> = new Set([
  'Sandhurst', 'Houghton Estate', 'Hyde Park', 'Westcliff', 'Dunkeld', 'Illovo', 'Saxonwold',
  'Forest Town', 'Hurlingham', 'Hurlingham Gardens', 'Atholl Gardens', 'Birnam Park', 'Melrose',
  'Melrose North', 'Parktown North', 'Parkhurst', 'Craighall Park', 'Bordeaux', 'Strathavon',
  'Westdene', 'Birdhaven',
]);

/**
 * Industrial districts (yards, sheds, the mining/rail belt south and west of the CBD). Curated
 * from the generated names; density alone under-reads them, so the list pins the character.
 */
export const INDUSTRIAL_DISTRICTS: ReadonlySet<string> = new Set([
  'Ophirton', 'Booysens', 'Wynberg', 'Crown', 'Langlaagte North', 'Paarlshoop', 'Village Main',
  'Denver', 'City Deep',
]);

/**
 * Highrise commercial cores. Curated by name because the OSM "buildingDensity" is a building COUNT
 * per km² — it peaks in dense low-rise suburbs (Greenside, Mayfair) and UNDER-reads the tower cores
 * (the Joburg CBD counts as ~244, Sandton's skyscrapers as ~23). So the skyline is pinned by name.
 */
export const HIGHRISE_DISTRICTS: ReadonlySet<string> = new Set([
  'Joburg CBD', 'Braamfontein', 'Hillbrow', 'Berea', 'Newtown', 'Ferreirasdorp',
  'Maboneng Precinct', 'Sandton',
]);

/** Minimum building-count density for a residential district's arterial frontages to become a retail strip. */
export const STRIP_DENSITY = 60;
/** Road width (units) at/above which a frontage is an arterial (primary/trunk carriageway). */
export const ARTERIAL_WIDTH = 13;

/** The baseline zone of a whole district, from its name/density alone (before per-point geometry). */
export function districtBaseZone(district: DistrictCenter): Exclude<Zone, 'none' | 'rural' | 'commercial-strip'> {
  if (ESTATE_DISTRICTS.has(district.name)) return 'estate';
  if (INDUSTRIAL_DISTRICTS.has(district.name)) return 'industrial';
  if (HIGHRISE_DISTRICTS.has(district.name)) return 'commercial-highrise';
  return 'residential';
}

/**
 * Classify a single point. `roadWidth` is the width of the frontage road it sits on (omit for a
 * pure district-level query); a wide arterial in a dense residential district becomes a strip.
 * Precedence: unbuilt geometry → farmland → district character → arterial retail → residential.
 */
export function classifyZone(x: number, z: number, roadWidth = 0): Zone {
  if (pointInAnyPolygon(WATER_POLYGONS, x, z)) return 'none';
  if (pointInAnyPolygon(GREEN_POLYGONS, x, z)) return 'none';
  if (pointInAnyPolygon(DIRT_POLYGONS, x, z)) return 'none';
  if (pointInAnyPolygon(AERODROME_POLYGONS, x, z)) return 'none';
  if (pointInAnyPolygon(FARM_POLYGONS, x, z)) return 'rural';

  const district = nearestDistrict(x, z);
  const base = districtBaseZone(district);
  if (base === 'estate' || base === 'industrial' || base === 'commercial-highrise') return base;
  // residential baseline: promote wide arterials in built-up suburbs to a commercial strip
  if (roadWidth >= ARTERIAL_WIDTH && district.density >= STRIP_DENSITY) return 'commercial-strip';
  return 'residential';
}

/** Baseline zone counts across every district — a quick citywide character summary. */
export function districtZoneSummary(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const district of DISTRICT_CENTERS) {
    const zone = districtBaseZone(district);
    counts[zone] = (counts[zone] ?? 0) + 1;
  }
  return counts;
}
