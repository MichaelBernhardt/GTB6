/**
 * Kelvin Yard security (flagship mission "Dark House").
 *
 * The yard is IMPOSSIBLE to breach while the grid is up: mains floodlights make any
 * intruder inside the fence instantly spotted, day or night, and the gate maglock
 * holds. Only a night-time load-shedding blackout kills the floodlights and drops the
 * maglock — then the remaining threat is torch-patrol guards, the player's own torch,
 * and gunfire. The game never states this; failure copy stays diegetic.
 *
 * Giveaways route through BlackoutStealth's shared model (own torch, muzzle-flash
 * afterimage, live headlight cones), so what betrays you to JMPD in a blackout
 * betrays you to the yard too. Guard torch patrols stay mission-owned cone math.
 */
import { visibleInBlackout, type HeadlightCone } from './BlackoutStealth';

export interface DepotGuard { x: number; z: number; heading: number; }
export interface DepotSnapshot {
  insideFence: boolean;
  playerX: number;
  playerZ: number;
  blackout: number; // eased 0..1 grid-down factor
  isNight: boolean;
  torchOn: boolean;
  muzzleFlash: number; // seconds of muzzle-flash afterimage remaining (BlackoutStealth convention)
  headlights: readonly HeadlightCone[]; // live vehicle beams near the yard
  guardSees: boolean;
}

/** The eased blackout factor above which the yard counts as dark (floodlights dead, maglock open). */
export const DEPOT_DARK_THRESHOLD = 0.7;
/** Grace seconds after mid-run power return: the surge flicker before the floodlights find you. */
export const POWER_SURGE_GRACE_S = 5;
/** Guard torch cone during a blackout: narrow beam, short throw. */
export const GUARD_TORCH_RANGE = 14;
export const GUARD_TORCH_HALF_ANGLE = Math.PI / 7;

export const depotDark = (blackout: number, isNight: boolean): boolean => isNight && blackout >= DEPOT_DARK_THRESHOLD;

/** Narrow torch-cone check for a patrol guard. Pure 2D; heading follows the game's atan2(x, z) convention. */
export function guardSees(guard: DepotGuard, playerX: number, playerZ: number): boolean {
  const dx = playerX - guard.x; const dz = playerZ - guard.z;
  const distance = Math.hypot(dx, dz);
  if (distance > GUARD_TORCH_RANGE) return false;
  if (distance < 1.2) return true; // brushing past a guard is a spot regardless of facing
  const bearing = Math.atan2(dx, dz);
  let delta = bearing - guard.heading;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta) <= GUARD_TORCH_HALF_ANGLE;
}

export class DepotSecurity {
  /** Grace seconds remaining after the grid came back while the player was mid-breach. */
  surge = 0;
  private wasDark = false;

  reset(): void { this.surge = 0; this.wasDark = false; }

  /** Per-frame verdict. 'spotted' is terminal for the objective (the mission layer fails it). */
  update(dt: number, snapshot: DepotSnapshot): 'clear' | 'spotted' {
    const dark = depotDark(snapshot.blackout, snapshot.isNight);
    if (dark) this.wasDark = true;
    else if (this.wasDark) { this.wasDark = false; this.surge = POWER_SURGE_GRACE_S; }
    this.surge = Math.max(0, this.surge - Math.max(0, dt));
    if (!snapshot.insideFence) return 'clear';
    if (!dark && this.surge <= 0) return 'spotted'; // floodlights (or daylight watch): unconditional
    if (visibleInBlackout(snapshot.playerX, snapshot.playerZ, snapshot.torchOn, snapshot.muzzleFlash, snapshot.headlights)) return 'spotted';
    if (snapshot.guardSees) return 'spotted';
    return 'clear';
  }

  /** The gate maglock is mains-fed: sealed whenever the yard isn't dark. */
  gateOpen(blackout: number, isNight: boolean): boolean { return depotDark(blackout, isNight); }
}
