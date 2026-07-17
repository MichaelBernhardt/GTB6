import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { MISSIONS, MissionSystem, missionUnlocked } from '../systems/MissionSystem';
import { StoryDirector } from '../systems/StoryDirector';
import { MISSION_SCRIPTS, TANKER_COLOR } from './scripts';
import type { GameSnapshot } from '../types';

const base: GameSnapshot = { playerPosition: new Vector3(), inVehicle: false, wantedLevel: 0, shotsFired: 0, hostileDefeated: 0, collectedItem: false };
const sim = (): MissionSystem => new MissionSystem();

describe('The Audition walkthrough', () => {
  const inTanker: Partial<GameSnapshot> = { inVehicle: true, vehicleKind: 'van', vehicleColor: TANKER_COLOR, vehicleHealthPct: 1 };

  it('completes: take the tanker, deliver it gently', () => {
    const system = sim(); expect(system.start('the-audition')).toBe(true);
    system.update(0.016, { ...base, ...inTanker }, false);
    expect(system.objective?.text).toContain('gently');
    expect(system.update(0.016, { ...base, ...inTanker }, true).completed?.reward).toBe(3000);
  });

  it('fails when the tanker bleeds below 30% (forgives several ordinary crashes)', () => {
    const system = sim(); system.start('the-audition');
    system.update(0.016, { ...base, ...inTanker }, false);
    expect(system.update(0.016, { ...base, ...inTanker, vehicleHealthPct: 0.45 }, false).failed).toBeUndefined();
    expect(system.update(0.016, { ...base, ...inTanker, vehicleHealthPct: 0.25 }, false).failed).toContain('bleeding diesel');
  });
});

describe('Pull the Plug walkthrough', () => {
  it('completes: substation after dark, breaker, lose the heat', () => {
    const system = sim(); system.start('pull-the-plug');
    expect(system.update(0.016, { ...base, isNight: false }, true).advanced).toBeUndefined(); // daylight arrival: nothing doing
    expect(system.update(0.016, { ...base, isNight: true }, true).advanced).toBe(true);
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true); // breaker thrown
    expect(system.objective?.kind).toBe('lose-wanted');
    expect(system.update(0.016, { ...base, wantedLevel: 2 }, false)).toEqual({});
    expect(system.update(0.016, { ...base, wantedLevel: 0 }, false).completed?.id).toBe('pull-the-plug');
    expect(MISSION_SCRIPTS['pull-the-plug']?.forceBlackout).toBe(2); // the beat that kills the grid
  });

  it('a mid-mission death restarts at the breaker, not the drive', () => {
    const system = sim(); system.start('pull-the-plug');
    system.update(0.016, { ...base, isNight: true }, true);
    system.fail('You were incapacitated');
    system.restart();
    expect(system.objectiveIndex).toBe(1);
  });
});

describe('Stage Fright walkthrough', () => {
  it('completes on the superbike regardless of heat — the alarm is a beat, not a fail state', () => {
    const system = sim(); system.start('stage-fright');
    system.update(0.016, { ...base, inVehicle: true, vehicleKind: 'superbike' }, false);
    expect(system.objective?.kind).toBe('reach');
    // wanted level 3 from the alarm does not fail anything: ride it out
    expect(system.update(0.016, { ...base, inVehicle: true, vehicleKind: 'superbike', wantedLevel: 3 }, true).completed?.id).toBe('stage-fright');
    expect(MISSION_SCRIPTS['stage-fright']?.alarm?.objective).toBe(1);
  });
});

describe('The Genny Round walkthrough', () => {
  it('completes: three doors, correct the holdout, pay Solly', () => {
    const system = sim(); system.start('genny-round');
    system.registerCheckpoint(); system.registerCheckpoint(); system.registerCheckpoint();
    expect(system.objective?.kind).toBe('defeat');
    system.update(0.016, { ...base, hostileDefeated: 2 }, false);
    expect(system.update(0.016, base, true).completed?.reward).toBe(3600);
  });
});

