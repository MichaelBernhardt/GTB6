import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, type BuildingSpec, type BuildingStyle } from './BuildingArchitecture';
import { GeometryBaker } from './StaticGeometry';

const facade = new THREE.MeshStandardMaterial({ color: 0x99a4a9, roughness: 0.72 });
const roof = new THREE.MeshStandardMaterial({ color: 0x424a4c, roughness: 0.86 });
const spec: BuildingSpec = { x: 7, z: -5, width: 30, depth: 22, height: 60, style: 'downtown', variant: 4, facade, roof };

function build(buildingSpec = spec): THREE.Group {
  const group = new THREE.Group();
  new BuildingArchitecture(group).build(buildingSpec);
  group.updateWorldMatrix(true, true);
  return group;
}

function radiiAt(buildingSpec: BuildingSpec, y: number): { rx: number; rz: number } {
  const podiumH = Math.min(9, buildingSpec.height * 0.2); const towerH = buildingSpec.height - podiumH;
  const t = THREE.MathUtils.clamp((y - podiumH - 0.2) / towerH, 0, 1); const taper = THREE.MathUtils.lerp(1.04, 1, t);
  const rz = buildingSpec.depth * 0.39 * taper;
  return { rx: rz * buildingSpec.width / Math.max(buildingSpec.depth, 1), rz };
}

function bakedPositions(): number[][] {
  const source = build(); const target = new THREE.Group(); const baker = new GeometryBaker();
  baker.addObject(source);
  source.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  baker.finalize(target);
  const positions: number[][] = [];
  target.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const values = Array.from(object.geometry.getAttribute('position').array as ArrayLike<number>);
    expect(values.every(Number.isFinite)).toBe(true);
    positions.push(values);
  });
  target.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
  return positions;
}

describe('cylindrical downtown architecture', () => {
  it('keeps every ring and mullion vertex in a tight envelope around the tapered facade', () => {
    const group = build(); const details: THREE.Mesh[] = [];
    group.traverse((object) => { if (object instanceof THREE.Mesh && object.userData.curvedFacadeDetail) details.push(object); });
    expect(details.filter((mesh) => mesh.userData.curvedFacadeDetail === 'ring').length).toBeGreaterThan(2);
    expect(details.filter((mesh) => mesh.userData.curvedFacadeDetail === 'mullion').length).toBeGreaterThan(10);

    const vertex = new THREE.Vector3();
    for (const mesh of details) {
      const signedDistances: number[] = []; const position = mesh.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
        const dx = vertex.x - spec.x; const dz = vertex.z - spec.z; const distance = Math.hypot(dx, dz);
        const { rx, rz } = radiiAt(spec, vertex.y);
        const facadeDistance = 1 / Math.sqrt((dx / distance / rx) ** 2 + (dz / distance / rz) ** 2);
        signedDistances.push(distance - facadeDistance);
      }
      expect(Math.min(...signedDistances), mesh.name).toBeGreaterThan(-0.4);
      expect(Math.max(...signedDistances), mesh.name).toBeLessThan(0.18);
      expect(Math.min(...signedDistances), mesh.name).toBeLessThan(-0.02);
      expect(Math.max(...signedDistances), mesh.name).toBeGreaterThan(0);
    }
  });

  it('does not attach rectangular bands or a fire escape to the cylindrical massing', () => {
    // Variant 11 selects cylindrical massing and would trigger the old fire-escape condition.
    const fireEscapeVariant = { ...spec, variant: 11 }; const group = build(fireEscapeVariant);
    const vertex = new THREE.Vector3(); let maxX = -Infinity; let maxZ = -Infinity;
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const position = object.geometry.getAttribute('position');
      for (let index = 0; index < position.count; index++) {
        vertex.fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld);
        maxX = Math.max(maxX, Math.abs(vertex.x - fireEscapeVariant.x)); maxZ = Math.max(maxZ, Math.abs(vertex.z - fireEscapeVariant.z));
      }
    });
    expect(maxX).toBeLessThanOrEqual(fireEscapeVariant.width / 2 + 0.001);
    expect(maxZ).toBeLessThanOrEqual(fireEscapeVariant.depth / 2 + 0.001);
  });

  it('bakes finite, deterministic geometry after disposal and regeneration', () => {
    const first = bakedPositions(); const regenerated = bakedPositions();
    expect(first.length).toBeGreaterThan(0);
    expect(regenerated).toEqual(first);
  });
});

describe('district architecture families', () => {
  it('builds all 36 silhouettes with finite tiers and deterministic massing ids', () => {
    let silhouettes = 0;
    for (const [style, count] of Object.entries(ARCHITECTURE_VARIANTS) as Array<[BuildingStyle, number]>) {
      for (let massing = 0; massing < count; massing++) {
        const group = new THREE.Group(); const architecture = new BuildingArchitecture(group);
        const profile = architecture.build({
          ...spec, style, variant: massing,
          height: style === 'downtown' ? 64 : style === 'dense-residential' ? 22 : 12,
        });
        expect(profile.massing, `${style} ${massing}`).toBe(massing);
        expect(profile.roofY).toBeGreaterThan(0);
        expect(profile.tiers.length).toBeGreaterThan(0);
        for (const tier of profile.tiers) {
          expect([tier.minX, tier.maxX, tier.minZ, tier.maxZ, tier.y0, tier.y1].every(Number.isFinite)).toBe(true);
          expect(tier.maxX).toBeGreaterThan(tier.minX); expect(tier.maxZ).toBeGreaterThan(tier.minZ); expect(tier.y1).toBeGreaterThan(tier.y0);
        }
        silhouettes++;
      }
    }
    expect(silhouettes).toBe(36);
  });
});
