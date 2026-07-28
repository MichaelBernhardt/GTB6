/**
 * Negotiation rules — pure predicates, no scene, no THREE.
 *
 * The design rule these encode: a refusal is never a wall, it is a CAUSE the player can read on
 * screen and fix in under a minute. Off shift → come back at seven. Doing 40 → stop the car. Driving
 * a JMPD cruiser → obviously not. On the bad-date list → that one you wait out, because you earned it.
 */

export type Refusal =
  | 'banned'      // you hurt someone; the whole block knows the car
  | 'off-shift'   // she is not working yet, and she said when she would be
  | 'moving'      // the car is not stopped
  | 'police-car'  // you are driving a marked cruiser
  | 'wreck'       // shot-up, burning, or otherwise not getting in
  | 'broke'       // cannot cover the stated price
  | 'busy';       // just finished; not a vending machine

export interface Shift { readonly start: number; readonly end: number }

/** Hour windows wrap midnight, because every interesting shift in this city does. */
export function onShift(hour: number, shift: Shift): boolean {
  const now = ((hour % 24) + 24) % 24;
  return shift.start <= shift.end ? now >= shift.start && now < shift.end : now >= shift.start || now < shift.end;
}

/** Whole hours until the shift opens — the number the refusal line quotes back to the player. */
export function hoursUntilShift(hour: number, shift: Shift): number {
  const now = ((hour % 24) + 24) % 24;
  const gap = (shift.start - now + 24) % 24;
  return Math.max(1, Math.round(gap));
}

export interface WindowState {
  readonly hour: number;
  readonly shift: Shift;
  /** Seconds of play left on the bad-date list. */
  readonly banned: number;
  readonly balance: number;
  readonly price: number;
  /** Undefined on foot. */
  readonly vehicle?: { readonly speed: number; readonly health: number; readonly maxHealth: number; readonly onFire: boolean; readonly police: boolean };
  /** Seconds left of her own after-work pause. */
  readonly busy: number;
}

export const WRECK_HEALTH_FRACTION = 0.45;
export const STOPPED_SPEED = 2.2;

/** The whole refusal ladder, in the order she would actually apply it. Undefined means yes. */
export function refuseWindow(state: WindowState): Refusal | undefined {
  if (state.banned > 0) return 'banned';
  if (state.vehicle?.police) return 'police-car';
  if (!onShift(state.hour, state.shift)) return 'off-shift';
  if (state.busy > 0) return 'busy';
  if (state.vehicle && (state.vehicle.onFire || state.vehicle.health < state.vehicle.maxHealth * WRECK_HEALTH_FRACTION)) return 'wreck';
  if (state.vehicle && Math.abs(state.vehicle.speed) > STOPPED_SPEED) return 'moving';
  if (state.balance < state.price) return 'broke';
  return undefined;
}

/** Seconds of play on the bad-date list. ~12 in-game hours at the 10-minute day cycle. */
export const BAD_DATE_SECONDS = 300;
/** What the Body Corporate adds to your levy account when word reaches the trustees. */
export const BAD_DATE_LEVY = 250;
/** Her own pause after a job, so the corner is never a vending machine. */
export const AFTER_WORK_SECONDS = 90;

/** In-game hours left on the list, for the line that tells the player exactly what they cost themselves. */
export function banHours(seconds: number, dayCycleSeconds = 600): number {
  return Math.max(1, Math.round(seconds / (dayCycleSeconds / 24)));
}

/**
 * Somewhere to stop. Deliberately the simplest legible rule in the feature — round the corner and
 * stop — because a condition the player cannot see is a condition that wedges them. No weather gate,
 * no darkness gate, no "find a quiet zone the map never marked": drive 30 m and brake.
 */
export interface QuietSpot {
  readonly speed: number;
  /** Metres from the kerb you picked her up at. */
  readonly distanceFromPickup: number;
}

export const QUIET_DISTANCE = 30;

export function isQuiet(spot: QuietSpot): boolean {
  return Math.abs(spot.speed) <= STOPPED_SPEED && spot.distanceFromPickup >= QUIET_DISTANCE;
}

/** What the HUD chip nags about while she is in the car — one instruction at a time. */
export function quietHint(spot: QuietSpot): string {
  if (spot.distanceFromPickup < QUIET_DISTANCE) return 'Round the corner';
  if (Math.abs(spot.speed) > STOPPED_SPEED) return 'Stop the car';
  return 'Kill the lights';
}
