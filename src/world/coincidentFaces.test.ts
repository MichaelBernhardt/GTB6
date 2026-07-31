/**
 * No wall in this city is drawn twice — and no new massing gets to reintroduce the bug.
 *
 * The MARTIAL x SMAL corner tower shipped 925 u² of z-fighting facade because its L-plan's two
 * ground tiers both computed their -X flank as x - w/2: same plane, one material, no tie-breaker,
 * and a per-box UV origin that drew every window twice a third of a bay apart. The sweep below
 * plans the ENTIRE real parcel list and holds it at zero visible coincident pairs — massing boxes
 * and their concrete foundation mirrors — so the failure mode is structurally extinct, not just
 * fixed where it was reported. The unit cases first prove the detector can actually see the bug
 * it guards against (a detector that matches nothing would also report a clean city).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, type BuildingSpec, type MassingBox } from './BuildingArchitecture';
import { COINCIDENT_SEPARATION, auditProfile, coincidentPairs, depthResolutionAt } from './coincidentFaces';
import { allBuildings } from './CityGen';
import { districtAt } from './mapData';
import { neighbourhoodBuildingVariant, neighbourhoodFacadeIndex } from './data/neighbourhoods';
import { facadeWorldTile } from './ProceduralMaterials';

const box = (x: number, y: number, z: number, width: number, height: number, depth: number, rounded = false): MassingBox =>
  ({ x, y, z, width, height, depth, rounded });

describe('coincidentPairs detector', () => {
  it('sees the corner-tower bug: two tiers sharing a flank plane by construction', () => {
    // The shipped massing-9 shape at the reported building's proportions: both -X extremes at x - w/2.
    const pairs = coincidentPairs([
      box(0, 16, -10.6, 33.6, 31.7, 29.1),
      box(-8.4, 16, 0, 16.8, 31.7, 53.0),
    ]);
    const visible = pairs.filter((pair) => pair.verdict === 'visible');
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.some((pair) => pair.axis === 'x' && pair.sign === -1 && pair.area > 500)).toBe(true);
  });

  it('ignores opposite-facing contact: a wing seated against a flank is not a fight', () => {
    // Disjoint halves touching at x = 0: the wing's +X face against the arm's -X face.
    expect(coincidentPairs([
      box(8.4, 16, -10.6, 16.8, 31.7, 29.1),
      box(-8.4, 16, 0, 16.8, 31.7, 53.0),
    ])).toEqual([]);
  });

  it('classifies grounded undersides and podium-seated tower bottoms as harmless', () => {
    const grounded = coincidentPairs([box(0, 10.2, 0, 20, 20, 20), box(12, 8.2, 0, 8, 16, 12)]);
    expect(grounded.map((pair) => pair.verdict)).toContain('buried-underside');
    expect(grounded.filter((pair) => pair.verdict === 'visible')).toEqual([]);
    // Two towers overlapping in plan, both resting on one podium: their undersides share the
    // podium-top plane but only the inside of the podium can see either.
    const seated = coincidentPairs([
      box(0, 5.2, 0, 40, 10, 40),
      box(-5, 25.2, 0, 20, 30, 20),
      box(5, 22.2, 0, 20, 24, 16),
    ]);
    expect(seated.filter((pair) => pair.axis === 'y' && pair.sign === -1).map((pair) => pair.verdict)).toContain('seated-underside');
    expect(seated.filter((pair) => pair.verdict === 'visible')).toEqual([]);
  });

  it('classifies coplanar roof tops under a covering gable as harmless, but bare ones as visible', () => {
    const overlapping = [box(0, 10.2, 0, 20, 20, 11), box(4, 10.2, 4, 10, 20, 18)];
    const bare = coincidentPairs(overlapping);
    expect(bare.filter((pair) => pair.axis === 'y' && pair.sign === 1).map((pair) => pair.verdict)).toContain('visible');
    const covered = coincidentPairs(overlapping, [{ x: 0, z: 0, width: 22, depth: 13, y: 20.2, rise: 3, ry: 0 },
      { x: 4, z: 4, width: 11, depth: 19, y: 20.2, rise: 3, ry: 0 }]);
    expect(covered.filter((pair) => pair.verdict === 'visible')).toEqual([]);
  });

  it('derives the coincidence threshold from the real camera, not a guess', () => {
    // near 0.1 (src/Game.ts), 24-bit depth: ~0.6 mm resolution at 100 u, ~54 mm at the 300 u sightline.
    expect(depthResolutionAt(100)).toBeCloseTo(0.006, 3);
    expect(COINCIDENT_SEPARATION).toBeCloseTo(0.0536, 3);
  });
});

describe('the real city', () => {
  // The parcel derivation is module-memoized but this worker may be the one that derives it cold
  // (~15 s, same budget the bake gate pays); the 3,712 plan() calls after that take under a second.
  it('has no visible coincident exterior faces on any building, massing or foundation', { timeout: 120_000 }, () => {
    const architecture = new BuildingArchitecture(new THREE.Group());
    const facade = new THREE.MeshBasicMaterial(); const roof = new THREE.MeshBasicMaterial();
    const buildings = allBuildings();
    expect(buildings.length).toBeGreaterThan(3000); // an empty sweep must not pass
    const failures: string[] = [];
    let harmless = 0;
    for (const building of buildings) {
      const district = districtAt(building.x, building.z);
      const variant = neighbourhoodBuildingVariant(district, building.variant);
      const spec: BuildingSpec = {
        x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
        style: building.style, variant, facade, roof,
        facadeTile: facadeWorldTile(neighbourhoodFacadeIndex(district, building.style, building.variant)),
      };
      for (const pair of auditProfile(architecture.plan(spec))) {
        if (pair.verdict !== 'visible') { harmless++; continue; }
        const massing = variant % ARCHITECTURE_VARIANTS[building.style];
        failures.push(`${building.style} m${massing} at ${building.x.toFixed(0)},${building.z.toFixed(0)}: `
          + `${pair.boxI < 0 ? 'foundation' : 'massing'} ${pair.axis}${pair.sign > 0 ? '+' : '-'} gap ${pair.gap.toFixed(4)} area ${pair.area.toFixed(1)} u²`);
      }
    }
    expect(failures, `${failures.length} visible coincident face pair(s):\n${failures.slice(0, 12).join('\n')}`).toEqual([]);
    // The sweep must still be SEEING faces — a broken enumerator would also report a clean city.
    expect(harmless).toBeGreaterThan(100);
  });
});
