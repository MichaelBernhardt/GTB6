import type { FearResponse } from './FearSystem';

/**
 * ARMED CITIZENS — the owner's deterrence rule, in one module.
 *
 * "Good samaritans and people that attack the player are always unarmed (attack with fists).
 *  If the player is unarmed that's okay. Some people may also rarely be armed, and if that's
 *  true they can attack the player even if they're armed. But certainly if I'm holding a gun,
 *  unarmed people shouldn't attack and start punching. Likewise, if I'm initially unarmed and
 *  someone attacks, and then I pull a gun, they will get scared and run (unless they also have
 *  a gun they can pull) rather than continuing to punch me."
 *
 * The whole table reduces to one line: FISTS ONLY PICK FIGHTS WITH FISTS. A citizen's 'fight'
 * response survives contact with a visibly armed player only if they carry themselves; JMPD
 * (facing armed suspects is the job) and Rank Enforcer crews (constructor-hostile mission
 * combatants, committed by design) are exempt at the call sites, not here.
 *
 * "Visibly armed" means the player's CURRENT weapon is a firearm and they are on foot — the
 * rigged player carries the selected weapon in hand at all times (RiggedPlayerVisual shows the
 * mesh whenever it is selected, holstering only in vehicles/air), so selection IS holding.
 * Fists — and any melee weapon added later — still invite fists: spec.melee is the line.
 */

/**
 * The rare concealed-carry trait, in the codebase's deterministic personality idiom
 * (index arithmetic, like `aggressive = index % 9 === 0` and the bravery hash — no
 * Math.random in a simulation path, ever).
 *
 * RARITY — 1 in 12 (~8%). Joburg: concealed carry is real (roughly one licensed firearm per
 * ten-odd adults nationally) but most people on the street are not walking around strapped;
 * 1-in-12 keeps an armed citizen an uncommon discovery, yet guarantees a few in any spawned
 * crowd (the opening 28 carry three).
 *
 * CORRELATION — the modulo DELIBERATELY shares a factor with the aggressive rule's 9:
 * index ≡ 3 (mod 12) intersects index ≡ 0 (mod 9) exactly at index ≡ 27 (mod 36), so one ped
 * in 36 is an ARMED AGGRESSIVE — the person who squares up to a player visibly holding a gun
 * and answers it by drawing their own. Without that structural overlap the owner's "they can
 * attack the player even if they're armed" would only ever surface through the rarer
 * samaritan/knockdown paths. Phase 3 keeps index 0 (first ped of every spawn wave, already
 * aggressive) unarmed, so the overlap lands mid-crowd instead of on the doorstep.
 */
export const ARMED_CITIZEN_MODULO = 12;
export const ARMED_CITIZEN_PHASE = 3;
export function isArmedCitizen(index: number, hostile: boolean, police: boolean): boolean {
  // Police have their own service pistol path (PoliceSystem); Rank Enforcers are a fist crew
  // by design — arming either here would double up or rebalance systems that already work.
  return !hostile && !police && index % ARMED_CITIZEN_MODULO === ARMED_CITIZEN_PHASE;
}

/**
 * The deterrence gate applied wherever a fear response is consumed (the good-samaritan
 * 'fight', the post-knockdown rise, the mid-fight break): an unarmed citizen's fight
 * collapses to flight when the player is visibly armed; an armed citizen's fight stands —
 * they draw. Never upgrades a response, never touches flee/cower/calm, so everything the
 * fear model already does (bravery thresholds, cowering, solidarity caps) is untouched.
 */
export function gunDeterrence(response: FearResponse, playerArmed: boolean, armed: boolean): FearResponse {
  return response === 'fight' && playerArmed && !armed ? 'flee' : response;
}

/** A shooter stops advancing and settles into the two-hand aim inside this range — a street
 *  confrontation, not a police cordon (JMPD engages out to 44). */
export const GUN_ENGAGE_RANGE = 9;
/** Hysteresis, exactly like the melee square-up: once aiming, the stance holds until the
 *  player opens the gap past this, so the aim never flickers while the player strafes. */
export const GUN_ENGAGE_RELEASE = 13;
/** Shots only come from the settled aim stance (== the release ring): no hip fire mid-sprint. */
export const CIVILIAN_FIRE_RANGE = GUN_ENGAGE_RELEASE;
/** Per hit. Sits under JMPD foot fire (4 + wanted level): a civilian defender pressures the
 *  player without out-shooting the police response the same fight usually summons. */
export const CIVILIAN_GUN_DAMAGE = 5;
/** Fire cadence: the base beat also serves as the draw beat — the first shot waits one full
 *  delay after the aim settles, so the draw reads before it wounds. */
export const CIVILIAN_FIRE_MIN = 1.1;
export const CIVILIAN_FIRE_JITTER = 0.8;
export function civilianFireDelay(jitter01: number): number {
  return CIVILIAN_FIRE_MIN + jitter01 * CIVILIAN_FIRE_JITTER;
}
