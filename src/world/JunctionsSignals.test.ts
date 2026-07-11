import { describe, expect, it } from 'vitest';
import { computeJunctionSurfaces, computeStopLines, JUNCTION_SURFACES, junctionPaves, junctionReach, SIGNAL_JUNCTIONS } from './mapData';
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

  it('gives every crossing its distinct incident arms (unit dirs, no opposed duplicates)', () => {
    for (const surface of JUNCTION_SURFACES) {
      expect(surface.arms.length).toBeGreaterThanOrEqual(1); // usually 2+ dirs; collinear stubs collapse to one
      for (const arm of surface.arms) {
        expect(Math.hypot(arm.dirX, arm.dirZ)).toBeCloseTo(1); // unit direction
        expect(arm.width).toBeGreaterThan(0);
      }
      // a through-road's two opposed vertices collapse to one arm: no near-antiparallel pair survives
      for (let i = 0; i < surface.arms.length; i++) for (let j = i + 1; j < surface.arms.length; j++) {
        const a = surface.arms[i]!; const b = surface.arms[j]!;
        expect(Math.abs(a.dirX * b.dirX + a.dirZ * b.dirZ)).toBeLessThan(0.986);
      }
    }
  });

  it('paves the whole square crossing — the four corners a bare disc would leave poking out (BUG A)', () => {
    // A 4-way of two width-W roads is a WxW square; its corners sit at ~0.71W from the node, outside the
    // widest/2+1 disc. The arm strips must cover them, else the ribbon edges show as an "X". Test the shared
    // corners of every near-orthogonal pair of carriageways at each crossing.
    let orthogonalCrossings = 0;
    for (const surface of JUNCTION_SURFACES) {
      for (let i = 0; i < surface.arms.length; i++) for (let j = i + 1; j < surface.arms.length; j++) {
        const a = surface.arms[i]!; const b = surface.arms[j]!;
        if (Math.abs(a.dirX * b.dirX + a.dirZ * b.dirZ) > 0.35) continue; // only the ~perpendicular pairs form a square
        orthogonalCrossings++;
        const half = Math.min(a.width, b.width) / 2 - 0.4; // just inside where the two ribbons share a corner
        for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
          const x = surface.x + (a.dirX * sa + b.dirX * sb) * half;
          const z = surface.z + (a.dirZ * sa + b.dirZ * sb) * half;
          expect(junctionPaves(surface, x, z)).toBe(true); // corner is paved, not bare tar with a ribbon seam
        }
      }
    }
    expect(orthogonalCrossings).toBeGreaterThan(100); // the CBD grid is full of them
  });

  it('blanks lane markings across the junction: reach spans the crossing and covers the disc', () => {
    for (const surface of JUNCTION_SURFACES) {
      const reach = junctionReach(surface);
      expect(reach).toBeGreaterThanOrEqual(surface.radius); // never smaller than the centre disc
      expect(reach).toBeGreaterThanOrEqual(surface.widest * 0.71); // spans the square crossing's half-diagonal
      expect(junctionPaves(surface, surface.x, surface.z)).toBe(true); // the node centre is always paved
    }
  });

  it('picks stop-line approaches by SA hierarchy: 4-way all, T stem only, robots all', () => {
    const cross = [ // two through roads crossing: a 4-way
      { name: 'Main', width: 12, dirX: 1, dirZ: 0 }, { name: 'Main', width: 12, dirX: -1, dirZ: 0 },
      { name: 'Cross', width: 12, dirX: 0, dirZ: 1 }, { name: 'Cross', width: 12, dirX: 0, dirZ: -1 },
    ];
    expect(computeStopLines(cross, false).length).toBe(4); // every approach of a 4-way stops

    const tee = [ // a through main + a terminating stem
      { name: 'Main', width: 14, dirX: 1, dirZ: 0 }, { name: 'Main', width: 14, dirX: -1, dirZ: 0 },
      { name: 'Stem', width: 8, dirX: 0, dirZ: 1 },
    ];
    const teeLines = computeStopLines(tee, false);
    expect(teeLines.length).toBe(1); // only the stem stops...
    expect(teeLines[0]).toMatchObject({ dirX: 0, dirZ: 1, width: 8 }); // ...and it is the stem, not the main road
    expect(computeStopLines(tee, true).length).toBe(3); // but a robot on that same T stops all three approaches
  });

  it('stop lines are well-formed, and the through-road exemption really fires on real T-junctions', () => {
    for (const surface of JUNCTION_SURFACES) {
      for (const line of surface.stopLines) {
        expect(Math.hypot(line.dirX, line.dirZ)).toBeCloseTo(1);
        expect(line.width).toBeGreaterThan(0);
      }
    }
    // A real T (one through-road collapses to a single arm + a stem) paints exactly the stem: fewer lines
    // than it has approaches, proving the main road stays bare.
    const tees = JUNCTION_SURFACES.filter((s) => s.degree === 3 && s.arms.length === 2 && s.stopLines.length === 1);
    expect(tees.length).toBeGreaterThan(20);
    // True 4-way crossings (two through-roads) paint every approach: four stop lines.
    const crossings = JUNCTION_SURFACES.filter((s) => s.degree >= 4 && s.stopLines.length >= 4);
    expect(crossings.length).toBeGreaterThan(15);
    // Signalised junctions stop every approach — never fewer lines than distinct arms, always at least one.
    const signalKeys = new Set(SIGNAL_JUNCTIONS.map((j) => `${j.x}|${j.z}`));
    for (const surface of JUNCTION_SURFACES) {
      if (!signalKeys.has(`${surface.x}|${surface.z}`)) continue;
      expect(surface.stopLines.length).toBeGreaterThanOrEqual(surface.arms.length);
    }
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
