import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type BuildingStyle =
  | 'downtown'
  | 'mixed-use'
  | 'dense-residential'
  | 'suburban'
  | 'industrial'
  | 'estate'
  | 'rural';

export const ARCHITECTURE_VARIANTS: Record<BuildingStyle, number> = {
  downtown: 11,
  'mixed-use': 5,
  'dense-residential': 6,
  suburban: 9,
  industrial: 9,
  estate: 8,
  rural: 4,
};

export interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  style: BuildingStyle;
  variant: number;
  facade: THREE.Material;
  roof: THREE.Material;
}

/** One solid massing volume in world XZ and building-local Y (the city lifts y by the parcel's terrain height). */
export interface MassingTier { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number; }

export interface BuildingProfile {
  roofY: number;
  massing: number;
  /** Every stacked box of the massing, bottom tier first — the collision registry mirrors these exactly.
   *  Gable roofs are left out: the player stands on the eaves plane beneath them. */
  tiers: MassingTier[];
}

/** Extend only the building volumes that actually meet the ground down to a common foundation base.
 *  Keeping each footprint separate prevents the levelling foundation from becoming a parcel-sized box
 *  around stepped, winged, or otherwise irregular buildings on sloped terrain. */
export function foundationTiers(tiers: readonly MassingTier[], bottomY: number): MassingTier[] {
  if (tiers.length === 0) return [];
  const groundY = Math.min(...tiers.map((tier) => tier.y0));
  return tiers
    .filter((tier) => Math.abs(tier.y0 - groundY) < 1e-4)
    .map((tier) => ({ ...tier, y0: bottomY, y1: tier.y0 }));
}

export interface FrontFacadeSpan { minX: number; maxX: number; z: number; }

/** Street-facing (+z) surface supporting a detail at one local x/y point. Requiring the tier to cover
 *  the detail's full width prevents windows and doors from hanging across the edge of a narrow wing. */
export function frontFacadeZAt(tiers: readonly MassingTier[], x: number, y: number, halfWidth = 0): number | undefined {
  const epsilon = 1e-4; let front: number | undefined;
  for (const tier of tiers) {
    if (y < tier.y0 - epsilon || y > tier.y1 + epsilon) continue;
    if (x - halfWidth < tier.minX - epsilon || x + halfWidth > tier.maxX + epsilon) continue;
    if (front === undefined || tier.maxZ > front) front = tier.maxZ;
  }
  return front;
}

/** Visible street-facing spans at a height, clipped to a requested trim range. Stepped and offset
 *  massing can expose several front planes; returning them separately keeps each strip on a real wall. */
export function frontFacadeSpansAt(tiers: readonly MassingTier[], y: number, minX: number, maxX: number): FrontFacadeSpan[] {
  if (!(maxX > minX)) return [];
  const epsilon = 1e-4;
  const active = tiers.filter((tier) =>
    y >= tier.y0 - epsilon && y <= tier.y1 + epsilon && tier.maxX > minX + epsilon && tier.minX < maxX - epsilon
  );
  const edges = [minX, maxX];
  for (const tier of active) {
    edges.push(Math.max(minX, tier.minX), Math.min(maxX, tier.maxX));
  }
  edges.sort((a, b) => a - b);
  const unique = edges.filter((edge, index) => index === 0 || Math.abs(edge - edges[index - 1]!) > epsilon);
  const spans: FrontFacadeSpan[] = [];
  for (let index = 0; index < unique.length - 1; index++) {
    const left = unique[index]!; const right = unique[index + 1]!;
    if (right - left <= epsilon) continue;
    const centre = (left + right) / 2;
    const z = frontFacadeZAt(active, centre, y, Math.max(0, (right - left) / 2 - epsilon));
    if (z === undefined) continue;
    const previous = spans[spans.length - 1];
    if (previous && Math.abs(previous.maxX - left) <= epsilon && Math.abs(previous.z - z) <= epsilon) previous.maxX = right;
    else spans.push({ minX: left, maxX: right, z });
  }
  return spans;
}

const boxMaterials = (facade: THREE.Material, roof: THREE.Material): THREE.Material[] => [facade, facade, roof, roof, facade, facade];

const createGableGeometry = (width: number, depth: number, rise: number): THREE.BufferGeometry => {
  const halfW = width / 2; const halfD = depth / 2;
  const vertices = [
    -halfW, 0, -halfD, halfW, 0, -halfD, 0, rise, -halfD,
    -halfW, 0, halfD, halfW, 0, halfD, 0, rise, halfD,
  ];
  const indices = [0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 2, 1, 4, 2, 4, 5, 1, 0, 3, 1, 3, 4];
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
};

export class BuildingArchitecture {
  private stone = new THREE.MeshStandardMaterial({ color: 0xc5c2b4, roughness: 0.75 });
  private darkMetal = new THREE.MeshStandardMaterial({ color: 0x283336, metalness: 0.72, roughness: 0.34 });
  private steel = new THREE.MeshStandardMaterial({ color: 0x596568, metalness: 0.6, roughness: 0.44 });
  private glass = new THREE.MeshPhysicalMaterial({ color: 0x335f69, roughness: 0.12, metalness: 0.2, clearcoat: 0.82 });
  private timber = new THREE.MeshStandardMaterial({ color: 0x704b32, roughness: 0.82 });
  private terracotta = new THREE.MeshStandardMaterial({ color: 0xa14b36, roughness: 0.84 });
  private plaster = new THREE.MeshStandardMaterial({ color: 0xd8cdb6, roughness: 0.88 });
  private pool = new THREE.MeshStandardMaterial({ color: 0x2f8fb8, roughness: 0.18, metalness: 0.1 });
  private thatch = new THREE.MeshStandardMaterial({ color: 0x8a7648, roughness: 1 });
  private court = new THREE.MeshStandardMaterial({ color: 0x2f6a4e, roughness: 0.92 });

  private tiers: MassingTier[] = [];

  constructor(private parent: THREE.Group) {}

  /** Retarget where subsequent build() output is added — the on-demand chunk builder points this at
   *  a fresh per-building group so the whole building can be rotated to face its street as a unit. */
  retarget(parent: THREE.Group): void { this.parent = parent; }

  build(spec: BuildingSpec): BuildingProfile {
    this.tiers = [];
    const massing = spec.variant % ARCHITECTURE_VARIANTS[spec.style];
    const roofY = spec.style === 'downtown' ? this.buildDowntown(spec, massing)
      : spec.style === 'mixed-use' ? this.buildMixedUse(spec, massing)
        : spec.style === 'dense-residential' ? this.buildDenseResidential(spec, massing)
          : spec.style === 'suburban' ? this.buildSuburban(spec, massing)
            : spec.style === 'industrial' ? this.buildIndustrial(spec, massing)
              : spec.style === 'estate' ? this.buildEstate(spec, massing)
                : this.buildRural(spec, massing);
    this.addStructuralDetail(spec, massing, roofY);
    return { roofY, massing, tiers: this.tiers };
  }

