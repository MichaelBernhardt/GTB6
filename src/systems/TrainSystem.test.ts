import { describe, expect, it } from 'vitest';
import { advanceShuttle, cumulativeArc, poseAt, type ShuttleParams, type ShuttleState } from './TrainSystem';

const LINE = [{ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 1000, z: 1000 }];
const PARAMS: ShuttleParams = { lineLength: 2000, trainLength: 30, maxSpeed: 20, accel: 1.5, dwellTime: 10 };

describe('rail path math', () => {
  it('accumulates arc length along vertices', () => {
    expect(cumulativeArc(LINE)).toEqual([0, 1000, 2000]);
  });

  it('interpolates pose along and around the corner', () => {
    const cum = cumulativeArc(LINE);
    expect(poseAt(LINE, cum, 500)).toMatchObject({ x: 500, z: 0, dirX: 1, dirZ: 0 });
    expect(poseAt(LINE, cum, 1500)).toMatchObject({ x: 1000, z: 500, dirX: 0, dirZ: 1 });
    expect(poseAt(LINE, cum, 99999)).toMatchObject({ x: 1000, z: 1000 }); // clamped at the terminus
    expect(poseAt(LINE, cum, -5)).toMatchObject({ x: 0, z: 0 });
  });
});

describe('shuttle scheduler', () => {
  const run = (state: ShuttleState, seconds: number): ShuttleState => {
    for (let i = 0; i < seconds * 30; i++) state = advanceShuttle(state, 1 / 30, PARAMS);
    return state;
  };

  it('accelerates out, cruises at max speed, and never overshoots the far terminus', () => {
    let state: ShuttleState = { s: 30, direction: 1, dwell: 0, speed: 0 };
    state = run(state, 20);
    expect(state.speed).toBeCloseTo(20, 0); // cruising mid-line
    state = run(state, 300);
    expect(state.s).toBeLessThanOrEqual(PARAMS.lineLength);
    expect(state.s).toBeGreaterThanOrEqual(PARAMS.trainLength);
  });

  it('brakes into the terminus, dwells, then departs the other way', () => {
    let state: ShuttleState = { s: 30, direction: 1, dwell: 0, speed: 0 };
    // Run until arrival (generous bound), then confirm the dwell-reverse cycle.
    for (let i = 0; i < 30 * 400 && !(state.s === PARAMS.lineLength && state.dwell > 0); i++) {
      state = advanceShuttle(state, 1 / 30, PARAMS);
    }
    expect(state.s).toBe(PARAMS.lineLength);
    expect(state.dwell).toBeGreaterThan(0);
    expect(state.speed).toBe(0);
    state = run(state, PARAMS.dwellTime + 1);
    expect(state.direction).toBe(-1);
    expect(state.s).toBeLessThan(PARAMS.lineLength); // rolling home
  });

  it('keeps the whole consist on the rails at the near terminus', () => {
    let state: ShuttleState = { s: 500, direction: -1, dwell: 0, speed: 12 };
    for (let i = 0; i < 30 * 400 && !(state.dwell > 0); i++) state = advanceShuttle(state, 1 / 30, PARAMS);
    expect(state.s).toBe(PARAMS.trainLength); // the nose stops a train-length up the line
  });
});
