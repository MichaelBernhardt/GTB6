import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS, BuildingArchitecture, foundationTiers, frontFacadeZAt, gableSurfaceAt, massingTopAt, type BuildingProfile, type BuildingSpec, type BuildingStyle } from './BuildingArchitecture';
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
    // Variant 15 selects cylindrical massing (15 % 11 = 4) and would trigger the old fire-escape condition.
    const fireEscapeVariant = { ...spec, variant: 15 }; const group = build(fireEscapeVariant);
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

describe('planar downtown facade details', () => {
  it('keeps bands and mullions attached to the real front plane of every box massing', () => {
    for (let massing = 0; massing < ARCHITECTURE_VARIANTS.downtown; massing++) {
      if (massing === 4) continue; // the elliptical tower has the separate curved-facade contract above
      // Adding 11 preserves an odd massing id while selecting the even detail pass.
      const variant = massing % 2 === 0 ? massing : massing + ARCHITECTURE_VARIANTS.downtown;
      const group = new THREE.Group(); const architecture = new BuildingArchitecture(group);
      const buildingSpec = { ...spec, variant }; const profile = architecture.build(buildingSpec); group.updateWorldMatrix(true, true);
      const details: THREE.Mesh[] = [];
      group.traverse((object) => { if (object instanceof THREE.Mesh && object.userData.planarFacadeDetail) details.push(object); });
      expect(details.some((mesh) => mesh.userData.planarFacadeDetail === 'mullion'), `massing ${massing} mullions`).toBe(true);
      expect(details.some((mesh) => mesh.userData.planarFacadeDetail === 'band'), `massing ${massing} bands`).toBe(true);

      for (const detail of details) {
        const bounds = new THREE.Box3().setFromObject(detail);
        const samples = detail.userData.planarFacadeDetail === 'band'
          ? [bounds.min.x + 1e-3, (bounds.min.x + bounds.max.x) / 2, bounds.max.x - 1e-3]
          : [detail.position.x];
        for (const x of samples) {
          const front = frontFacadeZAt(profile.tiers, x, detail.position.y, detail.userData.planarFacadeDetail === 'mullion' ? 0.08 : 0);
          expect(front, `${detail.name} on massing ${massing}`).toBeDefined();
          expect(bounds.min.z, `${detail.name} back on massing ${massing}`).toBeLessThanOrEqual(front! + 1e-3);
          expect(bounds.max.z - front!, `${detail.name} projection on massing ${massing}`).toBeLessThanOrEqual(0.121);
          expect(bounds.max.z, `${detail.name} visibility on massing ${massing}`).toBeGreaterThan(front!);
        }
      }
    }
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
        const foundations = foundationTiers(profile.tiers, -8);
        expect(foundations.length, `${style} ${massing}`).toBeGreaterThan(0);
        for (const foundation of foundations) {
          expect(foundation.y0).toBe(-8);
          expect(profile.tiers.some((tier) =>
            tier.minX === foundation.minX && tier.maxX === foundation.maxX
            && tier.minZ === foundation.minZ && tier.maxZ === foundation.maxZ
            && tier.y0 === foundation.y1
          ), `${style} ${massing} foundation exceeds its ground massing`).toBe(true);
        }
        silhouettes++;
      }
    }
    expect(silhouettes).toBe(Object.values(ARCHITECTURE_VARIANTS).reduce((a, b) => a + b, 0)); // every family across every district class
  });
});

/**
 * Every-family verification (merged from feat/clutter-variety): each (style, massing) variant must
 * build real meshes with collision tiers that mirror the massing, reach its spec height, and be
 * structurally distinct from its siblings (no two variants collapsing into the same massing).
 */
const familyFacade = new THREE.MeshStandardMaterial();
const familyRoof = new THREE.MeshStandardMaterial();
/** Representative parcel sizes per style (mid-range of the CityGen ZONE_SHAPE bands). */
const SIZES: Record<BuildingStyle, { w: number; d: number; h: number }> = {
  downtown: { w: 26, d: 24, h: 60 },
  'mixed-use': { w: 20, d: 16, h: 18 },
  'dense-residential': { w: 22, d: 14, h: 12 },
  suburban: { w: 16, d: 11, h: 8 },
  industrial: { w: 30, d: 26, h: 12 },
  estate: { w: 40, d: 28, h: 9 },
  rural: { w: 18, d: 12, h: 6 },
};

