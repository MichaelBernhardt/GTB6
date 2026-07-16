import { describe, expect, it } from 'vitest';
import {
  createPlaneState, PLANE_CEILING, PLANE_EXIT_SPEED, PLANE_MAX_SPEED, PLANE_ROTATE_SPEED, PLANE_STALL_SPEED,
  planeCrashDamage, planeHint, SAFE_LANDING_SINK, stepPlane, type PlaneState, type PlaneStick,
} from './FlightSystem';

const DT = 1 / 60;

/** Flies `seconds` at 60fps over flat ground at `support`; returns the final altitude and the last step. */
function fly(state: PlaneState, stick: PlaneStick, seconds: number, y: number, support = 0) {
  let step = stepPlane(state, stick, DT, y, support);
  for (let tick = 1; tick < Math.round(seconds / DT); tick++) step = stepPlane(state, stick, DT, step.y, support);
  return step;
}

/** Full-throttle takeoff to a sane cruise: rolls, rotates, climbs to roughly `until` altitude. */
function takeoff(until = 120): PlaneState {
  const state = createPlaneState(0);
  fly(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, 8, 0); // ground roll to speed
  expect(state.grounded).toBe(true);
  let step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 1 }, DT, 0, 0);
  for (let tick = 0; tick < 60 * 60 && step.y < until; tick++) step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 1 }, DT, step.y, 0);
  expect(state.grounded).toBe(false);
  expect(step.y).toBeGreaterThanOrEqual(until);
  // settle level at cruise
  for (let tick = 0; tick < 120; tick++) step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, DT, step.y, 0);
  return state;
}

describe('ground roll', () => {
  it('throttle winds up and the roll accelerates, staying on the tar without a pull-up', () => {
    const state = createPlaneState(0);
    const step = fly(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, 10, 0);
    expect(state.throttle).toBe(1);
    expect(state.speed).toBeGreaterThan(PLANE_ROTATE_SPEED);
    expect(state.grounded).toBe(true);
    expect(step.y).toBe(0);
    expect(step.dz).toBeGreaterThan(0); // heading 0 rolls along +z
  });

  it('steers on the nosewheel with the rudder (A/D), not the ailerons', () => {
    const state = createPlaneState(0);
    fly(state, { throttle: 1, roll: 0, rudder: 1, pitch: 0 }, 4, 0);
    expect(state.heading).toBeGreaterThan(0.3); // A turns left, same sign convention as the cars
    const ailerons = createPlaneState(0);
    fly(ailerons, { throttle: 1, roll: 1, rudder: 0, pitch: 0 }, 4, 0);
    expect(Math.abs(ailerons.heading)).toBeLessThan(0.02); // ←/→ do nothing on the tar
  });

  it('yaws flat on airborne rudder — slower than a committed bank', () => {
    const banked = takeoff(); const flat = takeoff();
    const bankedStart = banked.heading; const flatStart = flat.heading;
    for (let tick = 0; tick < 120; tick++) stepPlane(banked, { throttle: 1, roll: 1, rudder: 0, pitch: 0 }, DT, 200, 0);
    for (let tick = 0; tick < 120; tick++) stepPlane(flat, { throttle: 1, roll: 0, rudder: 1, pitch: 0 }, DT, 200, 0);
    expect(flat.heading - flatStart).toBeGreaterThan(0.05); // the rudder does yaw the nose…
    expect(flat.heading - flatStart).toBeLessThan(banked.heading - bankedStart); // …but the bank owns the turn
    expect(Math.abs(flat.roll)).toBeLessThan(0.05); // and the wings stay level doing it
  });

  it('will not rotate below flying speed', () => {
    const state = createPlaneState(0);
    fly(state, { throttle: 0.001, roll: 0, rudder: 0, pitch: 1 }, 2, 0);
    state.speed = PLANE_ROTATE_SPEED - 5;
    stepPlane(state, { throttle: 0, roll: 0, rudder: 0, pitch: 1 }, DT, 0, 0);
    expect(state.grounded).toBe(true);
  });

  it('brakes to a stop with S at idle throttle', () => {
    const state = createPlaneState(0);
    state.speed = 20;
    fly(state, { throttle: -1, roll: 0, rudder: 0, pitch: 0 }, 4, 0);
    expect(state.speed).toBe(0);
  });
});

