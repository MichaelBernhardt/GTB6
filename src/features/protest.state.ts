/**
 * Protest: the EAGER half. Rules, save shape and the outage ledger.
 *
 * This module sits at the top level of src/features/, so vite.config.ts sweeps it into the
 * `gameplay-rules` chunk (hundreds of kB spare) rather than leaving it unassigned like the lazy body
 * in src/features/protest/. It must stay tiny and import nothing heavy: `powerGrid` is a 30-line
 * eager leaf in `world-runtime`, and there is no three.js, no City and no Game here.
 *
 * Two things live here on purpose:
 *
 *  1. THE GRIEVANCE LEDGER. A protest that isn't caused by something the player has FELT reads as mob
 *     behaviour. Load shedding is the thing this game already makes the player feel — dark streets,
 *     dead robots, reaching for the torch — so the ledger counts the outage HOURS the player lived
 *     through, and remembers roughly where they stood. It has to tick before the feature body is
 *     loaded (that is the whole point of "the player already felt it"), which is why it is eager.
 *
 *     IT TICKS ON THE SIM SUB-STEP, from the registry's `eager.tick` hook, and it has now been wrong
 *     twice in the other two possible ways:
 *
 *      - the FIRST cut ticked it inside the registry's `approach.near()` predicate.
 *        `resolveInteraction` returns on the FIRST descriptor that offers something, so any feature
 *        ordered above this one — a shop door, a tee box, a doorstep — silently stopped the only
 *        unlock gate this feature has. The cross-feature verifier measured it: 3.90 outage-hours in
 *        the open street against 0.00 on a street corner.
 *      - the SECOND cut moved it to `powerGrid.onPowerChange` and credited one lump per outage off
 *        `performance.now()`. That fires reliably, but a WALL clock is not the game's clock: it ran
 *        while the game was paused, while the tab was backgrounded and while a menu was open (hence
 *        the MAX_OUTAGE_CREDIT_HOURS cap that had to exist), and it carried no position at all — so
 *        `hasAnchor` was false for the entire eager phase and the site fell back to the road under
 *        the player's own feet. That is the whole of the owner's "it just seems to spawn a protest
 *        where I am".
 *
 *     `eager.tick(dt, ctx)` is the seam that was missing when this was written and is not missing now
 *     (petrol bought it). The host calls it for EVERY unloaded feature on the fixed sim sub-step —
 *     never a rendered frame, never conditional on another feature's prompt — and hands it the game
 *     hour and the live position. So the eager credit and the loaded body's credit are now the same
 *     call, at the same rate, with the same anchor, and the handover cannot change either.
 *
 *  2. THE NECKLACING BLOCK. Burning tyres carry specific, heavy historical freight in South Africa:
 *     necklacing was a real 1980s township execution — a petrol-soaked tyre forced over a person's
 *     chest and arms and lit — that recurs in present-day vigilantism. No tyre in this game may ever
 *     take a person, a ragdoll or a corpse as its host, and no ignition may ever resolve onto one.
 *     The guard lives here, in a module with no three.js import, so it is unit-testable on its own
 *     and so the lazy body cannot ship without it. See protest.state.test.ts — the rule is enforced
 *     by tests, not by a comment.
 */
import { powerOn } from '../world/powerGrid';
import type { FeatureHudEntry, InteractionCtx } from './types';

// ---- tuning ------------------------------------------------------------------------------------

/**
 * Outage hours the player must have felt before a district will shut its own road.
 *
 * Set against the real schedule rather than guessed. LoadSheddingSystem sheds for 32-44 real seconds
 * every 130-190, and one game hour is 25 real seconds, so ONE shed is worth 1.28-1.76 hours. At 2.4
 * this always ripens on the SECOND shed and never the third — about four minutes of ordinary play.
 * It used to be 3, which needed a third cycle whenever the first two ran short: ten minutes of
 * walking around waiting for a feature to exist. Patience is a resource; spend it somewhere else.
 */
export const RIPE_OUTAGE_HOURS = 2.4;
/** After a picket the taps come back on, so the ledger is knocked back rather than zeroed — the next
 *  shutdown is earned again, but faster, exactly as a place that keeps being failed gets quicker to
 *  close its own road. */
export const POST_PICKET_HOURS = 1.2;
/**
 * A blockade stands this many game hours before the crowd drifts off (6 h ≈ 150 real seconds).
 *
 * It was 4 (≈100 s) while the player raised the blockade by pressing E on top of it, when the only
 * thing the clock had to cover was the walk from your own feet to the barricade. It now goes up
 * SITE_MIN_METRES away and you have to get there, which is 20-45 seconds of walking before any of the
 * 70-second picket has started. Do not shorten this below `PICKET_SECONDS` plus the walk.
 */
