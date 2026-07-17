/** Lightweight Verlet particle ragdoll for NPC deaths. Pure world-space simulation — no three.js
 *  objects, no allocation after construction — so it unit-tests without a GLB and costs nothing to
 *  freeze. RiggedPedestrianVisual seeds it from bone world positions and drives the skinned bones
 *  from the particle frame each step. */

/** World-space queries the ragdoll collides against. `heightAt` is the resting ground surface;
 *  `blockedAt` (optional) reports walls/props in the ground band for a coarse axis-separated slide. */
export interface RagdollEnvironment {
  heightAt(x: number, z: number): number;
  blockedAt?(x: number, z: number, radius: number): boolean;
}

/** One particle per major joint. Torso particles sit at bone origins; limb particles at the joint
 *  chain. Toes carry the ball-of-foot: without them the foot hangs past the ankle sphere and buries
 *  its toes in the road (the exact owner complaint on settled corpses). */
export const RAGDOLL_PARTICLES = {
  hips: 0, chest: 1, head: 2,
  shoulderL: 3, elbowL: 4, wristL: 5,
  shoulderR: 6, elbowR: 7, wristR: 8,
  hipL: 9, kneeL: 10, ankleL: 11,
  hipR: 12, kneeR: 13, ankleR: 14,
  toeL: 15, toeR: 16,
} as const;
export const RAGDOLL_PARTICLE_COUNT = 17;

export const RAGDOLL_TIMEOUT = 10; // owner call: hard stop — the body freezes wherever it is
export const RAGDOLL_STEP = 1 / 60;
/** At rest when no particle's end-of-step position moves more than this between consecutive steps
 *  (equilibrium sag inside a step doesn't count) for RAGDOLL_REST_STEPS steps in a row. */
export const RAGDOLL_REST_DISTANCE = 0.001;
export const RAGDOLL_REST_STEPS = 20;
const MAX_SUBSTEPS = 4; // a hitched frame slows the sim instead of exploding it
const GRAVITY = -20; // slightly heavy: a shot body should drop, not drift
const DAMPING = 0.015;
const GROUND_FRICTION = 0.65; // tangential velocity lost per grounded step — settles instead of ice-sliding
const SOLVER_ITERATIONS = 6;
const SPACER_FACTOR = 0.4; // a folded limb keeps at least this share of its full length end-to-end

/** Collision radius per particle — the local body thickness around the joint (ankles/wrists thin,
 *  hips/chest/head thick), so joints rest at ground+radius and the SKIN rests ON the surface.
 *  Calibrated against the shipped cast: settled skinned floor within ±0.05 of the ground. */
const RADII = new Float32Array([
  0.14, 0.15, 0.12,
  0.11, 0.08, 0.07,
  0.11, 0.08, 0.07,
  0.12, 0.10, 0.09,
  0.12, 0.10, 0.09,
  0.03, 0.03,
]);

const P = RAGDOLL_PARTICLES;
/** Rigid rods: skeleton edges plus a torso truss (widths, cross braces, spine chord) so the body
 *  keeps its shape instead of folding into spaghetti. Rest lengths come from the seeded pose. */
const RODS: ReadonlyArray<readonly [number, number]> = [
  [P.hips, P.chest], [P.chest, P.head], [P.hips, P.head],
  [P.chest, P.shoulderL], [P.chest, P.shoulderR], [P.shoulderL, P.shoulderR],
  [P.head, P.shoulderL], [P.head, P.shoulderR],
  [P.hips, P.hipL], [P.hips, P.hipR], [P.hipL, P.hipR],
  [P.shoulderL, P.hipL], [P.shoulderR, P.hipR], [P.shoulderL, P.hipR], [P.shoulderR, P.hipL],
  [P.chest, P.hipL], [P.chest, P.hipR],
  [P.shoulderL, P.elbowL], [P.elbowL, P.wristL], [P.shoulderR, P.elbowR], [P.elbowR, P.wristR],
  [P.hipL, P.kneeL], [P.kneeL, P.ankleL], [P.hipR, P.kneeR], [P.kneeR, P.ankleR],
  [P.ankleL, P.toeL], [P.kneeL, P.toeL], [P.ankleR, P.toeR], [P.kneeR, P.toeR], // rigid-ish feet: toes rest on the road, the shin brace keeps the foot from flopping through
];
/** Push-apart-only spacers [end, end, joint]: stop a limb folding fully through itself. */
const SPACERS: ReadonlyArray<readonly [number, number, number]> = [
  [P.shoulderL, P.wristL, P.elbowL], [P.shoulderR, P.wristR, P.elbowR],
  [P.hipL, P.ankleL, P.kneeL], [P.hipR, P.ankleR, P.kneeR],
];

