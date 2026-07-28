/**
 * Street economy — the EAGER half: the save slice, its sanitizer, and the kerb sites.
 *
 * This module is a TOP-LEVEL `src/features/<id>.state.ts` (one path segment), so vite.config.ts
 * sweeps it into `gameplay-rules` — the chunk with hundreds of kB spare — rather than into the
 * near-full `simulation` chunk. Two things live here and nothing else:
 *
 *  1. `sanitizeStreetState`, because SaveManager's deserialize is SYNCHRONOUS and runs long before
 *     any feature body could be fetched.
 *  2. `streetSites()`, because the registry's eager `approach` needs something to walk up to BEFORE
 *     the chunk loads — a predicate can't await an import.
 *
 * The lazy body (src/features/street/street.ts) imports this at RUNTIME on purpose. That costs
 * nothing: this file is already in an eager chunk because registry.ts imports it, so the feature
 * chunk merely references it. The trap the README warns about is the opposite direction — a state
 * module INSIDE src/features/street/ imported by both sides, which becomes its own extra eager chunk.
 *
 * Every site is DERIVED from map data at call time. Nothing here types a world coordinate: the map
 * is being reshaped (19,200 → ~9,806 units) and a literal would put a dealer in the Vaal Dam.
 */
import { besideRoad, DISTRICT_CENTERS, distanceToRoadEdge, nearestRoadSpot, type GeneratedRoad, type RoadSpot } from '../world/mapData';
import { PLAYER_SPAWN } from '../world/placements';
import { stablePositionRandom } from '../world/StableRandom';

// ---- save slice ---------------------------------------------------------------------------------

/** The three products the corners move. Kept here so the sanitizer and the lazy price table agree. */
export const STREET_PRODUCTS = ['zol', 'buttons', 'nyaope'] as const;
export type StreetProduct = (typeof STREET_PRODUCTS)[number];

export interface StreetSaveState {
  /** 0 Corner · 1 Runner · 2 Trustee. Derived from turnover, stored so a reload never demotes you. */
  tier: number;
  /** Rand put through the Body Corporate's books. The only progression number. */
  turnover: number;
  /** Arrear subs. The trustees add 8% of every sale and mention it, at length. */
  levy: number;
  stock: Record<StreetProduct, number>;
  /** Seconds of play left on the bad-date list — the citywide refusal after you hurt someone. */
  banned: number;
  /** Site ids already introduced, so nobody says hello twice. */
  met: string[];
  /** Completed short times. Counted, never scored. */
  rides: number;
  /** The corner a worker named as paying over the odds tonight, and for what. */
  tipSite?: string;
  tipProduct?: StreetProduct;
}

export const DEFAULT_STREET_STATE: StreetSaveState = {
  tier: 0, turnover: 0, levy: 0, stock: { zol: 0, buttons: 0, nyaope: 0 }, banned: 0, met: [], rides: 0,
};

/**
 * Everything the top rank can carry. Lives here rather than in the lazy price table because the
 * SYNCHRONOUS save sanitizer needs it: a hand-edited save that claims a thousand straws would be a
 * five-figure windfall on the first corner, so the stored total is clamped to what a Trustee could
 * actually have bought. The rank ladder in trade.ts reads the same constant.
 */
export const STREET_MAX_CARRY = 80;

function count(raw: unknown, cap: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0;
  return Math.min(cap, Math.max(0, value));
}

/** Runs inside SaveManager's synchronous deserialize, so it must stay pure and import no feature body. */
export function sanitizeStreetState(raw: unknown): StreetSaveState {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STREET_STATE, stock: { ...DEFAULT_STREET_STATE.stock } };
  const blob = raw as Partial<StreetSaveState> & { stock?: Record<string, unknown> };
  const stock = { zol: 0, buttons: 0, nyaope: 0 } as Record<StreetProduct, number>;
  let room = STREET_MAX_CARRY; // the TOTAL is capped, in declaration order, so the clamp is deterministic
  for (const product of STREET_PRODUCTS) {
    stock[product] = count(blob.stock?.[product], room);
    room -= stock[product];
  }
  const met = Array.isArray(blob.met)
    ? [...new Set(blob.met.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 48))].slice(0, 32)
    : [];
  const tipProduct = STREET_PRODUCTS.find((product) => product === blob.tipProduct);
  return {
    tier: Math.min(2, count(blob.tier, 2)),
    turnover: count(blob.turnover, 9_999_999),
    levy: count(blob.levy, 999_999),
    stock, met, banned: count(blob.banned, 6000), rides: count(blob.rides, 9999),
    tipSite: typeof blob.tipSite === 'string' && blob.tipSite.length <= 48 ? blob.tipSite : undefined,
    tipProduct,
  };
}

