/**
 * THE SHORT TIME — the cutscene, reduced to arithmetic.
 *
 * Nothing here touches THREE, the scene graph, the api or the save. It is a clock in, and a camera
 * pose plus three suspension numbers out, which is the only reason the comic timing below can be
 * asserted in a unit test rather than argued about from a screenshot.
 *
 * The treatment is the genre-standard one and it is standard because it works: the camera goes
 * OUTSIDE the car, black bars say cinema, the springs do the acting, and nothing whatsoever is
 * shown. The joke is entirely in the framing.
 *
 * The timing is the joke. A rock that starts at full amplitude is a vibrating car; a rock that never
 * stops is wallpaper. So it builds slowly, holds, STOPS DEAD for most of a second — the beat where
 * the player thinks it is over — and then resumes harder than it started, which is where the laugh
 * is. Every number below is in seconds from the moment the bars begin sliding in.
 */

/** Bars in and the crane out. Nothing moves on the car until the shot has arrived. */
export const SCENE_ROCK_START = 0.55;
/** The slow build tops out here. */
export const SCENE_BUILD_END = 2.6;
/** …and this is the beat where everything stops. */
export const SCENE_PAUSE_AT = 3.5;
/** The pause is a comic beat, not a bug: just under a second of a completely still car. */
export const SCENE_RESUME_AT = 4.4;
/** The second half is bigger than the first. It has to be, or the pause was for nothing. */
export const SCENE_RESUME_GAIN = 1.25;
/** The springs settle. */
export const SCENE_ROCK_END = 6.6;
/** Bars stay up over the settled car for a beat, then the card. Inside the 6-8s the brief asked for,
 *  and short enough that a player who has seen it twice is not held hostage by the third. */
export const SCENE_LENGTH = 7.2;

/** Peak pitch, in radians: 3° of nose-up. It reads clearly from ten metres and it is still a car on
 *  its springs rather than a boat in a storm. */
export const ROCK_PITCH = 0.052;
export const ROCK_ROLL = 0.034;
/** Peak lift in metres — barely a hand's width; suspension travel, not a hydraulic. */
export const ROCK_LIFT = 0.045;
export const ROCK_PITCH_HZ = 1.85;
/** Deliberately NOT a whole-number ratio of the pitch rate: the two beat against each other, so the
 *  motion never resolves into a visible loop over the seven seconds it is on screen. */
export const ROCK_ROLL_HZ = 1.27;

/** Where the lens sits, in metres from the car, and how high. Far enough to be tasteful, close
 *  enough that a 3° pitch still reads. */
export const SHOT_DISTANCE = 9.6;
export const SHOT_HEIGHT = 3.1;
/** ~139° off the bonnet: a three-quarter rear, which is the angle this joke has always been shot from. */
export const SHOT_ANGLE = 2.42;

const TURN = Math.PI * 2;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

function smoothstep(from: number, to: number, at: number): number {
  const x = clamp01((at - from) / (to - from));
  return x * x * (3 - 2 * x);
}

/**
 * The amplitude envelope: 0 while the camera is still moving, a slow build, a hold, the DEAD STOP,
 * then a bigger second half that settles to nothing. Peaks at SCENE_RESUME_GAIN, not at 1.
 */
export function rockEnvelope(t: number): number {
  if (t < SCENE_ROCK_START || t >= SCENE_ROCK_END) return 0;
  if (t < SCENE_PAUSE_AT) return smoothstep(SCENE_ROCK_START, SCENE_BUILD_END, t);
  if (t < SCENE_RESUME_AT) return 1 - smoothstep(SCENE_PAUSE_AT, SCENE_PAUSE_AT + 0.35, t);
  return SCENE_RESUME_GAIN
    * smoothstep(SCENE_RESUME_AT, SCENE_RESUME_AT + 0.4, t)
    * (1 - smoothstep(SCENE_ROCK_END - 0.7, SCENE_ROCK_END, t));
}

/**
 * The rock itself. `phase` is a stable 0..1 taken from the pickup kerb and the ride count — never
 * Math.random and never a wall clock, so the same ride replays identically and nothing here can
 * desync a save or a headless verification run.
 */
export function bodyRock(t: number, phase: number): { pitch: number; roll: number; lift: number } {
  const amp = rockEnvelope(t);
  if (amp <= 0) return { pitch: 0, roll: 0, lift: 0 };
  const swing = TURN * ROCK_PITCH_HZ * t + phase * TURN;
  return {
    pitch: Math.sin(swing) * ROCK_PITCH * amp,
    roll: Math.sin(TURN * ROCK_ROLL_HZ * t + phase * TURN * 1.7) * ROCK_ROLL * amp,
    // Lift never goes negative: a car sinking through the tar is a different film.
    lift: (1 - Math.cos(swing)) * 0.5 * ROCK_LIFT * amp,
  };
}

export interface ScenePoint { readonly x: number; readonly y: number; readonly z: number }

/**
 * The fixed exterior three-quarter. The side is chosen from the same stable phase, so two rides on
 * the same kerb are not the same shot, and it is chosen ONCE for the scene rather than per frame —
 * a camera that swaps sides halfway through is not a camera, it is a glitch.
 */
export function shortTimeShot(car: ScenePoint, heading: number, phase: number, groundY: number): { eye: ScenePoint; focus: ScenePoint } {
  const angle = heading + SHOT_ANGLE * (phase < 0.5 ? 1 : -1);
  return {
    eye: {
      x: car.x + Math.sin(angle) * SHOT_DISTANCE,
      // Above the higher of the tar under the lens and the tar under the car, so a kerb, a ramp or a
      // koppie between the two cannot put the camera underground.
      y: Math.max(groundY, car.y) + SHOT_HEIGHT,
      z: car.z + Math.cos(angle) * SHOT_DISTANCE,
    },
    focus: { x: car.x, y: car.y + 0.95, z: car.z },
  };
}
