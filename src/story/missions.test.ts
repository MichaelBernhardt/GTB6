import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { MISSIONS, MissionSystem } from '../systems/MissionSystem';
import { MISSION_SCRIPTS, CANDICE_VAN_COLOR } from './scripts';
import type { GameSnapshot } from '../types';

const base: GameSnapshot = { playerPosition: new Vector3(), inVehicle: false, wantedLevel: 0, shotsFired: 0, hostileDefeated: 0, collectedItem: false };
const sim = (): MissionSystem => new MissionSystem();

describe('mission content sanity', () => {
  it('every script entry belongs to a defined mission with finite geometry', () => {
    const ids = new Set(MISSIONS.map((mission) => mission.id));
    for (const [id, script] of Object.entries(MISSION_SCRIPTS)) {
      expect(ids.has(id), `script for unknown mission ${id}`).toBe(true);
      for (const stop of script.stops ?? []) { expect(Number.isFinite(stop.x)).toBe(true); expect(Number.isFinite(stop.z)).toBe(true); }
      for (const wave of script.waves ?? []) for (const spot of wave.spots) { expect(Number.isFinite(spot.x)).toBe(true); expect(Number.isFinite(spot.z)).toBe(true); }
      if (script.quarry?.destination) expect(Number.isFinite(script.quarry.destination.x)).toBe(true);
      if (script.quarry?.departObjective !== undefined) expect(script.quarry.departObjective).toBeGreaterThanOrEqual(script.quarry.spawnObjective);
    }
  });

  it('mission ids are unique and every start anchor is finite', () => {
    const seen = new Set<string>();
    for (const mission of MISSIONS) {
      expect(seen.has(mission.id)).toBe(false); seen.add(mission.id);
      expect(Number.isFinite(mission.start.position.x)).toBe(true);
      expect(Number.isFinite(mission.start.position.z)).toBe(true);
    }
  });

  it('act 1 prerequisites reference real missions', () => {
    const ids = new Set(MISSIONS.map((mission) => mission.id));
    for (const mission of MISSIONS) for (const need of mission.prerequisites?.missions ?? []) expect(ids.has(need), `${mission.id} needs unknown ${need}`).toBe(true);
  });
});

describe('Last Coach Home walkthrough', () => {
  it('completes: ride to Sandton Station aboard, fetch the bag, return', () => {
    const system = sim(); expect(system.start('last-coach-home')).toBe(true);
    // driving to Sandton in a car does NOT count
    expect(system.update(0.016, { ...base, inVehicle: true, vehicleKind: 'compact' }, true).advanced).toBeUndefined();
    // aboard, but dwelling at the wrong station
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Crown Station' }, false).advanced).toBeUndefined();
    // aboard at Sandton Station: the conditions are the objective (no reach flag needed)
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Sandton Station' }, false).advanced).toBe(true);
    expect(system.objective?.kind).toBe('collect');
    expect(system.update(0.016, { ...base, collectedItem: true }, true).advanced).toBe(true);
    const done = system.update(0.016, base, true);
    expect(done.completed?.id).toBe('last-coach-home');
    expect(done.completed?.reward).toBe(1100);
  });
});

describe('Copper Wire Blues walkthrough', () => {
  const toFollow = (system: MissionSystem): void => {
    system.start('copper-wire-blues');
    system.update(0.016, base, true); // reached the parked bakkie
    expect(system.objective?.kind).toBe('follow');
  };

  it('completes: reach the bakkie, tail it to the yard, eyeball the gate', () => {
    const system = sim(); toFollow(system);
    expect(system.update(0.016, { ...base, followDistance: 40, escortAlive: true }, false)).toEqual({});
    expect(system.update(0.016, { ...base, followDistance: 30, followArrived: true, escortAlive: true }, false).advanced).toBe(true);
    expect(system.update(0.016, base, true).completed?.id).toBe('copper-wire-blues');
  });

  it('fails by straying and restarts at the tail (checkpoint), not the meet', () => {
    const system = sim(); toFollow(system);
    expect(system.update(0.016, { ...base, followDistance: 120, escortAlive: true }, false).failed).toBe('You lost the bakkie in traffic');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(1); // straight back to the follow
  });

  it('fails if the bakkie is wrecked', () => {
    const system = sim(); toFollow(system);
    expect(system.update(0.016, { ...base, followDistance: 20, escortAlive: false }, false).failed).toBe('The bakkie is wrecked — no yard today');
  });
});

