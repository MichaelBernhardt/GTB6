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

// ---- junk in the carriageway ---------------------------------------------------------------------

/**
 * A driver meeting something lying in his lane — a burning tyre, a heap of barricade junk.
 *
 * The rule the design wanted: a driver who can go round goes round, a driver who cannot stops, and
 * which of those it is falls out of HOW MUCH OF THE CARRIAGEWAY is actually blocked rather than out of
 * a hand-set flag on the obstruction. One tyre near the kerb is a metre of steering. Three tyres laid
 * across the lane is a wall, and it is a wall for exactly the same reason a real one is: there is no
 * longer a gap wide enough for a car.
 *
 * All of it is scalar geometry in the driver's own frame, so it tests without a scene, a City or a
 * Vehicle — and PopulationSystem does the wiring, exactly as it does for the on-foot player above.
 */

/** How far down his own lane a driver looks for something on the tar. */
export const HAZARD_SCAN = 30;
/** Lateral slack a driver wants between his tyre wall and a burning one. */
export const HAZARD_CLEARANCE = 0.55;
/** The most a driver will move sideways to thread a gap: about one lane. Past this he is not going
 *  round it, he is driving into oncoming traffic or up the pavement — so he stops instead. */
export const HAZARD_SWERVE_MAX = 3.4;
/** Where the swerve steer-target is placed down the road (the pull-around's DODGE_AHEAD, for junk). */
export const HAZARD_SWERVE_AHEAD = 9;
/** Ease off while threading: you do not take a gap that size at cruise. */
export const HAZARD_SWERVE_THROTTLE = 0.7;
/** Extra bumper room held off burning junk, ON TOP of the ordinary car-following gap: you stop a bit
 *  further back from a fire than from a bakkie's tailgate. */
export const HAZARD_STOP_MARGIN = 1.2;
/** Stopped at junk this long: hoot, and ask the planner for a different way round. */
export const HAZARD_PATIENCE = 3.5;
export const HAZARD_REHONK = 2.6;

/** The band of lateral offsets ONE hazard denies the driver's own centreline. */
export interface HazardBand { readonly ahead: number; readonly lo: number; readonly hi: number; }

/**
 * Sample one hazard in the driver's frame. `undefined` when it is behind him, past the scan, or so
 * far to the side that no reachable swerve could ever be constrained by it — which is the common
 * case and the reason this allocates nothing for the tyre burning on the next street.
 *
 * Lateral sign matches `avoidPlayer`: positive is the car's right.
 */
export function hazardBand(
  dx: number, dz: number, radius: number,
  forwardX: number, forwardZ: number,
  halfWidth: number, scan = HAZARD_SCAN,
): HazardBand | undefined {
  const ahead = dx * forwardX + dz * forwardZ;
  if (ahead <= 0 || ahead > scan) return undefined;
  const side = dx * forwardZ - dz * forwardX;
  const half = radius + halfWidth + HAZARD_CLEARANCE;
  if (Math.abs(side) > half + HAZARD_SWERVE_MAX) return undefined;
  return { ahead, lo: side - half, hi: side + half };
}

/**
 * The smallest lateral shift that threads every band, or `undefined` when nothing inside ±limit fits.
 *
 * Bands are merged, then the only offsets worth testing are 0 and each merged band's two edges — the
 * least movement wins, so a driver drifts a metre round a kerbside tyre and does not swing a whole
 * lane for it. `undefined` is what makes a barricade a barricade.
 *
 * Deterministic on ties (the more negative offset wins), so two identical cars behave identically.
 */
export function threadHazards(bands: readonly HazardBand[], limit = HAZARD_SWERVE_MAX): number | undefined {
  if (bands.length === 0) return 0;
  const merged: Array<[number, number]> = [];
  for (const band of [...bands].sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
    const last = merged[merged.length - 1];
    if (last && band.lo <= last[1]) last[1] = Math.max(last[1], band.hi);
    else merged.push([band.lo, band.hi]);
  }
  const free = (offset: number): boolean => merged.every(([lo, hi]) => offset <= lo || offset >= hi);
  if (free(0)) return 0;
  let best: number | undefined;
  for (const [lo, hi] of merged) for (const offset of [lo, hi]) {
    if (Math.abs(offset) > limit || !free(offset)) continue;
    if (best === undefined || Math.abs(offset) < Math.abs(best) || (Math.abs(offset) === Math.abs(best) && offset < best)) best = offset;
  }
  return best;
}

/** Player↔car overlap resolution in the car's frame: the player may never occupy the car's volume.
 *  Returns the car-frame displacement along the axis of least penetration, or undefined when clear. */
export function overlapPush(ahead: number, lateral: number, halfLength: number, halfWidth: number, playerRadius: number): { ahead: number; lateral: number } | undefined {
  const penAhead = halfLength + playerRadius - Math.abs(ahead);
  const penLateral = halfWidth + playerRadius - Math.abs(lateral);
  if (penAhead <= 0 || penLateral <= 0) return undefined;
  return penLateral <= penAhead ? { ahead: 0, lateral: Math.sign(lateral || 1) * penLateral } : { ahead: Math.sign(ahead || 1) * penAhead, lateral: 0 };
}
