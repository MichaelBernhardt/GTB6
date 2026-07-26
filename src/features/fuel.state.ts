/**
 * PETROL — the eager half.
 *
 * This is the ONE path segment under src/features/ (see vite.config.ts), so it is swept into the
 * `gameplay-rules` chunk rather than becoming a chunk of its own. It carries three things:
 *
 *  1. the save slice + its sanitizer, which SaveManager runs synchronously at boot;
 *  2. the tank ledger and the burn maths, because fuel is the one feature that must be TRUE before
 *     the player has opted into it — a gauge that only starts draining once you have already pulled
 *     into a garage would be a mechanic you can decline;
 *  3. the forecourt sites, derived at runtime from the baked model scatter. No typed world
 *     coordinates: the map has moved once and will move again.
 *
 * The lazy body (src/features/fuel/fuel.ts) imports this by VALUE on purpose. Rule 4 in the feature
 * README forbids that only for a state module living INSIDE src/features/<id>/, which would become
 * its own extra eager chunk; a top-level `<id>.state.ts` already has an explicit chunk assignment,
 * so the body simply references the eager chunk and adds no bytes to its own.
 */
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleKind } from '../config';

/**
 * NOTHING under src/world/ may be imported here by VALUE, and this is not a style rule.
 *
 * `simulation` already imports `gameplay-rules` (LivingCitySystem, TaxiJobSystem, …), so a static
 * import the other way closes a chunk-evaluation cycle. It builds clean, every unit test passes, and
 * then the real bundle dies on boot with "Cannot access 'X' before initialization" — a
 * temporal-dead-zone fault that only a booted browser can show you. It cost this branch a boot.
 *
 * The forecourt data therefore arrives through a DYNAMIC import (see ensureSites), which resolves to
 * the already-loaded `simulation`/`world-data` chunks: no new chunk, no bytes, no cycle.
 */

// ---- the regulated price -------------------------------------------------------------------------

/** 95 unleaded, INLAND, in cents per litre. Coastal is 85-90c cheaper and getting that backwards is
 *  the specific error a Joburg player would notice — Johannesburg is inland, so this is the dear one.
 *  25.99 is also literally what the price totem on the scattered filling-station model reads
 *  (src/world/models/commercial.ts), so the pylon board and the pump agree on day one. */
export const BASE_95_CENTS = 2599;
/** 93 unleaded: the inland grade, and cheaper. On the Highveld it is the sensible buy, not a trap. */
export const GRADE_93_DISCOUNT_CENTS = 38;
/** Regulated changes land at midnight; in the real world that is the first Wednesday of the month.
 *  A game day is 600s (DAY_CYCLE_SECONDS), so a real month would be five hours of play — compressed
 *  to three midnights, announced one midnight in advance, so the beat lands about twice an hour. */
export const HIKE_PERIOD_DAYS = 3;

/** The levies inside every litre, cents. Real 2026-ish numbers: the joke lands on the state. */
export const LEVIES = { fuel: 429, raf: 225, carbon: 23 } as const;
export const LEVY_CENTS = LEVIES.fuel + LEVIES.raf + LEVIES.carbon;

// ---- tanks ---------------------------------------------------------------------------------------

/**
 * Tank size (litres) and thirst per kind.
 *
 * TUNING, against the owner's reward test and the payout table in src/story/missions.ts (900 / 1100 /
 * 1500 / 1800 / 2200 / 2600 / 2800 mid-tier; Economy opens at 750):
 *
 *  - A vol-tank on the starter Citi Golf is 45 L x R25.99 = R1,169 — one "Hot Copper" (1500). That is
 *    the anchor the plan asked for: a full fill is a mission, not a mortgage, and you almost never
 *    fill from bone dry.
 *  - Burn is per SECOND, not per unit, so a Sandton Rocket and a Hilux both get a comparable number of
 *    MINUTES per tank. Time is what the player actually feels.
 *  - IDLE + full throttle drains the starter car in ~9 minutes of pinned-to-the-floor driving, ~14 at a
 *    realistic average. Two or three fills in a long session: you notice it, it is never the session.
 *  - Two-wheelers are cheap to run (small tank, small thirst) — authentic, and it makes the scrambler
 *    a real economic choice rather than a downgrade.
 *  - The bicycle has no tank and never shows a gauge, matching how Vehicle already special-cases it.
 */
