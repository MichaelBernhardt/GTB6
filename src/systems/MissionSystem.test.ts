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

  it('fails a timed objective and can restart', () => {
    // content no longer times the opener (owner: forgiving first mission) — use a synthetic timed run
    const timed = { id: 'timed', name: 'Timed', contact: 'X', intro: '', reward: 0, start: { position: new Vector3(), label: 's' }, objectives: [{ kind: 'reach' as const, text: 'go', timeLimit: 30, target: { position: new Vector3(), label: 't' } }] };
    const system = new MissionSystem([timed]); system.start('timed');
    expect(system.update(31, snapshot, false).failed).toBe('Time expired');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(0);
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

// ---- Engine extensions: conditions, failIf, follow/survive, checkpoints, unlocks ----

import { missionUnlocked, type MissionDefinition } from './MissionSystem';

const sim = (missions: MissionDefinition[]): MissionSystem => new MissionSystem(missions);
const at = (label = 't'): { position: Vector3; label: string } => ({ position: new Vector3(), label });
const def = (objectives: MissionDefinition['objectives'], extra: Partial<MissionDefinition> = {}): MissionDefinition =>
  ({ id: 'sim', name: 'Sim', contact: 'X', intro: '', reward: 100, start: at('start'), objectives, ...extra });

describe('objective conditions', () => {
  it('reach only completes once every condition holds', () => {
    const system = sim([def([{ kind: 'reach', text: 'stop the train at Crown', target: at(), conditions: { drivingTrain: true, speedBelow: 0.5 } }])]);
    system.start('sim');
    expect(system.update(0.016, { ...snapshot, drivingTrain: true, playerSpeed: 8 }, true).completed).toBeUndefined();
    expect(system.update(0.016, { ...snapshot, drivingTrain: false, playerSpeed: 0 }, true).completed).toBeUndefined();
    expect(system.update(0.016, { ...snapshot, drivingTrain: true, playerSpeed: 0.2 }, true).completed?.id).toBe('sim');
  });

  it('blackoutAbove and undetected gate a breach objective', () => {
    const system = sim([def([{ kind: 'reach', text: 'reach the office', target: at(), conditions: { blackoutAbove: 0.7, undetected: true } }])]);
    system.start('sim');
    expect(system.update(0.016, { ...snapshot, blackout: 0 }, true).completed).toBeUndefined();
    expect(system.update(0.016, { ...snapshot, blackout: 1, detected: true }, true).completed).toBeUndefined();
    expect(system.update(0.016, { ...snapshot, blackout: 1 }, true).completed?.id).toBe('sim');
  });

  it('onTrain, station, altitude, parachuted and onFoot conditions evaluate against the snapshot', () => {
    const boarding = sim([def([{ kind: 'reach', text: 'ride to the halt', target: at(), conditions: { onTrain: true, stationName: 'Lughawe Halt' } }])]);
    boarding.start('sim');
    expect(boarding.update(0.016, { ...snapshot, onTrain: true, stationName: 'Crown Station' }, true).completed).toBeUndefined();
    expect(boarding.update(0.016, { ...snapshot, onTrain: true, stationName: 'Lughawe Halt' }, true).completed?.id).toBe('sim');
    const jump = sim([def([{ kind: 'reach', text: 'land it', target: at(), conditions: { onFoot: true, parachuted: true } }])]);
    jump.start('sim');
    expect(jump.update(0.016, { ...snapshot, inVehicle: true, vehicleKind: 'plane', parachuted: true }, true).completed).toBeUndefined();
    expect(jump.update(0.016, { ...snapshot, parachuted: true }, true).completed?.id).toBe('sim');
  });
});

describe('failIf rules', () => {
  it('vehicle-health-below fails with its own reason', () => {
    const system = sim([def([{ kind: 'reach', text: 'gently now', target: at(), failIf: [{ kind: 'vehicle-health-below', value: 0.6, reason: 'The tanker is leaking everywhere' }] }])]);
    system.start('sim');
    expect(system.update(0.016, { ...snapshot, vehicleHealthPct: 0.7 }, false).failed).toBeUndefined();
    expect(system.update(0.016, { ...snapshot, vehicleHealthPct: 0.5 }, false).failed).toBe('The tanker is leaking everywhere');
    expect(system.state).toBe('failed');
  });

  it('detected, wanted-above, escort-down and strayed all fail', () => {
    const rules = (failIf: NonNullable<MissionDefinition['objectives'][0]['failIf']>) => {
      const system = sim([def([{ kind: 'reach', text: 'go', target: at(), failIf }])]);
      system.start('sim');
      return system;
    };
    expect(rules([{ kind: 'detected', reason: 'Floodlights slam on' }]).update(0.016, { ...snapshot, detected: true }, false).failed).toBe('Floodlights slam on');
    expect(rules([{ kind: 'wanted-above', value: 2, reason: 'Too hot' }]).update(0.016, { ...snapshot, wantedLevel: 3 }, false).failed).toBe('Too hot');
    expect(rules([{ kind: 'escort-down', reason: 'Candice is down' }]).update(0.016, { ...snapshot, escortAlive: false }, false).failed).toBe('Candice is down');
    expect(rules([{ kind: 'strayed', value: 45, reason: 'You lost the bakkie' }]).update(0.016, { ...snapshot, followDistance: 60 }, false).failed).toBe('You lost the bakkie');
  });

  it('failIf outranks completion on the same frame', () => {
    const system = sim([def([{ kind: 'reach', text: 'go', target: at(), failIf: [{ kind: 'detected', reason: 'Seen' }] }])]);
    system.start('sim');
    expect(system.update(0.016, { ...snapshot, detected: true }, true).failed).toBe('Seen');
  });
});

describe('follow and survive kinds', () => {
  it('follow completes when the quarry arrives and fails when strayed', () => {
    const make = () => {
      const system = sim([def([{ kind: 'follow', text: 'tail the bakkie', failIf: [{ kind: 'strayed', value: 45, reason: 'Lost him' }] }])]);
      system.start('sim');
      return system;
    };
    const tail = make();
    expect(tail.update(0.016, { ...snapshot, followDistance: 30 }, false).completed).toBeUndefined();
    expect(tail.update(0.016, { ...snapshot, followDistance: 30, followArrived: true }, false).completed?.id).toBe('sim');
    expect(make().update(0.016, { ...snapshot, followDistance: 50 }, false).failed).toBe('Lost him');
  });

  it('survive completes by outlasting its timer instead of failing', () => {
    const system = sim([def([{ kind: 'survive', text: 'hold the yard', timeLimit: 90, failIf: [{ kind: 'escort-down', reason: 'Sindi is down' }] }])]);
    system.start('sim');
    expect(system.update(45, { ...snapshot, escortAlive: true }, false)).toEqual({});
    const result = system.update(46, { ...snapshot, escortAlive: true }, false);
    expect(result.completed?.id).toBe('sim');
  });
});

describe('checkpoint restart', () => {
  const twoPhase = (): MissionDefinition => def([
    { kind: 'reach', text: 'travel', target: at() },
    { kind: 'defeat', text: 'fight', required: 2, checkpoint: true },
    { kind: 'reach', text: 'deliver', target: at(), timeLimit: 30 },
  ]);

  it('restart resumes from the latest checkpointed objective', () => {
    const system = sim([twoPhase()]);
    system.start('sim');
    system.update(0.016, snapshot, true); // travel done
    expect(system.objectiveIndex).toBe(1);
    system.update(0.016, { ...snapshot, hostileDefeated: 2 }, false); // fight done → deliver
    system.update(31, snapshot, false); // deliver times out
    expect(system.state).toBe('failed');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(1); // back to the fight, not the drive over
    expect(system.state).toBe('active');
  });

  it('without checkpoints a restart goes back to the top with timers rearmed', () => {
    const system = sim([def([
      { kind: 'reach', text: 'go', target: at(), timeLimit: 10 },
      { kind: 'reach', text: 'then here', target: at() },
    ])]);
    system.start('sim');
    system.update(11, snapshot, false);
    expect(system.state).toBe('failed');
    system.restart();
    expect(system.objectiveIndex).toBe(0);
    expect(system.remainingTime).toBe(10);
  });
});

describe('missionUnlocked', () => {
  it('requires all prerequisite missions and flags', () => {
    const gated = def([], { prerequisites: { missions: ['a', 'b'], flags: ['act1'] } });
    expect(missionUnlocked(gated, new Set(['a']), new Set(['act1']))).toBe(false);
    expect(missionUnlocked(gated, new Set(['a', 'b']), new Set())).toBe(false);
    expect(missionUnlocked(gated, new Set(['a', 'b']), new Set(['act1']))).toBe(true);
    expect(missionUnlocked(def([]), new Set(), new Set())).toBe(true); // no prerequisites
  });
});