// ---- kerb sites ---------------------------------------------------------------------------------

export type StreetSiteKind = 'dealer' | 'worker';

export interface StreetSite {
  /** Stable slug: district + kind. Survives a map reshape as long as the district name does. */
  readonly id: string;
  readonly kind: StreetSiteKind;
  readonly district: string;
  readonly x: number;
  readonly z: number;
  /** Facing the road, so a fixture stands with their back to the wall like everyone actually does. */
  readonly heading: number;
  /** Index into the cast table in the lazy body. */
  readonly cast: number;
}

/**
 * Inner-city blocks, in the order the trade would actually pick them. This is a PREFERENCE, never a
 * requirement: districts that the map rework deletes simply drop out and the next-densest block
 * takes the corner. Nothing downstream may assume any of these names exists.
 */
const INNER_CITY = [
  'Hillbrow', 'Berea', 'Joburg CBD', 'Yeoville', 'Doornfontein', 'Jeppestown', 'Bertrams',
  'Braamfontein', 'Troyeville', 'Newtown', 'Maboneng Precinct', 'Ferreirasdorp', 'Fordsburg',
  "Judith's Paarl", 'Bellevue', 'Vrededorp', 'Bezuidenhoutsvallei', 'Marshalltown',
];

/** How many blocks carry a corner. Short on purpose: a dozen sites you meet beats fifty you don't. */
export const STREET_BLOCK_COUNT = 6;

/**
 * The cast slot that works the introduction block in DAYLIGHT.
 *
 * Block 0 is whichever corner is nearest where a session actually begins, and it carries a second
 * worker on a relief shift so that corner is staffed around the clock. Without this the first person
 * you can walk up to is on a 19h–5h shift, and a player who starts at noon meets an empty kerb and
 * concludes — correctly, from what he can see — that there is nothing here.
 *
 * Pinned rather than derived because this module is eager and the cast lives in the lazy body.
 * `street/copy.test.ts` asserts WORKERS[RELIEF_WORKER_CAST] covers midday and that block 0's two
 * workers between them cover all 24 hours, so the two halves can never drift apart.
 */
export const RELIEF_WORKER_CAST = 6;

/** Minimum metres between the dealer's corner and the worker's on the same block. */
export const MIN_CORNER_GAP = 25;

/** Cheap reject before the exact scan: a 4-point sample of a long polyline is enough to rule it out. */
function roadNear(road: GeneratedRoad, x: number, z: number, radius: number): boolean {
  const step = Math.max(1, Math.floor(road.points.length / 4));
  for (let index = 0; index < road.points.length; index += step) {
    const point = road.points[index]!;
    if ((point.x - x) ** 2 + (point.z - z) ** 2 < radius * radius) return true;
  }
  return false;
}

/**
 * Standing room, measured from EVERY carriageway edge rather than from the one road we offset from.
 *
 * This number is a bug fix with an in-engine receipt. A "corner" is by definition beside a junction,
 * and stepping 2.2 m past one road's kerb routinely lands inside the CROSS street. The first machine
 * playthrough of this feature found Gugu Ndlovu on 0 health and Chidi Nwosu on 60, both standing in
 * live traffic, being run down by ambient cars — which killed the corner for seven minutes and, if
 * the player happened to be within the blame radius, banned them from the entire trade for something
 * a taxi did. Walking up to your first contact was a trap.
 *
 * The figure is sized off the engine's own roadkill test, not by eye: PopulationSystem floors a ped
 * whose CENTRE is within sqrt(5) ≈ 2.24 m of a vehicle's centre. A car hugging the near kerb has its
 * centre roughly 1.5 m inside the road edge, so standing 2.6 m beyond the edge leaves about 4.1 m —
 * comfortably outside that radius, with room for a taxi that clips the pavement.
 */
export const PAVEMENT_CLEARANCE = 2.6;
/** Offsets tried, nearest kerb first, before giving up and taking the clearest of them. */
const KERB_STEPS = [3, 4, 5.2, 6.4, 8];
/** Vertices tried along the street, nearest first. Stepping ALONG the road is what actually escapes a
 *  junction: at a crossroads every perpendicular offset from the narrow street is still inside the
 *  wide one, and the probe showed most CBD candidates sitting 3–7 m deep in a carriageway. */