export const TANKS: Readonly<Record<VehicleKind, number>> = {
  compact: 45, sport: 55, van: 80, police: 66, taxi: 70,
  bicycle: 0, motorbike: 18, courier: 14, superbike: 18,
};
export const THIRST: Readonly<Record<VehicleKind, number>> = {
  compact: 0.85, sport: 1.15, van: 1.2, police: 1.05, taxi: 1.1,
  bicycle: 0, motorbike: 0.34, courier: 0.3, superbike: 0.42,
};
/** Litres per second with the engine running and the car standing still. */
export const IDLE_LPS = 0.006;
/** Extra litres per second at full throttle, before the per-kind thirst multiplier. */
export const THROTTLE_LPS = 0.09;

/** Below this fraction the engine stumbles; at zero it will not hold at all. */
export const SPUTTER_FRACTION = 0.055;
/** Below this the HUD chip turns warning-coloured and the attendant nags. */
export const LOW_FRACTION = 0.18;
/** A jerry can from the shop, litres. Plastic, five litre, the one everybody owns. */
export const CAN_LITRES = 5;
/** Can + deposit, rand. */
export const CAN_PRICE = 175;

export function tankSize(vehicle: Vehicle): number { return TANKS[vehicle.spec.kind] ?? 0; }
export function hasTank(vehicle: Vehicle | undefined): vehicle is Vehicle {
  return Boolean(vehicle) && tankSize(vehicle!) > 0;
}

// ---- the ledger ------------------------------------------------------------------------------------

/** Litres per live Vehicle. A WeakMap so a despawned car's entry dies with it — traffic churns hard
 *  and a Map keyed on vehicles would be a slow leak for the whole session. */
const ledger = new WeakMap<Vehicle, number>();
/** Set once the lazy body is live. Until then the tank floors at a limp reserve: a mechanic the
 *  player has never been shown must not be allowed to strand them. */
let revealed = false;
/** The very first car of a session is generously filled, so a fresh boot never opens on a chore. */
let seenAnyVehicle = false;
let lastTick = 0;

export function markRevealed(): void { revealed = true; }
export function isRevealed(): boolean { return revealed; }

/** Deterministic starting fill. Ambient, parked and stolen cars must NOT all be full or the mechanic
 *  never bites; the seed is the spawn position, mirroring stablePositionRandom's use everywhere else,
 *  so the same abandoned bakkie on the same corner always has the same quarter tank. */
/** Deterministic [0,1) from a world position. Same shape as world/StableRandom's position hash, but
 *  written out here because this module may not import from src/world (see the header). */
function positionRoll(x: number, z: number, salt = 4703): number {
  let h = Math.imul(Math.round(x * 16) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.round(z * 16) ^ 0xc2b2ae35, 0x27d4eb2f);
  h = Math.imul(h ^ salt, 0x165667b1);
  h ^= h >>> 15;
  return ((h >>> 0) % 100_000) / 100_000;
}

export function seedFill(vehicle: Vehicle): number {
  const size = tankSize(vehicle);
  if (size <= 0) return 0;
  const at = vehicle.group.position;
  const roll = positionRoll(at.x, at.z);
  const fraction = seenAnyVehicle ? 0.18 + roll * 0.67 : 0.62 + roll * 0.33;
  seenAnyVehicle = true;
  return size * fraction;
}

export function litresIn(vehicle: Vehicle): number {
  const existing = ledger.get(vehicle);
  if (existing !== undefined) return existing;
  const seeded = seedFill(vehicle);
  ledger.set(vehicle, seeded);
  return seeded;
}

export function setLitres(vehicle: Vehicle, litres: number): number {
  const clamped = Math.max(0, Math.min(tankSize(vehicle), litres));
  ledger.set(vehicle, clamped);
  return clamped;
}

/** Has this vehicle been metered yet? Used by the body to adopt a saved tank onto the car the player
 *  climbs back into after a reload. */
export function isMetered(vehicle: Vehicle): boolean { return ledger.has(vehicle); }

export function fractionIn(vehicle: Vehicle): number {
  const size = tankSize(vehicle);
  return size > 0 ? litresIn(vehicle) / size : 0;
}

/** Burn one step. Pure arithmetic — called from the eager approach predicate before the body loads,
 *  and from the body's update() after, which are mutually exclusive by construction. */
export function burn(vehicle: Vehicle, dt: number): number {
  const size = tankSize(vehicle);
  if (size <= 0 || dt <= 0) return 0;
  if (vehicle.wrecked || vehicle.disabled) return litresIn(vehicle);
  const load = Math.min(1, Math.abs(vehicle.speed) / Math.max(1, vehicle.spec.maxSpeed));
  const used = dt * (IDLE_LPS + THROTTLE_LPS * THIRST[vehicle.spec.kind] * load);
  // Until the player has actually met the mechanic, the tank bottoms out at a limp reserve instead
  // of stranding them for a rule nobody told them about.
  const floor = revealed ? 0 : size * 0.09;
  return setLitres(vehicle, Math.max(floor, litresIn(vehicle) - used));
}

