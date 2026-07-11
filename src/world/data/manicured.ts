/**
 * Manicured-site overrides (owner's "special touch"): the hand-curated exceptions to the citywide
 * procedural buildout. Each entry names a data-derived anchor (a landmark or district centre — NOT
 * a raw coordinate) and a generator to run there, plus a footprint radius. The procedural parcel
 * pass (CityGen) carves out every footprint so nothing collides with a special site, and the
 * runtime (City) runs each site's generator once, up front.
 *
 * Stage 1 ships ONE working example to prove the hook end-to-end (an oval stadium bowl). Stage 2/3
 * fill this list with the mansions, the padstal, the pier, etc. — data only, no engine changes.
 *
 * Pure data + pure resolution (no three.js) so CityGen and tests can read the footprints freely.
 */
import { districtCenter, landmark, type MapPt } from '../mapData';

/** Named generators the runtime knows how to build. Add a case in City.buildManicured for each. */
export type ManicuredGenerator = 'stadiumBowl';

/** How a site's world anchor is derived from committed map data (never a hand-typed coordinate). */
export type ManicuredAnchor =
  | { kind: 'landmark'; name: string }
  | { kind: 'district'; name: string };

export interface ManicuredSite {
  id: string;
  anchor: ManicuredAnchor;
  generator: ManicuredGenerator;
  /** Footprint radius (units): procedural buildings are kept out of this disc around the anchor. */
  radius: number;
  /** Free-form knobs passed through to the generator (e.g. bowl dimensions). */
  params?: Record<string, number>;
}

/**
 * The committed override list. Stage 1 = a single proven example: a placeholder oval stadium bowl
 * anchored to the Doornfontein-area sports precinct (Ellis Park), resolved from the district centre.
 * (The map JSON carries no stadium polygon yet, so we anchor to district data; Stage 2 can retarget
 * this to a real stadium landmark by editing the anchor alone.)
 */
export const MANICURED_SITES: readonly ManicuredSite[] = [
  {
    id: 'ellis-park-bowl',
    anchor: { kind: 'district', name: 'Doornfontein' },
    generator: 'stadiumBowl',
    radius: 95,
    params: { radiusX: 78, radiusZ: 62, wall: 22, tiers: 3 },
  },
];

export interface ResolvedManicuredSite extends ManicuredSite { x: number; z: number; }

/** Resolve a site's anchor to a world point, or undefined if the referenced data is missing. */
export function resolveAnchor(anchor: ManicuredAnchor): MapPt | undefined {
  if (anchor.kind === 'landmark') {
    const found = landmark(anchor.name);
    return found ? { x: found.x, z: found.z } : undefined;
  }
  const center = districtCenter(anchor.name);
  return center ? { x: center.x, z: center.z } : undefined;
}

/** Every manicured site whose anchor resolves against the current map, with world coordinates. */
export const RESOLVED_MANICURED_SITES: readonly ResolvedManicuredSite[] = MANICURED_SITES
  .map((site) => {
    const point = resolveAnchor(site.anchor);
    return point ? { ...site, x: point.x, z: point.z } : undefined;
  })
  .filter((site): site is ResolvedManicuredSite => site !== undefined);

/** Discs the procedural parcel pass must keep clear (id kept for debugging). */
export const MANICURED_FOOTPRINTS: ReadonlyArray<{ id: string; x: number; z: number; radius: number }> =
  RESOLVED_MANICURED_SITES.map((site) => ({ id: site.id, x: site.x, z: site.z, radius: site.radius }));
