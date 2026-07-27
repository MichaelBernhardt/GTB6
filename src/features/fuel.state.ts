/**
 * PETROL — the eager half.
 *
 * This is the ONE path segment under src/features/ (see vite.config.ts), so it is swept into the
 * `gameplay-rules` chunk rather than becoming a chunk of its own. Everything here has to earn its
 * place in the boot payload, and only four things do:
 *
 *  1. the save slice + its sanitizer, which SaveManager runs synchronously at boot;
 *  2. the tank ledger and the burn maths, because fuel is the one feature that must be TRUE before
 *     the player has opted into it — a gauge that only starts draining once you have already pulled
 *     into a garage would be a mechanic you can decline;
 *  3. THE GAUGE. The owner drove a whole session and never saw one, because the chip was built inside
 *     the lazy body and the body only loads when you press E at a forecourt. A permanently visible
 *     readout cannot live behind a load that may never happen, so it lives here and the body reuses
 *     the very same builder (tankGauge) — the strip does not change shape when the chunk lands.
 *  4. WHERE the garages roughly are, so `E  Pull in for petrol` can appear before the body exists.
 *     Roughly: a conservative circle strictly inside the smallest apron. The exact forecourt — its
 *     brand, its name, its pump islands, its kiosk door — is the body's business and is not here.
 *  5. THE MAP AND MINIMAP ICONS. Same lesson as the gauge, one rung further out: an icon that only
 *     appears once you are standing at a garage is an icon for a place you have already found. The
 *     owner drove a session with a working gauge and could not find anywhere to spend it. So the
 *     blips come from here (see fuelMapIcons -> src/features/mapIcons.ts), off the derived
 *     forecourt list, with the body nowhere in sight.
 *
 * Everything else (brands, apron geometry, the attendant's spot, the levies, every string of copy)
 * lives in the lazy half: src/features/fuel/pump.ts and src/features/fuel/fuel.ts.
 */
import type { Vehicle } from '../entities/Vehicle';
import type { VehicleKind } from '../config';
import type { FeatureHudEntry, InteractionCtx } from './types';

/**
 * NOTHING under src/world/ may be imported here by VALUE, and this is not a style rule.
 *
 * `simulation` already imports `gameplay-rules` (LivingCitySystem, TaxiJobSystem, …), so a static
 * import the other way closes a chunk-evaluation cycle. It builds clean, every unit test passes, and
 * then the real bundle dies on boot with "Cannot access 'X' before initialization" — a
 * temporal-dead-zone fault that only a booted browser can show you. It cost this branch a boot.
 *
 * The forecourt positions therefore arrive through a DYNAMIC import (see ensureForecourts), which
 * resolves to the already-loaded `simulation` chunk: no new chunk, no bytes, no cycle.
 */

// ---- the regulated price -------------------------------------------------------------------------

/** 95 unleaded, INLAND, in cents per litre. Coastal is 85-90c cheaper and getting that backwards is
 *  the specific error a Joburg player would notice — Johannesburg is inland, so this is the dear one.
 *  25.99 is also literally what the price totem on the scattered filling-station model reads
 *  (src/world/models/commercial.ts), so the pylon board and the pump agree on day one. */
export const BASE_95_CENTS = 2599;
/** Regulated changes land at midnight; in the real world that is the first Wednesday of the month.
 *  A game day is 600s (DAY_CYCLE_SECONDS), so a real month would be five hours of play — compressed
 *  to three midnights, announced one midnight in advance, so the beat lands about twice an hour. */
export const HIKE_PERIOD_DAYS = 3;

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

export function tankSize(vehicle: Vehicle): number { return TANKS[vehicle.spec.kind] ?? 0; }
export function hasTank(vehicle: Vehicle | undefined): vehicle is Vehicle {
  return Boolean(vehicle) && tankSize(vehicle!) > 0;
}

// ---- the ledger ------------------------------------------------------------------------------------

