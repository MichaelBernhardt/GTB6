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
 *     dead robots, reaching for the torch — so the ledger counts the outage HOURS the player spent
 *     out on foot in the dark, and remembers roughly where. It has to tick before the feature body is
 *     loaded (that is the whole point of "the player already felt it"), which is why it is eager.
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

// ---- tuning ------------------------------------------------------------------------------------

/** Outage hours the player must have felt, on foot, before a district will shut its own road.
 *  DAY_CYCLE_SECONDS is 600, so one game hour is 25 real seconds and load shedding runs ~35 s in
 *  every ~2.5 min: this ripens in roughly five minutes of ordinary play. Patience is a resource. */
export const RIPE_OUTAGE_HOURS = 3;
/** After a picket the taps come back on, so the ledger is knocked back rather than zeroed — the next
 *  shutdown is earned again, but faster, exactly as a place that keeps being failed gets quicker to
 *  close its own road. */
export const POST_PICKET_HOURS = 1.2;
/** A blockade stands this many game hours before the crowd drifts off (≈100 real seconds). */
export const BLOCKADE_HOURS = 4;
/** Dawn shutdowns are the real thing: all entrances at once, before work. A midday one is six people
 *  and two tyres. Being up at 05:00 is rewarded, never required. */
export const DAWN_START = 3;
export const DAWN_END = 8;
/** Hard cap on persisted scorch marks. FIFO — the 49th burn erases the oldest stain, never the newest. */
export const SCORCH_CAP = 48;
/** Tyres the player may carry. Small on purpose: a tyre is a thing you carry awkwardly, not ammo. */
export const TYRE_CARRY_CAP = 3;

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
export const TYRE_FEED_COOLDOWN = 3.5;
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

export interface ProtestSave {
  /** Outage hours felt on foot. */
  hours: number;
  /** Weighted mean of where the player stood in the dark, or null before any outage was felt. */
  anchor: [number, number] | null;
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
  return { hours: 0, anchor: null, tyres: 0, pickets: 0, scorch: [] };
}

/**
 * Runs inside SaveManager's synchronous deserialize (after the generic JSON-safe pass in
 * features/save.ts), so it must not throw and must not import the feature body.
 */
export function sanitizeProtestState(raw: unknown): ProtestSave {
  const out = defaultProtestSave();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const value = raw as Partial<ProtestSave>;
  out.hours = clamp(finite(value.hours), 0, 999);
  out.tyres = Math.round(clamp(finite(value.tyres), 0, TYRE_CARRY_CAP));
  out.pickets = Math.round(clamp(finite(value.pickets), 0, 9999));
  const anchor = value.anchor;
  if (Array.isArray(anchor) && anchor.length >= 2 && Number.isFinite(anchor[0]) && Number.isFinite(anchor[1])) {
    out.anchor = [clamp(Number(anchor[0]), -100_000, 100_000), clamp(Number(anchor[1]), -100_000, 100_000)];
  }
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
 * Ticked from TWO places by design: the registry's eager `approach.near()` while the body is not
 * loaded (once per rendered frame, on foot), and the loaded body's `update()` afterwards. Both feed
 * the same instance, so walking through three blackouts before the chunk ever loads still counts.
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

  get ripe(): boolean { return this.hours >= RIPE_OUTAGE_HOURS && this.hasAnchor; }

  spend(): void { this.hours = Math.min(this.hours, POST_PICKET_HOURS); }

  /** A checkpoint reload REPLACES the ledger: that save is now the truth. */
  load(save: ProtestSave): void {
    this.hours = save.hours;
    if (save.anchor) { this.anchorX = save.anchor[0]; this.anchorZ = save.anchor[1]; this.hasAnchor = true; }
    else { this.hasAnchor = false; this.anchorX = 0; this.anchorZ = 0; }
  }

  /**
   * The handover, and the one place this is easy to get catastrophically wrong.
   *
   * The eager `approach.near()` hook has been counting outage hours since the session started, from
   * zero, because an unloaded feature is never handed its save slice. When the body finally loads it
   * receives that slice — and a plain `load()` there would WIPE the very grievance that caused the
   * load, leaving the player staring at a prompt that does nothing. (It did exactly that in the first
   * in-engine playthrough: `E  Follow the smoke` appeared, the chunk arrived, and the feature woke up
   * with hours=0.00 and no blockade.)
   *
   * So: the stored hours are the baseline and whatever this session already felt is added on top.
   * The live anchor wins when there is one — where the player stood in the dark THIS session is a
   * better answer than where they stood last time.
   */
  adopt(save: ProtestSave): void {
    const sessionHours = this.hours;
    const sessionAnchor = this.hasAnchor ? [this.anchorX, this.anchorZ] as const : undefined;
    this.load(save);
    this.hours += sessionHours;
    if (sessionAnchor) { this.anchorX = sessionAnchor[0]; this.anchorZ = sessionAnchor[1]; this.hasAnchor = true; }
  }

  store(): Pick<ProtestSave, 'hours' | 'anchor'> {
    return { hours: Math.round(this.hours * 1000) / 1000, anchor: this.hasAnchor ? [Math.round(this.anchorX * 100) / 100, Math.round(this.anchorZ * 100) / 100] : null };
  }

  reset(): void { this.hours = 0; this.hasAnchor = false; this.anchorX = 0; this.anchorZ = 0; this.lastHour = -1; }
}

/** The one ledger. Shared by the registry's eager approach and the lazily loaded body. */
export const outageLedger = new OutageLedger();

/** Eager per-frame tick, called from the registry's `approach.near()`. Reads the live grid directly
 *  (powerGrid is a module-level singleton, already eager) because the FeatureGameApi that would
 *  otherwise supply it does not exist until the body loads. */
export function tickOutage(hour: number, x: number, z: number): void {
  outageLedger.tick(hour, x, z, powerOn());
}

/** Is there a shutdown to walk toward right now? Kept as a free function so both the eager approach
 *  and the loaded body ask the same question. */
export function shutdownPending(loadedBlockade: boolean): boolean {
  return !loadedBlockade && outageLedger.ripe;
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