const buildVariant = (style: BuildingStyle, variant: number): { parent: THREE.Group; profile: BuildingProfile } => {
  const parent = new THREE.Group();
  const { w, d, h } = SIZES[style];
  const profile = new BuildingArchitecture(parent).build({ x: 0, z: 0, width: w, depth: d, height: h, style, variant, facade: familyFacade, roof: familyRoof });
  return { parent, profile };
};

describe('procedural building families', () => {
  for (const style of Object.keys(ARCHITECTURE_VARIANTS) as BuildingStyle[]) {
    it(`builds every ${style} massing with real meshes and mirrored collision tiers`, () => {
      const { w, d, h } = SIZES[style];
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style]; variant++) {
        const { parent, profile } = buildVariant(style, variant);
        expect(profile.massing).toBe(variant);
        expect(profile.tiers.length).toBeGreaterThan(0);
        expect(profile.roofY).toBeGreaterThan(Math.min(h * 0.7, h - 1)); // every family reaches its parcel height
        // The collision registry mirrors the massing: no tier floats above the reported roof and every
        // tier stays near the parcel (garden walls may sit just outside the w×d mass, never further).
        for (const tier of profile.tiers) {
          expect(tier.y1).toBeGreaterThan(tier.y0);
          expect(tier.y1).toBeLessThanOrEqual(profile.roofY + 1e-6);
          expect(Math.max(Math.abs(tier.minX), Math.abs(tier.maxX))).toBeLessThanOrEqual(w / 2 + 1.6);
          expect(Math.max(Math.abs(tier.minZ), Math.abs(tier.maxZ))).toBeLessThanOrEqual(d / 2 + 1.6);
        }
        let meshes = 0;
        parent.traverse((object) => { if (object instanceof THREE.Mesh) meshes++; });
        expect(meshes).toBeGreaterThanOrEqual(3);
      }
    });

    it(`gives every ${style} variant a distinct massing (families don't collapse into one another)`, () => {
      const signatures = new Set<string>();
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style]; variant++) {
        const { profile } = buildVariant(style, variant);
        signatures.add(profile.tiers.map((t) => [t.minX, t.maxX, t.minZ, t.maxZ, t.y0, t.y1].map((v) => v.toFixed(2)).join(',')).sort().join('|'));
      }
      expect(signatures.size).toBe(ARCHITECTURE_VARIANTS[style]);
    });

    it(`rebuilds a ${style} variant deterministically`, () => {
      const first = buildVariant(style, 1).profile;
      const second = buildVariant(style, 1).profile;
      expect(second.tiers).toEqual(first.tiers);
      expect(second.roofY).toBe(first.roofY);
    });
  }
});