describe('Rank Cold War walkthrough', () => {
  const inVan: Partial<GameSnapshot> = { inVehicle: true, vehicleKind: 'van', vehicleColor: CANDICE_VAN_COLOR, vehicleHealthPct: 1 };

  it('completes: van, two ranks, moer three heavies, bring it home', () => {
    const system = sim(); system.start('rank-cold-war');
    system.update(0.016, { ...base, ...inVan }, false);
    expect(system.objective?.kind).toBe('checkpoints');
    system.registerCheckpoint(); system.registerCheckpoint();
    expect(system.objective?.kind).toBe('defeat');
    system.update(0.016, { ...base, ...inVan, hostileDefeated: 3 }, false);
    expect(system.objective?.kind).toBe('reach');
    const done = system.update(0.016, { ...base, ...inVan }, true);
    expect(done.completed?.reward).toBe(2600);
  });

  it('the van dying fails any stage, and restart resumes at the brawl checkpoint', () => {
    const system = sim(); system.start('rank-cold-war');
    system.update(0.016, { ...base, ...inVan }, false);
    system.registerCheckpoint(); system.registerCheckpoint();
    system.update(0.016, { ...base, ...inVan, hostileDefeated: 3 }, false); // defeat cleared → reach
    expect(system.update(0.016, { ...base, ...inVan, vehicleHealthPct: 0.2 }, false).failed).toBe('Candice\'s van is finished — and so is her route');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(2); // back to the fight, not the whole route
  });

  it('a random van of another colour does not start the route', () => {
    const system = sim(); system.start('rank-cold-war');
    expect(system.update(0.016, { ...base, inVehicle: true, vehicleKind: 'van', vehicleColor: 0xd28452 }, false).advanced).toBeUndefined();
  });
});

describe('The Reading of the Signs walkthrough', () => {
  it('completes the riddle chain — all clue objectives are hidden (no markers)', () => {
    const mission = MISSIONS.find((entry) => entry.id === 'reading-signs')!;
    expect(mission.objectives.slice(0, 3).every((objective) => objective.hidden)).toBe(true);
    expect(mission.objectives[3]!.hidden).toBeUndefined();
    const system = sim(); system.start('reading-signs');
    for (let i = 0; i < 3; i++) expect(system.update(0.016, base, true).advanced).toBe(true);
    expect(system.update(0.016, base, true).completed?.id).toBe('reading-signs');
    expect(MISSION_SCRIPTS['reading-signs']?.diaryPage).toBe(1);
  });

  it('restart after a mid-chain death resumes from the last solved riddle', () => {
    const system = sim(); system.start('reading-signs');
    system.update(0.016, base, true); // solved riddle 1 → objective 1 (checkpointed)
    system.fail('You were incapacitated');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(1);
  });
});

describe('act gating end-to-end', () => {
  it('act 1 missions unlock off the originals', () => {
    const completed = new Set<string>();
    const flags = new Set<string>();
    const unlocked = (): string[] => MISSIONS.filter((mission) => !completed.has(mission.id) && (mission.prerequisites?.missions ?? []).every((id) => completed.has(id)) && (mission.prerequisites?.flags ?? []).every((flag) => flags.has(flag))).map((mission) => mission.id);
    expect(unlocked()).toEqual(['delivery-run', 'hot-property', 'dockside-signal', 'arms-deal']);
    completed.add('delivery-run');
    expect(unlocked()).toContain('last-coach-home');
    expect(unlocked()).toContain('reading-signs');
    expect(unlocked()).not.toContain('copper-wire-blues');
    completed.add('hot-property');
    expect(unlocked()).toContain('copper-wire-blues');
    completed.add('dockside-signal');
    expect(unlocked()).toContain('rank-cold-war');
  });
});

describe('Kelvin Yard geometry', () => {
  it('keeps the gate kerb (casing spot) outside the detection ring and the office inside it', async () => {
    const { KELVIN_FENCE_RADIUS, KELVIN_GATE_SPOT, KELVIN_OFFICE_SPOT, KELVIN_YARD_CENTER } = await import('../world/placements');
    const gateDistance = Math.hypot(KELVIN_GATE_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_GATE_SPOT.z - KELVIN_YARD_CENTER.z);
    const officeDistance = Math.hypot(KELVIN_OFFICE_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_OFFICE_SPOT.z - KELVIN_YARD_CENTER.z);
    expect(gateDistance).toBeGreaterThan(KELVIN_FENCE_RADIUS); // casing the gate must not count as a breach
    expect(officeDistance).toBeLessThan(KELVIN_FENCE_RADIUS); // the ledger is only reachable inside the ring
  });
});