/** Wall-clock step for the eager path, which has no dt of its own. Clamped so a tab that was
 *  backgrounded for a minute does not empty the tank on the frame it comes back. */
export function eagerStep(): number {
  const now = typeof performance === 'undefined' ? Date.now() : performance.now();
  const dt = lastTick === 0 ? 0 : Math.max(0, Math.min(0.1, (now - lastTick) / 1000));
  lastTick = now;
  return dt;
}

/** New game / checkpoint reload: forget the session-scoped bookkeeping. The WeakMap empties itself as
 *  the old vehicles are collected. */
export function resetLedger(): void { revealed = false; seenAnyVehicle = false; lastTick = 0; }

// ---- forecourts ------------------------------------------------------------------------------------

/** Brands, in the same order buildFillingStation picks them, so the name on the prompt is the name on
 *  the sign above the pumps. Parody spellings are the model's, not ours. */
const BRANDS: ReadonlyArray<{ name: string; accent: string }> = [
  { name: 'Engine', accent: '#d64541' },
  { name: 'Caltexx', accent: '#3d9970' },
  { name: 'Sasoil', accent: '#3f78b5' },
  { name: 'Boerepetrol', accent: '#e0a63c' },
];

export interface Station {
  readonly id: string;
  /** "Engine Melville" — brand off the sign, suburb off the district layer. */
  readonly name: string;
  readonly brand: string;
  readonly accent: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  /** Half-extents of the drivable apron in the station's own frame. */
  readonly halfW: number;
  readonly halfD: number;
  /** The apron is laid one unit forward of the model origin. */
  readonly offZ: number;
  /** Local x of each pump island; the attendant stands at the first one. */
  readonly islands: readonly number[];
  /** True for the one station the feature has to build itself (see fuel.ts). */
  readonly authored: boolean;
}

type Hash = (seed: number, salt: number) => number;

function station(hash: Hash, name: (x: number, z: number, brand: string) => string, id: string, x: number, z: number, heading: number, seed: number, variant: number, authored: boolean, label?: string): Station {
  const brand = BRANDS[Math.floor(hash(seed, 3) * BRANDS.length) % BRANDS.length]!;
  // Mirrors buildFillingStation exactly: size = kit.rnd(2), canopy 14+4s x 9+2s, apron +6 x +8 at z+1.
  const size = hash(seed, 2);
  const canopyW = 14 + size * 4;
  const canopyD = 9 + size * 2;
  const islands = variant % 3 === 0 ? [0] : [-canopyW * 0.18, canopyW * 0.18];
  return {
    id, brand: brand.name, accent: brand.accent,
    name: label ?? name(x, z, brand.name),
    x, z, heading,
    halfW: (canopyW + 6) / 2, halfD: (canopyD + 8) / 2, offZ: 1,
    islands, authored,
  };
}

type MapModule = typeof import('../world/mapData');

/**
 * The dam-shore garage, taken from the map's own `fuel` landmark rather than typed in. The Vaal graft
 * brought the real Bayshore Marina Petrol Station across as data, but nothing in the world builds it —
 * so we set it beside the nearest road, facing the carriageway, and the body raises the forecourt.
 */
function bayshoreSite(map: MapModule): { x: number; z: number; heading: number } | undefined {
  const landmark = map.LANDMARKS.find((entry) => entry.kind === 'fuel');
  if (!landmark) return undefined;
  const spot = map.nearestRoadSpot(landmark.x, landmark.z);
  const sides: Array<1 | -1> = [1, -1];
  let best = { x: landmark.x, z: landmark.z, distance: Infinity };
  for (const side of sides) {
    const point = map.besideRoad(spot, side, 15);
    const distance = Math.hypot(point.x - landmark.x, point.z - landmark.z);
    if (distance < best.distance) best = { x: point.x, z: point.z, distance };
  }
  // Local +z faces the road: buildFillingStation opens the apron and hangs the pylon on +z.
  return { x: best.x, z: best.z, heading: Math.atan2(spot.x - best.x, spot.z - best.z) };
}

let sites: Station[] | undefined;
let warming: Promise<readonly Station[]> | undefined;

