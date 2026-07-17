import { SIGHT_RADIUS } from './PoliceKnowledge';

/** Blackout stealth: with Eskom down at night the city is genuinely dark, and JMPD can't see what nothing
 *  lights. While the blackout darkness is past this threshold, an unlit player is invisible to police SIGHT
 *  checks beyond a whites-of-eyes radius — unless something gives them away (torch, muzzle flash, headlights). */
export const BLACKOUT_STEALTH_THRESHOLD = 0.6;
/** Even in pitch dark you can't stand on a cop's toes: inside this radius they make you out regardless. */
export const BLACKOUT_SIGHT_RADIUS = 7;
/** How far a live headlight cone throws usable light onto a suspect. */
export const HEADLIGHT_CONE_RANGE = 28;
/** Half-angle of that cone: the vehicle has to be genuinely facing the player, not just parked nearby. */
export const HEADLIGHT_CONE_HALF_ANGLE = (28 * Math.PI) / 180;
/** Seconds a muzzle flash keeps the shooter lit after firing — shooting in the dark gives you away. */
export const MUZZLE_FLASH_SECONDS = 1.5;

const COS_HALF_ANGLE = Math.cos(HEADLIGHT_CONE_HALF_ANGLE);

/** One live pair of headlights: a non-wrecked vehicle with its lamps burning, described by pose alone. */
export interface HeadlightCone { x: number; z: number; heading: number; }

/** Is the point lit by a vehicle's forward beam? Vehicle forward is (sin heading, cos heading), matching
 *  Vehicle/DayNight. Standing dead on the vehicle (zero offset) is NOT in the beam — headlights point ahead. */
export function inHeadlightCone(x: number, z: number, heading: number, px: number, pz: number): boolean {
  const dx = px - x; const dz = pz - z; const distanceSq = dx * dx + dz * dz;
  if (distanceSq > HEADLIGHT_CONE_RANGE * HEADLIGHT_CONE_RANGE || distanceSq < 1e-6) return false;
  return (Math.sin(heading) * dx + Math.cos(heading) * dz) / Math.sqrt(distanceSq) >= COS_HALF_ANGLE;
}

/** Everything that betrays the player in a blackout: their own torch, the afterimage of a muzzle flash
 *  (seconds remaining), or standing in any live headlight cone. */
export function visibleInBlackout(px: number, pz: number, torchOn: boolean, muzzleFlash: number, cones: readonly HeadlightCone[]): boolean {
  return torchOn || muzzleFlash > 0 || cones.some((cone) => inHeadlightCone(cone.x, cone.z, cone.heading, px, pz));
}

/** The stealth gate itself: concealed only while the night-gated blackout darkness is high AND nothing lights
 *  the player. Daytime shedding (darkness 0) or a half-faded ramp never conceals. */
export function concealedInBlackout(darkness: number, visible: boolean): boolean {
  return darkness > BLACKOUT_STEALTH_THRESHOLD && !visible;
}

/** How far police can visually acquire the player this frame — the single knob PoliceSystem turns. */
export function policeSightRadius(concealed: boolean): number { return concealed ? BLACKOUT_SIGHT_RADIUS : SIGHT_RADIUS; }
