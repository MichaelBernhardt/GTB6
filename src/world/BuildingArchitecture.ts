import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type BuildingStyle = 'downtown' | 'residential' | 'industrial' | 'estate';

export const ARCHITECTURE_VARIANTS: Record<BuildingStyle, number> = {
  downtown: 5,
  residential: 4,
  industrial: 4,
  estate: 3,
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

  private tiers: MassingTier[] = [];

  constructor(private parent: THREE.Group) {}

  /** Retarget where subsequent build() output is added — the on-demand chunk builder points this at
   *  a fresh per-building group so the whole building can be rotated to face its street as a unit. */
  retarget(parent: THREE.Group): void { this.parent = parent; }

  build(spec: BuildingSpec): BuildingProfile {
    this.tiers = [];
    const massing = spec.variant % ARCHITECTURE_VARIANTS[spec.style];
    const roofY = spec.style === 'downtown'
      ? this.buildDowntown(spec, massing)
      : spec.style === 'residential'
        ? this.buildResidential(spec, massing)
        : spec.style === 'estate'
          ? this.buildEstate(spec, massing)
          : this.buildIndustrial(spec, massing);
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
    const podiumH = Math.min(9, h * 0.2); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
    const radius = d * 0.39;
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.04, h - podiumH, 32), spec.facade); tower.scale.set(w / Math.max(d, 1), 1, 1); tower.position.set(x, podiumH + (h - podiumH) / 2 + 0.2, z); tower.castShadow = true; tower.receiveShadow = true; this.parent.add(tower);
    this.tiers.push({ minX: x - w * 0.39, maxX: x + w * 0.39, minZ: z - radius, maxZ: z + radius, y0: podiumH + 0.2, y1: h + 0.2 }); // scaled cylinder tower, boxed
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius, 3.2, 32), spec.roof); crown.scale.x = w / Math.max(d, 1); crown.position.set(x, h + 1.8, z); crown.castShadow = true; this.parent.add(crown);
    return h + 3.4;
  }

  private buildResidential(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = Math.min(4.2, Math.max(2.2, w * 0.16));
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
    } else {
      this.addBox(spec, w, h, d * 0.72, x, h / 2 + 0.2, z - d * 0.12, true);
      const frontWingH = h * 0.82; this.addBox(spec, w * 0.42, frontWingH, d * 0.56, x + w * 0.22, frontWingH / 2 + 0.2, z + d * 0.28);
      this.addGableRoof(spec, x, z - d * 0.12, w + 0.6, d * 0.78, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.22, z + d * 0.28, w * 0.47, d * 0.62, frontWingH + 0.2, roofRise * 0.72);
    }
    return h + roofRise + 0.2;
  }

  private buildIndustrial(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = 2.4 + massing * 0.3;
    if (massing === 0 || massing === 3) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z);
      const bays = Math.max(2, Math.min(5, Math.floor(w / 8))); const bayWidth = w / bays;
      for (let bay = 0; bay < bays; bay++) this.addGableRoof(spec, x - w / 2 + bayWidth * (bay + 0.5), z, bayWidth + 0.16, d + 0.5, h + 0.2, roofRise);
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.16, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.38, h * 0.66, d * 0.72, x + w * 0.31, h * 0.33 + 0.2, z + d * 0.1);
      this.addGableRoof(spec, x - w * 0.16, z, w * 0.72, d + 0.5, h + 0.2, roofRise);
    } else {
      this.addBox(spec, w, h * 0.72, d, x, h * 0.36 + 0.2, z, true);
      const officeH = h * 0.9; this.addBox(spec, w * 0.3, officeH, d * 0.48, x - w * 0.3, officeH / 2 + 0.2, z + d * 0.2);
      this.addGableRoof(spec, x, z, w + 0.6, d + 0.5, h * 0.72 + 0.2, roofRise);
    }
    return massing === 2 ? Math.max(h * 0.72 + roofRise, h * 0.9) + 0.2 : h + roofRise + 0.2;
  }

  /** Low walled villa: a wide plastered house, a pool in the front yard, and a perimeter wall with a
   *  street-facing gate. The house boxes are collision tiers; the wall is four collider segments with
   *  a gap for the gate. Everything is built at the spec origin so the chunk builder can rotate it to
   *  the street. Fully procedural — no hand coordinates. */
  private buildEstate(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    const roofRise = Math.min(3.4, Math.max(2, w * 0.05));
    const wingSide = massing === 1 ? -1 : 1;
    const mainW = w * 0.6; const mainD = d * 0.66;
    this.addBox(spec, mainW, h, mainD, x - w * 0.02, h / 2 + 0.2, z - d * 0.04, true);
    const wingH = h * (massing === 2 ? 1 : 0.82);
    this.addBox(spec, w * 0.3, wingH, d * 0.5, x + wingSide * w * 0.26, wingH / 2 + 0.2, z + d * 0.12, true);
    this.addGableRoof(spec, x - w * 0.02, z - d * 0.04, mainW + 0.6, mainD + 0.6, h + 0.2, roofRise);

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
    return h + roofRise + 0.2;
  }

  /** A plastered wall segment that is both a mesh and an axis-aligned collision tier (grounded at +0.2). */
  private addWall(cx: number, _cy: number, cz: number, w: number, h: number, d: number): void {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.plaster);
    wall.position.set(cx, h / 2 + 0.2, cz); wall.castShadow = true; wall.receiveShadow = true; this.parent.add(wall);
    this.tiers.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, y0: 0.2, y1: h + 0.2 });
  }

  private addGableRoof(spec: BuildingSpec, x: number, z: number, width: number, depth: number, y: number, rise: number): void {
    const roof = new THREE.Mesh(createGableGeometry(width, depth, rise), spec.style === 'residential' ? this.terracotta : spec.roof); roof.position.set(x, y, z); roof.castShadow = true; roof.receiveShadow = true; this.parent.add(roof);
  }

  private addSetbackBand(x: number, z: number, width: number, depth: number, y: number): void {
    const band = new THREE.Mesh(new THREE.BoxGeometry(width, 0.28, depth), this.stone); band.position.set(x, y, z); band.castShadow = true; this.parent.add(band);
  }

  private addStructuralDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    if (spec.style === 'downtown') this.addDowntownDetail(spec, massing, roofY);
    else if (spec.style === 'residential') this.addResidentialDetail(spec, massing, roofY);
    else if (spec.style === 'estate') this.addResidentialDetail(spec, massing, roofY); // villa porch/chimney/dormers
    else this.addIndustrialDetail(spec, massing, roofY);
  }

  private addDowntownDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    if (massing === 4) {
      this.addCylindricalDowntownDetail(spec);
    } else {
      if (variant % 2 === 0) {
        const finCount = Math.max(3, Math.min(7, Math.floor(w / 4)));
        for (let index = 0; index < finCount; index++) {
          const px = x - w * 0.38 + index * (w * 0.76 / Math.max(1, finCount - 1));
          const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, h * 0.72, 0.52), this.stone); fin.position.set(px, h * 0.51, z + d / 2 + 0.23); fin.castShadow = true; this.parent.add(fin);
        }
      }
      for (let y = 11; y < h - 5; y += Math.max(10, h / 5)) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, 0.18, 0.28), this.darkMetal); band.position.set(x, y, z + d / 2 + 0.15); this.parent.add(band);
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
    const porch = new THREE.Mesh(new THREE.BoxGeometry(w * 0.48, 0.28, 2.3), this.timber); porch.position.set(x, 0.45, z + d / 2 + 1); porch.castShadow = true; this.parent.add(porch);
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.56, 0.18, 2.55), variant % 2 ? this.terracotta : this.darkMetal); porchRoof.position.set(x, 3.15, z + d / 2 + 1); porchRoof.rotation.x = -0.08; porchRoof.castShadow = true; this.parent.add(porchRoof);
    for (const px of [-w * 0.2, w * 0.2]) { const column = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 2.7, 14), this.stone); column.position.set(x + px, 1.8, z + d / 2 + 1.75); column.castShadow = true; this.parent.add(column); }
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
    const dock = new THREE.Mesh(new THREE.BoxGeometry(w * 0.58, 1.1, 2.4), this.steel); dock.position.set(x, 0.7, z + d / 2 + 1.1); dock.castShadow = true; this.parent.add(dock);
    const pipeHeight = Math.min(8, h * 0.65);
    for (const side of [-1, 1]) { const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, pipeHeight, 12), this.steel); pipe.position.set(x + side * w * 0.36, pipeHeight / 2 + 0.5, z + d / 2 + 0.28); pipe.castShadow = true; this.parent.add(pipe); }
    const duct = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, 0.8, 0.85), this.steel); duct.position.set(x, h * 0.62, z + d / 2 + 0.38); this.parent.add(duct);
    if (variant % 2 === 1) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.25, Math.min(8, h * 0.65), 24), this.steel); tank.position.set(x + w * 0.28, Math.min(8, h * 0.65) / 2 + 0.25, z - d * 0.22); tank.castShadow = true; this.parent.add(tank);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), this.steel); dome.position.set(tank.position.x, tank.position.y + Math.min(8, h * 0.65) / 2, tank.position.z); dome.castShadow = true; this.parent.add(dome);
    }
    if (massing === 3) {
      const monitor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 1.5, d * 0.24), this.glass); monitor.position.set(x, roofY - 0.7, z); monitor.castShadow = true; this.parent.add(monitor);
    }
  }
}