/** One-sided hinge limits (owner call: limbs go limp, physics does the rest — these never steer
 *  toward a pose, they only stop knees/elbows bending grotesquely backwards). The bend side is the
 *  sign of (root→joint × joint→end)·bodyRightAxis; a wrong-way bend beyond the tolerance nudges the
 *  joint back toward the straight line, and the rods re-settle around it. */
const HINGES: ReadonlyArray<{ root: number; joint: number; end: number; axisA: number; axisB: number; sign: number }> = [
  { root: P.hipL, joint: P.kneeL, end: P.ankleL, axisA: P.hipL, axisB: P.hipR, sign: 1 },
  { root: P.hipR, joint: P.kneeR, end: P.ankleR, axisA: P.hipL, axisB: P.hipR, sign: 1 },
  { root: P.shoulderL, joint: P.elbowL, end: P.wristL, axisA: P.shoulderL, axisB: P.shoulderR, sign: -1 },
  { root: P.shoulderR, joint: P.elbowR, end: P.wristR, axisA: P.shoulderL, axisB: P.shoulderR, sign: -1 },
];
const HINGE_TOLERANCE = 0.15; // sin of the allowed wrong-way bend (~8.6°) — loose, per the owner
const HINGE_STRENGTH = 0.15; // metres of correction per unit violation per substep — soft, so it can't inject energy
const HINGE_MAX_STEP = 0.02;

/** How much of an impact kick each particle takes: the upper body whips away while the feet stay
 *  planted, so the corpse topples over its own legs instead of translating sideways. */
const KICK_WEIGHTS = new Float32Array([
  0.6, 1, 1,
  1, 0.85, 0.7,
  1, 0.85, 0.7,
  0.5, 0.25, 0.1,
  0.5, 0.25, 0.1,
  0.05, 0.05,
]);
const KICK_LIFT = new Float32Array([
  0.1, 0.25, 0.3,
  0.25, 0, 0,
  0.25, 0, 0,
  0, 0, 0,
  0, 0, 0,
  0, 0,
]);

/** Impact impulse from damage: a shoulder bump nudges (~3 m/s), a car hit or blast launches — capped
 *  so a point-blank shotgun doesn't fire the body across the street. */
export function impactKickSpeed(damage: number): number { return Math.min(9, 2 + damage * 0.09); }

export class VerletRagdoll {
  /** World-space particle positions, xyz-interleaved. Read-only outside the sim. */
  readonly positions: Float32Array;
  private readonly previous: Float32Array;
  private readonly settleReference: Float32Array;
  private readonly rodRest: Float32Array;
  private readonly spacerMin: Float32Array;
  private accumulator = 0;
  private stillSteps = 0;
  elapsed = 0;
  frozen = false;

  constructor(seed: ArrayLike<number>) {
    if (seed.length !== RAGDOLL_PARTICLE_COUNT * 3) throw new Error(`Ragdoll seed needs ${RAGDOLL_PARTICLE_COUNT * 3} floats, got ${seed.length}.`);
    this.positions = Float32Array.from(seed);
    this.previous = Float32Array.from(seed);
    this.settleReference = Float32Array.from(seed);
    this.rodRest = new Float32Array(RODS.length);
    for (let rod = 0; rod < RODS.length; rod++) this.rodRest[rod] = this.distance(RODS[rod][0], RODS[rod][1]);
    this.spacerMin = new Float32Array(SPACERS.length);
    for (let spacer = 0; spacer < SPACERS.length; spacer++) {
      const [a, b, joint] = SPACERS[spacer];
      this.spacerMin[spacer] = SPACER_FACTOR * (this.distance(a, joint) + this.distance(joint, b));
    }
  }