export const BLOCKADE_HOURS = 6;
/**
 * Fraction of RIPE_OUTAGE_HOURS at which the district says out loud that it has had enough.
 *
 * The one warning beat. Everything before it is the HUD chip filling; everything after it is a road
 * being closed. 0.62 lands it around the end of the first outage, so the sequence a player actually
 * lives is: lights go out → a bar starts filling → "Brixton has had enough" → lights go out again →
 * the road shuts. Three beats, about four minutes, no reading.
 */
export const WARN_FRACTION = 0.62;
/** The grievance chip appears once the district is this far gone. Below it there is nothing to say
 *  yet and a chip that reads 3% is noise on a HUD that already carries STIM and CHUTE. */
export const HUD_FROM_FRACTION = 0.18;
/** Dawn shutdowns are the real thing: all entrances at once, before work. A midday one is six people
 *  and two tyres. Being up at 05:00 is rewarded, never required. */
export const DAWN_START = 3;
export const DAWN_END = 8;
/** Hard cap on persisted scorch marks. FIFO — the 49th burn erases the oldest stain, never the newest. */
export const SCORCH_CAP = 48;
/** Tyres the player may carry. Small on purpose: a tyre is a thing you carry awkwardly, not ammo. */
export const TYRE_CARRY_CAP = 3;

/**
 * How far from the player a blockade is allowed to go up, in world units.
 *
 * THE OWNER'S REPORT: "it just seems to spawn a protest where I am or something". It did — the site
 * was the road nearest his own feet — and content that materialises under you is a cheat button
 * however good the props are. A protest you STUMBLE ACROSS is a different thing entirely, and this
 * feature already builds a plume with `fog: false` specifically so it can be read from far away.
 *
 * So the site is pushed into a band: far enough that it appears over there rather than here, close
 * enough that walking to it is a walk. 85 u is about four buildings; 260 u is 40-60 seconds on foot,
 * inside BLOCKADE_HOURS with the picket still to come.
 */
export const SITE_MIN_METRES = 85;
export const SITE_MAX_METRES = 260;

export type BlockadeSize = 'dawn' | 'daytime';

/** Dawn: the full shutdown. Otherwise: a handful of neighbours and whatever was in the yard. */
export function blockadeSize(hour: number): BlockadeSize {
  const h = ((hour % 24) + 24) % 24;
  return h >= DAWN_START && h < DAWN_END ? 'dawn' : 'daytime';
}

export function crowdSize(size: BlockadeSize): number { return size === 'dawn' ? 10 : 6; }
export function tyreCount(size: BlockadeSize): number { return size === 'dawn' ? 6 : 3; }
/** How wide the road closure reads to the traffic planner. Dawn shutdowns close the whole approach. */
export function closureRadius(size: BlockadeSize): number { return size === 'dawn' ? 26 : 18; }

/** The picket: how long the crowd needs the smoke kept up, in seconds. Short and generous. */
export const PICKET_SECONDS = 70;
/** Smoke bleeds away at this much per second and a fresh tyre adds this much. Two tyres a minute
 *  holds it; the player is never asked to sprint. */
export const SMOKE_DECAY = 1.35;
export const SMOKE_PER_TYRE = 26;
/**
 * A SAME-FRAME GUARD, and nothing more. It used to be 3.5 s AND it gated the interaction rung, so
 * pressing E made the prompt vanish and come back three seconds later as a different verb — which is
 * how a working key ends up reported as "didn't seem to work". The rung is now always offered while
 * you are picketing at the fire, and this is only here so one keypress cannot be counted twice.
 */
export const TYRE_FEED_COOLDOWN = 0.12;
/** A tyre the player rolls out themselves burns for this long before the road reopens. */
export const SOLO_TYRE_SECONDS = 95;

/** Picket payout. Not a bribe and not a bounty: the player spends the morning working the jam,
 *  selling cold drinks and loose cigarettes down the queue of stopped cars, which is what actually
 *  happens at a blockade. Held smoke means a longer queue means a better morning. */
export function picketPayout(secondsHeld: number, size: BlockadeSize): number {
  const base = size === 'dawn' ? 320 : 200;
  return Math.round(base + Math.min(secondsHeld, PICKET_SECONDS) * 6);
}

// ---- save --------------------------------------------------------------------------------------