describe('Paper Round walkthrough (riddle)', () => {
  it('completes: hidden drop, dossier, back to Sindi', () => {
    const mission = MISSIONS.find((entry) => entry.id === 'paper-round')!;
    expect(mission.objectives[0]!.hidden).toBe(true);
    const system = sim(); system.start('paper-round');
    expect(system.update(0.016, base, true).advanced).toBe(true); // found the drop
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true);
    expect(system.update(0.016, base, true).completed?.id).toBe('paper-round');
    expect(MISSION_SCRIPTS['paper-round']?.diaryPage).toBe(2);
  });
});

describe('The Wrong Train walkthrough', () => {
  it('completes only when driving and stopped dead at Crown Station', () => {
    const system = sim(); system.start('the-wrong-train');
    expect(system.update(0.016, { ...base, onTrain: true }, false).advanced).toBeUndefined(); // riding, not driving
    expect(system.update(0.016, { ...base, onTrain: true, drivingTrain: true }, false).advanced).toBe(true);
    // rolling through Crown does not count: currentStationName only reads out when stopped (speed gate upstream)
    expect(system.update(0.016, { ...base, onTrain: true, drivingTrain: true, stationName: undefined }, false).advanced).toBeUndefined();
    expect(system.update(0.016, { ...base, onTrain: true, drivingTrain: true, stationName: 'Crown Station' }, false).advanced).toBe(true);
    expect(system.update(0.016, base, true).completed?.id).toBe('the-wrong-train');
  });
});

describe('Crosswinds walkthrough', () => {
  it('completes: airborne, high over Ponte, down to the forecourt inside the timer', () => {
    const system = sim(); system.start('crosswinds');
    expect(system.update(0.016, { ...base, inPlane: true, altitude: 10 }, false).advanced).toBeUndefined(); // still taxiing
    expect(system.update(0.016, { ...base, inPlane: true, altitude: 60 }, false).advanced).toBe(true);
    expect(system.update(0.016, { ...base, inPlane: true, altitude: 200 }, false).advanced).toBeUndefined(); // high, but not over Ponte
    expect(system.update(0.016, { ...base, inPlane: true, altitude: 200 }, true).advanced).toBe(true);
    expect(system.remainingTime).toBe(300); // the descent clock arms
    expect(system.update(1, base, true).completed?.id).toBe('crosswinds');
  });

  it('dawdling on the way down expires the drop', () => {
    const system = sim(); system.start('crosswinds');
    system.update(0.016, { ...base, inPlane: true, altitude: 60 }, false);
    system.update(0.016, { ...base, inPlane: true, altitude: 200 }, true);
    expect(system.update(301, base, false).failed).toBe('Time expired');
    system.restart();
    expect(system.objectiveIndex).toBe(2); // the drop leg is checkpointed (difficulty gradient)
  });
});

describe('Two Fires branch', () => {
  it('choice resolves to flags that gate the branch missions', () => {
    const director = new StoryDirector();
    const system = sim(); system.start('two-fires');
    expect(system.objective?.kind).toBe('choice');
    const result = system.choose('sindi');
    expect(result.completed?.id).toBe('two-fires');
    director.onChoice(result.choice!.missionId, result.choice!.choice.id);
    const completed = new Set(['two-fires']);
    const paperFire = MISSIONS.find((entry) => entry.id === 'paper-fire')!;
    const catchCutting = MISSIONS.find((entry) => entry.id === 'catch-them-cutting')!;
    expect(missionUnlocked(catchCutting, completed, director.flags)).toBe(true);
    expect(missionUnlocked(paperFire, completed, director.flags)).toBe(false); // the other branch stays shut
  });
});