describe('roof dressing stays seated on the massing (no floating vents)', () => {
  /** Meshes whose underside hangs in the air: not near the ground, not on/inside a massing tier,
   *  not seated in a gable surface, and not touching any sibling mesh from below (facade-attached
   *  ledges, rails and pipe racks lean on their host and pass). This is the defect class the owner
   *  reported as "floating vents": dressing anchored at the building-wide roofY over a lower wing. */
  const floatersOf = (style: BuildingStyle, variant: number, size = SIZES[style]): string[] => {
    const parent = new THREE.Group();
    const profile = new BuildingArchitecture(parent).build({ x: 0, z: 0, width: size.w, depth: size.d, height: size.h, style, variant, facade: familyFacade, roof: familyRoof });
    parent.updateWorldMatrix(true, true);
    const meshes: THREE.Mesh[] = [];
    parent.traverse((object) => { if (object instanceof THREE.Mesh) meshes.push(object); });
    const boxes = meshes.map((mesh) => new THREE.Box3().setFromObject(mesh));
    const floaters: string[] = [];
    meshes.forEach((mesh, index) => {
      const bounds = boxes[index]!;
      const bottom = bounds.min.y;
      if (bottom <= 1.8) return; // grounded on the local base plane
      const cx = (bounds.min.x + bounds.max.x) / 2; const cz = (bounds.min.z + bounds.max.z) / 2;
      let supported = profile.tiers.some((tier) =>
        cx >= tier.minX - 0.2 && cx <= tier.maxX + 0.2 && cz >= tier.minZ - 0.2 && cz <= tier.maxZ + 0.2 &&
        tier.y0 <= bottom + 0.3 && tier.y1 >= bottom - 1.2);
      if (!supported) {
        const surface = gableSurfaceAt(profile.gables, cx, cz);
        supported = surface !== undefined && surface >= bottom - 1.2;
      }
      if (!supported) supported = boxes.some((other, otherIndex) => otherIndex !== index &&
        other.min.x <= bounds.max.x + 0.35 && other.max.x >= bounds.min.x - 0.35 &&
        other.min.z <= bounds.max.z + 0.35 && other.max.z >= bounds.min.z - 0.35 &&
        other.min.y <= bottom + 0.3 && other.max.y >= bottom - 1.2);
      if (!supported) floaters.push(`${style}/v${variant} ${mesh.geometry.type} bottom ${bottom.toFixed(1)} at (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
    });
    return floaters;
  };

  for (const style of Object.keys(ARCHITECTURE_VARIANTS) as BuildingStyle[]) {
    it(`leaves no ${style} dressing hanging in mid-air (both variant parities)`, () => {
      for (let variant = 0; variant < ARCHITECTURE_VARIANTS[style] * 2; variant++) {
        expect(floatersOf(style, variant), `${style} variant ${variant}`).toEqual([]);
      }
    });
  }

  it('taller parcels stay seated too (setback towers, wings, walk-ups)', () => {
    expect(floatersOf('downtown', 3, { w: 30, d: 22, h: 72 })).toEqual([]);
    expect(floatersOf('mixed-use', 2, { w: 24, d: 18, h: 22 })).toEqual([]);
    expect(floatersOf('dense-residential', 5, { w: 22, d: 14, h: 16 })).toEqual([]);
    expect(floatersOf('suburban', 5, { w: 16, d: 11, h: 10 })).toEqual([]);
  });

  it('seats the dense-residential water tank exactly on the roof under it', () => {
    for (let variant = 0; variant < ARCHITECTURE_VARIANTS['dense-residential']; variant++) {
      const parent = new THREE.Group();
      const { w, d, h } = SIZES['dense-residential'];
      const profile = new BuildingArchitecture(parent).build({ x: 0, z: 0, width: w, depth: d, height: h, style: 'dense-residential', variant, facade: familyFacade, roof: familyRoof });
      parent.updateWorldMatrix(true, true);
      const tanks: THREE.Mesh[] = [];
      parent.traverse((object) => {
        if (object instanceof THREE.Mesh && object.geometry instanceof THREE.CylinderGeometry && (object.geometry.parameters as { radiusBottom: number }).radiusBottom === 0.8) tanks.push(object);
      });
      expect(tanks.length, `variant ${variant}`).toBe(1);
      const bounds = new THREE.Box3().setFromObject(tanks[0]!);
      const roof = massingTopAt(profile.tiers, tanks[0]!.position.x, tanks[0]!.position.z);
      expect(roof, `variant ${variant}`).toBeDefined();
      expect(Math.abs(bounds.min.y - roof!), `variant ${variant}`).toBeLessThan(0.05);
    }
  });

  it('computes the pitched surface of a recorded gable exactly', () => {
    const gable = { x: 4, z: -2, width: 10, depth: 8, y: 6, rise: 3, ry: 0 };
    expect(gableSurfaceAt([gable], 4, -2)).toBeCloseTo(9, 5);       // ridge
    expect(gableSurfaceAt([gable], 9, -2)).toBeCloseTo(6, 5);       // eaves edge
    expect(gableSurfaceAt([gable], 6.5, 1)).toBeCloseTo(7.5, 5);    // half-way down the slope
    expect(gableSurfaceAt([gable], 4, 3)).toBeUndefined();          // off the roof
    const turned = { ...gable, ry: Math.PI / 2 };                   // ridge now runs along x
    expect(gableSurfaceAt([turned], 4, -2)).toBeCloseTo(9, 5);
    expect(gableSurfaceAt([turned], 4, 2)).toBeCloseTo(6 + 3 * (1 - 4 / 5), 5);
  });
});
