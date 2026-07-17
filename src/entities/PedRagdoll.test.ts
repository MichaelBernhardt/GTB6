import { describe, expect, it } from 'vitest';
import {
  RAGDOLL_PARTICLES, RAGDOLL_PARTICLE_COUNT, RAGDOLL_REST_STEPS, RAGDOLL_STEP, RAGDOLL_TIMEOUT,
  VerletRagdoll, type RagdollEnvironment,
} from './PedRagdoll';

const P = RAGDOLL_PARTICLES;
const flat: RagdollEnvironment = { heightAt: () => 0 };

/** A plausible standing pose, feet just above ground — what a walk-cycle seed looks like. */
function standingSeed(): Float32Array {
  const seed = new Float32Array(RAGDOLL_PARTICLE_COUNT * 3);
  const set = (particle: number, x: number, y: number, z: number): void => { seed[particle * 3] = x; seed[particle * 3 + 1] = y; seed[particle * 3 + 2] = z; };
  set(P.hips, 0, 1.0, 0); set(P.chest, 0, 1.35, 0.02); set(P.head, 0, 1.62, 0.03);
  set(P.shoulderL, -0.2, 1.45, 0); set(P.elbowL, -0.24, 1.15, 0.05); set(P.wristL, -0.26, 0.88, 0.1);
  set(P.shoulderR, 0.2, 1.45, 0); set(P.elbowR, 0.24, 1.15, -0.05); set(P.wristR, 0.26, 0.88, -0.1);
  set(P.hipL, -0.1, 0.95, 0); set(P.kneeL, -0.1, 0.52, 0.06); set(P.ankleL, -0.1, 0.12, 0);
  set(P.hipR, 0.1, 0.95, 0); set(P.kneeR, 0.1, 0.52, -0.06); set(P.ankleR, 0.1, 0.12, 0.04);
  return seed;
}

const particleY = (body: VerletRagdoll, particle: number): number => body.positions[particle * 3 + 1];
const particleX = (body: VerletRagdoll, particle: number): number => body.positions[particle * 3];

function simulate(body: VerletRagdoll, env: RagdollEnvironment, seconds: number): void {
  const frames = Math.ceil(seconds * 60);
  for (let frame = 0; frame < frames && !body.frozen; frame++) body.step(1 / 60, env);
}

describe('VerletRagdoll', () => {
  it('falls, collapses and comes to rest on flat ground well before the hard timeout', () => {
    const body = new VerletRagdoll(standingSeed());
    body.kick(1, 0.2, 3);
    simulate(body, flat, RAGDOLL_TIMEOUT);
    expect(body.frozen).toBe(true);
    expect(body.elapsed).toBeLessThan(RAGDOLL_TIMEOUT); // genuine rest detection, not the timeout backstop
    expect(particleY(body, P.head)).toBeLessThan(0.6); // toppled, not frozen standing
    let lowest = Infinity;
    for (let particle = 0; particle < RAGDOLL_PARTICLE_COUNT; particle++) lowest = Math.min(lowest, particleY(body, particle));
    expect(lowest).toBeGreaterThan(-0.01); // never through the floor
    expect(lowest).toBeLessThan(0.15); // and resting on it, not hovering
  });

  it('keeps every skeleton rod within tolerance of its seeded length at rest', () => {
    const body = new VerletRagdoll(standingSeed());
    body.kick(0.3, -1, 4);
    simulate(body, flat, RAGDOLL_TIMEOUT);
    for (let rod = 0; rod < body.rodCount; rod++) {
      const rest = body.rodRestLength(rod);
      expect(Math.abs(body.rodLength(rod) - rest)).toBeLessThan(Math.max(0.01, rest * 0.05));
    }
  });

  it('kick topples the body away from the impact', () => {
    const body = new VerletRagdoll(standingSeed());
    body.kick(1, 0, 3.5);
    simulate(body, flat, RAGDOLL_TIMEOUT);
    expect(particleX(body, P.chest)).toBeGreaterThan(0.2); // upper body carried along +x
  });

  it('freezes at the hard timeout even while still moving', () => {
    const bottomless: RagdollEnvironment = { heightAt: () => -1000 };
    const body = new VerletRagdoll(standingSeed());
    simulate(body, bottomless, RAGDOLL_TIMEOUT + 2);
    expect(body.frozen).toBe(true);
    expect(body.elapsed).toBeGreaterThanOrEqual(RAGDOLL_TIMEOUT - RAGDOLL_STEP);
    expect(body.elapsed).toBeLessThanOrEqual(RAGDOLL_TIMEOUT + RAGDOLL_STEP);
  });

  it('spacer constraints stop a limb folding through itself', () => {
    const body = new VerletRagdoll(standingSeed());
    // Fold the left arm flat: wrist teleported onto the shoulder.
    body.positions[P.wristL * 3] = body.positions[P.shoulderL * 3];
    body.positions[P.wristL * 3 + 1] = body.positions[P.shoulderL * 3 + 1];
    body.positions[P.wristL * 3 + 2] = body.positions[P.shoulderL * 3 + 2];
    for (let frame = 0; frame < 10; frame++) body.step(1 / 60, flat);
    const dx = body.positions[P.wristL * 3] - body.positions[P.shoulderL * 3];
    const dy = body.positions[P.wristL * 3 + 1] - body.positions[P.shoulderL * 3 + 1];
    const dz = body.positions[P.wristL * 3 + 2] - body.positions[P.shoulderL * 3 + 2];
    expect(Math.hypot(dx, dy, dz)).toBeGreaterThan(0.15);
  });

  it('slides along walls instead of passing through them', () => {
    const walled: RagdollEnvironment = { heightAt: () => 0, blockedAt: (x) => x > 1 };
    const body = new VerletRagdoll(standingSeed());
    body.kick(1, 0, 8);
    simulate(body, walled, RAGDOLL_TIMEOUT);
    for (let particle = 0; particle < RAGDOLL_PARTICLE_COUNT; particle++) expect(particleX(body, particle)).toBeLessThanOrEqual(1.05);
  });

  it('one-sided hinge limits recover a grotesquely backward-bent knee without steering valid bends', () => {
    const body = new VerletRagdoll(standingSeed());
    // Hyperextend the left knee: ankle thrown far forward so the shin bends the wrong way.
    body.positions[P.ankleL * 3 + 2] = body.positions[P.kneeL * 3 + 2] + 0.4;
    body.positions[P.ankleL * 3 + 1] = body.positions[P.kneeL * 3 + 1];
    const before = body.hingeViolation(0);
    expect(before).toBeGreaterThan(0.3); // clearly wrong-way
    simulate(body, flat, RAGDOLL_TIMEOUT);
    for (let hinge = 0; hinge < body.hingeCount; hinge++) expect(body.hingeViolation(hinge)).toBeLessThan(0.25); // settled inside the loose limit
  });

  it('is deterministic for identical seeds and kicks', () => {
    const first = new VerletRagdoll(standingSeed()); const second = new VerletRagdoll(standingSeed());
    first.kick(0.7, -0.7, 3); second.kick(0.7, -0.7, 3);
    for (let frame = 0; frame < 120; frame++) { first.step(1 / 60, flat); second.step(1 / 60, flat); }
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
  });

  it('accumulates rest only over consecutive still steps', () => {
    const body = new VerletRagdoll(standingSeed());
    body.kick(1, 0, 3);
    simulate(body, flat, RAGDOLL_TIMEOUT);
    expect(body.frozen).toBe(true);
    expect(body.elapsed).toBeGreaterThan(RAGDOLL_REST_STEPS * RAGDOLL_STEP); // it fell first, then proved stillness
  });
});
