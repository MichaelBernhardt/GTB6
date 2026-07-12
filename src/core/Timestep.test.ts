import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYER } from '../config';
import type { InputManager } from './InputManager';
import type { City } from '../world/City';
import { Player } from '../entities/Player';
import { maxCatchupSteps, SIM_CATCHUP_BUDGET_MS, SIM_CATCHUP_STEPS, SIM_STEP_MAX, simSteps } from './Timestep';

// Player's rig loads jacket/denim textures through THREE.TextureLoader, which needs a DOM
// image element even in the node test environment; a create-only stub keeps the loader inert.
(globalThis as { document?: unknown }).document = {
  createElementNS: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
};

const walkInput = (sprint = false): InputManager => ({
  aiming: false, firing: false, firePressed: false,
  down: (code: string) => code === 'KeyW' || (sprint && code === 'ShiftLeft'),
  consume: () => false,
} as unknown as InputManager);

const openCity = {
  clampMoveAt: (_from: THREE.Vector3, to: THREE.Vector3) => to.clone(),
  supportHeight: () => 0, surfaceHeightAt: () => 0,
} as unknown as City;

/** Mirrors City.clampMoveAt's axis-separated wall clamp against a thin wall slab spanning z ∈ [-0.4, 0]:
 *  a desired position whose capsule overlaps the slab keeps that axis at `from` — but a step long enough
 *  to land entirely BEYOND the slab sails through, exactly the tunneling mode big deltas cause in game. */
const thinWallCity = {
  clampMoveAt: (from: THREE.Vector3, to: THREE.Vector3, radius: number) => {
    const output = to.clone();
    const blocked = (z: number) => z > -0.4 - radius && z < 0 + radius;
    if (blocked(output.z)) output.z = from.z;
    return output;
  },
  supportHeight: () => 0, surfaceHeightAt: () => 0,
} as unknown as City;

describe('simSteps slicing', () => {
  it('passes a healthy frame through as a single unclamped step', () => {
    expect(simSteps(1 / 60)).toEqual([1 / 60]);
    expect(simSteps(1 / 30)).toEqual([1 / 30]);
  });

  it('preserves real elapsed time below 20fps instead of clamping to 50ms', () => {
    for (const raw of [1 / 15, 1 / 10, 1 / 6]) expect(simSteps(raw).reduce((a, b) => a + b, 0)).toBeCloseTo(raw, 12);
  });

  it('never emits a step coarser than the physics-stable clamp', () => {
    for (let raw = 0.001; raw < 3; raw += 0.0137) for (const step of simSteps(raw)) expect(step).toBeLessThanOrEqual(SIM_STEP_MAX + 1e-12);
  });

  it('caps a monster hitch at the catch-up ceiling and drops the surplus', () => {
    const steps = simSteps(2.5); // tab restore
    expect(steps).toHaveLength(SIM_CATCHUP_STEPS);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(SIM_STEP_MAX * SIM_CATCHUP_STEPS, 12);
  });

  it('yields nothing for a zero or negative delta', () => {
    expect(simSteps(0)).toEqual([]);
    expect(simSteps(-0.01)).toEqual([]);
  });
});

describe('maxCatchupSteps catch-up budget (death-spiral guard)', () => {
  it('grants the full ceiling before any step has been measured', () => {
    expect(maxCatchupSteps(0)).toBe(SIM_CATCHUP_STEPS);
    expect(maxCatchupSteps(-1)).toBe(SIM_CATCHUP_STEPS);
  });

  it('lets a cheap step take the full ceiling but never more', () => {
    expect(maxCatchupSteps(1)).toBe(SIM_CATCHUP_STEPS); // 1ms step: budget fits far more than the ceiling
    expect(maxCatchupSteps(SIM_CATCHUP_BUDGET_MS / SIM_CATCHUP_STEPS)).toBe(SIM_CATCHUP_STEPS);
  });

  it('clamps toward a single step as the step cost approaches the whole budget', () => {
    expect(maxCatchupSteps(SIM_CATCHUP_BUDGET_MS / 2 + 1)).toBe(1); // two would overrun the budget
    expect(maxCatchupSteps(SIM_CATCHUP_BUDGET_MS)).toBe(1);
    expect(maxCatchupSteps(SIM_CATCHUP_BUDGET_MS * 4)).toBe(1); // never returns 0: the world must always advance
  });

  it('scales the allowance down monotonically as steps get more expensive', () => {
    const costs = [2, 8, 15, 25, 40, 80];
    const allowances = costs.map(maxCatchupSteps);
    for (let i = 1; i < allowances.length; i++) expect(allowances[i]).toBeLessThanOrEqual(allowances[i - 1]!);
    expect(Math.max(...allowances)).toBeLessThanOrEqual(SIM_CATCHUP_STEPS);
    expect(Math.min(...allowances)).toBeGreaterThanOrEqual(1);
  });
});

describe('real-time speed under low frame rates', () => {
  /** One simulated second of walking at a given frame rate, stepping the Player exactly as Game.animate does. */
  const walkedDistance = (fps: number): number => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, 0, 0));
    for (let frame = 0; frame < fps; frame++) for (const dt of simSteps(1 / fps)) player.update(dt, walkInput(), 0, openCity);
    return Math.abs(player.group.position.z);
  };

  it('walks the same real-world distance per second at 15fps and 10fps as at 60fps', () => {
    const at60 = walkedDistance(60);
    expect(at60).toBeCloseTo(PLAYER.walkSpeed, 5); // sanity: one second of walking covers walkSpeed units
    expect(walkedDistance(15)).toBeCloseTo(at60, 5);
    expect(walkedDistance(10)).toBeCloseTo(at60, 5);
  });
});

describe('hitch stability', () => {
  it('a single huge frame delta does not tunnel a sprinting player through a thin wall', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, 0, 3));
    for (const dt of simSteps(0.75)) player.update(dt, walkInput(true), 0, thinWallCity); // one 0.75s hitch, sliced
    expect(player.group.position.z).toBeGreaterThan(0); // stopped on the near side of the slab
  });

  it('control: the same hitch fed as one raw step would tunnel — the slicing is load-bearing', () => {
    const player = new Player(new THREE.Scene(), new THREE.Vector3(0, 0, 3));
    player.update(0.75, walkInput(true), 0, thinWallCity); // what the old `min(raw, 0.05)` clamp existed to prevent
    expect(player.group.position.z).toBeLessThan(-0.4); // sails clean past the slab
  });
});