describe('Paper Fire walkthrough (loyalist branch)', () => {
  it('completes: find the van in time, light it, vanish', () => {
    const system = sim(); system.start('paper-fire');
    expect(system.remainingTime).toBe(600);
    expect(system.update(1, base, true).advanced).toBe(true);
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true);
    expect(system.update(0.016, { ...base, wantedLevel: 0 }, false).completed?.id).toBe('paper-fire');
    expect(MISSIONS.find((entry) => entry.id === 'paper-fire')?.setFlags).toContain('act3');
    expect(MISSION_SCRIPTS['paper-fire']?.quarry?.igniteObjective).toBe(2);
  });

  it('running out the clock fails the approach', () => {
    const system = sim(); system.start('paper-fire');
    expect(system.update(601, base, false).failed).toBe('Time expired');
  });
});

describe('Catch Them Cutting walkthrough (whistle branch)', () => {
  it('completes: night stakeout, drop the crew, photograph, report', () => {
    const system = sim(); system.start('catch-them-cutting');
    expect(system.update(0.016, { ...base, isNight: true }, true).advanced).toBe(true);
    system.update(0.016, { ...base, hostileDefeated: 3 }, false);
    expect(system.objective?.kind).toBe('collect');
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true);
    expect(system.update(0.016, base, true).completed?.id).toBe('catch-them-cutting');
    expect(MISSIONS.find((entry) => entry.id === 'catch-them-cutting')?.setFlags).toContain('act3');
  });
});

describe('Dark House walkthrough (flagship)', () => {
  const dark: Partial<GameSnapshot> = { blackout: 1, isNight: true };

  it('the full discovery loop: spotted with the grid up, clean in a blackout', () => {
    const system = sim(); expect(system.start('dark-house')).toBe(true);
    system.update(0.016, base, true); // cased the gate
    expect(system.objective?.text).toContain('Figure it out');
    // grid up: the depot model marks the player detected the moment they cross the fence
    expect(system.update(0.016, { ...base, detected: true }, false).failed).toBe('Floodlights slam on. The whole yard saw you.');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(1); // straight back to the breach (checkpoint), no re-casing
    // blackout night: undetected all the way through
    expect(system.update(0.016, { ...base, ...dark }, true).advanced).toBe(true); // office reached
    expect(system.update(0.016, { ...base, ...dark, collectedItem: true }, true).advanced).toBe(true); // ledger
    expect(system.update(0.016, { ...base, ...dark }, true).completed?.id).toBe('dark-house');
  });

  it('detection during the ledger grab or the escape also fails diegetically', () => {
    const system = sim(); system.start('dark-house');
    system.update(0.016, base, true);
    system.update(0.016, { ...base, blackout: 1, isNight: true }, true);
    expect(system.update(0.016, { ...base, detected: true }, false).failed).toContain('Floodlights');
    system.restart();
    system.update(0.016, { ...base, blackout: 1, isNight: true }, true);
    system.update(0.016, { ...base, blackout: 1, isNight: true, collectedItem: true }, true);
    expect(system.update(0.016, { ...base, detected: true }, false).failed).toContain('Floodlights');
  });

  it('nothing in the mission copy ever names load shedding or the blackout', () => {
    const mission = MISSIONS.find((entry) => entry.id === 'dark-house')!;
    // The title "Dark House" is an evocative wink, not an instruction — everything the player is TOLD is scanned.
    const copy = [mission.intro, ...mission.objectives.map((objective) => `${objective.text} ${(objective.failIf ?? []).map((rule) => rule.reason).join(' ')}`)].join(' ').toLowerCase();
    for (const banned of ['load shedding', 'blackout', 'eskom', 'grid', 'power', 'stage 4', 'stage four', 'wait for', 'at night', 'dark']) {
      expect(copy.includes(banned), `flagship copy leaks the trick: "${banned}"`).toBe(false);
    }
  });
});