  private distance(a: number, b: number): number {
    const p = this.positions;
    return Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  }

  rodLength(index: number): number { return this.distance(RODS[index][0], RODS[index][1]); }
  rodRestLength(index: number): number { return this.rodRest[index]; }
  get rodCount(): number { return RODS.length; }

  /** Horizontal impact impulse, weighted heavy on the upper body so the corpse whips over its feet. */
  kick(directionX: number, directionZ: number, speed: number): void {
    const length = Math.hypot(directionX, directionZ);
    if (length < 1e-6 || speed <= 0) return;
    const dx = directionX / length; const dz = directionZ / length;
    for (let i = 0; i < RAGDOLL_PARTICLE_COUNT; i++) {
      const pace = speed * KICK_WEIGHTS[i] * RAGDOLL_STEP;
      this.previous[i * 3] -= dx * pace;
      this.previous[i * 3 + 1] -= speed * KICK_LIFT[i] * RAGDOLL_STEP;
      this.previous[i * 3 + 2] -= dz * pace;
    }
  }

  step(dt: number, env: RagdollEnvironment): void {
    if (this.frozen) return;
    this.accumulator = Math.min(this.accumulator + Math.max(0, dt), MAX_SUBSTEPS * RAGDOLL_STEP);
    while (!this.frozen && this.accumulator >= RAGDOLL_STEP - 1e-9) {
      this.accumulator -= RAGDOLL_STEP;
      this.substep(env);
    }
  }

  private substep(env: RagdollEnvironment): void {
    const p = this.positions; const q = this.previous;
    for (let i = 0; i < RAGDOLL_PARTICLE_COUNT; i++) {
      const ix = i * 3; const iy = ix + 1; const iz = ix + 2;
      const vx = (p[ix] - q[ix]) * (1 - DAMPING);
      const vy = (p[iy] - q[iy]) * (1 - DAMPING);
      const vz = (p[iz] - q[iz]) * (1 - DAMPING);
      q[ix] = p[ix]; q[iy] = p[iy]; q[iz] = p[iz];
      p[ix] += vx; p[iy] += vy + GRAVITY * RAGDOLL_STEP * RAGDOLL_STEP; p[iz] += vz;
    }
    for (let iteration = 0; iteration < SOLVER_ITERATIONS; iteration++) {
      for (let rod = 0; rod < RODS.length; rod++) this.solvePair(RODS[rod][0], RODS[rod][1], this.rodRest[rod], false);
      for (let spacer = 0; spacer < SPACERS.length; spacer++) this.solvePair(SPACERS[spacer][0], SPACERS[spacer][1], this.spacerMin[spacer], true);
    }
    for (let hinge = 0; hinge < HINGES.length; hinge++) this.limitHinge(hinge);
    for (let i = 0; i < RAGDOLL_PARTICLE_COUNT; i++) {
      const ix = i * 3; const iy = ix + 1; const iz = ix + 2;
      if (env.blockedAt) { // coarse wall slide: clamp each horizontal axis independently, like City.clampMove
        if (env.blockedAt(p[ix], q[iz], RADII[i])) { p[ix] = q[ix]; }
        if (env.blockedAt(p[ix], p[iz], RADII[i])) { p[iz] = q[iz]; }
      }
      const floor = env.heightAt(p[ix], p[iz]) + RADII[i];
      if (p[iy] < floor) {
        p[iy] = floor; q[iy] = floor; // inelastic landing
        q[ix] += (p[ix] - q[ix]) * GROUND_FRICTION;
        q[iz] += (p[iz] - q[iz]) * GROUND_FRICTION;
      }
    }
    // Rest detection compares end-of-step positions across steps, so the constant within-step
    // gravity sag (which the solver corrects) doesn't read as motion at equilibrium.
    const reference = this.settleReference; let maxSq = 0;
    for (let axis = 0; axis < p.length; axis++) {
      const moved = p[axis] - reference[axis];
      const sq = moved * moved;
      if (sq > maxSq) maxSq = sq;
      reference[axis] = p[axis];
    }
    this.stillSteps = maxSq < RAGDOLL_REST_DISTANCE * RAGDOLL_REST_DISTANCE ? this.stillSteps + 1 : 0;
    this.elapsed += RAGDOLL_STEP;
    if (this.stillSteps >= RAGDOLL_REST_STEPS || this.elapsed >= RAGDOLL_TIMEOUT) this.frozen = true;
  }