/**
 * Every forecourt in the city, derived at runtime.
 *
 * These are the filling-station models the scatter ALREADY placed and baked (18 of them on the
 * current map, catalog spacing 260, walkable canopy, solid kiosk and pumps). Reusing them costs zero
 * geometry and zero map data — and it is mutually exclusive with reserving pads, because a reserved
 * pad feeds ModelScatter.craftedBlocks and would DELETE the very model we want to stand on. We chose
 * reuse. Nothing here touches placements.ts or the bake.
 *
 * The one exception is the Bayshore Marina Petrol Station on the Vaal shore: it is a real OSM landmark
 * the map carries as data with no model built for it. The body builds that one at runtime and the
 * eager path skips it, so no prompt can appear at a garage that is not there yet.
 */
export function stations(): readonly Station[] {
  return sites ?? EMPTY;
}
const EMPTY: readonly Station[] = [];

/**
 * Resolve the forecourts, once. The three world modules are pulled in DYNAMICALLY — they already sit
 * in the eager `simulation`/`world-data` chunks, so this awaits nothing over the network and costs no
 * bytes, but it keeps `gameplay-rules` out of a static cycle with `simulation` (see the file header).
 * Kicked off by the first frame the player spends driving; awaited by the lazy body before it runs.
 */
export function ensureSites(): Promise<readonly Station[]> {
  if (sites) return Promise.resolve(sites);
  warming ??= Promise.all([
    import('../world/ModelScatter'),
    import('../world/mapData'),
    import('../world/models/kit'),
  ]).then(([scatter, map, kit]) => {
    if (sites) return sites;
    const name = (x: number, z: number, brand: string): string => `${brand} ${map.districtAt(x, z)}`;
    const list: Station[] = [];
    for (const model of scatter.allScatteredModels()) {
      if (model.name !== 'filling-station') continue;
      list.push(station(kit.hash, name, `fs-${list.length}`, model.x, model.z, model.heading, model.seed, model.variant, false));
    }
    const shore = bayshoreSite(map);
    if (shore) list.push(station(kit.hash, name, 'bayshore', shore.x, shore.z, shore.heading, 913377, 1, true, 'Caltexx Bayshore Marina'));
    sites = list;
    return sites;
  }).catch((error: unknown) => {
    // A forecourt list we could not derive is a feature that quietly does nothing, not a dead city.
    console.warn('[fuel] could not derive forecourts; petrol stays off this session.', error);
    sites = [];
    return sites;
  });
  return warming;
}

/** Squared distance helper that keeps the hot path allocation-free. */
function localOffset(site: Station, x: number, z: number): { lx: number; lz: number } {
  const dx = x - site.x; const dz = z - site.z;
  const c = Math.cos(-site.heading); const s = Math.sin(-site.heading);
  return { lx: dx * c + dz * s, lz: -dx * s + dz * c };
}

/** True when (x, z) is standing on this forecourt's apron. */
export function onApron(site: Station, x: number, z: number, slack = 0): boolean {
  if (Math.abs(x - site.x) > site.halfW + site.halfD + slack) return false; // cheap bbox reject
  const { lx, lz } = localOffset(site, x, z);
  return Math.abs(lx) <= site.halfW + slack && Math.abs(lz - site.offZ) <= site.halfD + slack;
}

/** The forecourt the given point is standing on, if any. */
export function stationAt(x: number, z: number, includeAuthored = true, slack = 0): Station | undefined {
  for (const site of stations()) {
    if (!includeAuthored && site.authored) continue;
    if (onApron(site, x, z, slack)) return site;
  }
  return undefined;
}

/** Nearest forecourt to a point, for the "your nearest garage is…" toast. */
export function nearestStation(x: number, z: number): { site: Station; distance: number } | undefined {
  let best: { site: Station; distance: number } | undefined;
  for (const site of stations()) {
    const distance = Math.hypot(site.x - x, site.z - z);
    if (!best || distance < best.distance) best = { site, distance };
  }
  return best;
}

/** World position of the attendant's spot: beside the first pump island, on the driver's side. */
export function attendantSpot(site: Station): { x: number; z: number } {
  const lx = (site.islands[0] ?? 0) - 2.6;
  const lz = site.offZ - 1.4;
  const c = Math.cos(site.heading); const s = Math.sin(site.heading);
  return { x: site.x + lx * c + lz * s, z: site.z - lx * s + lz * c };
}

/**
 * The kiosk door — where you buy the can, the Steri Stumpie and the airtime.
 *
 * Deliberately a tight ring rather than the whole apron: `Game.updateOnFoot` runs the feature ladder
 * one rung ABOVE "enter the nearest vehicle", so an on-foot offer that covered the forecourt would
 * stop you getting back into your own car at the pumps. Cars park at the pumps; the shop is behind
 * them. Mirrors buildFillingStation, which sets the kiosk at z = -canopyD/2 - 3.4.
 */
