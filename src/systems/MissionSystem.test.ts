import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { MissionSystem } from './MissionSystem';

const snapshot = { playerPosition: new Vector3(), inVehicle: false, wantedLevel: 0, shotsFired: 0, hostileDefeated: 0, collectedItem: false };

describe('MissionSystem', () => {
  it('progresses delivery objectives and awards completion metadata', () => {
    const system = new MissionSystem(); expect(system.start('delivery-run')).toBe(true);
    system.update(0, { ...snapshot, inVehicle: true, vehicleKind: 'compact', vehicleColor: 0xf1c232 }, false);
    expect(system.objective?.kind).toBe('checkpoints');
    system.registerCheckpoint(); system.registerCheckpoint(); system.registerCheckpoint();
    expect(system.objective?.kind).toBe('reach');
    const result = system.update(0, { ...snapshot, inVehicle: true, vehicleKind: 'compact', vehicleColor: 0xf1c232 }, true);
    expect(result.completed?.reward).toBe(900);
    expect(system.completed.has('delivery-run')).toBe(true);
  });

  it('leaves the opener untimed — its old 210s limit was impossible for the 3630u route', () => {
    const system = new MissionSystem(); system.start('delivery-run');
    system.update(0, { ...snapshot, inVehicle: true, vehicleKind: 'compact', vehicleColor: 0xf1c232 }, false);
    expect(system.objective?.timeLimit).toBeUndefined();
    expect(system.update(600, snapshot, false).failed).toBeUndefined(); // ten idle minutes cannot fail it
  });

  it('completes the CBD dilemma with one authored choice', () => {
    const system = new MissionSystem(); expect(system.start('arms-deal')).toBe(true);
    expect(system.objective?.kind).toBe('choice');
    expect(system.choose('wrong' as 'protect')).toEqual({});
    const result = system.choose('protect');
    expect(result.choice?.choice).toMatchObject({ id: 'protect', reward: 900 });
    expect(result.completed?.id).toBe('arms-deal');
    expect(system.choose('rob')).toEqual({});
  });
});
