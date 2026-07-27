import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { AIRPORT, GENERATED_ROADS } from './mapData';
import { buildLightAircraft, fenceRuns, lineDashes, rectFromQuad, rectPoint } from './Airport';

describe('AIRPORT map data', () => {
  it('parses the generated airport block', () => {
    expect(AIRPORT).toBeDefined();
    expect(AIRPORT!.runway.width).toBeGreaterThanOrEqual(10);
    expect(AIRPORT!.runway.points.length).toBeGreaterThanOrEqual(2);
    expect(AIRPORT!.taxiway.width).toBeGreaterThan(0);
    expect(AIRPORT!.apron.area).toBeGreaterThan(10_000);
    expect(AIRPORT!.buildings.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the runway and taxiway out of the driveable road network', () => {
    expect(GENERATED_ROADS.some((road) => road.kind === 'runway' || road.kind === 'taxiway')).toBe(false);
    const runway = AIRPORT!.runway.points;
    // No generated road shares a vertex with the runway centreline (it can't have leaked into nav/spawns).
    const runwayKeys = new Set(runway.map((point) => `${point.x}|${point.z}`));
    expect(GENERATED_ROADS.some((road) => road.points.some((point) => runwayKeys.has(`${point.x}|${point.z}`)))).toBe(false);
  });
});

describe('rectFromQuad', () => {
  const quad = [{ x: 10, z: 10 }, { x: 14, z: 10 }, { x: 14, z: 12 }, { x: 10, z: 12 }]; // 4×2, axis-aligned

  it('recovers centre and half extents with the long axis as u', () => {
    const rect = rectFromQuad(quad);
    expect(rect.cx).toBeCloseTo(12); expect(rect.cz).toBeCloseTo(11);
    expect(rect.hw).toBeCloseTo(2); expect(rect.hd).toBeCloseTo(1);
  });

  it('rectPoint(hw, hd) lands on a corner of the quad', () => {
    const rect = rectFromQuad(quad);
    const corner = rectPoint(rect, rect.hw, rect.hd);
    expect(quad.some((point) => Math.hypot(point.x - corner.x, point.z - corner.z) < 1e-6)).toBe(true);
  });

  it('recovers a rotated quad', () => {
    const angle = 0.6; const c = Math.cos(angle); const s = Math.sin(angle);
    const rotated = quad.map((point) => ({ x: 12 + (point.x - 12) * c - (point.z - 11) * s, z: 11 + (point.x - 12) * s + (point.z - 11) * c }));
    const rect = rectFromQuad(rotated);
    expect(rect.cx).toBeCloseTo(12); expect(rect.cz).toBeCloseTo(11);
    expect(rect.hw).toBeCloseTo(2); expect(rect.hd).toBeCloseTo(1);
    expect(Math.hypot(rect.ux, rect.uz)).toBeCloseTo(1);
    expect(rect.ux * rect.vx + rect.uz * rect.vz).toBeCloseTo(0); // u ⊥ v
  });
});

describe('lineDashes', () => {
  it('spaces dashes by pitch inside the margins', () => {
    const dashes = lineDashes({ x: 0, z: 0 }, { x: 100, z: 0 }, 10, 20, 10);
    expect(dashes.map((dash) => dash.x)).toEqual([15, 35, 55, 75]);
    for (const dash of dashes) { expect(dash.z).toBe(0); expect(dash.dirX).toBeCloseTo(1); expect(dash.dirZ).toBeCloseTo(0); }
    expect(dashes.at(-1)!.x + dashes.at(-1)!.len / 2).toBeLessThanOrEqual(90); // last dash respects the far margin
  });

  it('returns nothing when the line is shorter than its margins', () => {
    expect(lineDashes({ x: 0, z: 0 }, { x: 15, z: 0 }, 10, 20, 10)).toEqual([]);
  });
});

describe('fenceRuns', () => {
  const square = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }];

  it('covers an unblocked boundary edge-for-edge', () => {
    const runs = fenceRuns(square, 5, () => false);
    expect(runs.length).toBe(4);
    const total = runs.reduce((sum, run) => sum + Math.hypot(run.bx - run.ax, run.bz - run.az), 0);
    expect(total).toBeCloseTo(400);
  });

  it('leaves a gate gap where a road crosses an edge', () => {
    const runs = fenceRuns(square, 5, (x, z) => z === 0 && x > 40 && x < 60);
    const south = runs.filter((run) => run.az === 0 && run.bz === 0);
    expect(south.length).toBe(2);
    for (const run of south) for (const blockedX of [45, 50, 55]) {
      expect(blockedX < Math.min(run.ax, run.bx) || blockedX > Math.max(run.ax, run.bx)).toBe(true);
    }
  });
});

/** Every vertex of an airframe, in its own local space. */
const hull = (craft: { group: THREE.Object3D }): THREE.Box3 => new THREE.Box3().setFromObject(craft.group);

describe('buildLightAircraft', () => {
  // Compares the actual vertex data, not a child count: the airframe merges per material, so counting
  // children would have measured how the parts happened to be batched rather than what was built.
  it('is deterministic per seed', () => {
    const first = hull(buildLightAircraft(7)); const second = hull(buildLightAircraft(7));
    expect(first.min.toArray()).toEqual(second.min.toArray());
    expect(first.max.toArray()).toEqual(second.max.toArray());
    expect(buildLightAircraft(7).prop.position.toArray()).toEqual(buildLightAircraft(7).prop.position.toArray());
  });

  it('reports a sane parked footprint (wheels on y=0, nose along +z)', () => {
    const craft = buildLightAircraft(3);
    expect(craft.halfSpan).toBeGreaterThan(3);
    expect(craft.halfLength).toBeGreaterThan(3);
    expect(craft.height).toBeLessThan(5);
    const box = hull(craft);
    expect(box.min.y).toBeGreaterThan(-0.02); // wheels sit ON the apron, nothing buried under it
    expect(box.min.y).toBeLessThan(0.05);
    expect(box.max.y).toBeLessThan(craft.height); // the declared collider height really covers the fin
    expect(box.max.x).toBeLessThanOrEqual(craft.halfSpan); // and the declared span really covers the tips
    expect(box.max.x).toBeGreaterThan(craft.halfSpan * 0.8);
    // Nose toward +z: the prop sits at the front of the airframe and the tail runs further aft.
    expect(craft.prop.position.z).toBeGreaterThan(box.max.z * 0.8);
    expect(-box.min.z).toBeGreaterThan(box.max.z);
  });

  it('draws the whole airframe in a handful of meshes', () => {
    let meshes = 0; let tris = 0;
    buildLightAircraft(5).group.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      tris += (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position!.count) / 3;
    });
    expect(meshes).toBeLessThanOrEqual(6); // five of these are parked on the apron: draw calls are paid per plane
    expect(tris).toBeLessThan(2000);
  });
});