export function shopSpot(site: Station): { x: number; z: number } {
  const canopyD = site.halfD * 2 - 8;
  return apronPoint(site, 0, -canopyD / 2 - 0.9);
}
export const SHOP_REACH = 3.4;

/** A point on the apron, in the station's own frame — used for the price-hike queue. */
export function apronPoint(site: Station, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(site.heading); const s = Math.sin(site.heading);
  return { x: site.x + lx * c + lz * s, z: site.z - lx * s + lz * c };
}

// ---- the eager approach predicate --------------------------------------------------------------------

/**
 * Called every rendered frame while the player is driving and the feature is NOT loaded yet (the
 * host swaps in the body's own descriptors the moment it is). It does two jobs:
 *
 *   - burns fuel, so the tank is already honest when the player first pulls in;
 *   - answers "is there a garage under this car right now", which is what puts `E  Pull in for
 *     petrol` on the HUD and loads the chunk on the press.
 *
 * This is the workaround for the one seam the feature foundation does not have: there is no way for a
 * feature to be ticking before the player has opted into it. See honestGaps.
 */
export function approachNear(vehicle: Vehicle | undefined, x: number, z: number): boolean {
  const dt = eagerStep();
  if (!hasTank(vehicle)) return false;
  burn(vehicle, dt);
  void ensureSites(); // first frame behind the wheel warms the forecourt list; idempotent thereafter
  if (Math.abs(vehicle.speed) > 14) return false; // you have to actually pull in, not blast through
  return stationAt(x, z, false) !== undefined;
}

// ---- the save slice ----------------------------------------------------------------------------------

export interface FuelSave {
  /** Litres in the car the player was driving when the save was written; adopted by the next car
   *  they climb into. Only the garaged car survives a reload in `SavedVehicle`, which carries no fuel
   *  field, so this is deliberately approximate — and never punitive. */
  driving: number | null;
  /** Litres sloshing in the plastic can in the boot. */
  can: number;
  /** Lifetime rand tipped. Buys standing, never forgiveness. */
  tipped: number;
  /** Current pump price of 95, cents per litre. */
  cents: number;
  /** Midnights until the next regulated change. 1 means it lands tonight. */
  daysToHike: number;
  /** Signed size of the coming change, cents. */
  hikeCents: number;
  /** Litres bought over the save's life — the "regular" the attendant remembers. */
  litresBought: number;
}

export const DEFAULT_FUEL_SAVE: FuelSave = {
  driving: null, can: 0, tipped: 0, cents: BASE_95_CENTS,
  daysToHike: HIKE_PERIOD_DAYS, hikeCents: 0, litresBought: 0,
};

const number = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, parsed));
};

/** Runs inside SaveManager's synchronous deserialize, so it imports nothing from the feature body. */
export function sanitizeFuelSave(raw: unknown): FuelSave {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_FUEL_SAVE };
  const source = raw as Partial<Record<keyof FuelSave, unknown>>;
  const driving = typeof source.driving === 'number' && Number.isFinite(source.driving)
    ? Math.max(0, Math.min(120, source.driving)) : null;
  return {
    driving,
    can: number(source.can, 0, 0, CAN_LITRES),
    tipped: number(source.tipped, 0, 0, 1_000_000),
    cents: Math.round(number(source.cents, BASE_95_CENTS, 1200, 6000)),
    daysToHike: Math.round(number(source.daysToHike, HIKE_PERIOD_DAYS, 0, 12)),
    hikeCents: Math.round(number(source.hikeCents, 0, -400, 400)),
    litresBought: number(source.litresBought, 0, 0, 1_000_000),
  };
}

// ---- money + copy ------------------------------------------------------------------------------------

export const randText = (rand: number): string =>
  `R${Math.round(rand).toLocaleString('en-ZA')}`;
export const centsText = (cents: number): string => `R${(cents / 100).toFixed(2)}`;
export const litresText = (litres: number): string => `${litres.toFixed(1)} ℓ`;

/** Litres you get for a given rand at a given price, and the rand a given number of litres costs. */
export const litresFor = (rand: number, cents: number): number => (rand * 100) / cents;
export const randFor = (litres: number, cents: number): number => (litres * cents) / 100;

export function gradeCents(base: number, grade: 93 | 95): number {
  return grade === 95 ? base : base - GRADE_93_DISCOUNT_CENTS;
}