/** Litres per live Vehicle. A WeakMap so a despawned car's entry dies with it — traffic churns hard
 *  and a Map keyed on vehicles would be a slow leak for the whole session. */
const ledger = new WeakMap<Vehicle, number>();
/** Set once the lazy body is live. Until then the tank floors at a limp reserve: a player who has
 *  never met a forecourt must not be stranded by one. The GAUGE is not gated on this — it shows from
 *  the first frame behind the wheel — so the reserve is a kindness, not a secret. */
let revealed = false;
/** The very first car of a session is generously filled, so a fresh boot never opens on a chore. */
let seenAnyVehicle = false;

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

/**
 * Burn one step.
 *
 * `dt` is SIMULATION time and nothing else: fixed sub-steps of at most SIM_STEP_MAX, sliced from the
 * wall clock by src/core/Timestep.ts. It used to be a wall-clock delta taken once per RENDERED frame
 * from inside the approach predicate, and clamped to 0.1 s so a backgrounded tab could not empty the
 * tank — which quietly made the whole mechanic frame-rate coupled. Measured in-engine on a slow box:
 * 0.0059 L/s against a design rate of 0.0825 L/s, a 45 L tank lasting 127 minutes instead of 9. A
 * fuel burn that depends on your frame rate is a bug, so the burn is driven from the host's per-sim
 * tick now (see fuelTick) and this function never reads a clock of its own.
 */
export function burn(vehicle: Vehicle, dt: number): number {
  const size = tankSize(vehicle);
  if (size <= 0 || dt <= 0) return 0;
  if (vehicle.wrecked || vehicle.disabled) return litresIn(vehicle);
  const load = Math.min(1, Math.abs(vehicle.speed) / Math.max(1, vehicle.spec.maxSpeed));
  const used = dt * (IDLE_LPS + THROTTLE_LPS * THIRST[vehicle.spec.kind] * load);
  // Until the player has actually met the mechanic, the tank bottoms out at a limp reserve instead
  // of stranding them for a rule nobody told them about. Never a REFILL, though: min() against what
  // is actually in there, or a tank already below the reserve would climb back up to it.
  const floor = revealed ? 0 : Math.min(litresIn(vehicle), size * 0.09);
  return setLitres(vehicle, Math.max(floor, litresIn(vehicle) - used));
}

/** New game / checkpoint reload: forget the session-scoped bookkeeping. The WeakMap empties itself as
 *  the old vehicles are collected. */
export function resetLedger(): void { revealed = false; seenAnyVehicle = false; }

// ---- the gauge ---------------------------------------------------------------------------------------

/**
 * The fuel chip, and the ONLY place it is built.
 *
 * The eager slice draws it from the first frame the player is behind the wheel; the loaded body calls
 * this same function and appends the jerry-can chip. One builder means the readout cannot change
 * shape, id or wording at the moment the chunk lands — the player sees one continuous gauge.
 */
export function tankGauge(vehicle: Vehicle | undefined): FeatureHudEntry | undefined {
  if (!hasTank(vehicle)) return undefined;
  const fraction = fractionIn(vehicle);
  return {
    id: 'fuel:tank', label: 'FUEL',
    value: fraction <= 0 ? 'DRY' : `${Math.round(fraction * 100)}%`,
    fill: fraction * 100,
    warn: fraction < LOW_FRACTION,
  };
}

// ---- forecourts, roughly ------------------------------------------------------------------------------

/** A filling-station model the scatter already placed, straight off the bake. The eager half knows
 *  only where one stands and which way it faces; pump.ts turns this into a named forecourt. */
export interface Forecourt {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  /** Deterministic build seed and variant, so the body derives the same canopy the world built. */
  readonly seed: number;
  readonly variant: number;
}

/** The apron is laid one unit forward of the model origin (buildFillingStation). Shared with pump.ts
 *  so the rough circle below and the exact rectangle up there are centred on the same point. */
