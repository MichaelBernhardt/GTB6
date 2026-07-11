import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { PropRegistry } from '../systems/PropSystem';
import type { RoadPoint, RoadsidePoint } from './City';
import { createSignMesh } from './ProceduralMaterials';
import { onPowerChange } from './powerGrid';

const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

export interface JunctionDefinition {
  x: number;
  z: number;
  angle: number;
  roadA: string;
  roadB: string;
  phase: number;
}

export const CITY_JUNCTIONS: JunctionDefinition[] = [
  { x: -8, z: 205, angle: 0.2, roadA: 'JAN SMUTS AVE', roadB: 'WILLIAM NICOL DR', phase: 0 },
  { x: 5, z: 12, angle: -0.2, roadA: 'JAN SMUTS AVE', roadB: 'MAIN REEF RD', phase: 4 },
  { x: 75, z: -5, angle: -0.35, roadA: 'MAIN REEF RD', roadB: 'BREE ST', phase: 8 },
  { x: -262, z: 88, angle: 0.18, roadA: 'VILAKAZI ST', roadB: 'LOUIS BOTHA AVE', phase: 12 },
  { x: -130, z: 50, angle: -0.28, roadA: 'MAIN REEF RD', roadB: 'EMPIRE RD', phase: 16 },
  { x: 115, z: 205, angle: 0.32, roadA: 'WILLIAM NICOL DR', roadB: 'RIVONIA RD', phase: 20 },
  { x: 78, z: -246, angle: 0.65, roadA: 'COMMISSIONER ST', roadB: 'MARSHALL ST', phase: 24 },
];

export const SIGNAL_CORNER_OFFSET = 15.5;

export const ETOLL_GANTRIES: Array<{ x: number; z: number; angle: number }> = [
  { x: 9.5, z: 100, angle: 3.27 },
  { x: -8.5, z: -42.5, angle: 3.05 },
];

interface SignalLens { axis: 0 | 1; phase: number; channel: 0 | 1 | 2; }
const SIGNAL_COLORS = [0xe83f3f, 0xf0ad2f, 0x39d36c] as const;

const BULB_COLOR = 0xffdca0;

export class UrbanInfrastructure {
  /** Interleaved xz world positions of every streetlamp fixture, for the day/night light pool. */
  lampsXZ = new Float32Array(0);
  private group = new THREE.Group();
  private lenses: SignalLens[] = [];
  private lensMesh?: THREE.InstancedMesh;
  private lensColor = new THREE.Color();
  private elapsed = 0;
  private bulbMaterial?: THREE.MeshBasicMaterial;
  private powered = true;

  constructor(
    parent: THREE.Group,
    private roadsidePoints: RoadsidePoint[],
    private isBlocked: (x: number, z: number, radius: number) => boolean,
    private isRoad: (x: number, z: number, margin: number) => boolean,
    private props: PropRegistry,
  ) {
    this.group.name = 'Urban infrastructure'; parent.add(this.group);
    onPowerChange((on) => { this.powered = on; });
    this.buildVegetation();
    this.buildStreetlights();
    this.buildTrafficSignals();
    this.buildRoadsideSigns();
    this.buildStreetFurniture();
    this.buildTransitStops();
    this.buildEtollGantries();
  }

