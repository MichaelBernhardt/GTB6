/** Arcade flight model for the O.R. Tambourine light aircraft. Pure state stepping — Game owns the entity,
 *  the city queries and the visuals; this module owns the numbers so headless tests can fly a whole sortie:
 *  throttle up, roll down the runway, rotate, banked turns, stall mush, ceiling, and the landing verdict. */

export const PLANE_MAX_SPEED = 72; // ~260 km/h flat out — comfortably over every road vehicle
export const PLANE_STALL_SPEED = 26; // below this the wings quit: the nose mushes over and the sink builds
export const PLANE_ROTATE_SPEED = 32; // ground speed needed before pulling up leaves the tar
export const PLANE_CEILING = 600; // thin-air ceiling: climbs top out gently here, no hard wall
export const PLANE_MAX_PITCH = 0.6; // rad — full stick deflection either way
export const PLANE_MAX_ROLL = 0.85; // rad — a committed bank, never a knife edge
export const PLANE_PITCH_RATE = 1.15; // rad/s of held pitch key
export const PLANE_AUTO_LEVEL = 1.6; // 1/s — hands-off trim eases the nose back to level (keyboard-friendly)
export const PLANE_ROLL_RESPONSE = 3.5; // 1/s convergence of roll onto the steer target
export const PLANE_TURN_RATE = 0.95; // heading rate per radian of bank at full airspeed
export const PLANE_THROTTLE_RATE = 0.55; // full throttle travel per second of held key
export const PLANE_THRUST_RESPONSE = 0.35; // 1/s — how fast thrust pulls speed toward the throttle target
export const PLANE_AIR_DRAG_RESPONSE = 0.14; // 1/s — a cut throttle bleeds speed slowly in the air
export const PLANE_GROUND_DRAG_RESPONSE = 0.45; // 1/s — rolling friction eats speed much faster on the tar
export const PLANE_WHEEL_BRAKE = 16; // u/s² — S past idle rides the wheel brakes on the ground
export const PLANE_GRAVITY_BLEED = 9; // u/s² along the flight path per radian-ish of pitch: climbs bleed, dives build
export const PLANE_GROUND_STEER = 1.5; // rad/s of nosewheel authority at taxi speed
export const STALL_PITCH = -0.52; // where the stalled nose falls to
export const STALL_SINK_GAIN = 1.5; // extra sink per unit of speed deficit below the stall
export const CEILING_TRIM = -0.06; // pitch the ceiling pushes the nose toward
export const CEILING_FADE = 50; // climb rate fades to nothing across this band above the ceiling — a soft lid, no wall
export const SAFE_LANDING_SINK = 9; // touch down sinking faster than this and it's a wreck, not a landing
export const SAFE_LANDING_PITCH = -0.22; // nose-down past this at contact is a lawn dart regardless of sink
export const PLANE_EXIT_SPEED = 4; // slow enough to climb out on the ground
export const PLANE_WRECK_RESPAWN = 12; // seconds before a wreck is towed back to its apron stand

export interface PlaneState { heading: number; pitch: number; roll: number; speed: number; throttle: number; grounded: boolean; }
/** throttle: W(+1)/S(-1) held. steer: A(+1)/D(-1). pitch: ArrowUp(+1) climbs, ArrowDown(-1) dives. */
export interface PlaneStick { throttle: number; steer: number; pitch: number; }
export interface PlaneStep { dx: number; dz: number; y: number; landed: boolean; crashed: boolean; sink: number; }

export function createPlaneState(heading: number): PlaneState {
  return { heading, pitch: 0, roll: 0, speed: 0, throttle: 0, grounded: true };
}

/** One tick of the sortie: throttle winds the airspeed, the gear steers on the tar until rotation speed,
 *  then bank carries the heading, trim auto-levels, the stall and the ceiling both push the nose where the
 *  air says it goes, and ground contact returns the landing verdict (rollout vs wreck). */