describe('takeoff and cruise', () => {
  it('rotates above flying speed and climbs away', () => {
    const state = takeoff();
    expect(state.grounded).toBe(false);
    expect(state.speed).toBeGreaterThan(PLANE_STALL_SPEED);
  });

  it('auto-levels hands-off: pitch trims back near zero and altitude holds', () => {
    const state = takeoff();
    let step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, DT, 300, 0);
    for (let tick = 0; tick < 300; tick++) step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, DT, step.y, 0);
    expect(Math.abs(state.pitch)).toBeLessThan(0.03);
    const before = step.y;
    for (let tick = 0; tick < 300; tick++) step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, DT, step.y, 0);
    expect(Math.abs(step.y - before)).toBeLessThan(12); // near-level cruise over five seconds
  });

  it('banks into a turn and rolls back level when the stick is released', () => {
    const state = takeoff();
    const before = state.heading;
    fly(state, { throttle: 1, roll: 1, rudder: 0, pitch: 0 }, 3, 300);
    expect(state.roll).toBeGreaterThan(0.5);
    expect(state.heading).toBeGreaterThan(before + 0.8);
    fly(state, { throttle: 1, roll: 0, rudder: 0, pitch: 0 }, 3, 300);
    expect(Math.abs(state.roll)).toBeLessThan(0.05);
  });

  it('tops out at the ceiling: a held climb cannot punch far past it', () => {
    const state = takeoff();
    let step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 1 }, DT, 550, 0);
    let peak = step.y;
    for (let tick = 0; tick < 60 * 40; tick++) { step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: 1 }, DT, step.y, 0); peak = Math.max(peak, step.y); }
    expect(peak).toBeLessThan(PLANE_CEILING + 60);
  });
});

describe('stall', () => {
  it('closing the throttle bleeds airspeed until the plane stalls and comes down', () => {
    const state = takeoff();
    const cut: PlaneStick = { throttle: -1, roll: 0, rudder: 0, pitch: 0 };
    let step = stepPlane(state, cut, DT, 400, 0);
    let stalled = false;
    for (let tick = 0; tick < 60 * 120 && !step.landed; tick++) { step = stepPlane(state, cut, DT, step.y, 0); stalled ||= state.speed < PLANE_STALL_SPEED; }
    expect(state.throttle).toBe(0);
    expect(stalled).toBe(true); // it ran out of airspeed on the way…
    expect(step.landed).toBe(true); // …and it came down
  });

  it('holding the stick back cannot out-muscle a deep stall', () => {
    const state = takeoff();
    state.speed = 8; state.throttle = 0; // engine at idle, well below flying speed
    fly(state, { throttle: 0, roll: 0, rudder: 0, pitch: 1 }, 3, 400);
    expect(state.pitch).toBeLessThan(0); // the mush wins
  });
});

describe('landing', () => {
  it('a slow, shallow touchdown rolls out instead of wrecking', () => {
    const state = takeoff();
    state.pitch = -0.06; state.speed = 34; state.roll = 0;
    let step = stepPlane(state, { throttle: 0.4, roll: 0, rudder: 0, pitch: 0 }, DT, 6, 0);
    for (let tick = 0; tick < 60 * 20 && !step.landed; tick++) step = stepPlane(state, { throttle: 0.4, roll: 0, rudder: 0, pitch: -0.06 < state.pitch ? -0.2 : 0 }, DT, step.y, 0);
    expect(step.landed).toBe(true);
    expect(step.crashed).toBe(false);
    expect(state.grounded).toBe(true);
  });

  it('a steep dive into the ground is a crash', () => {
    const state = takeoff();
    state.pitch = -0.55; state.speed = 60;
    const step = stepPlane(state, { throttle: 1, roll: 0, rudder: 0, pitch: -1 }, DT, 0.4, 0);
    expect(step.landed).toBe(true);
    expect(step.crashed).toBe(true);
    expect(step.sink).toBeGreaterThan(SAFE_LANDING_SINK);
  });

  it('crash damage scales with sink and speed', () => {
    expect(planeCrashDamage(0, 20)).toBeLessThan(planeCrashDamage(30, 20));
    expect(planeCrashDamage(10, 10)).toBeLessThan(planeCrashDamage(10, PLANE_MAX_SPEED));
    expect(planeCrashDamage(30, 60)).toBeGreaterThan(100); // a full stall-in is lethal
  });
});

describe('hints', () => {
  it('tracks the flight phase', () => {
    const state = createPlaneState(0);
    expect(planeHint(state)).toContain('Climb out');
    state.speed = PLANE_EXIT_SPEED + 4;
    expect(planeHint(state)).toContain('Brake');
    state.speed = PLANE_ROTATE_SPEED;
    expect(planeHint(state)).toContain('Pull up');
    state.grounded = false;
    expect(planeHint(state)).toContain('Bail out');
  });
});
