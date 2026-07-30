/**
 * LOCKS — which doorways are locked, from which SIDE, and the arithmetic of picking them.
 *
 * The line is the plan's "line D": a place of business that is open is open — a shopfront, a
 * commercial or civic lobby, a works dock — and everything else is somebody's home or a private
 * stair and is locked. Measured against the whole city that locks 3,794 of 7,415 doors (51.2%),
 * including all 2,194 suburban houses. On top of that sits the night fork the plan recommended:
 * a works dock and a civic hall are open IN HOURS — at night (22:00–06:00) they lock too, because
 * "a shop that is open is open" stops being true of a steelworks at 2 a.m. Downtown and mixed-use
 * lobbies and shopfronts stay open around the clock: the city centre never bolts its public doors,
 * and the friction budget matters more than the realism there.
 *
 * DIRECTION IS THE WHOLE MODEL, and it is encoded in ONE function rather than at each door. The
 * owner's rule, verbatim: "you don't need to lockpick to get out. You can always exit a building,
 * either front door or onto the roof. Getting back in is when you need to lock pick." So a lock is
 * a property of the doorway PLUS the side you approach it from: from the inside every door in the
 * city — street door and roof door alike — opens freely, forever, no pick, no check. doorLocked()
 * answers false for 'inside' before it looks at anything else, so no future call site can trap a
 * player indoors (or on a roof) by forgetting the rule: to get it wrong you would have to lie about
 * which side you are standing on.
 */
import type { BuildingFacts, Finish } from './core';

/** The gate is LIVE: the pick exists (Inventory.lockpicks), Jozi Arms and every bottle store sell
 *  it, and the picking dial ships in the same commit that flipped this. */
export const LOCKS_ENABLED = true;

/** Which side of the doorway the player is on. 'inside' is never locked — see the header. */
export type DoorSide = 'outside' | 'inside';

/** Lobbies that belong to the public: an office tower, a civic hall. A block of
 *  flats shares the same door furniture and none of the same welcome. */
const OPEN_LOBBY_STYLES = new Set(['downtown', 'mixed-use', 'civic']);

/** The night fork (plan judgement call 1, recommended ON): places of WORK — the industrial dock and
 *  the civic hall — lock outside working hours. Retail and the commercial lobbies never do. */
export const WORKS_LOCK_AT_NIGHT = true;
export const NIGHT_FROM = 22;
export const NIGHT_TO = 6;

export function isNightHour(hour: number): boolean {
  return hour >= NIGHT_FROM || hour < NIGHT_TO;
}

/** The DAYTIME classification alone — what is locked around the clock, regardless of hour. Pure so
 *  the census, the tests and the pick UI all agree on one line. */
export function lockedClass(facts: Pick<BuildingFacts, 'style' | 'entrance'>): boolean {
  if (facts.entrance === 'shopfront' || facts.entrance === 'dock') return false;
  if (facts.entrance === 'lobby' && OPEN_LOBBY_STYLES.has(facts.style)) return false;
  return true;
}

/** Doors that are open in hours but lock at night: the works dock, the civic hall. */
export function locksAtNight(facts: Pick<BuildingFacts, 'style' | 'entrance'>): boolean {
  if (lockedClass(facts)) return false; // already locked around the clock
  if (facts.entrance === 'dock') return true;
  return facts.entrance === 'lobby' && facts.style === 'civic';
}

/**
 * THE live lock question, and the only one any call site may ask. Exit paths need not (and do not)
 * call it at all; entry paths pass the side they approach from, and 'inside' short-circuits open.
 */
export function doorLocked(facts: Pick<BuildingFacts, 'style' | 'entrance'>, side: DoorSide, hour: number): boolean {
  if (side === 'inside') return false; // NEVER trapped — in a building or on its roof
  if (!LOCKS_ENABLED) return false;
  if (lockedClass(facts)) return true;
  return WORKS_LOCK_AT_NIGHT && locksAtNight(facts) && isNightHour(hour);
}

// ---- the picking dial ----------------------------------------------------------------------------
//
// The activity, not a progress bar: a sweep runs up and falls back, over and over — the pick feeling
// along the pins — and somewhere near the top the lock BITES (the HUD chip flares, the prompt turns
// urgent). Press E inside the bite and the door opens. Miss and the sweep simply starts again: no
// broken picks, no lost money, no toast — the falling bar is the whole message. Borrowed straight
// from golf's meters ("E stops the ring", walk off to cancel), which is the game's native skill-check
// vocabulary.
//
// The friction budget is the design: this gate now sits on the front door of half the city, so the
// dial must be charming at door one and INVISIBLE at door two hundred. Three levers do that:
//   - the bite is wider on rough doors (a bare works lock is loose; a smart estate lock is tight);
//   - every MISS on the same door widens it further (the lock never gets harder, only easier);
//   - after PICK_MASTERY lifetime picks the bite doubles for good — practice makes the two-hundredth
//     house effectively instant, which is what "patience is a resource to spend carefully" demands.

/** Seconds for one upward sweep (and the same falling back). A patient full cycle is ~2.2 s; a
 *  player who knows the lock presses on the first rise. */
export const PICK_SWEEP_SECONDS = 1.1;
/** Lifetime successful picks after which the bite window doubles for good. */
export const PICK_MASTERY = 25;

const BITE_BY_FINISH: Record<Finish, number> = { bare: 0.30, homely: 0.24, smart: 0.18 };

/** Width of the bite window as a fraction of the sweep, given the door's finish, the player's
 *  lifetime picks, and misses so far on THIS attempt. Clamped so a dial is never a formality the
 *  player cannot read (floor) nor a wall (the miss ramp guarantees convergence). */
export function pickBiteWidth(finish: Finish, lifetimePicks: number, misses: number): number {
  const base = BITE_BY_FINISH[finish] ?? 0.24;
  const mastery = lifetimePicks >= PICK_MASTERY ? 2 : 1;
  const mercy = 1 + 0.15 * Math.min(6, misses); // each miss opens the lock a little wider
  return Math.min(0.55, base * mastery * mercy);
}

/** Whether a press at this sweep position (0..1) lands inside the bite. The bite sits at the TOP of
 *  the sweep: push too far past it and the sweep falls back — press as it bites. */
export function pickBites(sweep: number, biteWidth: number): boolean {
  return sweep >= 1 - biteWidth;
}