  /** Signed wrong-way bend of a hinge: positive means the joint is bent beyond straight to the
   *  anatomically impossible side, as the sin of the bend angle. Exposed for tests. */
  hingeViolation(index: number): number {
    const { root, joint, end, axisA, axisB, sign } = HINGES[index];
    const p = this.positions;
    let ax = p[axisB * 3] - p[axisA * 3]; let ay = p[axisB * 3 + 1] - p[axisA * 3 + 1]; let az = p[axisB * 3 + 2] - p[axisA * 3 + 2];
    const axisLength = Math.hypot(ax, ay, az);
    if (axisLength < 1e-6) return 0;
    ax /= axisLength; ay /= axisLength; az /= axisLength;
    const tx = p[joint * 3] - p[root * 3]; const ty = p[joint * 3 + 1] - p[root * 3 + 1]; const tz = p[joint * 3 + 2] - p[root * 3 + 2];
    const sx = p[end * 3] - p[joint * 3]; const sy = p[end * 3 + 1] - p[joint * 3 + 1]; const sz = p[end * 3 + 2] - p[joint * 3 + 2];
    const norm = Math.hypot(tx, ty, tz) * Math.hypot(sx, sy, sz);
    if (norm < 1e-6) return 0;
    const bend = (ty * sz - tz * sy) * ax + (tz * sx - tx * sz) * ay + (tx * sy - ty * sx) * az; // (T×S)·axis
    return -sign * bend / norm;
  }

  get hingeCount(): number { return HINGES.length; }

  private limitHinge(index: number): void {
    const violation = this.hingeViolation(index);
    if (violation <= HINGE_TOLERANCE) return;
    const { root, joint, end, axisA, axisB, sign } = HINGES[index];
    const p = this.positions;
    let ax = p[axisB * 3] - p[axisA * 3]; let ay = p[axisB * 3 + 1] - p[axisA * 3 + 1]; let az = p[axisB * 3 + 2] - p[axisA * 3 + 2];
    const axisLength = Math.hypot(ax, ay, az); if (axisLength < 1e-6) return;
    ax /= axisLength; ay /= axisLength; az /= axisLength;
    // Gradient of the bend measure w.r.t. the joint is (end−root)×axis: pushing the joint along it
    // (times `sign`) reduces the wrong-way bend without any target pose.
    const lx = p[end * 3] - p[root * 3]; const ly = p[end * 3 + 1] - p[root * 3 + 1]; const lz = p[end * 3 + 2] - p[root * 3 + 2];
    let gx = ly * az - lz * ay; let gy = lz * ax - lx * az; let gz = lx * ay - ly * ax;
    const gradientLength = Math.hypot(gx, gy, gz); if (gradientLength < 1e-6) return;
    const push = sign * Math.min(HINGE_MAX_STEP, (violation - HINGE_TOLERANCE) * HINGE_STRENGTH) / gradientLength;
    gx *= push; gy *= push; gz *= push;
    p[joint * 3] += gx; p[joint * 3 + 1] += gy; p[joint * 3 + 2] += gz;
  }

  private solvePair(a: number, b: number, rest: number, pushOnly: boolean): void {
    const p = this.positions;
    const ax = a * 3; const bx = b * 3;
    const dx = p[bx] - p[ax]; const dy = p[bx + 1] - p[ax + 1]; const dz = p[bx + 2] - p[ax + 2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6 || (pushOnly && dist >= rest)) return;
    const correction = (dist - rest) / dist * 0.5;
    p[ax] += dx * correction; p[ax + 1] += dy * correction; p[ax + 2] += dz * correction;
    p[bx] -= dx * correction; p[bx + 1] -= dy * correction; p[bx + 2] -= dz * correction;
  }
}
