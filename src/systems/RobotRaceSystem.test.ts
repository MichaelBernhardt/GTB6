import { describe, expect, it } from 'vitest';
import {
  buildRobotCircuit, racePace, raceTier, ROBOT_RACE_CLEAN_BONUS, ROBOT_RACE_GOLD_SECONDS,
  ROBOT_RACE_REWARDS, ROBOT_RACE_SILVER_SECONDS, RobotRace,
} from './RobotRaceSystem';

const circuit = {
  start: { x: 0, z: 0, label: 'Start' },
  checkpoints: [
    { x: 20, z: 0, label: 'Robot 1' },
    { x: 20, z: 20, label: 'Robot 2' },
    { x: 0, z: 0, label: 'Finish' },
  ],
};

describe('Robot Run circuit selection', () => {
  it('selects unique real junctions and closes the circuit at its start', () => {
    const junctions = Array.from({ length: 8 }, (_, index) => ({
      x: index * 200 - 600,
      z: (index % 3) * 300 - 300,
      roadA: `Road ${index}`,
      roadB: `Street ${index}`,
    }));
    const result = buildRobotCircuit(junctions, { x: 0, z: 0 });
    expect(result).toBeDefined();
    expect(result!.checkpoints.at(-1)).toMatchObject({ x: result!.start.x, z: result!.start.z });
    const unique = new Set(result!.checkpoints.slice(0, -1).map((point) => `${point.x},${point.z}`));
    expect(unique.size).toBe(result!.checkpoints.length - 1);
    expect(result!.checkpoints[0]!.label).toContain('Road');
  });

  it('refuses to invent a circuit without enough robots', () => {
    expect(buildRobotCircuit([], { x: 0, z: 0 })).toBeUndefined();
    expect(buildRobotCircuit([{ x: 0, z: 0 }], { x: 0, z: 0 })).toBeUndefined();
  });
});

describe('Robot Run timing and rewards', () => {
  it('advances only in order and pays gold plus a clean-car bonus', () => {
    const race = new RobotRace(circuit);
    expect(race.start(1)).toBe(true);
    expect(race.update(10, { x: 20, z: 50 }, 1)).toEqual({}); // skipped Robot 1
    expect(race.update(10, { x: 20, z: 0 }, 1)).toEqual({ checkpoint: 1 });
    expect(race.target.label).toBe('Robot 2');
    expect(race.update(10, { x: 20, z: 20 }, 0.96)).toEqual({ checkpoint: 2 });
    const result = race.update(10, { x: 0, z: 0 }, 0.93).finished;
    expect(result).toMatchObject({
      tier: 'gold',
      base: ROBOT_RACE_REWARDS.gold,
      cleanBonus: ROBOT_RACE_CLEAN_BONUS,
      total: ROBOT_RACE_REWARDS.gold + ROBOT_RACE_CLEAN_BONUS,
      personalBest: true,
    });
    expect(race.active).toBe(false);
  });

  it('drops the clean bonus after meaningful damage and retains the faster personal best', () => {
    const race = new RobotRace(circuit);
    race.start(1);
    race.update(70, { x: 20, z: 0 }, 0.9);
    race.update(70, { x: 20, z: 20 }, 0.9);
    const first = race.update(70, { x: 0, z: 0 }, 0.9).finished!;
    expect(first.cleanBonus).toBe(0);
    expect(first.tier).toBe('silver');
    race.start(1);
    race.update(90, { x: 20, z: 0 }, 1);
    race.update(90, { x: 20, z: 20 }, 1);
    const slower = race.update(90, { x: 0, z: 0 }, 1).finished!;
    expect(slower.personalBest).toBe(false);
    expect(slower.bestTime).toBe(first.elapsed);
  });

  it('fails on a wreck and can be started again', () => {
    const race = new RobotRace(circuit);
    race.start(1);
    expect(race.update(1, { x: 0, z: 0 }, 0)).toEqual({ failed: 'Your ride is finished before the race is.' });
    expect(race.active).toBe(false);
    expect(race.start(0.5)).toBe(true);
    expect(race.fail('Driver bailed')).toEqual({ failed: 'Driver bailed' });
  });

  it('reports gold, silver and finish pace thresholds exactly', () => {
    expect(raceTier(ROBOT_RACE_GOLD_SECONDS)).toBe('gold');
    expect(raceTier(ROBOT_RACE_GOLD_SECONDS + 0.01)).toBe('silver');
    expect(raceTier(ROBOT_RACE_SILVER_SECONDS + 0.01)).toBe('finished');
    expect(racePace(0)).toEqual({ label: 'GOLD', remaining: ROBOT_RACE_GOLD_SECONDS });
    expect(racePace(ROBOT_RACE_GOLD_SECONDS)).toEqual({ label: 'SILVER', remaining: ROBOT_RACE_SILVER_SECONDS - ROBOT_RACE_GOLD_SECONDS });
    expect(racePace(ROBOT_RACE_SILVER_SECONDS)).toEqual({ label: 'FINISH' });
  });
});
