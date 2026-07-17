import { describe, expect, it } from 'vitest';
import { cumulativeArc, poseAt } from './TrainSystem';
import { cabAt, nearestArcOnSpan, stepAboard, stepDrive, stitchRailPaths, type AboardBounds, type DriveParams } from './TrainRide';

const LINE = [{ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 1000, z: 1000 }];
const CUM = cumulativeArc(LINE);
const sample = (s: number): { x: number; z: number } => poseAt(LINE, CUM, s);
const EAST = { dirX: 1, dirZ: 0 }; // +s runs +x on the first leg
const BOUNDS: AboardBounds = { length: 63, margin: 0.8, halfWidth: 1.05 };

describe('nearestArcOnSpan', () => {
  it('projects a point beside the span onto the closest arc position', () => {
    const near = nearestArcOnSpan(sample, 100, 163, 130, 3);
    expect(near.s).toBeCloseTo(130, 0);
    expect(near.dist).toBeCloseTo(3, 1);
  });

  it('clamps to the span ends for points beyond them', () => {
    expect(nearestArcOnSpan(sample, 100, 163, 400, 0).s).toBeCloseTo(163, 5);
    expect(nearestArcOnSpan(sample, 100, 163, 50, 0).s).toBeCloseTo(100, 5);
  });

  it('follows the polyline around a corner', () => {
    const near = nearestArcOnSpan(sample, 950, 1050, 1004, 10); // corner at s=1000; closest is on the +z leg
    expect(near.s).toBeCloseTo(1010, 0);
    expect(near.dist).toBeCloseTo(4, 1);
  });
});

describe('stepAboard', () => {
  it('walking toward +s moves the rider toward the nose (offset shrinks)', () => {
    // yaw 0: stick forward = world -z; rail dir -z means along = +1.
    const step = stepAboard({ s: 30, lateral: 0 }, 0, 1, 0, 8, 0.5, { dirX: 0, dirZ: -1 }, BOUNDS);
    expect(step.s).toBeCloseTo(26); expect(step.lateral).toBeCloseTo(0); expect(step.moving).toBe(true);
  });

  it('strafing accumulates lateral offset and clamps at the corridor wall', () => {
    // Rail runs +x; camera yaw -pi/2 looks along +x, so stick right (side=1) pushes world +z = -perp.
    let state = { s: 30, lateral: 0 };
    for (let i = 0; i < 40; i++) state = stepAboard(state, 1, 0, -Math.PI / 2, 8, 0.1, EAST, BOUNDS);
    expect(Math.abs(state.lateral)).toBeCloseTo(BOUNDS.halfWidth);
    expect(state.s).toBeCloseTo(30);
  });

  it('cannot walk out past the nose or the tail', () => {
    let state = { s: 2, lateral: 0 };
    for (let i = 0; i < 100; i++) state = stepAboard(state, 0, 1, Math.PI / 2, 8, 0.1, EAST, BOUNDS); // hold forward long past the corridor length, then reverse
    const pinned = state.s;
    expect(pinned === BOUNDS.margin || pinned === BOUNDS.length - BOUNDS.margin).toBe(true);
    for (let i = 0; i < 200; i++) state = stepAboard(state, 0, -1, Math.PI / 2, 8, 0.1, EAST, BOUNDS);
    expect(state.s === BOUNDS.margin || state.s === BOUNDS.length - BOUNDS.margin).toBe(true);
    expect(state.s).not.toBe(pinned);
  });

  it('standing still reports not moving and holds position', () => {
    const step = stepAboard({ s: 30, lateral: 0.4 }, 0, 0, 1.3, 8, 0.5, EAST, BOUNDS);
    expect(step).toMatchObject({ s: 30, lateral: 0.4, moving: false });
  });

  it('reports the world heading of travel', () => {
    const step = stepAboard({ s: 30, lateral: 0 }, 0, 1, 0, 8, 0.1, EAST, BOUNDS);
    expect(step.heading).toBeCloseTo(Math.atan2(0, -1)); // stick forward at yaw 0 walks world -z
  });
});

describe('cabAt', () => {
  it('flags the nose cab, tail cab, and the aisle between', () => {
    expect(cabAt(1, 63, 3)).toBe(1);
    expect(cabAt(61, 63, 3)).toBe(-1);
    expect(cabAt(30, 63, 3)).toBe(0);
  });
});