describe('Act 3 tails and finale', () => {
  it('Long Live the King: hold the yard, break the loyalists', () => {
    const system = sim(); system.start('long-live-the-king');
    system.update(0.016, base, true);
    expect(system.objective?.kind).toBe('survive');
    expect(system.update(61, base, false).advanced).toBe(true); // outlasted the siege
    system.update(0.016, { ...base, hostileDefeated: 4 }, false);
    expect(system.state).toBe('complete');
    expect(MISSIONS.find((entry) => entry.id === 'long-live-the-king')?.setFlags).toContain('endgame');
  });

  it('Carcass: timed ledger run, shake heat, sweep the stashes', () => {
    const system = sim(); system.start('carcass');
    expect(system.update(1, base, true).advanced).toBe(true);
    expect(system.update(0.016, { ...base, wantedLevel: 0 }, false).advanced).toBe(true);
    expect(system.remainingTime).toBe(600);
    system.registerCheckpoint(); system.registerCheckpoint();
    const done = system.registerCheckpoint();
    expect(done.completed?.reward).toBe(12000);
  });

  it('The Switch: reach in time, drop the wreckers, survive the hold', () => {
    const system = sim(); system.start('the-switch');
    expect(system.update(1, base, true).advanced).toBe(true);
    system.update(0.016, { ...base, hostileDefeated: 4 }, false);
    expect(system.objective?.kind).toBe('survive');
    expect(system.update(91, base, false).completed?.id).toBe('the-switch');
  });

  it('missing the finale timer fails and restarts from the top', () => {
    const system = sim(); system.start('the-switch');
    expect(system.update(421, base, false).failed).toBe('Time expired');
    system.restart();
    expect(system.objectiveIndex).toBe(0);
  });
});

describe('side pieces', () => {
  it('Padstal Run: out, load, home — both legs timed', () => {
    const system = sim(); system.start('padstal-run');
    expect(system.remainingTime).toBe(900);
    expect(system.update(1, base, true).advanced).toBe(true);
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true);
    expect(system.remainingTime).toBe(900); // the home leg gets its own clock
    expect(system.update(1, base, true).completed?.reward).toBe(4000);
  });

  it('Pier Pressure: catch him, convince him, collect', () => {
    const system = sim(); system.start('pier-pressure');
    expect(system.update(1, base, true).advanced).toBe(true);
    system.update(0.016, { ...base, hostileDefeated: 1 }, false);
    expect(system.update(0.016, { ...base, collectedItem: true }, true).completed?.id).toBe('pier-pressure');
  });
});

describe('full arc gating', () => {
  it('walks the whole campaign: on-ramp → act 1 → payroll → branch → act 3 → finale', () => {
    const director = new StoryDirector();
    const completed = new Set<string>();
    const unlockedIds = (): string[] => MISSIONS.filter((mission) => !completed.has(mission.id) && missionUnlocked(mission, completed, director.flags)).map((mission) => mission.id);
    const finish = (id: string): void => {
      expect(unlockedIds(), `expected ${id} to be unlocked`).toContain(id);
      completed.add(id);
      const mission = MISSIONS.find((entry) => entry.id === id)!;
      director.onMissionCompleted(mission);
    };
    expect(unlockedIds()).not.toContain('the-audition');
    finish('delivery-run'); finish('hot-property'); finish('dockside-signal');
    finish('copper-wire-blues'); // Solly hears about you
    expect(unlockedIds()).toContain('the-audition');
    expect(unlockedIds()).not.toContain('dark-house');
    finish('the-audition'); finish('pull-the-plug');
    expect(unlockedIds()).toContain('paper-round'); // Sindi read the fault logs
    finish('stage-fright'); finish('paper-round');
    expect(unlockedIds()).toContain('two-fires');
    finish('two-fires');
    director.onChoice('two-fires', 'solly');
    expect(unlockedIds()).toContain('paper-fire');
    expect(unlockedIds()).not.toContain('catch-them-cutting');
    finish('paper-fire'); // raises act3
    expect(unlockedIds()).toContain('dark-house');
    finish('dark-house');
    expect(unlockedIds()).toContain('long-live-the-king');
    expect(unlockedIds()).not.toContain('carcass'); // other branch stays shut
    finish('long-live-the-king'); // raises endgame
    expect(unlockedIds()).toContain('the-switch');
    finish('the-switch');
    expect(director.flags.has('stage-six-over')).toBe(true);
  });
});
