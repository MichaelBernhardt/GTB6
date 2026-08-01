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
  it('completes: board at Doornfontein, ride IN to Park, fetch the bag, return (train verb restored)', () => {
    const system = sim(); expect(system.start('last-coach-home')).toBe(true);
    expect(system.objective?.kind).toBe('reach');
    // The marker leads to the BOARDING point now (round 4): the old single objective walked the
    // player straight to Park, where the on-train gate refused them with no hint to board elsewhere.
    // driving there in a car does NOT count — boarding requires being aboard AND at Doornfontein
    expect(system.update(0.016, { ...base, inVehicle: true, vehicleKind: 'compact' }, true).advanced).toBeUndefined();
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Crown Station' }, false).advanced).toBeUndefined();
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Doornfontein Station' }, false).advanced).toBe(true);
    // …then ride the same train in to Park.
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Doornfontein Station' }, false).advanced).toBeUndefined(); // still at the platform
    expect(system.update(0.016, { ...base, onTrain: true, stationName: 'Johannesburg Park Station' }, false).advanced).toBe(true);
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
    expect(system.update(0.016, { ...base, followDistance: 200, escortAlive: true }, false).failed).toBe('You lost the pickup in traffic');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(1); // straight back to the follow
  });

  it('fails if the bakkie is wrecked', () => {
    const system = sim(); toFollow(system);
    expect(system.update(0.016, { ...base, followDistance: 20, escortAlive: false }, false).failed).toBe('The pickup is wrecked — no yard today');
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
    expect(system.update(0.016, { ...base, ...inVan, vehicleHealthPct: 0.2 }, false).failed).toBeUndefined(); // 20%: battered but breathing (difficulty gradient)
    expect(system.update(0.016, { ...base, ...inVan, vehicleHealthPct: 0.05 }, false).failed).toBe('Candice\'s van is finished — and so is her route');
    expect(system.restart()).toBe(true);
    expect(system.objectiveIndex).toBe(3); // the home leg is checkpointed too now (difficulty gradient)
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

describe('Rank Business geometry (owner round 4)', () => {
  it('ends on Candice herself, and escapes a real perimeter', async () => {
    const { CANDICE_START, TERMINAL_SPOT } = await import('../world/placements');
    const mission = MISSIONS.find((entry) => entry.id === 'dockside-signal')!;
    // Giver/pin agreement: the final objective labelled 'Candice' must target where her body stands
    // (it used to point at a kiosk spot 110u across a field from her).
    const final = mission.objectives[mission.objectives.length - 1]!;
    expect(final.target?.label).toBe('Candice');
    expect(Math.hypot(final.target!.position.x - CANDICE_START.x, final.target!.position.z - CANDICE_START.z)).toBeLessThan(1);
    // The "perimeter" is a ring around the terminal, not a far-away dot (it used to be 518u out).
    const escape = mission.objectives.find((objective) => objective.kind === 'escape')!;
    expect(escape.minDistance).toBe(150);
    expect(Math.hypot(escape.target!.position.x - TERMINAL_SPOT.x, escape.target!.position.z - TERMINAL_SPOT.z)).toBeLessThan(1);
    // And the mission-start anchor IS Candice's spot (contact body spawns at the first-listed start).
    expect(Math.hypot(mission.start.position.x - CANDICE_START.x, mission.start.position.z - CANDICE_START.z)).toBeLessThan(1);
  });

  it('Dark House keeps its reach-a-point escape (no minDistance)', () => {
    const darkHouse = MISSIONS.find((entry) => entry.id === 'dark-house')!;
    const escape = darkHouse.objectives.find((objective) => objective.kind === 'escape')!;
    expect(escape.minDistance).toBeUndefined();
    expect(escape.radius).toBe(6);
  });
});

describe('Pier Pressure geometry (owner round 4)', () => {
  it('sends the fare hunt to the real Vaalpunt Slipway as a sanctioned journey', async () => {
    const { PIER_POINT } = await import('../world/placements');
    const mission = MISSIONS.find((entry) => entry.id === 'pier-pressure')!;
    const reach = mission.objectives[0]!;
    expect(Math.hypot(reach.target!.position.x - PIER_POINT.x, reach.target!.position.z - PIER_POINT.z), 'pin at the landmark the copy names').toBeLessThan(30);
    expect(MISSION_SCRIPTS['pier-pressure']?.tier).toBe('journey');
    expect(MISSION_SCRIPTS['pier-pressure']?.journeys).toContain(0);
  });
});

describe('promised places geometry (owner round 4, pass 2)', () => {
  it('ends Copper Wire Blues at a vantage with the Kelvin gate in sight — outside the fence ring', async () => {
    const { CABLE_YARD_SPOT, KELVIN_FENCE_RADIUS, KELVIN_GATE_SPOT, KELVIN_YARD_CENTER } = await import('../world/placements');
    const toCentre = Math.hypot(CABLE_YARD_SPOT.x - KELVIN_YARD_CENTER.x, CABLE_YARD_SPOT.z - KELVIN_YARD_CENTER.z);
    expect(toCentre, 'clocking the yard must not count as breaching it').toBeGreaterThan(KELVIN_FENCE_RADIUS);
    const toGate = Math.hypot(CABLE_YARD_SPOT.x - KELVIN_GATE_SPOT.x, CABLE_YARD_SPOT.z - KELVIN_GATE_SPOT.z);
    expect(toGate, 'first sight of the gate: the vantage is up the road, not across town').toBeLessThan(90);
    expect(toGate).toBeGreaterThan(20);
  });

  it('puts the Ophirton feeder IN Ophirton, breaker beside the set piece', async () => {
    const { SUBSTATION_BREAKER, SUBSTATION_SITE, SUBSTATION_SPOT } = await import('../world/placements');
    const { districtAt } = await import('../world/mapData');
    expect(districtAt(SUBSTATION_SITE.x, SUBSTATION_SITE.z), 'the copy names Ophirton — the pin must be there').toBe('Ophirton');
    expect(Math.hypot(SUBSTATION_SPOT.x - SUBSTATION_SITE.x, SUBSTATION_SPOT.z - SUBSTATION_SITE.z)).toBeLessThan(12);
    expect(Math.hypot(SUBSTATION_BREAKER.x - SUBSTATION_SITE.x, SUBSTATION_BREAKER.z - SUBSTATION_SITE.z)).toBeLessThan(12);
  });

  it('sends the padstal run to the real Ouma se Padstal landmark', async () => {
    const { PADSTAL_POINT, PADSTAL_SITE, PADSTAL_SPOT } = await import('../world/placements');
    expect(Math.hypot(PADSTAL_SPOT.x - PADSTAL_POINT.x, PADSTAL_SPOT.z - PADSTAL_POINT.z), 'pin at the landmark the copy names').toBeLessThan(45);
    expect(Math.hypot(PADSTAL_SITE.building.x - PADSTAL_SPOT.x, PADSTAL_SITE.building.z - PADSTAL_SPOT.z), 'the stall fronts its own doorstep pad').toBeLessThan(16);
  });
});

describe('Kelvin Yard geometry', () => {
  it('keeps the gate and rear escape outside the detection ring and the office inside it', async () => {
    const { KELVIN_BREACH_SPOT, KELVIN_FENCE_RADIUS, KELVIN_GATE_SPOT, KELVIN_OFFICE_SPOT, KELVIN_YARD_CENTER } = await import('../world/placements');
    const gateDistance = Math.hypot(KELVIN_GATE_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_GATE_SPOT.z - KELVIN_YARD_CENTER.z);
    const breachDistance = Math.hypot(KELVIN_BREACH_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_BREACH_SPOT.z - KELVIN_YARD_CENTER.z);
    const officeDistance = Math.hypot(KELVIN_OFFICE_SPOT.x - KELVIN_YARD_CENTER.x, KELVIN_OFFICE_SPOT.z - KELVIN_YARD_CENTER.z);
    expect(gateDistance).toBeGreaterThan(KELVIN_FENCE_RADIUS); // casing the gate must not count as a breach
    expect(breachDistance).toBeGreaterThan(KELVIN_FENCE_RADIUS); // escaping must really leave the yard
    expect(officeDistance).toBeLessThan(KELVIN_FENCE_RADIUS); // the ledger is only reachable inside the ring
  });
});

describe('mission flow audit: every objective is locatable or intentionally location-free', () => {
  // Mirrors Game.currentTarget's marker pipeline: a non-hidden objective must resolve to a world
  // marker (target / parked vehicle / scripted quarry / checkpoint stops) or be a kind that
  // legitimately has no place (lose-wanted, survive, choice). Owner playtest: "no clue on the
  // minimap about what to go to" — this keeps every future mission honest.
  it('audits all missions', async () => {
    const { PARKED_VEHICLES } = await import('../world/placements');
    for (const mission of MISSIONS) {
      const script = MISSION_SCRIPTS[mission.id];
      mission.objectives.forEach((objective, index) => {
        const label = `${mission.id}[${index}] ${objective.kind}`;
        if (objective.hidden) { expect(objective.target, `${label}: hidden riddles still need a real reach target`).toBeDefined(); return; }
        switch (objective.kind) {
          case 'reach': case 'escape':
            expect(Boolean(objective.target) || Boolean(objective.conditionsOnly && objective.conditions), `${label}: needs a target (marker) or be conditionsOnly`).toBe(true);
            break;
          case 'collect':
            expect(objective.target, `${label}: collect needs a target (reach check + marker)`).toBeDefined();
            break;
          case 'checkpoints':
            expect((script?.stops?.length ?? 0) >= (objective.required ?? 1), `${label}: needs ${objective.required} stops in MISSION_SCRIPTS`).toBe(true);
            break;
          case 'enter-kind': {
            const parked = PARKED_VEHICLES.some((entry) => entry.kind === objective.vehicleKind && (!objective.vehicleColor || entry.color === objective.vehicleColor));
            expect(parked, `${label}: no parked ${objective.vehicleKind} (colour ${objective.vehicleColor?.toString(16)}) exists for the blip`).toBe(true);
            break;
          }
          case 'follow':
            expect(script?.quarry?.destination, `${label}: follow needs a scripted quarry with a destination`).toBeDefined();
            break;
          case 'defeat': {
            const covered = (script?.waves ?? []).some((wave) => wave.objective === index || (wave.checkpoint !== undefined && wave.objective === index - 1));
            expect(covered, `${label}: defeat needs a hostile wave at this objective (or the checkpoint before it)`).toBe(true);
            break;
          }
          case 'lose-wanted': case 'survive': case 'choice':
            break; // legitimately location-free
        }
      });
    }
  });
});
