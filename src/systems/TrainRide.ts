/**
 * Pure math for riding and driving a passenger train (see TrainSystem for the scene side).
 *
 * A rider aboard a consist is a point in "corridor space": arc-length offset back from the
 * train NOSE (0 = nose, trainLength = tail) plus a signed lateral offset off the track
 * centreline. Composing that with the line pose every frame gives moving-platform physics
 * for free — the world position is always `pose(noseS - s) + perp · lateral`.
 */

export interface RailDir { dirX: number; dirZ: number }

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));

/** Closest arc position to (px, pz) within [sMin, sMax]: coarse 1u walk, then a 0.1u refine. */
export function nearestArcOnSpan(sample: (s: number) => { x: number; z: number }, sMin: number, sMax: number, px: number, pz: number): { s: number; dist: number } {
  let bestS = sMin; let bestD = Infinity;
  const scan = (from: number, to: number, step: number): void => {
    for (let s = from; s <= to + 1e-6; s += step) {
      const at = Math.min(s, to); const p = sample(at); const d = Math.hypot(p.x - px, p.z - pz);
      if (d < bestD) { bestD = d; bestS = at; }
    }
  };
  scan(sMin, sMax, 1);
  scan(Math.max(sMin, bestS - 1), Math.min(sMax, bestS + 1), 0.1);
  return { s: bestS, dist: bestD };
}

export interface AboardState { s: number; lateral: number }
export interface AboardBounds { length: number; margin: number; halfWidth: number }

/**
 * Walk the corridor: camera-relative WASD is rotated into the world (same convention as
 * Player.update), projected onto the local rail direction (along) and its perpendicular
 * (lateral), then integrated and clamped to the corridor volume. Moving toward +s DECREASES
 * the offset-from-nose. Returns the walk heading so the rig can face the travel direction.
 */
export function stepAboard(state: AboardState, side: number, forward: number, yaw: number, speed: number, dt: number, dir: RailDir, bounds: AboardBounds): AboardState & { moving: boolean; heading: number } {
  if (!side && !forward) return { ...state, moving: false, heading: 0 };
  const len = Math.hypot(side, forward);
  const px = side / len; const pz = -forward / len; // pre-rotation stick vector (x right, -z forward)
  const mx = px * Math.cos(yaw) + pz * Math.sin(yaw);
  const mz = -px * Math.sin(yaw) + pz * Math.cos(yaw);
  const along = mx * dir.dirX + mz * dir.dirZ;
  const lateral = mx * dir.dirZ - mz * dir.dirX; // perp = up × dir = (dirZ, -dirX)
  return {
    s: clamp(state.s - along * speed * dt, bounds.margin, bounds.length - bounds.margin),
    lateral: clamp(state.lateral + lateral * speed * dt, -bounds.halfWidth, bounds.halfWidth),
    moving: true, heading: Math.atan2(mx, mz),
  };
}

/** Which cab the offset-from-nose sits in: 1 = nose cab (faces +s), -1 = tail cab, 0 = the aisle. */
export function cabAt(s: number, trainLength: number, zone: number): 1 | -1 | 0 {
  return s <= zone ? 1 : s >= trainLength - zone ? -1 : 0;
}

export interface DriveState { s: number; v: number }
export interface DriveParams { minS: number; maxS: number; maxSpeed: number; accel: number; brake: number; coast: number }

/**
 * Player-driven step: throttle +1 (W) accelerates toward the direction the occupied cab faces
 * (cabSign in +s terms), -1 (S) brakes — harder than it accelerates — and then reverses; no
 * input coasts gently down. The nose stays in [minS, maxS] and hitting a line end kills the speed.
 */
export function stepDrive(state: DriveState, throttle: number, cabSign: 1 | -1, dt: number, p: DriveParams): DriveState {
  const want = Math.sign(throttle) * cabSign;
  let v = state.v;
  if (want > 0) v = Math.min(p.maxSpeed, v + (v < 0 ? p.brake : p.accel) * dt);
  else if (want < 0) v = Math.max(-p.maxSpeed, v - (v > 0 ? p.brake : p.accel) * dt);
  else v -= Math.sign(v) * Math.min(Math.abs(v), p.coast * dt);
  let s = state.s + v * dt;
  if (s <= p.minS) { s = p.minS; if (v < 0) v = 0; }
  if (s >= p.maxS) { s = p.maxS; if (v > 0) v = 0; }
  return { s, v };
}
