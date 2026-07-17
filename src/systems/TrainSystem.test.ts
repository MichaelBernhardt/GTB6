import { describe, expect, it } from 'vitest';
import { advanceShuttle, cumulativeArc, formatCountdown, nearestArc, nextStop, poseAt, type ShuttleParams, type ShuttleState } from './TrainSystem';

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

describe('station stops', () => {
  const STOPPING: ShuttleParams = { ...PARAMS, stops: [700, 1400] };
  const run = (state: ShuttleState, seconds: number): ShuttleState => {
    for (let i = 0; i < seconds * 30; i++) state = advanceShuttle(state, 1 / 30, STOPPING);
    return state;
  };

  it('picks the next stop ahead in the travel direction, else the terminus', () => {
    expect(nextStop(30, 1, STOPPING)).toBe(700);
    expect(nextStop(700, 1, STOPPING)).toBe(1400); // a platform just served does not re-arrest the train
    expect(nextStop(1500, 1, STOPPING)).toBe(PARAMS.lineLength);
    expect(nextStop(1500, -1, STOPPING)).toBe(1400);
    expect(nextStop(700, -1, STOPPING)).toBe(PARAMS.trainLength);
    expect(nextStop(1000, 1, PARAMS)).toBe(PARAMS.lineLength); // no stops: plain end-to-end shuttle
  });

  it('brakes into an intermediate station, dwells, then continues the SAME way', () => {
    let state: ShuttleState = { s: 30, direction: 1, dwell: 0, speed: 0 };
    for (let i = 0; i < 30 * 400 && !(state.dwell > 0); i++) state = advanceShuttle(state, 1 / 30, STOPPING);
    expect(state.s).toBe(700); // first station, not the terminus
    expect(state.speed).toBe(0);
    expect(state.dwell).toBe(PARAMS.dwellTime);
    state = run(state, PARAMS.dwellTime + 1);
    expect(state.direction).toBe(1); // doors closed, still heading up the line
    expect(state.s).toBeGreaterThan(700);
  });

  it('serves every stop in order, both ways, and still reverses only at the ends', () => {
    let state: ShuttleState = { s: 30, direction: 1, dwell: 0, speed: 0 };
    const halts: Array<{ s: number; direction: number }> = [];
    for (let i = 0; i < 30 * 1200 && halts.length < 6; i++) {
      const before = state.dwell;
      state = advanceShuttle(state, 1 / 30, STOPPING);
      if (state.dwell > 0 && before <= 0) halts.push({ s: state.s, direction: state.direction });
    }
    expect(halts.map((halt) => halt.s)).toEqual([700, 1400, 2000, 1400, 700, 30]);
    expect(halts[2]!.direction).toBe(1); // arrives at the far end still pointing up; reversal happens after the dwell
  });

  it('never overshoots a stop even arriving at cruise speed', () => {
    let state: ShuttleState = { s: 30, direction: 1, dwell: 0, speed: PARAMS.maxSpeed };
    for (let i = 0; i < 30 * 120 && !(state.dwell > 0); i++) {
      state = advanceShuttle(state, 1 / 30, STOPPING);
      expect(state.s).toBeLessThanOrEqual(700);
    }
    expect(state.s).toBe(700);
  });
});

describe('rider-facing helpers', () => {
  it('finds the arc position nearest a world point (station → stop mapping)', () => {
    const cum = cumulativeArc(LINE);
    expect(nearestArc(LINE, cum, 500, 60)).toBeCloseTo(500, 5);
    expect(nearestArc(LINE, cum, 1080, 400)).toBeCloseTo(1400, 5); // beside the second leg
    expect(nearestArc(LINE, cum, -50, -50)).toBe(0); // clamped at the start
  });

  it('formats the departs-in countdown as m:ss (ceil, never a dead 0:00 while dwelling)', () => {
    expect(formatCountdown(27)).toBe('0:27');
    expect(formatCountdown(26.2)).toBe('0:27');
    expect(formatCountdown(89.5)).toBe('1:30');
    expect(formatCountdown(0.4)).toBe('0:01');
    expect(formatCountdown(-1)).toBe('0:00');
  });
});