  update(dt: number): void {
    this.elapsed = (this.elapsed + dt) % 30;
    const mesh = this.lensMesh; if (!mesh) return;
    this.lenses.forEach((lens, index) => {
      const cycle = (this.elapsed + lens.phase + lens.axis * 15) % 30;
      const on = this.powered && (lens.channel === 2 ? cycle < 11 : lens.channel === 1 ? cycle >= 11 && cycle < 14 : cycle >= 14);
      this.lensColor.setHex(on ? SIGNAL_COLORS[lens.channel] : 0x14100e);
      if (on) this.lensColor.multiplyScalar(2.1);
      mesh.setColorAt(index, this.lensColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** 0 = day (dim panel), 1 = night: pushes the shared bulb material into HDR so streetlamp heads bloom.
   *  During load shedding the panel goes fully dark whatever the hour — Eskom outranks dusk. */
  setLampGlow(factor: number): void {
    if (!this.powered) { this.bulbMaterial?.color.setHex(0x2a2d2f); return; }
    this.bulbMaterial?.color.setHex(BULB_COLOR).multiplyScalar(0.35 + factor * 2.85);
  }

  private buildVegetation(): void {
    // Verge planting: trees/shrubs stand 2.1u OUTWARD of the roadside line, clear of both the sidewalk walk
    // line peds actually route along (they used to grow exactly on the nav points and embed spawned peds)
    // and of junction lane chords (hence the wider road margin).
    const sites = this.roadsidePoints
      .filter((_, index) => index % 6 === 0)
      .map((point) => ({ x: point.x - point.inwardX * 2.1, z: point.z - point.inwardZ * 2.1 }))
      .filter((point) => !this.isBlocked(point.x, point.z, 2.8) && !this.isRoad(point.x, point.z, 2.4));
    const jacarandas = sites.filter((_, index) => index % 2 === 0);
    const broadleaf = sites.filter((_, index) => index % 2 !== 0);
    this.buildBroadleafTrees(broadleaf);
    this.buildJacarandas(jacarandas);

    const shrubSites = sites.filter((_, index) => index % 3 === 0);
    const shrubGeometry = new THREE.SphereGeometry(1, 16, 10);
    const shrubs = new THREE.InstancedMesh(shrubGeometry, new THREE.MeshStandardMaterial({ color: 0x365f3d, roughness: 0.94 }), shrubSites.length * 3);
    const shrubDebrisMaterial = new THREE.MeshStandardMaterial({ color: 0x3c6a41, roughness: 0.94 });
    const matrix = new THREE.Matrix4(); const color = new THREE.Color(); let shrubIndex = 0;
    shrubSites.forEach((site, index) => {
      for (let cluster = 0; cluster < 3; cluster++) {
        const angle = cluster / 3 * Math.PI * 2 + index; const scale = 0.42 + ((index + cluster) % 4) * 0.08;
        const x = site.x + Math.cos(angle) * 1.35; const z = site.z + Math.sin(angle) * 1.35;
        matrix.compose(new THREE.Vector3(x, scale * 0.75, z), new THREE.Quaternion(), new THREE.Vector3(scale * 1.25, scale, scale));
        shrubs.setMatrixAt(shrubIndex, matrix); shrubs.setColorAt(shrubIndex, color.setHex(cluster === 1 ? 0x4f7d45 : 0x315c3b));
        const instance = shrubIndex;
        this.props.register('shrub', x, z, scale * 1.1, scale * 1.5, {
          hide: () => { shrubs.setMatrixAt(instance, HIDDEN_MATRIX); shrubs.instanceMatrix.needsUpdate = true; },
          debris: () => {
            const group = new THREE.Group(); group.position.set(x, 0, z);
            const tuft = new THREE.Mesh(shrubGeometry, shrubDebrisMaterial); tuft.position.y = scale * 0.75; tuft.scale.set(scale * 1.25, scale, scale); tuft.castShadow = true; group.add(tuft);
            return group;
          },
        });
        shrubIndex++;
      }
    });
    shrubs.castShadow = true; shrubs.receiveShadow = true; this.group.add(shrubs);
  }

  private buildBroadleafTrees(sites: RoadPoint[]): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.32, 0.58, 5.2, 14);
    const crownGeometry = new THREE.SphereGeometry(1, 20, 14);
    const trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshStandardMaterial({ color: 0x5c402c, roughness: 0.96 }), sites.length);
    const crowns = new THREE.InstancedMesh(crownGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 }), sites.length * 5);
    const matrix = new THREE.Matrix4(); const color = new THREE.Color(); const quaternion = new THREE.Quaternion();
    sites.forEach((site, index) => {
      const height = 0.9 + (index % 5) * 0.035;
      this.props.register('tree', site.x, site.z, 0.5, 5.2 * height); // trunk-sized, so the sidewalk stays walkable
      matrix.compose(new THREE.Vector3(site.x, 2.6 * height, site.z), quaternion, new THREE.Vector3(height, height, height)); trunks.setMatrixAt(index, matrix);
      const offsets: Array<[number, number, number, number]> = [[0, 6.2, 0, 2.25], [-1.45, 5.65, 0.3, 1.8], [1.35, 5.75, -0.35, 1.9], [0.25, 5.6, 1.3, 1.65], [-0.35, 6.45, -0.9, 1.55]];
      const palette = index % 4 === 0 ? [0x8a6cc4, 0x9b7fd4, 0xb18ae0, 0x8a6cc4] : [0x4c6b38, 0x5d7a3e, 0x6f8646, 0x445e34];
      offsets.forEach(([ox, oy, oz, scale], cluster) => {
        const sway = ((index * 17 + cluster * 7) % 11 - 5) * 0.055;
        matrix.compose(new THREE.Vector3(site.x + ox + sway, oy * height, site.z + oz - sway), quaternion, new THREE.Vector3(scale * (1 + sway * 0.2), scale * 0.78, scale));
        const instance = index * offsets.length + cluster; crowns.setMatrixAt(instance, matrix);
        crowns.setColorAt(instance, color.setHex(palette[(index + cluster) % 4] ?? 0x5d7a3e));
      });
    });
    trunks.castShadow = true; trunks.receiveShadow = true; crowns.castShadow = true; crowns.receiveShadow = true;
    this.group.add(trunks, crowns);
  }

  private buildJacarandas(sites: RoadPoint[]): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.26, 0.52, 4.6, 14);
    const crownGeometry = new THREE.SphereGeometry(1, 20, 14);
    const trunks = new THREE.InstancedMesh(trunkGeometry, new THREE.MeshStandardMaterial({ color: 0x6b4d38, roughness: 0.92 }), sites.length);
    const crowns = new THREE.InstancedMesh(crownGeometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 }), sites.length * 5);
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const color = new THREE.Color();
    sites.forEach((site, index) => {
      const height = 0.92 + (index % 4) * 0.045;
      this.props.register('tree', site.x, site.z, 0.45, 4.6 * height); // jacaranda trunks are as solid as any other tree
      matrix.compose(new THREE.Vector3(site.x, 2.3 * height, site.z), quaternion, new THREE.Vector3(height, height, height)); trunks.setMatrixAt(index, matrix);
      const offsets: Array<[number, number, number, number]> = [[0, 5.4, 0, 2.5], [-1.7, 4.9, 0.4, 1.9], [1.6, 5, -0.4, 2], [0.3, 4.8, 1.55, 1.75], [-0.45, 5.6, -1.05, 1.6]];
      offsets.forEach(([ox, oy, oz, scale], cluster) => {
        const sway = ((index * 13 + cluster * 5) % 9 - 4) * 0.06;
        matrix.compose(new THREE.Vector3(site.x + ox + sway, oy * height, site.z + oz - sway), quaternion, new THREE.Vector3(scale * 1.1, scale * 0.66, scale * 1.1));
        const instance = index * offsets.length + cluster; crowns.setMatrixAt(instance, matrix);
        crowns.setColorAt(instance, color.setHex([0x9b7fd4, 0xb18ae0, 0x8a6cc4][(index + cluster) % 3] ?? 0x9b7fd4));
      });
    });
    trunks.castShadow = true; trunks.receiveShadow = true; crowns.castShadow = true; crowns.receiveShadow = true;
    this.group.add(trunks, crowns);
  }

  private buildStreetlights(): void {
    const sites = this.roadsidePoints.filter((point, index) => index % 4 === 1 && !this.isBlocked(point.x, point.z, 1.2) && !this.isRoad(point.x, point.z, 0.9));
    const metal = new THREE.MeshStandardMaterial({ color: 0x253033, roughness: 0.34, metalness: 0.82 });
    const deadBulbMaterial = new THREE.MeshBasicMaterial({ color: 0x2a2d2f, side: THREE.DoubleSide }); // a downed lamp is dark, day or night, powered or not
    const poleGeometry = new THREE.CylinderGeometry(0.08, 0.17, 6.5, 12);
    const armGeometry = new THREE.CylinderGeometry(0.055, 0.065, 1.25, 10);
    const collarGeometry = new THREE.CylinderGeometry(0.23, 0.28, 0.42, 14);
    const fixtureGeometry = new RoundedBoxGeometry(0.9, 0.22, 0.42, 3, 0.07);
    const bulbGeometry = new THREE.PlaneGeometry(0.62, 0.22);
    const poles = new THREE.InstancedMesh(poleGeometry, metal, sites.length);
    const arms = new THREE.InstancedMesh(armGeometry, metal, sites.length);
    const collars = new THREE.InstancedMesh(collarGeometry, metal, sites.length);
    const fixtures = new THREE.InstancedMesh(fixtureGeometry, metal, sites.length);
    const bulbs = new THREE.InstancedMesh(bulbGeometry, new THREE.MeshBasicMaterial({ color: BULB_COLOR, side: THREE.DoubleSide }), sites.length);
    this.bulbMaterial = bulbs.material as THREE.MeshBasicMaterial; this.setLampGlow(0); // day/night + load shedding drive this material instead of registerPowered
    const lampsXZ = new Float32Array(sites.length * 2); this.lampsXZ = lampsXZ;
    const matrix = new THREE.Matrix4(); const up = new THREE.Vector3(0, 1, 0);
    sites.forEach((site, index) => {
      const direction = new THREE.Vector3(site.inwardX, 0, site.inwardZ).normalize();
      lampsXZ[index * 2] = site.x + direction.x * 1.18; lampsXZ[index * 2 + 1] = site.z + direction.z * 1.18;
      const headRotation = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(-direction.z, direction.x));
      matrix.compose(new THREE.Vector3(site.x, 3.25, site.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)); poles.setMatrixAt(index, matrix);
      matrix.makeTranslation(site.x, 0.23, site.z); collars.setMatrixAt(index, matrix);
      const armRotation = new THREE.Quaternion().setFromUnitVectors(up, direction);
      matrix.compose(new THREE.Vector3(site.x, 6.08, site.z).addScaledVector(direction, 0.58), armRotation, new THREE.Vector3(1, 1, 1)); arms.setMatrixAt(index, matrix);
      matrix.compose(new THREE.Vector3(site.x, 6.15, site.z).addScaledVector(direction, 1.18), headRotation, new THREE.Vector3(1, 1, 1)); fixtures.setMatrixAt(index, matrix);
      const bulbRotation = headRotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      matrix.compose(new THREE.Vector3(site.x, 6.02, site.z).addScaledVector(direction, 1.18), bulbRotation, new THREE.Vector3(1, 1, 1)); bulbs.setMatrixAt(index, matrix);
      this.props.register('streetlight', site.x, site.z, 0.2, 6.5, {
        hide: () => {
          for (const mesh of [poles, arms, collars, fixtures, bulbs]) { mesh.setMatrixAt(index, HIDDEN_MATRIX); mesh.instanceMatrix.needsUpdate = true; }
          lampsXZ[index * 2] = 1e9; lampsXZ[index * 2 + 1] = 1e9; // evict from the day/night light pool: felled lamps shine no more
        },
        debris: () => {
          const group = new THREE.Group(); group.position.set(site.x, 0, site.z);
          const pole = new THREE.Mesh(poleGeometry, metal); pole.position.y = 3.25;
          const collar = new THREE.Mesh(collarGeometry, metal); collar.position.y = 0.23;
          const arm = new THREE.Mesh(armGeometry, metal); arm.position.set(direction.x * 0.58, 6.08, direction.z * 0.58); arm.quaternion.copy(armRotation);
          const fixture = new THREE.Mesh(fixtureGeometry, metal); fixture.position.set(direction.x * 1.18, 6.15, direction.z * 1.18); fixture.quaternion.copy(headRotation);
          const bulb = new THREE.Mesh(bulbGeometry, deadBulbMaterial); bulb.position.set(direction.x * 1.18, 6.02, direction.z * 1.18); bulb.quaternion.copy(bulbRotation);
          for (const part of [pole, collar, arm, fixture]) part.castShadow = true;
          group.add(pole, collar, arm, fixture, bulb);
          return group;
        },
      });
    });
    poles.castShadow = true; arms.castShadow = true; fixtures.castShadow = true; this.group.add(poles, arms, collars, fixtures, bulbs);
  }

  private buildTrafficSignals(): void {
    const lensTransforms: THREE.Matrix4[] = [];
    for (const junction of CITY_JUNCTIONS) {
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      for (const forwardSide of [-1, 1] as const) for (const rightSide of [-1, 1] as const) {
        const axis: 0 | 1 = forwardSide === rightSide ? 0 : 1;
        const inward = (axis === 0 ? forward.clone().multiplyScalar(-forwardSide) : right.clone().multiplyScalar(-rightSide));
        const position = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, forwardSide * SIGNAL_CORNER_OFFSET).addScaledVector(right, rightSide * SIGNAL_CORNER_OFFSET);
        if (!this.clearOfRoad(position, junction)) continue; // corner diagonal ran down a road: no pole beats a pole in the middle of a lane
        const heading = Math.atan2(inward.z, -inward.x);
        this.addSignalPole(position, heading, axis, junction.phase, lensTransforms);
      }
      this.addStreetSigns(junction, forward, right);
    }
    const lensMesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.19, 20), new THREE.MeshBasicMaterial(), lensTransforms.length);
    lensTransforms.forEach((transform, index) => { lensMesh.setMatrixAt(index, transform); lensMesh.setColorAt(index, this.lensColor.setHex(0x14100e)); });
    lensMesh.instanceMatrix.needsUpdate = true;
    this.lensMesh = lensMesh; this.group.add(lensMesh);
  }

  private addSignalPole(position: THREE.Vector3, heading: number, axis: 0 | 1, phase: number, lensTransforms: THREE.Matrix4[]): void {
    this.props.register('signal', position.x, position.z, 0.24, 5.7); // robots are heavy municipal steel — they stop a bakkie
    const assembly = new THREE.Group(); assembly.position.copy(position); assembly.rotation.y = heading;
    const metal = new THREE.MeshStandardMaterial({ color: 0x273135, metalness: 0.78, roughness: 0.34 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe0aa29, metalness: 0.32, roughness: 0.48 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 5.7, 12), metal); pole.position.y = 2.85;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.13, 0.13), metal); arm.position.set(-2.05, 5.4, 0);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.72, 2.2, 0.58, 3, 0.09), yellow); head.position.set(-3.95, 4.65, 0);
    const hoodGeometry = new THREE.CylinderGeometry(0.25, 0.25, 0.22, 16, 1, false, 0, Math.PI);
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const matrix = new THREE.Matrix4(); const one = new THREE.Vector3(1, 1, 1);
    for (const channel of [0, 1, 2] as const) {
      matrix.compose(new THREE.Vector3(-3.95, 5.28 - channel * 0.64, 0.301).applyQuaternion(rotation).add(position), rotation, one);
      lensTransforms.push(matrix.clone()); this.lenses.push({ axis, phase, channel });
      const hood = new THREE.Mesh(hoodGeometry, yellow); hood.rotation.set(Math.PI / 2, 0, 0); hood.position.set(-3.95, 5.38 - channel * 0.64, 0.34); assembly.add(hood);
    }
    assembly.add(pole, arm, head); assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(assembly);
  }

  /** The hand-authored junction anchors don't sit exactly on either centerline and roads cross at odd
   *  angles, so a SIGNAL_CORNER_OFFSET diagonal can land in the middle of a lane (it did: Jan Smuts and
   *  Bree St both had signals planted on the tar, wedging traffic forever). Slide the corner outward
   *  along its diagonal until it clears every road by a solid-prop-safe margin; give up past 12u extra. */
  private clearOfRoad(position: THREE.Vector3, junction: JunctionDefinition): boolean {
    const diagonal = new THREE.Vector3(position.x - junction.x, 0, position.z - junction.z).normalize();
    for (let slide = 0; slide <= 6; slide++) {
      if (!this.isRoad(position.x, position.z, 2.2)) return true;
      position.addScaledVector(diagonal, 2);
    }
    return false;
  }

  private addStreetSigns(junction: JunctionDefinition, forward: THREE.Vector3, right: THREE.Vector3): void {
    const postPosition = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, SIGNAL_CORNER_OFFSET).addScaledVector(right, SIGNAL_CORNER_OFFSET);
    if (!this.clearOfRoad(postPosition, junction)) return;
    const assembly = new THREE.Group(); assembly.position.copy(postPosition);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.6, 10), new THREE.MeshStandardMaterial({ color: 0x344044, metalness: 0.68, roughness: 0.4 })); post.position.y = 1.8; assembly.add(post);
    const labels: Array<[string, number, number]> = [[junction.roadA, junction.angle, 3.25], [junction.roadB, junction.angle + Math.PI / 2, 2.78]];
    for (const [label, angle, y] of labels) {
      const sign = createSignMesh(new THREE.PlaneGeometry(4.2, 0.92), label, '#f2f4e9', { background: '#176a5a', doubleSide: true });
      sign.position.y = y; sign.rotation.y = angle; assembly.add(sign);
    }
    assembly.traverse((object) => { object.userData.dynamic = true; }); // knock-over props stay unmerged so they can tip
    this.group.add(assembly);
    this.props.register('sign', postPosition.x, postPosition.z, 0.14, 3.6, { debris: () => assembly });
  }

  private buildRoadsideSigns(): void {
    const signs: Array<[number, number, number, string]> = [
      [-22, 28, -0.2, 'STOP'], [91, 10, -0.35, '60'], [-275, 104, 0.18, 'STOP'], [131, 214, 0.32, 'HIJACKING HOTSPOT'],
      [176, -238, 0.05, 'P'], [268, 278, -0.25, '60'], [-205, -222, 0.1, 'SMASH & GRAB HOTSPOT'], [-112, 218, 0.2, 'TAXI'],
    ];
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x7b8380, metalness: 0.68, roughness: 0.38 });
    for (const [x, z, angle, label] of signs) {
      if (this.isRoad(x, z, 0.45)) continue;
      const hotspot = label.includes('HOTSPOT');
      const assembly = new THREE.Group(); assembly.position.set(x, 0, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 2.6, 9), poleMaterial); pole.position.y = 1.3; assembly.add(pole);
      const background = label === 'STOP' ? '#b62f2d' : label === 'P' ? '#28619a' : label === 'TAXI' ? '#f2c521' : '#f0eee2';
      const foreground = label === 'STOP' || label === 'P' ? '#ffffff' : '#182326';
      const geometry = label === 'STOP' ? new THREE.CircleGeometry(0.7, 8) : hotspot ? new THREE.PlaneGeometry(2.4, 1.1) : new THREE.PlaneGeometry(label === 'ONE WAY' ? 1.65 : 1.1, 1.25);
      const sign = createSignMesh(geometry, label, foreground, { background, doubleSide: true });
      sign.position.y = 2.45; sign.rotation.y = angle; assembly.add(sign);
      assembly.traverse((object) => { object.userData.dynamic = true; }); // knock-over props stay unmerged so they can tip
      this.group.add(assembly);
      this.props.register('sign', x, z, 0.14, 2.6, { debris: () => assembly });
    }
  }

  private buildStreetFurniture(): void {
    const sites = this.roadsidePoints.filter((point, index) => index % 13 === 3 && !this.isBlocked(point.x, point.z, 2) && !this.isRoad(point.x, point.z, 0.7));
    const wood = new THREE.MeshStandardMaterial({ color: 0x744d32, roughness: 0.77 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3739, metalness: 0.72, roughness: 0.35 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8322d, metalness: 0.3, roughness: 0.5 });
    const slatGeometry = new RoundedBoxGeometry(2.25, 0.11, 0.16, 2, 0.035);
    const legGeometry = new THREE.BoxGeometry(0.08, 0.55, 0.5);
    const backGeometry = new RoundedBoxGeometry(2.25, 0.62, 0.1, 2, 0.03);
    const bodyGeometry = new THREE.CylinderGeometry(0.17, 0.23, 0.7, 16);
    const capGeometry = new THREE.SphereGeometry(0.23, 14, 9);
    const slats = new THREE.InstancedMesh(slatGeometry, wood, sites.length * 3);
    const legs = new THREE.InstancedMesh(legGeometry, metal, sites.length * 2);
    const backs = new THREE.InstancedMesh(backGeometry, wood, sites.length);
    const bodies = new THREE.InstancedMesh(bodyGeometry, red, sites.length);
    const caps = new THREE.InstancedMesh(capGeometry, red, sites.length);
    const matrix = new THREE.Matrix4(); const identity = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0); const backTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12);
    sites.forEach((site, index) => {
      const yaw = Math.atan2(site.inwardX, site.inwardZ);
      const rotation = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      const bx = site.x - site.inwardX * 0.8; const bz = site.z - site.inwardZ * 0.8; // benches sit back from the walk line so their 0.85u shell doesn't clip routed peds
      const world = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx, ly, lz).applyQuaternion(rotation).add(new THREE.Vector3(bx, 0, bz));
      [-0.22, 0, 0.22].forEach((lz, slot) => { matrix.compose(world(0, 0.62, lz), rotation, one); slats.setMatrixAt(index * 3 + slot, matrix); });
      [-0.78, 0.78].forEach((lx, slot) => { matrix.compose(world(lx, 0.3, 0), rotation, one); legs.setMatrixAt(index * 2 + slot, matrix); });
      matrix.compose(world(0, 0.98, -0.29), rotation.clone().multiply(backTilt), one); backs.setMatrixAt(index, matrix);
      this.props.register('bench', bx, bz, 0.85, 1.1, {
        hide: () => {
          for (const slot of [0, 1, 2]) slats.setMatrixAt(index * 3 + slot, HIDDEN_MATRIX);
          for (const slot of [0, 1]) legs.setMatrixAt(index * 2 + slot, HIDDEN_MATRIX);
          backs.setMatrixAt(index, HIDDEN_MATRIX);
          for (const mesh of [slats, legs, backs]) mesh.instanceMatrix.needsUpdate = true;
        },
        debris: () => {
          const group = new THREE.Group(); group.position.set(bx, 0, bz); group.rotation.y = yaw;
          for (const lz of [-0.22, 0, 0.22]) { const slat = new THREE.Mesh(slatGeometry, wood); slat.position.set(0, 0.62, lz); group.add(slat); }
          for (const lx of [-0.78, 0.78]) { const leg = new THREE.Mesh(legGeometry, metal); leg.position.set(lx, 0.3, 0); group.add(leg); }
          const back = new THREE.Mesh(backGeometry, wood); back.position.set(0, 0.98, -0.29); back.rotation.x = -0.12; group.add(back);
          group.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
          return group;
        },
      });
      const hx = site.x - site.inwardX * 0.75; const hz = site.z - site.inwardZ * 0.75; // hydrants used to lean INTO the walk line (0.4u off it) and embedded spawned peds
      matrix.compose(new THREE.Vector3(hx, 0.36, hz), identity, one); bodies.setMatrixAt(index, matrix);
      matrix.compose(new THREE.Vector3(hx, 0.76, hz), identity, one); caps.setMatrixAt(index, matrix);
      this.props.register('hydrant', hx, hz, 0.24, 0.9, {
        hide: () => { bodies.setMatrixAt(index, HIDDEN_MATRIX); caps.setMatrixAt(index, HIDDEN_MATRIX); bodies.instanceMatrix.needsUpdate = true; caps.instanceMatrix.needsUpdate = true; },
        debris: () => {
          const group = new THREE.Group(); group.position.set(hx, 0, hz);
          const body = new THREE.Mesh(bodyGeometry, red); body.position.y = 0.36; body.castShadow = true;
          const cap = new THREE.Mesh(capGeometry, red); cap.position.y = 0.76; group.add(body, cap);
          return group;
        },
      });
    });
    for (const mesh of [slats, legs, backs, bodies, caps]) { mesh.castShadow = true; mesh.receiveShadow = true; this.group.add(mesh); }
  }

  private buildEtollGantries(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x7d8489, metalness: 0.72, roughness: 0.36 });
    const purple = new THREE.MeshStandardMaterial({ color: 0x4b2e83, metalness: 0.3, roughness: 0.5 });
    for (const gantry of ETOLL_GANTRIES) {
      const assembly = new THREE.Group(); assembly.position.set(gantry.x, 0, gantry.z); assembly.rotation.y = gantry.angle;
      for (const side of [-17, 17]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 7, 12), steel); post.position.set(side, 3.5, 0); assembly.add(post);
        this.props.register('post', gantry.x + side * Math.cos(gantry.angle), gantry.z - side * Math.sin(gantry.angle), 0.3, 7); // gantry pylons: SANRAL built them to last
      }
      const truss = new THREE.Mesh(new THREE.BoxGeometry(36, 0.9, 1.1), steel); truss.position.y = 6.6; assembly.add(truss);
      for (const x of [-8, 0, 8]) { const camera = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.6), purple); camera.position.set(x, 5.9, 0.3); assembly.add(camera); }
      const board = createSignMesh(new THREE.PlaneGeometry(6, 1.4), 'E-TOLL · SANRAL', '#f2f4e9', { background: '#4b2e83', doubleSide: true });
      board.position.set(0, 6.65, 0.62); assembly.add(board);
      assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
      this.group.add(assembly);
    }
  }

  private buildTransitStops(): void {
    const stops: Array<[number, number, number, string]> = [[-48, 222, 0.15, 'BREE RANK'], [166, 173, -0.2, 'WANDERERS'], [-210, -229, 0.12, 'MTN RANK'], [125, -265, -0.08, 'NOORD RANK']]; // MTN RANK sits back from Commissioner so its 2.7u shell clears the walk line
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x6e9da3, roughness: 0.16, metalness: 0.08, clearcoat: 0.7, transparent: true, opacity: 0.66 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x293638, metalness: 0.72, roughness: 0.35 });
    for (const [x, z, angle, label] of stops) {
      if (this.isRoad(x, z, 2.8)) continue;
      this.props.register('shelter', x, z, 2.7, 2.9);
      const shelter = new THREE.Group(); shelter.position.set(x, 0, z); shelter.rotation.y = angle;
      const back = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.7, 0.08), glass); back.position.y = 1.45;
      const roof = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.16, 1.65, 3, 0.06), metal); roof.position.set(0, 2.9, 0.7);
      const seat = new THREE.Mesh(new RoundedBoxGeometry(3.4, 0.16, 0.55, 2, 0.04), metal); seat.position.set(0, 0.65, 0.42);
      const name = createSignMesh(new THREE.PlaneGeometry(3.8, 0.65), label, '#172023', { background: '#c7982c', powered: true }); name.position.set(0, 2.45, 0.06);
      shelter.add(back, roof, seat, name); shelter.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(shelter);
    }
  }
}