/**
 * What survives a session.
 *
 * NOT the grievance. It used to persist `hours` and `anchor`, and that is where the worst bug in the
 * feature's history lived: the eager half counted from zero every session, the body then received the
 * stored slice, and a plain `load()` there WIPED the very grievance that had just caused the load —
 * so `E  Follow the smoke` appeared, the chunk arrived, and the feature woke up with hours=0.00. The
 * fix at the time was an `adopt()` that merged the two, which worked and left a permanent trap for
 * the next person.
 *
 * The grievance is now deliberately SESSION-SCOPED, which deletes the whole class of problem and is
 * also the more legible design: everything the chip shows you, you earned in front of your own eyes
 * this session. A returning player who walked into an instant protest could not possibly have known
 * why. Ripening is about four minutes of ordinary play — cheap enough to re-earn, and re-earning it is
 * the part that makes the protest mean something.
 *
 * What DOES survive is the durable stuff: tyres in hand, pickets you saw through, and the stains,
 * because nobody ever comes to repair tar.
 */
export interface ProtestSave {
  /** Tyres in hand. */
  tyres: number;
  /** Pickets seen through to the end. */
  pickets: number;
  /** Flat [x, z, radius, …] triples, newest last, at most SCORCH_CAP triples. Nobody repairs tar. */
  scorch: number[];
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const finite = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export function defaultProtestSave(): ProtestSave {
  return { tyres: 0, pickets: 0, scorch: [] };
}

/**
 * Runs inside SaveManager's synchronous deserialize (after the generic JSON-safe pass in
 * features/save.ts), so it must not throw and must not import the feature body. Saves written by the
 * build that persisted `hours`/`anchor` still load: the extra keys are simply not read.
 */
export function sanitizeProtestState(raw: unknown): ProtestSave {
  const out = defaultProtestSave();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const value = raw as Partial<ProtestSave>;
  out.tyres = Math.round(clamp(finite(value.tyres), 0, TYRE_CARRY_CAP));
  out.pickets = Math.round(clamp(finite(value.pickets), 0, 9999));
  if (Array.isArray(value.scorch)) {
    const triples: number[] = [];
    for (let index = 0; index + 2 < value.scorch.length; index += 3) {
      const x = finite(value.scorch[index], NaN); const z = finite(value.scorch[index + 1], NaN); const r = finite(value.scorch[index + 2], NaN);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(r)) continue;
      triples.push(clamp(x, -100_000, 100_000), clamp(z, -100_000, 100_000), clamp(r, 0.5, 12));
    }
    out.scorch = triples.slice(Math.max(0, triples.length - SCORCH_CAP * 3)); // FIFO: keep the newest
  }
  return out;
}

// ---- the grievance ledger ----------------------------------------------------------------------

/** Shortest signed distance from `previous` to `next` on a 24-hour dial, in hours. */
export function hourDelta(previous: number, next: number): number {
  const diff = (((next - previous) % 24) + 36) % 24 - 12;
  return diff;
}

/**
 * How much outage the player has personally stood in, and roughly where.
 *
 * ONE feeder, on the sim sub-step, and it is `tickGrievance()` at the bottom of this file. While the
 * body is unloaded the registry's `eager.tick` calls it; the instant the body loads, the body's
 * `update()` calls it instead — and `FeatureHost.update` runs exactly one of those two, ever, so
 * there is no double-count to guard against and no handover to get wrong.
 */
export class OutageLedger {
  hours = 0;
  anchorX = 0;
  anchorZ = 0;
  hasAnchor = false;
  private lastHour = -1;

  /** @param hour game hour 0..24 · @param powered grid state · returns the hours credited this call. */
  tick(hour: number, x: number, z: number, powered: boolean): number {
    if (this.lastHour < 0) { this.lastHour = hour; return 0; }
    // Clamped: a console `set timerate`, a menu pause or a long frame must not dump a whole day of
    // grievance in one step, and a backwards clock must never subtract.
    const elapsed = clamp(hourDelta(this.lastHour, hour), 0, 0.5);
    this.lastHour = hour;
    if (powered || elapsed <= 0) return 0;
    this.hours += elapsed;
    // Weighted running mean of where the player stood in the dark. One pair of numbers, no grid, no
    // absolute coordinates typed anywhere — the map is being reshaped under us.
    const alpha = this.hasAnchor ? clamp(elapsed / Math.max(this.hours, 0.001), 0.05, 0.4) : 1;
    this.anchorX += (x - this.anchorX) * alpha;
    this.anchorZ += (z - this.anchorZ) * alpha;
    this.hasAnchor = true;
    return elapsed;
  }