const ALONG_STEPS = [0, 1, -1, 2, -2, 3, -3, 4, -4];

/** A road spot at an arbitrary vertex — mapData keeps its own `spotAt` private, and stepping along
 *  the street is the whole point of the search below. Same tangent convention (previous → next). */
function vertexSpot(road: GeneratedRoad, index: number): RoadSpot {
  const point = road.points[index]!;
  const previous = road.points[Math.max(0, index - 1)] ?? point;
  const next = road.points[Math.min(road.points.length - 1, index + 1)] ?? point;
  const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
  return { x: point.x, z: point.z, dirX: dx / length, dirZ: dz / length, road };
}

/** A kerb spot on an ordinary street near a point: no highways (width > 16), no service lanes, and
 *  never on a road surface — the pavement, where a person could actually stand. */
function kerbNear(x: number, z: number, salt: number): { x: number; z: number; heading: number; clear: number } {
  const spot = nearestRoadSpot(x, z, (road) => road.width >= 7 && road.width <= 16 && roadNear(road, x, z, 900));
  const road = spot.road;
  let index = 0; let closest = Infinity;
  for (let at = 0; at < road.points.length; at++) {
    const point = road.points[at]!;
    const distance = (point.x - spot.x) ** 2 + (point.z - spot.z) ** 2;
    if (distance < closest) { closest = distance; index = at; }
  }
  const first = stablePositionRandom(spot.x, spot.z, salt) < 0.5 ? 1 : -1;
  let best = { x: spot.x, z: spot.z, heading: 0, clear: -Infinity };
  for (const along of ALONG_STEPS) {
    const at = index + along;
    if (at < 0 || at >= road.points.length) continue;
    const here = vertexSpot(road, at);
    for (const side of [first, (first === 1 ? -1 : 1)] as const) {
      for (const clearance of KERB_STEPS) {
        const kerb = besideRoad(here, side, clearance);
        const clear = distanceToRoadEdge(kerb.x, kerb.z);
        const candidate = { x: kerb.x, z: kerb.z, heading: Math.atan2(here.x - kerb.x, here.z - kerb.z), clear };
        if (clear > best.clear) best = candidate;
        if (clear >= PAVEMENT_CLEARANCE) return candidate; // nearest safe pavement on the nearest kerb wins
      }
    }
  }
  return best;
}

let cache: StreetSite[] | undefined;

/**
 * The corners, derived once per session from whatever districts the generated map actually has.
 *
 * Memoized because `nearestRoadSpot` walks every road vertex and this is called from a per-frame
 * proximity predicate. Deterministic: `stablePositionRandom` only — no Math.random, no Date, so two
 * players on two machines stand on the same kerb.
 */
