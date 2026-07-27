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
import { besideRoad, DISTRICT_CENTERS, nearestRoadSpot, type GeneratedRoad } from '../world/mapData';
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

/** A kerb spot on an ordinary street near a point: no highways (width > 16), no service lanes. */
function kerbNear(x: number, z: number, salt: number): { x: number; z: number; heading: number } {
  const spot = nearestRoadSpot(x, z, (road) => road.width >= 7 && road.width <= 16 && roadNear(road, x, z, 900));
  const side = stablePositionRandom(spot.x, spot.z, salt) < 0.5 ? 1 : -1;
  const kerb = besideRoad(spot, side, 2.2);
  return { x: kerb.x, z: kerb.z, heading: Math.atan2(spot.x - kerb.x, spot.z - kerb.z) };
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
    .slice(0, STREET_BLOCK_COUNT);

  const sites: StreetSite[] = [];
  ranked.forEach(({ district }, block) => {
    const slug = district.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let dealerX = 0; let dealerZ = 0;
    (['dealer', 'worker'] as const).forEach((kind, which) => {
      // Both corners sit on the same block on purpose — they share a kerb, a streetlight and a
      // by-law officer. They must not share a PAVING SLAB, so the worker's corner re-rolls (still
      // deterministically) until it is a walk away from the dealer's.
      let kerb = { x: 0, z: 0, heading: 0 }; let best = -1;
      for (let attempt = 0; attempt < 5; attempt++) {
        const salt = block * 31 + which * 7 + attempt * 211 + 101;
        const angle = stablePositionRandom(district.x, district.z, salt) * Math.PI * 2;
        const reach = Math.min(district.radius, 240) * (0.3 + 0.4 * stablePositionRandom(district.x, district.z, salt + 3));
        const candidate = kerbNear(district.x + Math.cos(angle) * reach, district.z + Math.sin(angle) * reach, salt + 5);
        const apart = which === 0 ? Infinity : Math.hypot(candidate.x - dealerX, candidate.z - dealerZ);
        if (apart > best) { best = apart; kerb = candidate; }
        if (apart >= MIN_CORNER_GAP) break;
      }
      if (which === 0) { dealerX = kerb.x; dealerZ = kerb.z; }
      sites.push({
        id: `${slug}-${kind}`, kind, district: district.name,
        x: kerb.x, z: kerb.z, heading: kerb.heading,
        cast: block, // one dealer and one worker per block, cast in declaration order
      });
    });
  });
  cache = sites;
  return sites;
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
 * THE DISCOVERY RINGS. These numbers are the whole reason the owner stood in town at 23:00 and saw
 * nothing, so they are declared together, here, in the eager half where both sides can read them.
 *
 *  - ASK_AROUND_RADIUS is the eager approach ring in registry.ts, and pressing E inside it is the ONLY
 *    thing that loads the feature body in ordinary play. Nothing else fetches the chunk: not driving
 *    past, not the hour, not the district. It was 46 m — a paving slab around twelve invisible points
 *    in a city kilometres across. The player's own starting kerb is ~97 m from the CBD corner, so at
 *    the most likely place a session begins, on the densest block that carries a corner, the game
 *    never mentioned the trade and never staffed it. A block is the unit here, not a slab.
 *  - STAFF_RADIUS is how close before a corner is actually worked. It must be >= the ask ring, or the
 *    ask-around toast names two people and a bearing and you walk to an empty kerb — the exact way to
 *    turn a fixed feature back into a broken-looking one. street.state.test.ts pins both.
 *
 * Widening the ask ring is not free: the on-foot feature rung sits above `E  Enter vehicle`, so until
 * the first press the prompt inside the ring reads "Ask around" instead. That costs ONE press — the
 * press loads the body, `askAround` marks the whole block met, and the loaded rung stands down for
 * good. One press, once, in exchange for the feature existing at all.
 */
export const ASK_AROUND_RADIUS = 260;
export const STREET_STAFF_RADIUS = 300;
export const STREET_UNSTAFF_RADIUS = 380;

/** Only for tests that need a clean derivation after stubbing the map. */
export function resetStreetSites(): void { cache = undefined; }
