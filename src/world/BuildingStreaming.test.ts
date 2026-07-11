import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BuildingArchitecture } from './BuildingArchitecture';
import { GeometryBaker } from './StaticGeometry';
import { allBuildings, CELL_SIZE, generateCell, type GeneratedBuilding } from './CityGen';

// Mirrors City.buildOneBuilding closely enough for a geometry-determinism check: build each building at
// the origin, rotate it to face its street, place it. Shared materials stand in for City's cached
// facade/roof set so the per-cell merge collapses identical materials just like the runtime does.
const facade = new THREE.MeshStandardMaterial({ color: 0x99a4a9, roughness: 0.72 });
const roof = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86 });

function buildingGroup(arch: BuildingArchitecture, spec: GeneratedBuilding): THREE.Group {
  const group = new THREE.Group();
  arch.retarget(group);
  arch.build({ x: 0, z: 0, width: spec.width, depth: spec.depth, height: spec.height, style: spec.style, variant: spec.variant, facade, roof });
  group.position.set(spec.x, 0, spec.z); group.rotation.y = spec.heading;
  return group;
}

/** Bake a cell the way City streams it (one building at a time) and return draw-call + vertex totals. */
function bakeCell(cellX: number, cellZ: number): { meshes: number; vertices: number } {
  const target = new THREE.Group();
  const arch = new BuildingArchitecture(target);
  const baker = new GeometryBaker();
  for (const spec of generateCell(cellX, cellZ)) {
    const group = buildingGroup(arch, spec);
    baker.addObject(group);
    group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  }
  baker.finalize(target);
  let meshes = 0; let vertices = 0;
  target.traverse((object) => { if (object instanceof THREE.Mesh) { meshes++; vertices += object.geometry.getAttribute('position').count; } });
  return { meshes, vertices };
}

const densest = (() => {
  const counts = new Map<string, number>();
  for (const b of allBuildings()) { const k = `${Math.floor(b.x / CELL_SIZE)},${Math.floor(b.z / CELL_SIZE)}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
  let key = '0,0'; let best = 0;
  for (const [k, n] of counts) if (n > best) { best = n; key = k; }
  return key.split(',').map(Number) as [number, number];
})();

describe('on-demand building mesh streaming', () => {
  it('collapses a whole cell of buildings into a handful of draw calls (per-cell merge)', () => {
    const { meshes, vertices } = bakeCell(densest[0], densest[1]);
    expect(vertices).toBeGreaterThan(0);
    expect(meshes).toBeGreaterThan(0);
    expect(meshes).toBeLessThanOrEqual(40); // a dozen-odd merged meshes, not one per building
  });

  it('regenerates identical geometry after disposal (generate → dispose → regenerate)', () => {
    const first = bakeCell(densest[0], densest[1]);
    const again = bakeCell(densest[0], densest[1]);
    expect(again).toEqual(first);
  });

  it('produces no meshes for an empty cell', () => {
    expect(bakeCell(9999, 9999)).toEqual({ meshes: 0, vertices: 0 });
  });
});