  /** 0..1 — how far this district is toward closing its own road. The number on the HUD chip. */
  get fraction(): number { return clamp(this.hours / RIPE_OUTAGE_HOURS, 0, 1); }
  get ripe(): boolean { return this.hours >= RIPE_OUTAGE_HOURS; }
  /** Said out loud once, before anything happens. */
  get warning(): boolean { return this.hours >= RIPE_OUTAGE_HOURS * WARN_FRACTION; }

  /** A road was closed, so the ledger is knocked back rather than zeroed: the next shutdown is earned
   *  again, but faster, exactly as a place that keeps being failed gets quicker to close its own road.
   *  Called on EVERY stand-down and not only on a paid picket — otherwise a blockade that fades
   *  unattended leaves the ledger ripe and the next one goes up the same second. */
  spend(): void { this.hours = Math.min(this.hours, POST_PICKET_HOURS); }

  reset(): void {
    this.hours = 0; this.hasAnchor = false; this.anchorX = 0; this.anchorZ = 0;
    this.lastHour = -1;
  }
}

/** The one ledger. Shared by the registry's eager tick and the lazily loaded body. */
export const outageLedger = new OutageLedger();

/**
 * THE GRIEVANCE TICK — one call, two callers, and it must never move into a predicate again.
 *
 * Called from the registry's `eager.tick` while the body is unloaded and from the body's own
 * `update()` once it is. Both arrive on the fixed sim sub-step through `FeatureHost.update`, which
 * means: it does not run while the game is paused, it does not run per rendered frame, it is not
 * frame-rate coupled, and no other feature's prompt can stop it. All four of those were true of at
 * least one earlier version of this line.
 */
export function tickGrievance(ctx: Pick<InteractionCtx, 'hour' | 'position'>): void {
  outageLedger.tick(ctx.hour, ctx.position.x, ctx.position.z, powerOn());
}

/**
 * The grievance chip — the whole of "he should be able to tell that a district is aggrieved BEFORE
 * anything happens".
 *
 * ONE function, called by the registry's eager `hud` and by the loaded body's `hud()`, so the strip
 * cannot change shape at the moment the chunk lands (the README's rule, and the reason petrol's gauge
 * is built this way). It advances only while the lights are out and freezes when they come back, which
 * is the causal chain stated without a word of text: the bar moves when you are standing in the dark.
 */
export function grievanceHud(): FeatureHudEntry[] {
  const fraction = outageLedger.fraction;
  if (fraction < HUD_FROM_FRACTION || outageLedger.ripe) return [];
  const percent = Math.round(fraction * 100);
  return [{ id: 'protest:anger', label: 'FED UP', value: `${percent}%`, fill: percent, warn: outageLedger.warning }];
}

/** Should the host fetch the body? Deliberately EARLY — the body is what says "this district has had
 *  enough" and what raises the blockade, so it has to be up and running before the grievance ripens,
 *  not at the moment it does. Rides `approach.preload`, so it offers nothing and steals no press. */
export function grievanceWarming(): boolean {
  return outageLedger.fraction >= HUD_FROM_FRACTION;
}

// ---- where the road gets closed ----------------------------------------------------------------

/** A road pose the body has already snapped out of the live road network, with its district. */
export interface SiteCandidate {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly heading: number;
  readonly district: string;
}

/**
 * Pick the road to close. PURE, so the rule is testable without a city.
 *
 * The rule, in order, and the reason each clause is there:
 *
 *  1. Never within SITE_MIN_METRES of the player. This clause IS the owner's bug report — a protest
 *     that materialises on top of you is a cheat button, and one you cannot see arrive.
 *  2. Prefer inside the band (≤ SITE_MAX_METRES), so it is a walk and not an expedition, and so the
 *     plume is actually in shot from where he is standing when the notification lands.
 *  3. Within the band, prefer the district the player kept standing in — the place that is aggrieved
 *     is the place that closes its road, and the HUD chip has been filling for that district.
 *  4. Then: nearest to the anchor. That is "the road nearest where you stood in the dark", which is
 *     the sentence the design promised all along.
 *
 * Ties resolve to the earlier candidate, and callers build the candidate list from fixed bearings, so
 * the same grievance in the same place always closes the same road. No Math.random anywhere.
 */
