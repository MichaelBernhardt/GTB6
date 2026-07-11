import { describe, expect, it } from 'vitest';
import { computeJunctionSurfaces, JUNCTION_SURFACES, SIGNAL_JUNCTIONS } from './mapData';
import { signalHoldsDriver, signalPhaseState, SIGNAL_STOP_APPROACH, type JunctionDefinition } from './UrbanInfrastructure';

describe('intersection surfaces (BUG B: unify overlapping road ribbons)', () => {
  it('paves a sane number of real crossings, every one degree >= 3', () => {
    // Degree < 3 is a single ribbon passing through or two roads meeting end-to-end: no overlap to fix.
    expect(JUNCTION_SURFACES.length).toBeGreaterThan(1000);
    expect(JUNCTION_SURFACES.length).toBeLessThan(2500);
    expect(JUNCTION_SURFACES.every((surface) => surface.degree >= 3)).toBe(true);
  });

  it('sizes each disc to span the widest meeting carriageway (covers the overlap, floods no verge)', () => {
    // radius must reach at least across the widest road's half-width so the disc covers where a
    // crossing ribbon overlaps it; the margin cap keeps it from spilling far into the sidewalks.
    expect(JUNCTION_SURFACES.every((surface) => surface.radius >= surface.widest / 2)).toBe(true);
    expect(JUNCTION_SURFACES.every((surface) => surface.radius <= surface.widest / 2 + 1.001)).toBe(true);
    expect(JUNCTION_SURFACES.every((surface) => surface.widest >= 5)).toBe(true);
  });

  it('places every signalised junction on a paved surface (signals are a subset of the crossings)', () => {
    const surfaceKeys = new Set(JUNCTION_SURFACES.map((surface) => `${surface.x}|${surface.z}`));
    expect(SIGNAL_JUNCTIONS.every((junction) => surfaceKeys.has(`${junction.x}|${junction.z}`))).toBe(true);
  });

  it('is deterministic and tightens to fewer crossings as the minimum degree rises', () => {
    expect(JSON.stringify(computeJunctionSurfaces())).toBe(JSON.stringify(computeJunctionSurfaces()));
    const crossOnly = computeJunctionSurfaces({ minDegree: 4 });
    expect(crossOnly.length).toBeLessThan(JUNCTION_SURFACES.length);
    expect(crossOnly.every((surface) => surface.degree >= 4)).toBe(true);
    // margin is tunable and flows straight into the radius
    expect(computeJunctionSurfaces({ margin: 3 }).every((surface) => surface.radius === surface.widest / 2 + 3)).toBe(true);
  });
});

describe('robot phase cycle (BUG A: shared clock for lens + AI)', () => {
  it('runs green -> amber -> red across the 30s loop', () => {
    expect(signalPhaseState(0, 0, 0)).toBe('green');
    expect(signalPhaseState(0, 0, 10.9)).toBe('green');
    expect(signalPhaseState(0, 0, 11)).toBe('amber');
    expect(signalPhaseState(0, 0, 13.9)).toBe('amber');
    expect(signalPhaseState(0, 0, 14)).toBe('red');
    expect(signalPhaseState(0, 0, 29.9)).toBe('red');
  });

  it('wraps the loop and never lets both carriageway axes run green together', () => {
    expect(signalPhaseState(0, 0, 30)).toBe('green'); // wrapped back to cycle 0
    expect(signalPhaseState(0, 0, 61)).toBe(signalPhaseState(0, 0, 1));
    expect(signalPhaseState(0, 1, 0)).toBe('red'); // cross axis is 15s out of phase
    for (let t = 0; t < 30; t += 0.25) {
      expect(signalPhaseState(0, 0, t) === 'green' && signalPhaseState(0, 1, t) === 'green').toBe(false);
    }
  });
});

describe('drivers obey robots (BUG A: minimal stop-on-red)', () => {
  // angle 0 => roadA runs along +z (forward = (sin0, cos0) = (0, 1)); axis 0 is a car heading +z.
  const junction: JunctionDefinition = { x: 0, z: 0, angle: 0, roadA: 'MAIN', roadB: 'CROSS', phase: 0, widest: 20 };

  it('holds an approaching car on a red axis but waves it through on green', () => {
    expect(signalHoldsDriver(junction, 0, -15, 0, 20)).toBe(true); // axis 0 is red at t=20
    expect(signalHoldsDriver(junction, 0, -15, 0, 0)).toBe(false); // axis 0 is green at t=0
  });

  it('lets the cross axis flow while the main axis is stopped', () => {
    const eastHeading = Math.PI / 2; // dir = (1, 0): a car on the cross road (axis 1)
    expect(signalHoldsDriver(junction, -15, 0, eastHeading, 0)).toBe(true); // axis 1 is red at t=0
    expect(signalHoldsDriver(junction, 0, -15, 0, 0)).toBe(false); // main axis green at the same instant
  });

  it('ignores cars driving away, already committed into the box, or beyond the hold ring', () => {
    expect(signalHoldsDriver(junction, 0, 15, 0, 20)).toBe(false); // north of the box heading +z: moving away
    expect(signalHoldsDriver(junction, 0, -2, 0, 20)).toBe(false); // inside the box: commit through, don't freeze mid-junction
    const farOut = junction.widest / 2 + SIGNAL_STOP_APPROACH + 5;
    expect(signalHoldsDriver(junction, 0, -farOut, 0, 20)).toBe(false); // past the hold ring
  });
});