export const APRON_OFFSET = 1;

/**
 * Radius of the eager "you are at a garage" circle, metres.
 *
 * Deliberately CONSERVATIVE. buildFillingStation's smallest apron is 20 x 17.5 about the offset point,
 * so a circle of 8 is strictly inside every forecourt on the map. That matters: pressing E on the
 * eager prompt loads the body and immediately re-resolves against the body's own rungs, and if the
 * exact apron test then disagreed the press would do nothing at all. Under-promise, then load.
 */
export const APPROACH_REACH = 8;

const EMPTY: readonly Forecourt[] = [];
let spots: Forecourt[] | undefined;
let warming: Promise<readonly Forecourt[]> | undefined;

/** Every filling-station model on the map, or nothing until the list has been derived. */
export function forecourts(): readonly Forecourt[] { return spots ?? EMPTY; }

/**
 * Derive the forecourt positions, once.
 *
 * These are the filling-station models the scatter ALREADY placed and baked (19 of them on the
 * current map, catalog spacing 260, walkable canopy, solid kiosk and pumps). Reusing them costs zero
 * geometry and zero map data — and it is mutually exclusive with reserving pads, because a reserved
 * pad feeds ModelScatter.craftedBlocks and would DELETE the very model we want to stand on. We chose
 * reuse.
 *
 * The nineteenth is the dam-shore station the map names ("Bayshore Marina Petrol Station", a gold
 * star on the M-map). It used to be built by the LAZY BODY, which made it a place you could never
 * reach: the body only loads when you press E on a forecourt, and the eager list this function
 * builds never contained it — so driving to the star showed bare veld, no prompt, no way in. It is
 * a scattered model like the other eighteen now (ModelScatter.landmarkForecourtPass), which means
 * the world builds it whether or not this feature ever loads, and it arrives here for free.
 *
 * ModelScatter is pulled in DYNAMICALLY: it already sits in the eager `simulation` chunk, so this
 * awaits nothing over the network and costs no bytes, but it keeps `gameplay-rules` out of a static
 * cycle with `simulation` (see the file header). Kicked off by the first sim step the player spends
 * driving; awaited by the lazy body before it runs.
 */
export function ensureForecourts(): Promise<readonly Forecourt[]> {
  if (spots) return Promise.resolve(spots);
  warming ??= import('../world/ModelScatter').then((scatter) => {
    if (spots) return spots;
    const list: Forecourt[] = [];
    for (const model of scatter.allScatteredModels()) {
      if (model.name !== 'filling-station') continue;
      list.push({ id: `fs-${list.length}`, x: model.x, z: model.z, heading: model.heading, seed: model.seed, variant: model.variant });
    }
    spots = list;
    return spots;
  }).catch((error: unknown) => {
    // A forecourt list we could not derive is a feature that quietly does nothing, not a dead city.
    console.warn('[fuel] could not derive forecourts; petrol stays off this session.', error);
    spots = [];
    return spots;
  });
  return warming;
}

/** World units to metres, the same conversion the street signs and the distance toasts use. */
export const UNITS_TO_METRES = 1.359;

/** The nearest forecourt to a point, or undefined until the list has been derived. */
export function nearestForecourt(x: number, z: number): { spot: Forecourt; metres: number } | undefined {
  let best: { spot: Forecourt; metres: number } | undefined;
  for (const spot of forecourts()) {
    const metres = Math.hypot(spot.x - x, spot.z - z) * UNITS_TO_METRES;
    if (!best || metres < best.metres) best = { spot, metres };
  }
  return best;
}

/** Metres to the nearest forecourt, or undefined until the list has been derived. */
export function metresToForecourt(x: number, z: number): number | undefined {
  return nearestForecourt(x, z)?.metres;
}

/** Eight-point compass bearing from one world point to another. -Z is north, the same convention the
 *  minimap's compass rose and the street signs use. */