export function pickBlockadeSite(
  candidates: readonly SiteCandidate[],
  player: { x: number; z: number },
  anchor: { x: number; z: number },
  anchorDistrict: string,
): SiteCandidate | undefined {
  const gap = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
  const clear = candidates.filter((entry) => gap(entry, player) >= SITE_MIN_METRES);
  if (clear.length === 0) {
    // Nothing far enough away: take the furthest road we found rather than raising one under his feet.
    let best: SiteCandidate | undefined;
    for (const entry of candidates) if (!best || gap(entry, player) > gap(best, player)) best = entry;
    return best;
  }
  const inBand = clear.filter((entry) => gap(entry, player) <= SITE_MAX_METRES);
  const pool = inBand.length > 0 ? inBand : clear;
  const local = pool.filter((entry) => entry.district === anchorDistrict);
  const shortlist = local.length > 0 ? local : pool;
  let best = shortlist[0];
  for (const entry of shortlist) if (best && gap(entry, anchor) < gap(best, anchor)) best = entry;
  return best;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const;

/**
 * Which way to look, in words. The notification says "170 m south-east" because a district name is
 * not a direction and a map is not what somebody reads while walking.
 *
 * -z is north here, matching the map and the minimap.
 */
export function bearingName(dx: number, dz: number): string {
  if (dx === 0 && dz === 0) return 'right here';
  const degrees = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const index = Math.round((((degrees % 360) + 360) % 360) / 45) % 8;
  return COMPASS[index]!;
}

// ---- the necklacing block ----------------------------------------------------------------------

/** Thrown when something tries to make a person the host of a tyre or the target of an ignition. */
export class ProhibitedTyreHostError extends Error {
  constructor(where: string) {
    super(`[protest] refused: ${where} was handed a living body as a tyre host. Tyres in this game are placed on the ground by world coordinate only.`);
    this.name = 'ProhibitedTyreHostError';
  }
}

const LIVING_OBJECT3D_TYPES = new Set(['Bone', 'SkinnedMesh']);
const MAX_WALK = 24;

/**
 * Is this candidate a person, a ragdoll, a corpse, or any part of one?
 *
 * Deliberately structural and over-inclusive rather than an `instanceof Pedestrian` check: it must
 * still hold if a ragdoll is refactored, if a bone is passed instead of the body, or if a caller
 * hands over some wrapper. False positives cost nothing here — the only thing on the other side of
 * this guard is "put a tyre somewhere else".
 */
export function isLivingTarget(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Record<string, unknown>;
  // Pedestrian and anything that behaves like one.
  if (typeof value.takeDamage === 'function') return true;
  if (typeof value.health === 'number') return true;
  if (typeof value.hailing === 'boolean' || typeof value.scripted === 'boolean') return true;
  if (value.ragdoll || value.skeleton || value.isBone === true || value.isSkinnedMesh === true) return true;
  const userData = value.userData as Record<string, unknown> | undefined;
  if (userData && (userData.ped || userData.pedestrian || userData.ragdoll || userData.body)) return true;
  if (typeof value.type === 'string' && LIVING_OBJECT3D_TYPES.has(value.type)) return true;
  // A limb hands you its bone, not the body: walk the ancestry, bounded.
  let parent = value.parent as Record<string, unknown> | undefined | null;
  for (let step = 0; parent && step < MAX_WALK; step++) {
    if (typeof parent.takeDamage === 'function' || typeof parent.health === 'number') return true;
    if (typeof parent.type === 'string' && LIVING_OBJECT3D_TYPES.has(parent.type)) return true;
    const parentData = parent.userData as Record<string, unknown> | undefined;
    if (parentData && (parentData.ped || parentData.pedestrian || parentData.ragdoll)) return true;
    parent = parent.parent as Record<string, unknown> | undefined | null;
  }
  // …and a body may be handed over as the group that CONTAINS the skeleton.
  return containsLivingPart(value, 0);
}

function containsLivingPart(node: Record<string, unknown>, depth: number): boolean {
  if (depth >= 4) return false;
  const children = node.children;
  if (!Array.isArray(children)) return false;
  for (const child of children.slice(0, 64)) {
    if (!child || typeof child !== 'object') continue;
    const value = child as Record<string, unknown>;
    if (value.isBone === true || value.isSkinnedMesh === true) return true;
    if (typeof value.type === 'string' && LIVING_OBJECT3D_TYPES.has(value.type)) return true;
    if (containsLivingPart(value, depth + 1)) return true;
  }
  return false;
}

/** The one gate. Every tyre placement and every ignition resolves through this. */
export function assertNotLivingHost(candidate: unknown, where: string): void {
  if (isLivingTarget(candidate)) throw new ProhibitedTyreHostError(where);
}

/** Filters a candidate list down to things a fire may be applied to. Never throws — an ignition
 *  sweep that happens to include a bystander simply does not include them. */
export function ignitableTargets<T>(candidates: readonly T[]): T[] {
  return candidates.filter((candidate) => !isLivingTarget(candidate));
}
