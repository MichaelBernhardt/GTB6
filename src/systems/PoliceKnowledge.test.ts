import { describe, expect, it } from 'vitest';
import { determineReporter, pickRoamGoal, PoliceKnowledge, radioCallout, REPORT_DELAY, ROAM_RADIUS, SIGHT_RADIUS, WITNESS_RADIUS, type WitnessCandidate } from './PoliceKnowledge';

const ped = (x: number, z: number, alive = true, victim = false): WitnessCandidate<string> => ({ ref: `${x},${z}${victim ? ':victim' : ''}`, x, z, alive, victim });

describe('witness determination', () => {
  it('picks the nearest living bystander within the witness radius', () => {
    const far = ped(WITNESS_RADIUS - 2, 0); const near = ped(5, 0);
    expect(determineReporter(0, 0, [far, near])).toBe(near.ref);
  });

  it('files no report when everyone nearby is dead or out of range', () => {
    expect(determineReporter(0, 0, [ped(5, 0, false), ped(WITNESS_RADIUS + 10, 0)])).toBeUndefined();
    expect(determineReporter(0, 0, [])).toBeUndefined();
  });

  it('lets a surviving victim report the attack themselves', () => {
    const victim = ped(0, 0, true, true);
    expect(determineReporter(0, 0, [victim])).toBe(victim.ref);
  });

  it('dead victims cannot report, and victims never double as bystanders', () => {
    expect(determineReporter(0, 0, [ped(0, 0, false, true)])).toBeUndefined();
    const victim = ped(1, 0, true, true); const bystander = ped(9, 0);
    expect(determineReporter(0, 0, [bystander, victim])).toBe(victim.ref);
  });

  it('honors a per-crime radius override', () => {
    const witness = ped(50, 0);
    expect(determineReporter(0, 0, [witness])).toBeUndefined();
    expect(determineReporter(0, 0, [witness], 58)).toBe(witness.ref);
  });
});

describe('report maturation', () => {
  it('holds heat and lastKnown until REPORT_DELAY elapses, then lands at the crime scene', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(12, -8, 14, 'witness');
    expect(knowledge.update(REPORT_DELAY - 1)).toEqual([]);
    expect(knowledge.lastKnown).toBeNull();
    const matured = knowledge.update(2);
    expect(matured.map((report) => report.heat)).toEqual([14]);
    expect(knowledge.lastKnown).toMatchObject({ x: 12, z: -8 });
    expect(knowledge.pendingReports).toBe(0);
  });

  it('matures stacked reports independently on the dispatch clock', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(0, 0, 7, 'a');
    knowledge.update(10);
    knowledge.fileReport(30, 30, 24, 'b');
    expect(knowledge.update(REPORT_DELAY - 10).map((report) => report.heat)).toEqual([7]);
    expect(knowledge.lastKnown).toMatchObject({ x: 0, z: 0 });
    expect(knowledge.update(10).map((report) => report.heat)).toEqual([24]);
    expect(knowledge.lastKnown).toMatchObject({ x: 30, z: 30 });
  });

  it('cancels a pending report when its reporter dies inside the delay window', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(5, 5, 20, 'witness');
    knowledge.update(5, () => false);
    expect(knowledge.pendingReports).toBe(0);
    expect(knowledge.update(REPORT_DELAY)).toEqual([]);
    expect(knowledge.lastKnown).toBeNull();
  });

  it('supports reputation-adjusted report delays', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(4, 6, 8, 'witness', 10);
    expect(knowledge.update(9)).toEqual([]);
    expect(knowledge.update(1).map((report) => report.heat)).toEqual([8]);
  });
});

describe('cop-witnessed crimes and sightings', () => {
  it('cop witness updates lastKnown immediately with nothing queued', () => {
    const knowledge = new PoliceKnowledge();
    knowledge.copWitness(3, 4);
    expect(knowledge.lastKnown).toMatchObject({ x: 3, z: 4 });
    expect(knowledge.pendingReports).toBe(0);
  });

  it('sightings continuously refresh lastKnown with a newer timestamp', () => {
    const knowledge = new PoliceKnowledge();
    knowledge.sight(1, 1);
    const first = knowledge.lastKnown;
    knowledge.update(2);
    knowledge.sight(9, 9);
    expect(knowledge.lastKnown).toMatchObject({ x: 9, z: 9 });
    expect(knowledge.lastKnown!.time).toBeGreaterThan(first!.time);
  });

  it('a matured report moves lastKnown to the crime scene, not the player', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.sight(100, 100);
    knowledge.fileReport(-20, -20, 10, 'witness');
    knowledge.update(REPORT_DELAY + 1);
    expect(knowledge.lastKnown).toMatchObject({ x: -20, z: -20 });
  });

  it('reset wipes all police knowledge', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.sight(1, 1); knowledge.fileReport(2, 2, 5, 'witness');
    knowledge.reset();
    expect(knowledge.lastKnown).toBeNull();
    expect(knowledge.pendingReports).toBe(0);
    expect(knowledge.sightingAge).toBeNull();
  });
});