export function compassTo(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
  const angle = Math.atan2(toX - fromX, -(toZ - fromZ)); // 0 = north, clockwise
  const index = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return points[index]!;
}

/**
 * Below the low mark, say how far the nearest garage is and which way it lies.
 *
 * A red gauge with nowhere to take it is a punishment. The blips on the map and the minimap are the
 * standing answer to "where is petrol"; this chip is the one that arrives unasked at the moment you
 * need it, so it carries a heading as well as a distance — "410 m NE" is something you can act on
 * without opening the map. The body draws the SAME chip, so it does not blink out of existence the
 * moment the chunk lands.
 */
export function garageHint(vehicle: Vehicle | undefined, x: number, z: number): FeatureHudEntry | undefined {
  if (!hasTank(vehicle) || fractionIn(vehicle) >= LOW_FRACTION) return undefined;
  const near = nearestForecourt(x, z);
  if (!near) return undefined;
  return { id: 'fuel:hint', label: 'GARAGE', value: `${Math.round(near.metres)} m ${compassTo(x, z, near.spot.x, near.spot.z)}`, warn: true };
}

/**
 * Every forecourt as a map blip, for src/features/mapIcons.ts.
 *
 * Kicks the derivation itself rather than waiting for a sim step behind the wheel: a player on foot
 * with a jerry can and no vehicle still needs to see where petrol is, and `ensureForecourts` is
 * idempotent and resolves against the already-loaded `simulation` chunk, so calling it from the map
 * path costs nothing but the first frame's empty list.
 */
export function fuelMapIcons(): ReadonlyArray<{ x: number; z: number }> {
  void ensureForecourts();
  return forecourts();
}

/** The forecourt whose pumps this point is standing among, by the rough circle. */
export function forecourtNear(x: number, z: number, reach = APPROACH_REACH): Forecourt | undefined {
  const limit = reach * reach;
  for (const spot of forecourts()) {
    const cx = spot.x + Math.sin(spot.heading) * APRON_OFFSET;
    const cz = spot.z + Math.cos(spot.heading) * APRON_OFFSET;
    const dx = x - cx; const dz = z - cz;
    if (dx * dx + dz * dz <= limit) return spot;
  }
  return undefined;
}

// ---- the eager slice: one tick, one chip, one prompt ---------------------------------------------------

/**
 * Burn, every simulation step, whether or not the feature body has ever loaded.
 *
 * This is the hook the feature foundation did not have and now does (FeatureDescriptor.eager) — see
 * the note in registry.ts. It used to be a side effect smuggled into the proximity predicate, which
 * ran once per RENDERED frame off a wall clock and was therefore frame-rate coupled; the predicate is
 * pure again and the burn is where burns belong.
 */
export function fuelTick(dt: number, ctx: InteractionCtx): void {
  const vehicle = ctx.vehicle;
  if (!hasTank(vehicle)) return;
  void ensureForecourts(); // first step behind the wheel warms the forecourt list; idempotent after
  burn(vehicle, dt);
}

/** The gauge, before the body exists. On screen from the first frame of driving, every frame after. */
export function fuelHud(ctx: InteractionCtx): readonly FeatureHudEntry[] {
  const chip = tankGauge(ctx.vehicle);
  if (!chip) return [];
  const hint = garageHint(ctx.vehicle, ctx.position.x, ctx.position.z);
  return hint ? [chip, hint] : [chip];
}

/**
 * "Is there a garage under this car right now" — the question that puts `E  Pull in for petrol` on the
 * HUD and fetches the chunk on the press. PURE: it reads the world and answers, and burns nothing.
 */
export function approachNear(vehicle: Vehicle | undefined, x: number, z: number): boolean {
  if (!hasTank(vehicle)) return false;
  if (Math.abs(vehicle.speed) > 14) return false; // you have to actually pull in, not blast through
  return forecourtNear(x, z) !== undefined;
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