export function stepPlane(state: PlaneState, stick: PlaneStick, dt: number, y: number, support: number): PlaneStep {
  state.throttle = Math.min(1, Math.max(0, state.throttle + stick.throttle * PLANE_THROTTLE_RATE * dt));
  const target = state.throttle * PLANE_MAX_SPEED;
  const response = target > state.speed ? PLANE_THRUST_RESPONSE : state.grounded ? PLANE_GROUND_DRAG_RESPONSE : PLANE_AIR_DRAG_RESPONSE;
  state.speed += (target - state.speed) * (1 - Math.exp(-dt * response));
  if (state.grounded) return stepGroundRoll(state, stick, dt, support);
  state.roll += (stick.steer * PLANE_MAX_ROLL - state.roll) * (1 - Math.exp(-dt * PLANE_ROLL_RESPONSE)); // steer rolls the wings…
  state.heading += state.roll * PLANE_TURN_RATE * (0.45 + 0.55 * Math.min(1, state.speed / PLANE_MAX_SPEED)) * dt; // …and the bank carries the nose around
  if (stick.pitch !== 0) state.pitch = Math.min(PLANE_MAX_PITCH, Math.max(-PLANE_MAX_PITCH, state.pitch + stick.pitch * PLANE_PITCH_RATE * dt));
  else state.pitch -= state.pitch * Math.min(1, dt * PLANE_AUTO_LEVEL); // hands off: the trim eases the nose level
  state.speed = Math.max(0, state.speed - Math.sin(state.pitch) * PLANE_GRAVITY_BLEED * dt); // climbs bleed airspeed, dives build it
  const deficit = Math.max(0, PLANE_STALL_SPEED - state.speed);
  if (deficit > 0) state.pitch += (STALL_PITCH - state.pitch) * Math.min(1, dt * deficit * 0.4); // too slow: no stick authority saves it
  if (y >= PLANE_CEILING && state.pitch > CEILING_TRIM) state.pitch += (CEILING_TRIM - state.pitch) * Math.min(1, dt * 1.5); // thin air eases the nose over…
  const lift = Math.sin(state.pitch) * state.speed - deficit * STALL_SINK_GAIN;
  const thin = Math.min(1, Math.max(0, (PLANE_CEILING + CEILING_FADE - y) / CEILING_FADE)); // …and starves the climb outright: even a held stick tops out inside the fade band
  const dy = (lift > 0 ? lift * thin : lift) * dt;
  const dx = Math.sin(state.heading) * Math.cos(state.pitch) * state.speed * dt;
  const dz = Math.cos(state.heading) * Math.cos(state.pitch) * state.speed * dt;
  const nextY = y + dy;
  const sink = Math.max(0, -dy / dt);
  if (nextY > support) return { dx, dz, y: nextY, landed: false, crashed: false, sink };
  const crashed = sink > SAFE_LANDING_SINK || state.pitch < SAFE_LANDING_PITCH; // slow and shallow rolls out; slamming in does not
  state.grounded = true; state.pitch = 0; state.roll = 0;
  return { dx, dz, y: support, landed: true, crashed, sink };
}

/** On the tar: nosewheel steering (best at taxi speed, washing out as it gets fast), wheel brakes on S past
 *  idle, and rotation — at flying speed a held pull-up pops the wheels off with a visible nose-up moment. */
function stepGroundRoll(state: PlaneState, stick: PlaneStick, dt: number, support: number): PlaneStep {
  if (stick.throttle < 0 && state.throttle === 0) state.speed = Math.max(0, state.speed - PLANE_WHEEL_BRAKE * dt);
  state.roll -= state.roll * Math.min(1, dt * 5);
  state.pitch -= state.pitch * Math.min(1, dt * 6);
  const grip = Math.min(1, state.speed / 6) * (1 - Math.min(state.speed / 90, 0.45));
  state.heading += stick.steer * PLANE_GROUND_STEER * grip * dt;
  const dx = Math.sin(state.heading) * state.speed * dt; const dz = Math.cos(state.heading) * state.speed * dt;
  if (stick.pitch > 0 && state.speed >= PLANE_ROTATE_SPEED) { state.grounded = false; state.pitch = 0.12; }
  return { dx, dz, y: support, landed: true, crashed: false, sink: 0 };
}

/** Crash bill for whoever was in the seat: base airframe write-off plus sink and forward speed. */
export function planeCrashDamage(sink: number, speed: number): number {
  return Math.round(35 + sink * 3 + speed * 0.6);
}

/** HUD hint for the flight phase: taxi, takeoff roll, or airborne. */
export function planeHint(state: PlaneState): string {
  if (!state.grounded) return '↑/↓  Climb / dive  ·  A/D  Bank  ·  W/S  Throttle  ·  E  Bail out';
  if (state.speed >= PLANE_ROTATE_SPEED) return '↑  Pull up to lift off  ·  A/D  Steer  ·  S  Brake';
  return state.speed > PLANE_EXIT_SPEED ? 'W  Throttle up  ·  A/D  Steer  ·  S  Brake' : 'W  Throttle up  ·  A/D  Steer  ·  E  Climb out';
}
