/**
 * WHICH DOORS ARE LOCKED — the classification the owner's follow-up asked for, as a pure function,
 * with the GATE ITSELF SWITCHED OFF until the pick exists.
 *
 * The line is the plan's "line D": a place of business that is open is open — a shopfront, a
 * commercial or civic lobby, a works dock — and everything else is somebody's home or a private
 * stair and is locked. Measured against the whole city that locks 3,907 of 7,415 doors (52.7%),
 * including all 2,194 suburban houses.
 *
 * WHY THE GATE IS OFF. Locking a door is only honest once the player can buy the key: the lock-pick
 * item, the shop SKU and the picking interaction are the locks pass's work, and none of them exist
 * yet. Flipping LOCKS_ENABLED before that pass lands would bolt half the city shut with no pick
 * purchasable anywhere — the exact "feature is broken" failure this round exists to kill. The roof
 * hatch already routes through doorLocked() (see interiors:roofdoor), so when the locks pass flips
 * this constant, the street door and the roof hatch start asking the same question on the same day.
 */
import type { BuildingFacts } from './core';

/** Flip in the locks pass, when Inventory.lockpicks + the shop SKU + the picking dial exist. */
export const LOCKS_ENABLED = false;

/** Lobbies that belong to the public during the day: an office tower, a civic hall. A block of
 *  flats shares the same door furniture and none of the same welcome. */
const OPEN_LOBBY_STYLES = new Set(['downtown', 'mixed-use', 'civic']);

/** The classification alone — what WOULD be locked, regardless of whether locks are live. Pure so
 *  the census, the tests and the future pick UI all agree on one line. */
export function lockedClass(facts: Pick<BuildingFacts, 'style' | 'entrance'>): boolean {
  if (facts.entrance === 'shopfront' || facts.entrance === 'dock') return false;
  if (facts.entrance === 'lobby' && OPEN_LOBBY_STYLES.has(facts.style)) return false;
  return true;
}

/** The live gate. Exit paths must NEVER consult this — "picking is only needed to enter, not exit"
 *  is a hard rule: nobody is ever trapped inside a building. */
export function doorLocked(facts: Pick<BuildingFacts, 'style' | 'entrance'>): boolean {
  return LOCKS_ENABLED && lockedClass(facts);
}