describe('stepDrive', () => {
  const P: DriveParams = { minS: 63, maxS: 2000, maxSpeed: 26, accel: 1.6, brake: 3.4, coast: 0.5 };
  const run = (state: { s: number; v: number }, throttle: number, cabSign: 1 | -1, seconds: number): { s: number; v: number } => {
    for (let i = 0; i < seconds * 30; i++) state = stepDrive(state, throttle, cabSign, 1 / 30, P);
    return state;
  };

  it('throttles up to max speed toward the cab facing', () => {
    const state = run({ s: 500, v: 0 }, 1, 1, 30);
    expect(state.v).toBeCloseTo(P.maxSpeed, 5);
    expect(state.s).toBeGreaterThan(500);
  });

  it('drives the other way from the tail cab', () => {
    const state = run({ s: 500, v: 0 }, 1, -1, 10);
    expect(state.v).toBeLessThan(0);
    expect(state.s).toBeLessThan(500);
  });

  it('brakes harder than it accelerates, then reverses', () => {
    let state = run({ s: 500, v: 0 }, 1, 1, 5); // v = 8 after 5 s at 1.6
    const cruise = state.v;
    state = run(state, -1, 1, 2); // braking at 3.4 sheds 6.8 in 2 s
    expect(state.v).toBeCloseTo(cruise - 6.8, 1);
    state = run(state, -1, 1, 10);
    expect(state.v).toBeLessThan(0); // held brake becomes reverse
  });

  it('clamps at the line ends and kills the speed there', () => {
    const state = run({ s: 1990, v: 20 }, 1, 1, 10);
    expect(state.s).toBe(P.maxS);
    expect(state.v).toBe(0);
  });

  it('coasts down to a stop with no input', () => {
    const state = run({ s: 500, v: 3 }, 0, 1, 30);
    expect(state.v).toBeCloseTo(0, 5);
  });
});

describe('stitchRailPaths (junction coupling)', () => {
  const P = (x: number, z: number) => ({ x, z });

  it('joins two lines sharing an exact endpoint into one, deduping the joint vertex', () => {
    // The real case: the airport spur STARTS at the Main Line's start vertex.
    const spur = [P(-4659.3, 6113.6), P(-5079.1, 5917.9), P(-5826, 5571)];
    const main = [P(-4659.3, 6113.6), P(-2362.4, 6700.2), P(7780, 7000)];
    const out = stitchRailPaths([spur, main]);
    expect(out).toHaveLength(1);
    const line = out[0]!;
    expect(line.length).toBe(5); // 3 + 3 minus the duplicated joint
    // Continuous: no zero-length or near-zero segment anywhere.
    for (let i = 1; i < line.length; i++) expect(Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.z - line[i - 1]!.z)).toBeGreaterThan(0.5);
    // Ends are the airport halt and the far east end.
    const ends = [line[0]!, line[line.length - 1]!].map((p) => `${Math.round(p.x)}`).sort();
    expect(ends).toEqual(['-5826', '7780']);
  });

  it('bridges a small gap (within tolerance) with an ordinary segment', () => {
    const a = [P(0, 0), P(100, 0)];
    const b = [P(104, 0), P(200, 0)]; // 4 u discontinuity
    const out = stitchRailPaths([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(4); // gap kept as a real (short) segment, nothing deduped
  });

  it('leaves genuinely separate lines and mid-line branches alone', () => {
    const main = [P(0, 0), P(500, 0), P(1000, 0)];
    const branch = [P(500, 0), P(500, 400)]; // meets the MIDDLE of main: a switch, not a coupler
    const far = [P(0, 3000), P(1000, 3000)];
    const out = stitchRailPaths([main, branch, far]);
    expect(out).toHaveLength(3); // the branch touches main's MIDDLE vertex — that's a switch, not an end joint
  });

  it('reverses as needed for tail-to-tail and head-to-head joins', () => {
    const a = [P(0, 0), P(100, 0)];
    const b = [P(300, 0), P(100, 0)]; // b's TAIL meets a's tail
    const out = stitchRailPaths([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0]!.map((p) => p.x)).toEqual([0, 100, 300]);
  });
});