describe('sighting age', () => {
  it('is null before any officer has ever seen the player', () => {
    expect(new PoliceKnowledge().sightingAge).toBeNull();
  });

  it('tracks seconds since the last live sighting and refreshes on re-sight', () => {
    const knowledge = new PoliceKnowledge();
    knowledge.sight(1, 1);
    expect(knowledge.sightingAge).toBe(0);
    knowledge.update(4);
    expect(knowledge.sightingAge).toBe(4);
    knowledge.sight(2, 2);
    expect(knowledge.sightingAge).toBe(0);
  });

  it('treats a cop-witnessed crime as a sighting', () => {
    const knowledge = new PoliceKnowledge();
    knowledge.copWitness(3, 4);
    expect(knowledge.sightingAge).toBe(0);
  });

  it('never counts civilian reports as sightings, pending or matured', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(5, 5, 10, 'witness');
    expect(knowledge.sightingAge).toBeNull();
    knowledge.update(REPORT_DELAY + 1);
    expect(knowledge.lastKnown).toMatchObject({ x: 5, z: 5 });
    expect(knowledge.sightingAge).toBeNull();
  });
});

describe('roam destination selection', () => {
  const nodes = [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 0, z: 50 }, { x: 200, z: 200 }, { x: -300, z: 10 }];

  it('only ever picks nodes within ROAM_RADIUS of the last known position', () => {
    for (const roll of [0, 0.34, 0.67, 0.99]) {
      const goal = pickRoamGoal(nodes, { x: 0, z: 0 }, ROAM_RADIUS, () => roll);
      const node = nodes[goal]!;
      expect(Math.hypot(node.x, node.z)).toBeLessThanOrEqual(ROAM_RADIUS);
    }
  });

  it('falls back to the nearest node when none sit inside the radius', () => {
    expect(pickRoamGoal([{ x: 90, z: 0 }, { x: 500, z: 0 }], { x: 0, z: 0 })).toBe(0);
    expect(pickRoamGoal([], { x: 0, z: 0 })).toBe(-1);
  });
});

describe('radio dispatch', () => {
  it('tags a report with its crime label at filing time and carries it to maturity', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(1, 2, 14, 'witness', REPORT_DELAY, 'mugging');
    knowledge.fileReport(3, 4, 30, 'witness', REPORT_DELAY, 'explosion');
    expect(knowledge.update(REPORT_DELAY + 1).map((report) => report.label)).toEqual(['mugging', 'explosion']);
  });

  it('defaults unlabeled reports to assault', () => {
    const knowledge = new PoliceKnowledge<string>();
    knowledge.fileReport(0, 0, 5, 'witness');
    expect(knowledge.update(REPORT_DELAY)[0]!.label).toBe('assault');
  });

  it('phrases a matured 911 call as a fresh report of the crime in its district', () => {
    expect(radioCallout('mugging', 'Sandton')).toEqual({ title: 'Mugging reported in Sandton', detail: 'Caller phoned it in. Units en route.' });
    expect(radioCallout('vehicle arson', 'Joburg CBD').title).toBe('Vehicle arson reported in Joburg CBD');
  });

  it('gives cop-witnessed crimes units-responding flavor instead of a caller', () => {
    const callout = radioCallout('gunfire', 'Braamfontein', true);
    expect(callout.title).toBe('Gunfire in progress in Braamfontein');
    expect(callout.detail).toContain('units responding');
    expect(callout.detail).not.toContain('Caller');
  });
});

describe('perception constants', () => {
  it('keeps the tuning knobs in sane relation', () => {
    expect(REPORT_DELAY).toBe(30);
    expect(SIGHT_RADIUS).toBeGreaterThan(WITNESS_RADIUS);
    expect(ROAM_RADIUS).toBeGreaterThan(SIGHT_RADIUS);
  });
});
