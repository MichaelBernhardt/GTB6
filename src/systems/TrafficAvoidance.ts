/** Civilian traffic vs the ON-FOOT player: forward-corridor braking, held-up honking with per-driver
 *  jitter, an eventual GTA-style pull-around, and real contact (a shove at walking pace, speed-scaled
 *  damage + a tumble past SHOVE_SPEED). Police are exempt — PoliceSystem runs its own standoff brain.
 *  Pure math lives here; PopulationSystem does the wiring. */

export const AVOID_RANGE = 60; // only vehicles this close to the player run the corridor check
export const CORRIDOR_MARGIN = 0.6; // lateral slack beyond the half body width
export const STOP_BASE = 3; // stopping envelope floor: the FRONT BUMPER holds this short of the player
export const STOP_SCALE = 0.9; // extra envelope per unit of speed: faster cars brake sooner
export const HOLD_SPEED = 2.2; // under this a blocked driver counts as held up: full stop, honk clock runs
export const RELEASE_CLEAR = 0.5; // corridor must stay clear this long before a held car rolls again
export const FIRST_HONK = 1.2; // patience before the first hoot
export const REHONK_MIN = 2; // re-honk cadence bounds, jittered per driver so a queue never honks in sync
export const REHONK_MAX = 3;
export const PULL_AROUND_MIN = 8; // total blockage before the driver gives up and swings past
export const PULL_AROUND_MAX = 10;
export const DODGE_TIME = 2.4; // how long the pull-around steer target is held
export const DODGE_SIDE = 2.6; // lateral offset of the dodge target
export const DODGE_AHEAD = 7; // forward offset of the dodge target
export const DODGE_THROTTLE = 0.25; // ease past, don't floor it: the player is right there
export const SHOVE_SPEED = 3; // below: contact only shoves; at/above: damage + knockdown tumble
export const HIT_SPEED_KEEP = 0.75; // the car sheds a bit of speed on a body hit
export const HIT_COOLDOWN = 0.9; // one damage event per contact burst, not one per frame

/** How far ahead a driver scans for the player: distance needed to ease to a stop at this speed. */
export function stoppingEnvelope(speed: number): number { return Math.abs(speed) * STOP_SCALE + STOP_BASE; }

/** Corridor distances are measured from the FRONT BUMPER, not the center: a Quantum's nose reaches
 *  the player two-plus units before its center does, and it must stop as short as a compact. */
export function bumperAhead(centerAhead: number, halfLength: number): number { return centerAhead - halfLength; }

/** True when the player stands inside the vehicle's forward stopping corridor (car frame: ahead of the
 *  FRONT BUMPER along the heading, lateralSq the squared perpendicular offset). Behind or beside never blocks. */
export function corridorBlocked(ahead: number, lateralSq: number, speed: number, halfWidth: number): boolean {
  if (ahead <= 0 || ahead >= stoppingEnvelope(speed)) return false;
  const halfLane = halfWidth + CORRIDOR_MARGIN;
  return lateralSq < halfLane * halfLane;
}

/** Held-state hysteresis: feeds the clear timer and returns undefined once the corridor has stayed
 *  clear for RELEASE_CLEAR — a held car must not inch forward because the player shifted 20cm. */
export function holdRelease(clearFor: number, blocked: boolean, dt: number): number | undefined {
  const next = blocked ? 0 : clearFor + dt;
  return next < RELEASE_CLEAR ? next : undefined;
}

/** Crawl-speed nose contact moves the CAR, not the player: a standing player is never bulldozed.
 *  Lateral overlap (the player sidling into a door) still pushes the player — he is the mover there. */
export function carYields(pushLateral: number, speed: number): boolean { return pushLateral === 0 && Math.abs(speed) < SHOVE_SPEED; }

/** Body-hit damage, riderImpactDamage's cousin: contact below SHOVE_SPEED is a zero-damage nudge,
 *  past it the bumper wins and damage scales with speed. */
export function vehicleHitDamage(speed: number): number {
  const impact = Math.abs(speed);
  return impact < SHOVE_SPEED ? 0 : Math.round(4 + (impact - SHOVE_SPEED) * 1.5);
}

export function firstHonkDelay(random: () => number = Math.random): number { return FIRST_HONK + random() * 0.6; }
export function rehonkDelay(random: () => number = Math.random): number { return REHONK_MIN + random() * (REHONK_MAX - REHONK_MIN); }
export function pullAroundPatience(random: () => number = Math.random): number { return PULL_AROUND_MIN + random() * (PULL_AROUND_MAX - PULL_AROUND_MIN); }

/** Which side to swing past a blocking player: away from him when that lane is clear, the other side
 *  as a fallback, 0 when boxed in (sit and hoot some more). Positive lateral = the car's right. */
export function pullAroundSide(playerLateral: number, clearPositive: boolean, clearNegative: boolean): -1 | 0 | 1 {
  const away = playerLateral >= 0 ? -1 : 1;
  if (away === 1 ? clearPositive : clearNegative) return away;
  return (away === 1 ? clearNegative : clearPositive) ? -away as -1 | 1 : 0;
}

/** Player↔car overlap resolution in the car's frame: the player may never occupy the car's volume.
 *  Returns the car-frame displacement along the axis of least penetration, or undefined when clear. */
export function overlapPush(ahead: number, lateral: number, halfLength: number, halfWidth: number, playerRadius: number): { ahead: number; lateral: number } | undefined {
  const penAhead = halfLength + playerRadius - Math.abs(ahead);
  const penLateral = halfWidth + playerRadius - Math.abs(lateral);
  if (penAhead <= 0 || penLateral <= 0) return undefined;
  return penLateral <= penAhead ? { ahead: 0, lateral: Math.sign(lateral || 1) * penLateral } : { ahead: Math.sign(ahead || 1) * penAhead, lateral: 0 };
}
