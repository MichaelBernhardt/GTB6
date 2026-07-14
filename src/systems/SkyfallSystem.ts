/** Skydive physics for the `skyfall` console command. Pure state stepping — Game owns the player, the city
 *  queries and the visuals; this module owns the numbers so headless tests can fly the whole descent. */

export const SKYFALL_ALTITUDE = 2500; // drop height above the target ground — high enough for a long freefall

/** Freefall: belly-down terminal velocity, W tips head-down (faster everything), S arches flat (slow + track).
 *  Forward speeds are tuned for big ground coverage — flat tracking (S) out-glides the sink (>1:1) so you can
 *  aim for a distant landing zone and really move across the map, not just drift. */
export const FREEFALL_DESCENT = 55;
export const FREEFALL_DIVE_DESCENT = 78;
export const FREEFALL_FLAT_DESCENT = 38;
export const FREEFALL_FORWARD = 30;
export const FREEFALL_FORWARD_DIVE = 70;
export const FREEFALL_FORWARD_TRACK = 60;
export const FREEFALL_TURN_RATE = 1.7; // rad/s
export const FREEFALL_RESPONSE = 1.4; // 1/s convergence toward the target sink rate

/** Canopy: gentle sink, strong glide authority, W dives for speed and S rides the brakes. The flat sink + high
 *  forward gives a long glide (~2.7:1 neutral) so a deployed chute covers a lot of ground toward a chosen target. */
export const CHUTE_DESCENT = 7;
export const CHUTE_DIVE_DESCENT = 13;
export const CHUTE_BRAKE_DESCENT = 5.5;
export const CHUTE_FORWARD = 19;
export const CHUTE_FORWARD_DIVE = 27;
export const CHUTE_FORWARD_BRAKE = 5;
export const CHUTE_TURN_RATE = 1.15;
export const CHUTE_RESPONSE = 6; // the canopy bites fast: deploying sheds ~50 u/s of sink in about a second

export const PITCH_RATE = 2.4; // full stick deflection per second of held key
export const PITCH_RELAX = 2.2; // released stick eases back to neutral

/** Flare: one burst per deploy, armed only near the ground, briefly killing the sink for a step-off landing. */
export const FLARE_WINDOW = 16;
export const FLARE_DURATION = 1.6;
export const FLARE_DESCENT = 2.2;
/** Touch down under canopy at or below this sink rate and the landing is free; diving in still stings. */
export const SAFE_CHUTE_DESCENT = 12;

export type AirborneMode = 'freefall' | 'parachute';
export interface AirborneState { mode: AirborneMode; pitch: number; bank: number; heading: number; descent: number; flareTimer: number; flareArmed: boolean; fallOriginY: number; }
/** pitch: W(+1)/S(-1) held. steer: D(+1)/A(-1). flare: S or Space held (canopy only, near the ground). */
export interface AirborneStick { pitch: number; steer: number; flare: boolean; }
export interface AirborneStep { dx: number; dz: number; y: number; landed: boolean; descent: number; }

export function startAirborne(heading: number, y: number): AirborneState {
  return { mode: 'freefall', pitch: 0, bank: 0, heading, descent: 0, flareTimer: 0, flareArmed: false, fallOriginY: y };
}

export function canDeploy(mode: AirborneMode, parachutes: number): boolean { return mode === 'freefall' && parachutes > 0; }

/** Pulling the ripcord: the canopy takes over with level trim and a fresh flare in the brakes. */
export function deployParachute(state: AirborneState): void {
  state.mode = 'parachute'; state.pitch = 0; state.flareTimer = 0; state.flareArmed = true;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Target sink rate for the current trim: dive steepens it, flattening or riding the brakes eases it, a flare kills it. */
export function targetDescent(mode: AirborneMode, pitch: number, flaring = false): number {
  if (flaring) return FLARE_DESCENT;
  if (mode === 'freefall') return pitch >= 0 ? lerp(FREEFALL_DESCENT, FREEFALL_DIVE_DESCENT, pitch) : lerp(FREEFALL_DESCENT, FREEFALL_FLAT_DESCENT, -pitch);
  return pitch >= 0 ? lerp(CHUTE_DESCENT, CHUTE_DIVE_DESCENT, pitch) : lerp(CHUTE_DESCENT, CHUTE_BRAKE_DESCENT, -pitch);
}

/** Horizontal authority: a freefall dive trades altitude for ground speed, flat tracking still travels. */
export function targetForward(mode: AirborneMode, pitch: number, flaring = false): number {
  if (mode === 'freefall') return pitch >= 0 ? lerp(FREEFALL_FORWARD, FREEFALL_FORWARD_DIVE, pitch) : lerp(FREEFALL_FORWARD, FREEFALL_FORWARD_TRACK, -pitch);
  if (flaring) return CHUTE_FORWARD_BRAKE;
  return pitch >= 0 ? lerp(CHUTE_FORWARD, CHUTE_FORWARD_DIVE, pitch) : lerp(CHUTE_FORWARD, CHUTE_FORWARD_BRAKE, -pitch);
}

/** One tick of the descent: trim and heading from the stick, sink rate easing toward its target, the flare
 *  window near the ground, and the landing report when the feet reach the support surface. */
export function stepAirborne(state: AirborneState, stick: AirborneStick, dt: number, y: number, support: number): AirborneStep {
  if (stick.pitch !== 0) state.pitch = Math.min(1, Math.max(-1, state.pitch + stick.pitch * PITCH_RATE * dt));
  else state.pitch -= state.pitch * Math.min(1, dt * PITCH_RELAX);
  state.heading -= stick.steer * (state.mode === 'freefall' ? FREEFALL_TURN_RATE : CHUTE_TURN_RATE) * dt;
  state.bank += (stick.steer * 0.5 - state.bank) * Math.min(1, dt * 6);
  if (state.mode === 'parachute' && stick.flare && state.flareArmed && y - support <= FLARE_WINDOW) { state.flareArmed = false; state.flareTimer = FLARE_DURATION; }
  const flaring = state.flareTimer > 0; state.flareTimer = Math.max(0, state.flareTimer - dt);
  const response = state.mode === 'freefall' ? FREEFALL_RESPONSE : CHUTE_RESPONSE;
  state.descent += (targetDescent(state.mode, state.pitch, flaring) - state.descent) * (1 - Math.exp(-dt * response));
  const forward = targetForward(state.mode, state.pitch, flaring);
  const dx = Math.sin(state.heading) * forward * dt; const dz = Math.cos(state.heading) * forward * dt;
  const nextY = y - state.descent * dt;
  if (nextY <= support) return { dx, dz, y: support, landed: true, descent: state.descent };
  return { dx, dz, y: nextY, landed: false, descent: state.descent };
}

/** Canopy landings at a sane sink rate are free; slamming in nose-down still costs a bruise per unit over. */
export function chuteLandingDamage(descent: number): number {
  return descent <= SAFE_CHUTE_DESCENT ? 0 : Math.round((descent - SAFE_CHUTE_DESCENT) * 6);
}

/** HUD hint while airborne; the deploy key only shows when a chute is actually aboard. */
export function airborneHint(mode: AirborneMode, parachutes: number): string {
  if (mode === 'parachute') return 'W/S  Dive / brake  ·  A/D  Steer  ·  S or SPACE near ground  Flare';
  return parachutes > 0 ? 'SPACE  Deploy parachute  ·  W  Dive  ·  S  Flatten  ·  A/D  Steer' : 'W  Dive  ·  S  Flatten  ·  A/D  Steer  ·  No parachute aboard';
}