export function streetSites(): StreetSite[] {
  if (cache) return cache;
  const ranked = [...DISTRICT_CENTERS]
    .map((district) => {
      const preference = INNER_CITY.indexOf(district.name);
      return { district, score: (preference >= 0 ? 10_000 - preference * 100 : 0) + Math.min(2000, district.density) };
    })
    .sort((a, b) => b.score - a.score || (a.district.name < b.district.name ? -1 : 1))
    .slice(0, STREET_BLOCK_COUNT)
    // …and then ORDERED BY HOW SOON YOU MEET THEM. Block 0 is the corner nearest where a session
    // begins, which matters twice over: trade.supplyProduct pins block 0 to the one product a
    // Corner-rank player with R750 is allowed to buy, and RELIEF_WORKER_CAST staffs block 0 through
    // the day. Both of those were landing on Hillbrow, 1.7 km from the spawn kerb, while the corner
    // the player could actually reach in a minute sold something his rank could not touch.
    .sort((a, b) => spawnDistance(a.district) - spawnDistance(b.district) || (a.district.name < b.district.name ? -1 : 1));

  const sites: StreetSite[] = [];
  ranked.forEach(({ district }, block) => {
    const slug = district.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    // The corners on this block. They share a kerb, a streetlight and a by-law officer on purpose,
    // but they must not share a PAVING SLAB, so each one re-rolls (still deterministically) until it
    // is a walk away from the ones already placed. Block 0 carries the daylight relief as well.
    const plan: { kind: StreetSiteKind; cast: number; suffix: string }[] = [
      { kind: 'dealer', cast: block, suffix: 'dealer' },
      { kind: 'worker', cast: block, suffix: 'worker' },
      ...(block === 0 ? [{ kind: 'worker' as StreetSiteKind, cast: RELIEF_WORKER_CAST, suffix: 'day-worker' }] : []),
    ];
    const placed: { x: number; z: number }[] = [];
    plan.forEach((corner, which) => {
      let kerb = { x: 0, z: 0, heading: 0, clear: -Infinity }; let best = -1;
      for (let attempt = 0; attempt < 8; attempt++) {
        const salt = block * 31 + which * 7 + attempt * 211 + 101;
        // Golden-angle spread on retries. A purely random re-roll can land three candidates on the
        // same stretch of kerb (it did: Bertrams' two corners came out 13 m apart), so each retry is
        // deliberately swung to a different side of the district before the distance test runs.
        const angle = stablePositionRandom(district.x, district.z, salt) * Math.PI * 2 + attempt * 2.399963;
        const reach = Math.min(district.radius, 240) * (0.3 + 0.4 * stablePositionRandom(district.x, district.z, salt + 3));
        const candidate = kerbNear(district.x + Math.cos(angle) * reach, district.z + Math.sin(angle) * reach, salt + 5);
        const apart = placed.reduce((closest, at) => Math.min(closest, Math.hypot(candidate.x - at.x, candidate.z - at.z)), Infinity);
        // Off the carriageway FIRST, spread out second. A corner in the road is not a corner, it is a
        // road death, and a road death inside the blame radius shuts the whole trade on the player.
        const safe = candidate.clear >= PAVEMENT_CLEARANCE;
        const score = apart + (safe ? 10_000 : 0);
        if (score > best) { best = score; kerb = candidate; }
        if (safe && apart >= MIN_CORNER_GAP) break;
      }
      placed.push({ x: kerb.x, z: kerb.z });
      sites.push({
        id: `${slug}-${corner.suffix}`, kind: corner.kind, district: district.name,
        x: kerb.x, z: kerb.z, heading: kerb.heading, cast: corner.cast,
      });
    });
  });
  cache = sites;
  return sites;
}

/** Flat metres from the game's own start point — the ordering key for which block you meet first. */
function spawnDistance(district: { x: number; z: number }): number {
  return Math.hypot(district.x - PLAYER_SPAWN[0], district.z - PLAYER_SPAWN[2]);
}

/** Nearest site to a point, with its squared distance — the eager approach ring and the console both use it. */
export function nearestStreetSite(x: number, z: number): { site: StreetSite; distanceSq: number } | undefined {
  let best: StreetSite | undefined; let bestDistance = Infinity;
  for (const site of streetSites()) {
    const distance = (site.x - x) ** 2 + (site.z - z) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = site; }
  }
  return best ? { site: best, distanceSq: bestDistance } : undefined;
}

/**
 * THE DISCOVERY RINGS. These are the numbers the owner's playtest was actually about, so they are
 * declared together, here, in the eager half where both sides can read them.
 *
 *  - STREET_LOAD_RADIUS is the eager ring in registry.ts. The host now watches it every 0.4 s and
 *    loads the body the moment the player is inside — no press, no prompt, no riddle (see
 *    FeatureHost.preloadNearby). The old design made ONE press on an "E Ask around" prompt the only
 *    thing in the entire build that could bring these people into existence, and the ring around each
 *    invisible point was 46 m wide. The player's start kerb is ~97 m from the CBD corner: at the most
 *    likely place a session begins, the game never mentioned the trade and never staffed it.
 *  - STAFF_RADIUS is how close before a corner is actually worked, and it must be >= the load ring,
 *    or the map blip and the pillar of light point at an empty pavement — the exact way to turn a
 *    fixed feature back into a broken-looking one. street.state.test.ts pins both.
 *
 * The load ring is a BLOCK, not a doorstep, because a corner has to be staffed and blipped before you
 * are close enough to see anybody on it. Costing the player nothing is what makes that affordable:
 * there is no prompt in the ring any more, so it can never sit on top of `E  Enter vehicle`.
 */
export const STREET_LOAD_RADIUS = 300;
export const STREET_STAFF_RADIUS = 340;
export const STREET_UNSTAFF_RADIUS = 420;

/** Only for tests that need a clean derivation after stubbing the map. */
export function resetStreetSites(): void { cache = undefined; }