  /** Every massing box doubles as a collision tier; decorative details are plain meshes and stay out of the registry. */
  private addBox(spec: BuildingSpec, width: number, height: number, depth: number, x: number, y: number, z: number, rounded = false): THREE.Mesh {
    const radius = Math.min(1.25, width * 0.06, depth * 0.06);
    const geometry = rounded ? new RoundedBoxGeometry(width, height, depth, 5, radius) : new THREE.BoxGeometry(width, height, depth);
    this.tiers.push({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, y0: y - height / 2, y1: y + height / 2 });
    const mesh = new THREE.Mesh(geometry, boxMaterials(spec.facade, spec.roof)); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; this.parent.add(mesh); return mesh;
  }

  private buildDowntown(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    if (massing === 0) {
      const podiumH = Math.min(9, h * 0.18); const middleH = h * 0.55; const upperH = h - podiumH - middleH;
      this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.86, middleH, d * 0.84, x, podiumH + middleH / 2 + 0.2, z);
      this.addBox(spec, w * 0.62, upperH, d * 0.66, x + w * 0.08, podiumH + middleH + upperH / 2 + 0.2, z - d * 0.04, true);
      this.addSetbackBand(x, z, w * 0.88, d * 0.86, podiumH + 0.22); this.addSetbackBand(x + w * 0.08, z - d * 0.04, w * 0.64, d * 0.68, podiumH + middleH + 0.22);
      return h + 0.2;
    }
    if (massing === 1) {
      const podiumH = Math.min(10, h * 0.22); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      const towerH = h - podiumH;
      this.addBox(spec, w * 0.43, towerH, d * 0.82, x - w * 0.23, podiumH + towerH / 2 + 0.2, z);
      this.addBox(spec, w * 0.37, towerH * 0.84, d * 0.72, x + w * 0.25, podiumH + towerH * 0.42 + 0.2, z + d * 0.06, true);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(w * 0.28, 3.2, d * 0.42), this.glass); bridge.position.set(x, podiumH + towerH * 0.57, z + d * 0.04); bridge.castShadow = true; this.parent.add(bridge);
      return h + 0.2;
    }
    if (massing === 2) {
      const podiumH = Math.min(8, h * 0.16); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.72, h - podiumH, d * 0.78, x, podiumH + (h - podiumH) / 2 + 0.2, z, true);
      for (const side of [-1, 1]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.38, h - podiumH + 1.6, d * 0.83), this.stone); fin.position.set(x + side * w * 0.37, podiumH + (h - podiumH) / 2 + 0.2, z); fin.castShadow = true; this.parent.add(fin);
      }
      return h + 0.2;
    }
    if (massing === 3) {
      const lowerH = h * 0.58;
      this.addBox(spec, w * 0.58, lowerH, d, x, lowerH / 2 + 0.2, z);
      this.addBox(spec, w, lowerH, d * 0.46, x, lowerH / 2 + 0.2, z - d * 0.04);
      this.addBox(spec, w * 0.46, h - lowerH, d * 0.58, x + w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z, true);
      this.addSetbackBand(x, z, w * 0.6, d * 1.03, lowerH + 0.2);
      return h + 0.2;
    }
    if (massing === 4) {
      const podiumH = Math.min(9, h * 0.2); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      const radius = d * 0.39;
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.04, h - podiumH, 32), spec.facade); tower.scale.set(w / Math.max(d, 1), 1, 1); tower.position.set(x, podiumH + (h - podiumH) / 2 + 0.2, z); tower.castShadow = true; tower.receiveShadow = true; this.parent.add(tower);
      this.tiers.push({ minX: x - w * 0.39, maxX: x + w * 0.39, minZ: z - radius, maxZ: z + radius, y0: podiumH + 0.2, y1: h + 0.2 }); // scaled cylinder tower, boxed
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius, 3.2, 32), spec.roof); crown.scale.x = w / Math.max(d, 1); crown.position.set(x, h + 1.8, z); crown.castShadow = true; this.parent.add(crown);
      return h + 3.4;
    }
    if (massing === 5) {
      const podiumH = Math.min(11, h * 0.2); const towerH = h - podiumH;
      this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.7, towerH, d * 0.46, x - w * 0.08, podiumH + towerH / 2 + 0.2, z - d * 0.22);
      this.addBox(spec, w * 0.38, towerH * 0.78, d * 0.76, x + w * 0.23, podiumH + towerH * 0.39 + 0.2, z + d * 0.08, true);
      this.addSetbackBand(x - w * 0.08, z - d * 0.22, w * 0.72, d * 0.48, h + 0.2);
      return h + 0.4;
    }
    if (massing === 6) {
      const baseH = h * 0.36; const middleH = h * 0.34; const topH = h - baseH - middleH;
      this.addBox(spec, w, baseH, d, x, baseH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.78, middleH, d * 0.82, x + w * 0.04, baseH + middleH / 2 + 0.2, z - d * 0.03);
      this.addBox(spec, w * 0.5, topH, d * 0.56, x - w * 0.1, baseH + middleH + topH / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x + w * 0.04, z - d * 0.03, w * 0.8, d * 0.84, baseH + middleH + 0.2);
      return h + 0.4;
    }
    if (massing === 7) {
      // Ziggurat: four stepped setback tiers, deco bands at each step — the Anstey's-era CBD profile.
      let y = 0.2; let tw = w; let td = d;
      for (const share of [0.34, 0.28, 0.22, 0.16]) {
        const tierH = h * share;
        this.addBox(spec, tw, tierH, td, x, y + tierH / 2, z, tw === w);
        y += tierH;
        if (share !== 0.16) this.addSetbackBand(x, z, tw * 1.02, td * 1.02, y);
        tw *= 0.78; td *= 0.78;
      }
      const finial = new THREE.Mesh(new THREE.BoxGeometry(1.1, 3.4, 1.1), this.stone); finial.position.set(x, h + 1.7, z); finial.castShadow = true; this.parent.add(finial);
      return h + 0.2;
    }
    if (massing === 8) {
      // Colonnade podium: a double-height columned arcade under the podium deck, recessed glazed
      // lobby behind the columns, then a sheer rounded slab. The deck tier floats at 3.6 so the
      // player can actually walk the arcade between the columns.
      const podiumH = Math.min(11, Math.max(6, h * 0.24));
      this.addBox(spec, w * 0.9, 3.4, d * 0.66, x, 1.7 + 0.2, z - d * 0.14);
      this.addBox(spec, w, podiumH - 3.4, d, x, 3.4 + (podiumH - 3.4) / 2 + 0.2, z);
      const cols = Math.max(4, Math.min(8, Math.floor(w / 3.5)));
      for (let index = 0; index < cols; index++) {
        const px = x - w * 0.44 + index * (w * 0.88 / (cols - 1));
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 3.4, 12), this.stone); column.position.set(px, 1.9, z + d / 2 - 0.5); column.castShadow = true; this.parent.add(column);
      }
      this.addBox(spec, w * 0.7, h - podiumH, d * 0.76, x, podiumH + (h - podiumH) / 2 + 0.2, z, true);
      this.addSetbackBand(x, z, w * 1.01, d * 1.01, podiumH + 0.22);
      return h + 0.2;
    }
    if (massing === 9) {
      // Corner tower: an L-plan block anchoring the street corner with a full-height drum-capped tower.
      const blockH = h * 0.58;
      this.addBox(spec, w, blockH, d * 0.55, x, blockH / 2 + 0.2, z - d * 0.2);
      this.addBox(spec, w * 0.5, blockH, d, x - w * 0.25, blockH / 2 + 0.2, z);
      const towerW = Math.min(w, d) * 0.42;
      const tx = x + w / 2 - towerW / 2; const tz = z + d / 2 - towerW / 2;
      this.addBox(spec, towerW, h, towerW, tx, h / 2 + 0.2, tz, true);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(towerW * 0.32, towerW * 0.44, 2.6, 18), spec.roof); cap.position.set(tx, h + 1.5, tz); cap.castShadow = true; this.parent.add(cap);
      this.addSetbackBand(x, z - d * 0.2, w * 1.02, d * 0.57, blockH + 0.2);
      return h + 2.8;
    }
    // massing 10 — twin offset slabs joined by a service core; plant room + braced rooftop water tanks.
    this.addBox(spec, w * 0.46, h, d * 0.9, x - w * 0.24, h / 2 + 0.2, z, true);
    this.addBox(spec, w * 0.46, h * 0.78, d * 0.9, x + w * 0.24, h * 0.39 + 0.2, z);
    this.addBox(spec, w * 0.18, h * 0.88, d * 0.5, x, h * 0.44 + 0.2, z - d * 0.1);
    const plant = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, 2.3, d * 0.34), this.steel); plant.position.set(x - w * 0.24, h + 1.35, z - d * 0.14); plant.castShadow = true; this.parent.add(plant);
    for (const dz of [-0.18, 0.16]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 2.1, 16), this.steel); tank.position.set(x + w * 0.24, h * 0.78 + 1.75, z + d * dz); tank.castShadow = true; this.parent.add(tank);
      for (const lx of [-0.9, 0.9]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), this.darkMetal); leg.position.set(x + w * 0.24 + lx, h * 0.78 + 0.65, z + d * dz); this.parent.add(leg); }
    }
    return h + 0.2;
  }

  private buildMixedUse(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    const shopH = Math.min(4.4, h * 0.38);
    if (massing === 0) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.82, h - shopH, d * 0.74, x, shopH + (h - shopH) / 2 + 0.2, z - d * 0.08);
    } else if (massing === 1) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.48, h - shopH, d * 0.9, x - w * 0.25, shopH + (h - shopH) / 2 + 0.2, z);
      this.addBox(spec, w * 0.45, (h - shopH) * 0.76, d * 0.48, x + w * 0.24, shopH + (h - shopH) * 0.38 + 0.2, z - d * 0.22, true);
    } else if (massing === 2) {
      this.addBox(spec, w, h * 0.62, d * 0.72, x, h * 0.31 + 0.2, z - d * 0.14, true);
      this.addBox(spec, w * 0.42, h, d * 0.42, x + w * 0.26, h / 2 + 0.2, z + d * 0.22);
    } else if (massing === 3) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.38, h - shopH, d * 0.7, x + side * w * 0.25, shopH + (h - shopH) / 2 + 0.2, z - side * d * 0.06, side > 0);
    } else {
      const lowerH = h * 0.54;
      this.addBox(spec, w, lowerH, d, x, lowerH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.68, h - lowerH, d * 0.72, x - w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x, z, w, d, lowerH + 0.2);
    }
    return h + 0.2;
  }

  private buildDenseResidential(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    if (massing === 0) {
      this.addBox(spec, w, h, d * 0.42, x, h / 2 + 0.2, z - d * 0.29, true);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.28, h * 0.82, d * 0.58, x + side * w * 0.36, h * 0.41 + 0.2, z + d * 0.18);
    } else if (massing === 1) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.2, h + 2.2, d * 0.34, x - w * 0.34, (h + 2.2) / 2 + 0.2, z + d * 0.2);
    } else if (massing === 2) {
      this.addBox(spec, w * 0.62, h, d * 0.72, x - w * 0.12, h / 2 + 0.2, z - d * 0.08);
      this.addBox(spec, w * 0.5, h * 0.66, d * 0.54, x + w * 0.25, h * 0.33 + 0.2, z + d * 0.22, true);
    } else if (massing === 3) {
      const units = 3; const unitW = w / units;
      for (let unit = 0; unit < units; unit++) this.addBox(spec, unitW * 0.92, h * (0.78 + unit * 0.11), d * 0.82, x - w / 2 + unitW * (unit + 0.5), h * (0.78 + unit * 0.11) / 2 + 0.2, z + (unit % 2) * d * 0.08, unit === 1);
    } else if (massing === 4) {
      const floorH = h * 0.46;
      this.addBox(spec, w, floorH, d, x, floorH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.84, h - floorH, d * 0.76, x + w * 0.04, floorH + (h - floorH) / 2 + 0.2, z - d * 0.08);
      this.addSetbackBand(x, z, w, d, floorH + 0.2);
    } else {
      // Three-storey walk-up flats: flat roof behind a parapet, external stair tower, open walkway slabs.
      const blockH = Math.max(h, 8.6);
      this.addBox(spec, w, blockH, d * 0.8, x, blockH / 2 + 0.2, z - d * 0.06, true);
      this.addBox(spec, w * 0.22, blockH + 1.1, d * 0.32, x - w * 0.29, (blockH + 1.1) / 2 + 0.2, z + d * 0.28);
      const parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.5, d * 0.8 + 0.3), this.plaster); parapet.position.set(x, blockH + 0.4, z - d * 0.06); parapet.castShadow = true; this.parent.add(parapet);
      for (let level = 1; level * 2.9 < blockH - 1.2; level++) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.14, 1.15), this.stone); slab.position.set(x, level * 2.9 + 0.2, z - d * 0.06 + d * 0.4 + 0.58); slab.castShadow = true; this.parent.add(slab);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.08, 0.06), this.darkMetal); rail.position.set(x, level * 2.9 + 1.15, z - d * 0.06 + d * 0.4 + 1.1); this.parent.add(rail);
      }
      return blockH + 1.3 + 0.2;
    }
    return h + (massing === 1 ? 2.4 : 0.2);
  }

  private buildSuburban(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h, variant } = spec; const roofRise = Math.min(4.2, Math.max(2.2, w * 0.16));
    if (massing === 0) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z, true);
      this.addGableRoof(spec, x, z, w + 0.7, d + 0.8, h + 0.2, roofRise);
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.15, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.42, h * 0.72, d * 0.72, x + w * 0.29, h * 0.36 + 0.2, z + d * 0.12, true);
      this.addGableRoof(spec, x - w * 0.15, z, w * 0.72, d + 0.7, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.29, z + d * 0.12, w * 0.47, d * 0.77, h * 0.72 + 0.2, roofRise * 0.72);
    } else if (massing === 2) {
      const floorH = h * 0.54; this.addBox(spec, w, floorH, d, x, floorH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.84, h - floorH, d * 0.84, x, floorH + (h - floorH) / 2 + 0.2, z - d * 0.04);
      this.addGableRoof(spec, x, z - d * 0.04, w * 0.9, d * 0.9, h + 0.2, roofRise);
      this.addSetbackBand(x, z, w * 1.02, d * 1.02, floorH + 0.2);
    } else if (massing === 3) {
      this.addBox(spec, w, h, d * 0.72, x, h / 2 + 0.2, z - d * 0.12, true);
      const frontWingH = h * 0.82; this.addBox(spec, w * 0.42, frontWingH, d * 0.56, x + w * 0.22, frontWingH / 2 + 0.2, z + d * 0.28);
      this.addGableRoof(spec, x, z - d * 0.12, w + 0.6, d * 0.78, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.22, z + d * 0.28, w * 0.47, d * 0.62, frontWingH + 0.2, roofRise * 0.72);
    } else if (massing === 4) {
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.47, h * (side > 0 ? 0.86 : 1), d * 0.82, x + side * w * 0.255, h * (side > 0 ? 0.86 : 1) / 2 + 0.2, z + side * d * 0.05, true);
        this.addGableRoof(spec, x + side * w * 0.255, z + side * d * 0.05, w * 0.5, d * 0.88, h * (side > 0 ? 0.86 : 1) + 0.2, roofRise * 0.82);
      }
    } else if (massing === 5) {
      const lowerH = h * 0.58;
      this.addBox(spec, w, lowerH, d, x, lowerH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.62, h - lowerH, d * 0.68, x - w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x, z, w, d, lowerH + 0.2);
    } else if (massing === 6) {
      // Stoep house in a low walled yard — the SA suburb vernacular: raised veranda across the
      // street face under a lean-to roof, boundary wall with a front gap for the path.
      this.addBox(spec, w * 0.86, h, d * 0.76, x, h / 2 + 0.2, z - d * 0.1, true);
      this.addGableRoof(spec, x, z - d * 0.1, w * 0.9, d * 0.82, h + 0.2, roofRise);
      const stoepD = Math.min(2.6, d * 0.24);
      this.addBox(spec, w * 0.86, 0.5, stoepD, x, 0.2, z + d * 0.28 + stoepD / 2 - d * 0.1);
      const stoepZ = z + d * 0.28 + stoepD / 2 - d * 0.1;
      const stoepRoof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.16, stoepD + 0.6), variant % 2 ? this.terracotta : this.darkMetal); stoepRoof.position.set(x, h * 0.66 + 0.2, stoepZ); stoepRoof.rotation.x = -0.09; stoepRoof.castShadow = true; this.parent.add(stoepRoof);
      for (const px of [-w * 0.36, -w * 0.12, w * 0.12, w * 0.36]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, h * 0.62, 10), this.timber); post.position.set(x + px, h * 0.31 + 0.6, stoepZ + stoepD / 2 - 0.2); post.castShadow = true; this.parent.add(post); }
      const wx = w * 0.5 + 0.9; const wz = d * 0.5 + 0.9; const wallH = 1.4; const th = 0.32;
      this.addWall(x, wallH, z - wz, wx * 2 + th, wallH, th);
      for (const side of [-1, 1]) this.addWall(x + side * wx, wallH, z, th, wallH, wz * 2 + th);
      const gap = Math.min(2.2, w * 0.14); const run = (wx * 2 - gap * 2) / 2;
      for (const side of [-1, 1]) this.addWall(x + side * (gap + run / 2), wallH, z + wz, run, wallH, th);
    } else if (massing === 7) {
      // L-plan: two perpendicular gabled wings hugging a front yard corner.
      this.addBox(spec, w, h, d * 0.55, x, h / 2 + 0.2, z - d * 0.2);
      this.addBox(spec, w * 0.42, h, d * 0.88, x + w * 0.26, h / 2 + 0.2, z + d * 0.02, true);
      this.addGableRoof(spec, x, z - d * 0.2, w + 0.6, d * 0.6, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.26, z + d * 0.02, d * 0.93, w * 0.47, h + 0.2, roofRise * 0.85, Math.PI / 2);
    } else {
      // massing 8 — double-storey with a first-floor balcony over the entrance.
      const lower = h * 0.52;
      this.addBox(spec, w, lower, d, x, lower / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.86, h - lower, d * 0.8, x, lower + (h - lower) / 2 + 0.2, z - d * 0.06);
      this.addGableRoof(spec, x, z - d * 0.06, w * 0.9, d * 0.86, h + 0.2, roofRise);
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(w * 0.44, 0.14, 1.5), this.stone); balcony.position.set(x, lower + 0.3, z + d / 2 + 0.72); balcony.castShadow = true; this.parent.add(balcony);
      for (const px of [-w * 0.2, 0, w * 0.2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1, 0.07), this.darkMetal); post.position.set(x + px, lower + 0.85, z + d / 2 + 1.4); this.parent.add(post); }
      const handRail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.44, 0.07, 0.07), this.darkMetal); handRail.position.set(x, lower + 1.35, z + d / 2 + 1.4); this.parent.add(handRail);
    }
    return massing === 5 ? h + 0.2 : h + roofRise + 0.2;
  }

  private buildIndustrial(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = 2.4 + massing * 0.3;
    if (massing === 0 || massing === 3) {
      const bodyW = massing === 3 ? w * 0.74 : w; const bodyX = massing === 3 ? x - w * 0.13 : x;
      this.addBox(spec, bodyW, h, d, bodyX, h / 2 + 0.2, z);
      const bays = Math.max(2, Math.min(5, Math.floor(bodyW / 8))); const bayWidth = bodyW / bays;
      for (let bay = 0; bay < bays; bay++) this.addGableRoof(spec, bodyX - bodyW / 2 + bayWidth * (bay + 0.5), z, bayWidth + 0.16, d + 0.5, h + 0.2, roofRise);
      if (massing === 3) this.addBox(spec, w * 0.22, h * 0.6, d * 0.7, x + w * 0.38, h * 0.3 + 0.2, z - d * 0.08); // sawtooth works + flat-roof annex
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.16, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.38, h * 0.66, d * 0.72, x + w * 0.31, h * 0.33 + 0.2, z + d * 0.1);
      this.addGableRoof(spec, x - w * 0.16, z, w * 0.72, d + 0.5, h + 0.2, roofRise);
    } else if (massing === 2) {
      this.addBox(spec, w, h * 0.72, d, x, h * 0.36 + 0.2, z, true);
      const officeH = h * 0.9; this.addBox(spec, w * 0.3, officeH, d * 0.48, x - w * 0.3, officeH / 2 + 0.2, z + d * 0.2);
      this.addGableRoof(spec, x, z, w + 0.6, d + 0.5, h * 0.72 + 0.2, roofRise);
    } else if (massing === 4) {
      this.addBox(spec, w * 0.72, h, d, x - w * 0.14, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.28, h * 1.18, d * 0.58, x + w * 0.34, h * 0.59 + 0.2, z + d * 0.16, true);
      this.addGableRoof(spec, x - w * 0.14, z, w * 0.76, d + 0.5, h + 0.2, roofRise);
    } else if (massing === 5) {
      // Clerestory hall: tall central nave with a raised glazed light strip, low lean-to side aisles.
      const naveH = h * 1.1; const aisleH = h * 0.55;
      this.addBox(spec, w * 0.5, naveH, d, x, naveH / 2 + 0.2, z);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.25, aisleH, d * 0.94, x + side * w * 0.375, aisleH / 2 + 0.2, z);
      const clerestory = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, 1.1, d * 0.9), this.glass); clerestory.position.set(x, naveH - 0.9, z); this.parent.add(clerestory);
      this.addGableRoof(spec, x, z, w * 0.54, d + 0.5, naveH + 0.2, roofRise * 0.8);
      return naveH + roofRise * 0.8 + 0.2;
    } else if (massing === 6) {
      // Silo battery: the works shed feeding a row of three cylindrical silos over a catwalk.
      this.addBox(spec, w * 0.55, h, d, x - w * 0.2, h / 2 + 0.2, z);
      this.addGableRoof(spec, x - w * 0.2, z, w * 0.6, d + 0.5, h + 0.2, roofRise);
      const siloR = Math.min(w * 0.11, d * 0.16); const siloH = h * 1.35; const sx = x + w * 0.33;
      for (const dz of [-0.3, 0, 0.3]) {
        const silo = new THREE.Mesh(new THREE.CylinderGeometry(siloR, siloR, siloH, 18), this.steel); silo.position.set(sx, siloH / 2 + 0.2, z + d * dz); silo.castShadow = true; silo.receiveShadow = true; this.parent.add(silo);
        this.tiers.push({ minX: sx - siloR, maxX: sx + siloR, minZ: z + d * dz - siloR, maxZ: z + d * dz + siloR, y0: 0.2, y1: siloH + 0.2 });
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.24, siloR, siloR * 1.1, 18), this.steel); cone.position.set(sx, siloH + siloR * 0.55 + 0.2, z + d * dz); cone.castShadow = true; this.parent.add(cone);
      }
      const catwalk = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.16, 1.1), this.darkMetal); catwalk.position.set(x + w * 0.08, h + 0.4, z); catwalk.castShadow = true; this.parent.add(catwalk);
      return siloH + 0.4;
    } else if (massing === 7) {
      // Twin long sheds: two parallel gabled halls with a service lane and a gantry frame between them.
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.38, h, d, x + side * w * 0.29, h / 2 + 0.2, z);
        this.addGableRoof(spec, x + side * w * 0.29, z, w * 0.42, d + 0.5, h + 0.2, roofRise * 0.9);
      }
      for (const dz of [-0.32, 0.32]) {
        for (const side of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, h + 1.6, 0.22), this.steel); post.position.set(x + side * w * 0.09, (h + 1.6) / 2 + 0.2, z + d * dz); post.castShadow = true; this.parent.add(post); }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, 0.3, 0.3), this.steel); beam.position.set(x, h + 1.5, z + d * dz); beam.castShadow = true; this.parent.add(beam);
      }
      return h + roofRise + 0.2;
    } else if (massing === 8) {
      // Chimney works: main hall, attached boiler house, tall brick stack and a pipe rack run.
      this.addBox(spec, w * 0.62, h, d, x - w * 0.15, h / 2 + 0.2, z);
      this.addGableRoof(spec, x - w * 0.15, z, w * 0.66, d + 0.5, h + 0.2, roofRise);
      const boilerH = h * 0.78; this.addBox(spec, w * 0.28, boilerH, d * 0.6, x + w * 0.3, boilerH / 2 + 0.2, z - d * 0.14);
      const stackR = Math.min(1.6, w * 0.05); const stackH = h * 2.1; const kx = x + w * 0.3; const kz = z + d * 0.28;
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(stackR * 0.72, stackR, stackH, 16), this.terracotta); stack.position.set(kx, stackH / 2 + 0.2, kz); stack.castShadow = true; this.parent.add(stack);
      this.tiers.push({ minX: kx - stackR, maxX: kx + stackR, minZ: kz - stackR, maxZ: kz + stackR, y0: 0.2, y1: stackH + 0.2 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(stackR * 0.78, stackR * 0.82, 0.5, 16), this.stone); band.position.set(kx, stackH - 1.4, kz); this.parent.add(band);
      for (let py = 1.4; py < boilerH; py += 1.6) { const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, w * 0.42, 10), this.steel); pipe.rotation.z = Math.PI / 2; pipe.position.set(x + w * 0.07, py, z - d * 0.14); this.parent.add(pipe); }
      return stackH + 0.2;
    }
    return massing === 2 ? Math.max(h * 0.72 + roofRise, h * 0.9) + 0.2 : massing === 4 ? h * 1.18 + 0.2 : h + roofRise + 0.2;
  }

  /** Low walled villa: a wide plastered house, a pool in the front yard, and a perimeter wall with a
   *  street-facing gate. The house boxes are collision tiers; the wall is four collider segments with
   *  a gap for the gate. Everything is built at the spec origin so the chunk builder can rotate it to
   *  the street. Fully procedural — no hand coordinates. */
  private buildEstate(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    const roofRise = Math.min(3.4, Math.max(2, w * 0.05));
    if (massing === 3) {
      this.addBox(spec, w * 0.62, h * 0.58, d * 0.68, x - w * 0.08, h * 0.29 + 0.2, z - d * 0.04, true);
      this.addBox(spec, w * 0.48, h * 0.42, d * 0.5, x + w * 0.1, h * 0.79 + 0.2, z - d * 0.08, true);
      this.addBox(spec, w * 0.26, h * 0.46, d * 0.36, x + w * 0.32, h * 0.23 + 0.2, z + d * 0.2);
      const pool = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w * 0.32, 13), 0.3, Math.min(d * 0.24, 8)), this.pool); pool.position.set(x - w * 0.2, 0.12, z + d * 0.3); pool.receiveShadow = true; this.parent.add(pool);
      return h + 0.4;
    }
    const wingSide = massing === 1 ? -1 : 1;
    const mainW = w * 0.6; const mainD = d * 0.66;
    let roofY = h + roofRise + 0.2;
    if (massing <= 2) {
      this.addBox(spec, mainW, h, mainD, x - w * 0.02, h / 2 + 0.2, z - d * 0.04, true);
      const wingH = h * (massing === 2 ? 1 : 0.82);
      this.addBox(spec, w * 0.3, wingH, d * 0.5, x + wingSide * w * 0.26, wingH / 2 + 0.2, z + d * 0.12, true);
      this.addGableRoof(spec, x - w * 0.02, z - d * 0.04, mainW + 0.6, mainD + 0.6, h + 0.2, roofRise);
    } else if (massing === 4) {
      // U-plan villa: the main house with matched wings both sides framing the pool court.
      this.addBox(spec, mainW, h, d * 0.5, x, h / 2 + 0.2, z - d * 0.14, true);
      this.addGableRoof(spec, x, z - d * 0.14, mainW + 0.6, d * 0.56, h + 0.2, roofRise);
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.24, h * 0.82, d * 0.52, x + side * w * 0.3, h * 0.41 + 0.2, z + d * 0.08, true);
        this.addGableRoof(spec, x + side * w * 0.3, z + d * 0.08, d * 0.57, w * 0.28, h * 0.82 + 0.2, roofRise * 0.8, Math.PI / 2);
      }
    } else if (massing === 5) {
      // Modern flat-roof double storey: stacked offset boxes, cantilevered upper floor, glass band.
      this.addBox(spec, mainW, h * 0.55, mainD, x, h * 0.275 + 0.2, z - d * 0.04, true);
      this.addBox(spec, mainW * 0.86, h * 0.5, mainD * 0.92, x + w * 0.06, h * 0.55 + h * 0.25 + 0.2, z + d * 0.02, true);
      const glassBand = new THREE.Mesh(new THREE.BoxGeometry(mainW * 0.8, 1.1, 0.1), this.glass); glassBand.position.set(x + w * 0.06, h * 0.72, z + d * 0.02 + mainD * 0.46 + 0.06); this.parent.add(glassBand);
      const brise = new THREE.Mesh(new THREE.BoxGeometry(mainW * 0.9, 0.14, 2), this.timber); brise.position.set(x + w * 0.06, h * 1.05 + 0.35, z + d * 0.02 + mainD * 0.3); brise.castShadow = true; this.parent.add(brise);
      roofY = h * 1.05 + 0.2;
    } else if (massing === 6) {
      // Thatch-look lodge: steep grass-brown gables over a plastered body, plus a rondavel-ish lapa.
      this.addBox(spec, mainW, h * 0.86, mainD, x - w * 0.02, h * 0.43 + 0.2, z - d * 0.04, true);
      const thatchRise = Math.max(roofRise * 1.7, h * 0.5);
      const thatchRoof = new THREE.Mesh(createGableGeometry(mainW + 0.8, mainD + 0.8, thatchRise), this.thatch); thatchRoof.position.set(x - w * 0.02, h * 0.86 + 0.2, z - d * 0.04); thatchRoof.castShadow = true; thatchRoof.receiveShadow = true; this.parent.add(thatchRoof);
      const lapaR = Math.min(3.2, w * 0.12); const lx = x + w * 0.28; const lz = z + d * 0.18;
      const lapa = new THREE.Mesh(new THREE.CylinderGeometry(lapaR, lapaR, 2.4, 14), this.plaster); lapa.position.set(lx, 1.4, lz); lapa.castShadow = true; this.parent.add(lapa);
      this.tiers.push({ minX: lx - lapaR, maxX: lx + lapaR, minZ: lz - lapaR, maxZ: lz + lapaR, y0: 0.2, y1: 2.6 });
      const lapaRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.2, lapaR + 0.7, 2.2, 14), this.thatch); lapaRoof.position.set(lx, 3.7, lz); lapaRoof.castShadow = true; this.parent.add(lapaRoof);
      roofY = h * 0.86 + thatchRise + 0.2;
    } else {
      // massing 7 — tennis-court estate: compact double villa beside a fenced practice court.
      this.addBox(spec, w * 0.44, h, mainD, x - w * 0.24, h / 2 + 0.2, z - d * 0.04, true);
      this.addGableRoof(spec, x - w * 0.24, z - d * 0.04, w * 0.48, mainD + 0.6, h + 0.2, roofRise);
      const courtW = Math.min(w * 0.4, 15); const courtD = Math.min(d * 0.52, 8.2); const cx = x + w * 0.22; const czz = z - d * 0.08;
      const court = new THREE.Mesh(new THREE.BoxGeometry(courtW, 0.14, courtD), this.court); court.position.set(cx, 0.28, czz); court.receiveShadow = true; this.parent.add(court);
      const netLine = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, courtD), this.plaster); netLine.position.set(cx, 0.8, czz); this.parent.add(netLine);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.8, 0.1), this.darkMetal); post.position.set(cx + sx * courtW / 2, 1.6, czz + sz * courtD / 2); this.parent.add(post); }
    }

    // Perimeter garden wall (kept inside the reserved building radius), gated on the +z street face.
    const wx = w * 0.5 + 1.2; const wz = d * 0.5 + 1.2; const wallH = 2.3; const th = 0.4;
    this.addWall(x, wallH, z - wz, wx * 2 + th, wallH, th);                // back
    this.addWall(x - wx, wallH, z, th, wallH, wz * 2 + th);               // left
    this.addWall(x + wx, wallH, z, th, wallH, wz * 2 + th);               // right
    const gateHalf = Math.min(3, w * 0.14);                               // gate opening on the street side
    const frontRun = (wx * 2 - gateHalf * 2) / 2;
    for (const side of [-1, 1]) this.addWall(x + side * (gateHalf + frontRun / 2), wallH, z + wz, frontRun, wallH, th);
    for (const side of [-1, 1]) { const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.8, 3, 0.8), this.stone); pillar.position.set(x + side * gateHalf, 1.5, z + wz); pillar.castShadow = true; this.parent.add(pillar); }
    const gate = new THREE.Mesh(new THREE.BoxGeometry(gateHalf * 2, 2, 0.12), this.darkMetal); gate.position.set(x, 1, z + wz); this.parent.add(gate);

    // Pool in the front yard, between house and gate.
    const poolW = Math.min(w * 0.34, 12); const poolD = Math.min(d * 0.3, 8);
    const pool = new THREE.Mesh(new THREE.BoxGeometry(poolW, 0.3, poolD), this.pool); pool.position.set(x + wingSide * -w * 0.16, 0.12, z + d * 0.24); pool.receiveShadow = true; this.parent.add(pool);
    const coping = new THREE.Mesh(new THREE.BoxGeometry(poolW + 0.8, 0.16, poolD + 0.8), this.plaster); coping.position.set(pool.position.x, 0.06, pool.position.z); coping.receiveShadow = true; this.parent.add(coping);
    return roofY;
  }

  private buildRural(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = Math.min(2.8, Math.max(1.4, w * 0.12));
    if (massing === 0) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z);
      this.addGableRoof(spec, x, z, w + 0.8, d + 1, h + 0.2, roofRise);
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.16, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.38, h * 0.72, d * 0.72, x + w * 0.31, h * 0.36 + 0.2, z + d * 0.12);
      this.addGableRoof(spec, x - w * 0.16, z, w * 0.72, d + 0.8, h + 0.2, roofRise);
    } else if (massing === 2) {
      for (const side of [-1, 1]) {
        const cottageH = h * (side > 0 ? 0.88 : 1);
        this.addBox(spec, w * 0.46, cottageH, d * 0.82, x + side * w * 0.26, cottageH / 2 + 0.2, z + side * d * 0.06);
        this.addGableRoof(spec, x + side * w * 0.26, z + side * d * 0.06, w * 0.5, d * 0.9, cottageH + 0.2, roofRise * 0.8);
      }
    } else {
      this.addBox(spec, w, h * 0.72, d, x, h * 0.36 + 0.2, z, true);
      this.addBox(spec, w * 0.34, h, d * 0.6, x - w * 0.28, h / 2 + 0.2, z - d * 0.12);
      this.addGableRoof(spec, x - w * 0.28, z - d * 0.12, w * 0.38, d * 0.66, h + 0.2, roofRise);
    }
    return h + roofRise + 0.2;
  }

  /** A plastered wall segment that is both a mesh and an axis-aligned collision tier (grounded at +0.2). */
  private addWall(cx: number, _cy: number, cz: number, w: number, h: number, d: number): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.plaster);
    wall.position.set(cx, h / 2 + 0.2, cz); wall.castShadow = true; wall.receiveShadow = true; this.parent.add(wall);
    this.tiers.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, y0: 0.2, y1: h + 0.2 });
  }

  private addGableRoof(spec: BuildingSpec, x: number, z: number, width: number, depth: number, y: number, rise: number, ry = 0): void {
    const tiled = spec.style === 'suburban' || spec.style === 'estate';
    const roof = new THREE.Mesh(createGableGeometry(width, depth, rise), tiled ? this.terracotta : spec.roof); roof.position.set(x, y, z); roof.rotation.y = ry; roof.castShadow = true; roof.receiveShadow = true; this.parent.add(roof);
  }

  private addSetbackBand(x: number, z: number, width: number, depth: number, y: number): void {
    const band = new THREE.Mesh(new THREE.BoxGeometry(width, 0.28, depth), this.stone); band.position.set(x, y, z); band.castShadow = true; this.parent.add(band);
  }

  private addStructuralDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    if (spec.style === 'downtown') this.addDowntownDetail(spec, massing, roofY);
    else if (spec.style === 'mixed-use') this.addMixedUseDetail(spec, massing);
    else if (spec.style === 'dense-residential') this.addDenseResidentialDetail(spec, massing, roofY);
    else if (spec.style === 'suburban' || spec.style === 'rural') this.addResidentialDetail(spec, massing, roofY);
    else if (spec.style === 'estate') this.addResidentialDetail(spec, massing, roofY); // villa porch/chimney/dormers
    else this.addIndustrialDetail(spec, massing, roofY);
  }

  private addMixedUseDetail(spec: BuildingSpec, massing: number): void {
    const { x, z, width: w, depth: d, variant } = spec;
    const canopyW = w * 0.74; const canopyZ = frontFacadeZAt(this.tiers, x, 3.25, canopyW / 2);
    if (canopyZ !== undefined) {
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(canopyW, 0.18, 1.5), variant % 2 ? this.darkMetal : this.terracotta);
      canopy.position.set(x, 3.25, canopyZ + 0.7); canopy.castShadow = true; this.parent.add(canopy);
    }
    const bays = Math.max(2, Math.min(5, Math.floor(w / 5)));
    for (let bay = 0; bay < bays; bay++) {
      const px = x - w * 0.36 + bay * (w * 0.72 / Math.max(1, bays - 1));
      const shopW = Math.min(3.2, w / bays * 0.72); const shopZ = frontFacadeZAt(this.tiers, px, 1.35, shopW / 2); if (shopZ === undefined) continue;
      const shop = new THREE.Mesh(new THREE.BoxGeometry(shopW, 2.2, 0.12), this.glass); shop.position.set(px, 1.35, shopZ + 0.02); this.parent.add(shop);
    }
    if (massing === 4) this.addSetbackBand(x, z, w * 0.7, d * 0.74, spec.height + 0.3);
  }

  private addDenseResidentialDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h } = spec;
    for (let y = 4; y < h - 1; y += 3.1) {
      const balconyX = x + (massing % 2 ? w * 0.08 : 0); const balconyW = w * 0.56;
      const facadeZ = frontFacadeZAt(this.tiers, balconyX, y, balconyW / 2); if (facadeZ === undefined) continue;
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(balconyW, 0.14, 1.05), this.stone); balcony.position.set(balconyX, y, facadeZ + 0.45); balcony.castShadow = true; this.parent.add(balcony);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(balconyW, 0.65, 0.06), this.darkMetal); rail.position.set(balconyX, y + 0.42, facadeZ + 0.95); this.parent.add(rail);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 1.5, 14), this.darkMetal); tank.position.set(x - w * 0.25, roofY + 0.75, z - d * 0.18); tank.castShadow = true; this.parent.add(tank);
  }

  private addDowntownDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    if (massing === 4) {
      this.addCylindricalDowntownDetail(spec);
    } else {
      if (variant % 2 === 0) {
        const finCount = Math.max(3, Math.min(7, Math.floor(w / 4)));
        const bottom = h * 0.15; const top = h * 0.87;
        const edges = [bottom, top, ...this.tiers.flatMap((tier) => [tier.y0, tier.y1]).filter((y) => y > bottom && y < top)].sort((a, b) => a - b);
        for (let index = 0; index < finCount; index++) {
          const px = x - w * 0.38 + index * (w * 0.76 / Math.max(1, finCount - 1));
          const segments: Array<{ y0: number; y1: number; z: number }> = [];
          for (let edge = 0; edge < edges.length - 1; edge++) {
            const y0 = edges[edge]!; const y1 = edges[edge + 1]!; if (y1 - y0 < 1e-4) continue;
            const facadeZ = frontFacadeZAt(this.tiers, px, (y0 + y1) / 2, 0.08); if (facadeZ === undefined) continue;
            const previous = segments[segments.length - 1];
            if (previous && Math.abs(previous.y1 - y0) < 1e-4 && Math.abs(previous.z - facadeZ) < 1e-4) previous.y1 = y1;
            else segments.push({ y0, y1, z: facadeZ });
          }
          for (const segment of segments) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, segment.y1 - segment.y0, 0.16), this.stone);
            fin.position.set(px, (segment.y0 + segment.y1) / 2, segment.z + 0.04); fin.castShadow = true;
            fin.name = 'planar-facade-mullion'; fin.userData.planarFacadeDetail = 'mullion'; this.parent.add(fin);
          }
        }
      }
      for (let y = 11; y < h - 5; y += Math.max(10, h / 5)) {
        for (const span of frontFacadeSpansAt(this.tiers, y, x - w * 0.41, x + w * 0.41)) {
          const band = new THREE.Mesh(new THREE.BoxGeometry(span.maxX - span.minX, 0.18, 0.16), this.darkMetal);
          band.position.set((span.minX + span.maxX) / 2, y, span.z + 0.04);
          band.name = 'planar-facade-band'; band.userData.planarFacadeDetail = 'band'; this.parent.add(band);
        }
      }
      if (variant % 3 === 0 && h > 30) this.addFireEscape(x, z, w, d, h);
    }
    if (massing === 2 || massing === 4) {
      const crown = new THREE.Group(); crown.position.set(x, roofY, z);
      for (const px of [-w * 0.2, w * 0.2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.5, 0.16), this.darkMetal); post.position.set(px, 1.75, 0); crown.add(post); }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.52, 0.18, 0.18), this.darkMetal); beam.position.y = 3.45; crown.add(beam); this.parent.add(crown);
    }
  }

  /** Trim for the tapered elliptical downtown tower. The old shared downtown pass placed a flat
   *  grid at the rectangular parcel edge, leaving its ends visibly detached from this narrower
   *  massing. Rings and mullions instead use the cylinder's exact 4% bottom-to-top taper. */
  private addCylindricalDowntownDetail(spec: BuildingSpec): void {
    const { x, z, width: w, height: h, variant } = spec;
    const podiumH = Math.min(9, h * 0.2); const towerBottom = podiumH + 0.2; const towerTop = h + 0.2;
    const ringHeights: number[] = [];
    for (let y = Math.max(11, towerBottom + 2.5); y < h - 5; y += Math.max(10, h / 5)) {
      ringHeights.push(y);
      const { rx, rz } = this.cylindricalTowerRadii(spec, y);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rz - 0.07, 0.09, 6, 32), this.darkMetal);
      ring.position.set(x, y, z); ring.rotation.x = Math.PI / 2; ring.scale.x = rx / rz;
      ring.castShadow = true; ring.name = 'cylindrical-facade-ring'; ring.userData.curvedFacadeDetail = 'ring'; this.parent.add(ring);
    }

    if (variant % 2 !== 0) return;
    const finCount = Math.max(3, Math.min(7, Math.floor(w / 4)));
    const segmentEdges = [towerBottom + 0.8, ...ringHeights, towerTop - 4.7];
    for (let segment = 0; segment < segmentEdges.length - 1; segment++) {
      const y0 = segmentEdges[segment]! + (segment === 0 ? 0 : 0.25);
      const y1 = segmentEdges[segment + 1]! - (segment === segmentEdges.length - 2 ? 0 : 0.25);
      if (y1 - y0 < 0.6) continue;
      const cy = (y0 + y1) / 2; const { rx, rz } = this.cylindricalTowerRadii(spec, cy);
      for (let index = 0; index < finCount; index++) {
        // Keep the original street-facing spread, but solve each point and its normal on the ellipse.
        const u = finCount === 1 ? 0 : -0.92 + index * (1.84 / (finCount - 1));
        const px = u * rx; const pz = Math.sqrt(1 - u * u) * rz;
        const normal = new THREE.Vector2(px / (rx * rx), pz / (rz * rz)).normalize();
        const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.18, y1 - y0, 0.28), this.stone);
        mullion.position.set(x + px - normal.x * 0.1, cy, z + pz - normal.y * 0.1);
        mullion.rotation.y = Math.atan2(normal.x, normal.y); mullion.castShadow = true;
        mullion.name = 'cylindrical-facade-mullion'; mullion.userData.curvedFacadeDetail = 'mullion'; this.parent.add(mullion);
      }
    }
  }

  private cylindricalTowerRadii(spec: BuildingSpec, y: number): { rx: number; rz: number } {
    const podiumH = Math.min(9, spec.height * 0.2); const towerH = spec.height - podiumH;
    const t = THREE.MathUtils.clamp((y - podiumH - 0.2) / towerH, 0, 1);
    const taper = THREE.MathUtils.lerp(1.04, 1, t); const rz = spec.depth * 0.39 * taper;
    return { rx: rz * spec.width / Math.max(spec.depth, 1), rz };
  }

  private addFireEscape(x: number, z: number, w: number, d: number, h: number): void {
    const sideX = x + w / 2 + 0.55;
    for (let y = 8; y < h - 3; y += 10) {
      const platform = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 3.1), this.darkMetal); platform.position.set(sideX, y, z + d * 0.16); this.parent.add(platform);
      for (const pz of [-1.35, 1.35]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.07), this.darkMetal); rail.position.set(sideX + 0.55, y + 0.45, z + d * 0.16 + pz); this.parent.add(rail); }
      const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.08, 8.7, 0.08), this.darkMetal); ladder.position.set(sideX + 0.55, y + 4.35, z + d * 0.16 + 1.25); this.parent.add(ladder);
      for (let rung = 0; rung < 5; rung++) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), this.darkMetal); bar.position.set(sideX + 0.55, y + 0.8 + rung * 1.75, z + d * 0.16 + 1.25); this.parent.add(bar); }
    }
  }

  private addResidentialDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    const porchW = w * 0.48; const facadeZ = frontFacadeZAt(this.tiers, x, 1.8, porchW / 2);
    if (facadeZ !== undefined) {
      const porch = new THREE.Mesh(new THREE.BoxGeometry(porchW, 0.28, 2.3), this.timber); porch.position.set(x, 0.45, facadeZ + 1); porch.castShadow = true; this.parent.add(porch);
      const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.56, 0.18, 2.55), variant % 2 ? this.terracotta : this.darkMetal); porchRoof.position.set(x, 3.15, facadeZ + 1); porchRoof.rotation.x = -0.08; porchRoof.castShadow = true; this.parent.add(porchRoof);
      for (const px of [-w * 0.2, w * 0.2]) { const column = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 2.7, 14), this.stone); column.position.set(x + px, 1.8, facadeZ + 1.75); column.castShadow = true; this.parent.add(column); }
    }
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 0.9), this.terracotta); chimney.position.set(x - w * 0.25, roofY - 0.5, z - d * 0.18); chimney.castShadow = true; this.parent.add(chimney);
    if (massing !== 2 && h > 8) {
      for (const side of [-1, 1]) {
        const dormer = new THREE.Mesh(new THREE.BoxGeometry(Math.min(2.4, w * 0.2), 1.75, 1.35), boxMaterials(spec.facade, spec.roof)); dormer.position.set(x + side * w * 0.22, h + 1.05, z + d * 0.28); dormer.castShadow = true; this.parent.add(dormer);
        const window = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.92), this.glass); window.position.set(dormer.position.x, dormer.position.y, dormer.position.z + 0.681); this.parent.add(window);
      }
    }
  }

  private addIndustrialDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    const dockW = w * 0.58; const dockZ = frontFacadeZAt(this.tiers, x, 0.7, dockW / 2);
    if (dockZ !== undefined) {
      const dock = new THREE.Mesh(new THREE.BoxGeometry(dockW, 1.1, 2.4), this.steel); dock.position.set(x, 0.7, dockZ + 1.1); dock.castShadow = true; this.parent.add(dock);
    }
    const pipeHeight = Math.min(8, h * 0.65);
    for (const side of [-1, 1]) {
      const pipeX = x + side * w * 0.36; const pipeY = pipeHeight / 2 + 0.5; const pipeZ = frontFacadeZAt(this.tiers, pipeX, pipeY, 0.17); if (pipeZ === undefined) continue;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, pipeHeight, 12), this.steel); pipe.position.set(pipeX, pipeY, pipeZ + 0.1); pipe.castShadow = true; this.parent.add(pipe);
    }
    const ductW = w * 0.42; const ductY = h * 0.62; const ductZ = frontFacadeZAt(this.tiers, x, ductY, ductW / 2);
    if (ductZ !== undefined) { const duct = new THREE.Mesh(new THREE.BoxGeometry(ductW, 0.8, 0.85), this.steel); duct.position.set(x, ductY, ductZ + 0.36); this.parent.add(duct); }
    if (variant % 2 === 1) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.25, Math.min(8, h * 0.65), 24), this.steel); tank.position.set(x + w * 0.28, Math.min(8, h * 0.65) / 2 + 0.25, z - d * 0.22); tank.castShadow = true; this.parent.add(tank);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), this.steel); dome.position.set(tank.position.x, tank.position.y + Math.min(8, h * 0.65) / 2, tank.position.z); dome.castShadow = true; this.parent.add(dome);
    }
    if (massing === 3) {
      const monitor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 1.5, d * 0.24), this.glass); monitor.position.set(x, roofY - 0.7, z); monitor.castShadow = true; this.parent.add(monitor);
    }
  }
}
