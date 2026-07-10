import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { RoadPoint, RoadsidePoint } from './City';
import { onPowerChange, registerPowered } from './powerGrid';

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

interface SignalHead {
  red: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  green: THREE.MeshStandardMaterial;
  axis: 0 | 1;
  phase: number;
}

const makeSignTexture = (label: string, background: string, foreground = '#f2f4e9'): THREE.CanvasTexture => {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable');
  context.fillStyle = background; context.fillRect(0, 0, 512, 128);
  context.strokeStyle = foreground; context.lineWidth = 9; context.strokeRect(7, 7, 498, 114);
  context.fillStyle = foreground; context.font = '700 48px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(label, 256, 67, 470);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
};

const setSignal = (material: THREE.MeshStandardMaterial, active: boolean, color: number): void => {
  material.color.setHex(active ? color : 0x191d1b);
  material.emissive.setHex(active ? color : 0x000000);
  material.emissiveIntensity = active ? 2.8 : 0;
};

export class UrbanInfrastructure {
  private group = new THREE.Group();
  private signals: SignalHead[] = [];
  private elapsed = 0;
  private powered = true;

  constructor(
    parent: THREE.Group,
    private sidewalkPoints: RoadPoint[],
    private roadsidePoints: RoadsidePoint[],
    private isBlocked: (x: number, z: number, radius: number) => boolean,
    private isRoad: (x: number, z: number, margin: number) => boolean,
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
    for (const signal of this.signals) {
      if (!this.powered) {
        setSignal(signal.green, false, 0x39d36c);
        setSignal(signal.amber, false, 0xf0ad2f);
        setSignal(signal.red, false, 0xe83f3f);
        continue;
      }
      const cycle = (this.elapsed + signal.phase + signal.axis * 15) % 30;
      setSignal(signal.green, cycle < 11, 0x39d36c);
      setSignal(signal.amber, cycle >= 11 && cycle < 14, 0xf0ad2f);
      setSignal(signal.red, cycle >= 14, 0xe83f3f);
    }
  }

  private buildVegetation(): void {
    const sites = this.sidewalkPoints.filter((point, index) => index % 6 === 0 && !this.isBlocked(point.x, point.z, 2.8) && !this.isRoad(point.x, point.z, 0.65));
    const jacarandas = sites.filter((_, index) => index % 2 === 0);
    const broadleaf = sites.filter((_, index) => index % 2 !== 0);
    this.buildBroadleafTrees(broadleaf);
    this.buildJacarandas(jacarandas);

    const shrubSites = sites.filter((_, index) => index % 3 === 0);
    const shrubGeometry = new THREE.SphereGeometry(1, 16, 10);
    const shrubs = new THREE.InstancedMesh(shrubGeometry, new THREE.MeshStandardMaterial({ color: 0x365f3d, roughness: 0.94 }), shrubSites.length * 3);
    const matrix = new THREE.Matrix4(); const color = new THREE.Color(); let shrubIndex = 0;
    shrubSites.forEach((site, index) => {
      for (let cluster = 0; cluster < 3; cluster++) {
        const angle = cluster / 3 * Math.PI * 2 + index; const scale = 0.42 + ((index + cluster) % 4) * 0.08;
        matrix.compose(new THREE.Vector3(site.x + Math.cos(angle) * 1.35, scale * 0.75, site.z + Math.sin(angle) * 1.35), new THREE.Quaternion(), new THREE.Vector3(scale * 1.25, scale, scale));
        shrubs.setMatrixAt(shrubIndex, matrix); shrubs.setColorAt(shrubIndex, color.setHex(cluster === 1 ? 0x4f7d45 : 0x315c3b)); shrubIndex++;
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
    const poleGeometry = new THREE.CylinderGeometry(0.08, 0.17, 6.5, 12);
    const armGeometry = new THREE.CylinderGeometry(0.055, 0.065, 1.25, 10);
    const fixtureGeometry = new RoundedBoxGeometry(0.9, 0.22, 0.42, 3, 0.07);
    const poles = new THREE.InstancedMesh(poleGeometry, metal, sites.length);
    const arms = new THREE.InstancedMesh(armGeometry, metal, sites.length);
    const collars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.23, 0.28, 0.42, 14), metal, sites.length);
    const fixtures = new THREE.InstancedMesh(fixtureGeometry, metal, sites.length);
    const bulbMaterial = new THREE.MeshBasicMaterial({ color: 0xffdca0, side: THREE.DoubleSide });
    registerPowered(bulbMaterial, 0xffdca0, 0x2a2d2f);
    const bulbs = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.62, 0.22), bulbMaterial, sites.length);
    const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion(); const up = new THREE.Vector3(0, 1, 0);
    sites.forEach((site, index) => {
      const direction = new THREE.Vector3(site.inwardX, 0, site.inwardZ).normalize();
      const angle = Math.atan2(-direction.z, direction.x); quaternion.setFromAxisAngle(up, angle);
      matrix.compose(new THREE.Vector3(site.x, 3.25, site.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)); poles.setMatrixAt(index, matrix);
      matrix.makeTranslation(site.x, 0.23, site.z); collars.setMatrixAt(index, matrix);
      const armRotation = new THREE.Quaternion().setFromUnitVectors(up, direction);
      matrix.compose(new THREE.Vector3(site.x, 6.08, site.z).addScaledVector(direction, 0.58), armRotation, new THREE.Vector3(1, 1, 1)); arms.setMatrixAt(index, matrix);
      matrix.compose(new THREE.Vector3(site.x, 6.15, site.z).addScaledVector(direction, 1.18), quaternion, new THREE.Vector3(1, 1, 1)); fixtures.setMatrixAt(index, matrix);
      const bulbRotation = quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      matrix.compose(new THREE.Vector3(site.x, 6.02, site.z).addScaledVector(direction, 1.18), bulbRotation, new THREE.Vector3(1, 1, 1)); bulbs.setMatrixAt(index, matrix);
    });
    poles.castShadow = true; arms.castShadow = true; fixtures.castShadow = true; this.group.add(poles, arms, collars, fixtures, bulbs);
  }

  private buildTrafficSignals(): void {
    for (const junction of CITY_JUNCTIONS) {
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      for (const forwardSide of [-1, 1] as const) for (const rightSide of [-1, 1] as const) {
        const axis: 0 | 1 = forwardSide === rightSide ? 0 : 1;
        const inward = (axis === 0 ? forward.clone().multiplyScalar(-forwardSide) : right.clone().multiplyScalar(-rightSide));
        const position = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, forwardSide * SIGNAL_CORNER_OFFSET).addScaledVector(right, rightSide * SIGNAL_CORNER_OFFSET);
        const heading = Math.atan2(inward.z, -inward.x);
        this.addSignalPole(position, heading, axis, junction.phase);
      }
      this.addStreetSigns(junction, forward, right);
    }
  }

  private addSignalPole(position: THREE.Vector3, heading: number, axis: 0 | 1, phase: number): void {
    const assembly = new THREE.Group(); assembly.position.copy(position); assembly.rotation.y = heading;
    const metal = new THREE.MeshStandardMaterial({ color: 0x273135, metalness: 0.78, roughness: 0.34 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe0aa29, metalness: 0.32, roughness: 0.48 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 5.7, 12), metal); pole.position.y = 2.85;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.13, 0.13), metal); arm.position.set(-2.05, 5.4, 0);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.72, 2.2, 0.58, 3, 0.09), yellow); head.position.set(-3.95, 4.65, 0);
    const hoodGeometry = new THREE.CylinderGeometry(0.25, 0.25, 0.22, 16, 1, false, 0, Math.PI);
    const lensMaterials = [0xe83f3f, 0xf0ad2f, 0x39d36c].map((color) => new THREE.MeshStandardMaterial({ color: 0x191d1b, emissive: color, emissiveIntensity: 0, roughness: 0.35 }));
    lensMaterials.forEach((material, index) => {
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), material); lens.position.set(-3.95, 5.28 - index * 0.64, 0.301); assembly.add(lens);
      const hood = new THREE.Mesh(hoodGeometry, yellow); hood.rotation.set(Math.PI / 2, 0, 0); hood.position.set(-3.95, 5.38 - index * 0.64, 0.34); assembly.add(hood);
    });
    assembly.add(pole, arm, head); assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(assembly);
    const red = lensMaterials[0]; const amber = lensMaterials[1]; const green = lensMaterials[2];
    if (red && amber && green) this.signals.push({ red, amber, green, axis, phase });
  }

  private addStreetSigns(junction: JunctionDefinition, forward: THREE.Vector3, right: THREE.Vector3): void {
    const postPosition = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, SIGNAL_CORNER_OFFSET).addScaledVector(right, SIGNAL_CORNER_OFFSET);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.6, 10), new THREE.MeshStandardMaterial({ color: 0x344044, metalness: 0.68, roughness: 0.4 })); post.position.copy(postPosition).setY(1.8); this.group.add(post);
    const labels: Array<[string, number, number]> = [[junction.roadA, junction.angle, 3.25], [junction.roadB, junction.angle + Math.PI / 2, 2.78]];
    for (const [label, angle, y] of labels) {
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.92), new THREE.MeshBasicMaterial({ map: makeSignTexture(label, '#176a5a'), side: THREE.DoubleSide }));
      sign.position.copy(postPosition).setY(y); sign.rotation.y = angle; this.group.add(sign);
    }
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
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 2.6, 9), poleMaterial); pole.position.set(x, 1.3, z); this.group.add(pole);
      const background = label === 'STOP' ? '#b62f2d' : label === 'P' ? '#28619a' : label === 'TAXI' ? '#f2c521' : '#f0eee2';
      const foreground = label === 'STOP' || label === 'P' ? '#ffffff' : '#182326';
      const geometry = label === 'STOP' ? new THREE.CircleGeometry(0.7, 8) : hotspot ? new THREE.PlaneGeometry(2.4, 1.1) : new THREE.PlaneGeometry(1.1, 1.25);
      const sign = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: makeSignTexture(label, background, foreground), side: THREE.DoubleSide }));
      sign.position.set(x, 2.45, z); sign.rotation.y = angle; this.group.add(sign);
    }
  }

  private buildStreetFurniture(): void {
    const sites = this.roadsidePoints.filter((point, index) => index % 13 === 3 && !this.isBlocked(point.x, point.z, 2) && !this.isRoad(point.x, point.z, 0.7));
    const wood = new THREE.MeshStandardMaterial({ color: 0x744d32, roughness: 0.77 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3739, metalness: 0.72, roughness: 0.35 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8322d, metalness: 0.3, roughness: 0.5 });
    sites.forEach((site) => {
      const bench = new THREE.Group(); bench.position.set(site.x, 0, site.z); bench.rotation.y = Math.atan2(site.inwardX, site.inwardZ);
      for (const z of [-0.22, 0, 0.22]) { const slat = new THREE.Mesh(new RoundedBoxGeometry(2.25, 0.11, 0.16, 2, 0.035), wood); slat.position.set(0, 0.62, z); bench.add(slat); }
      for (const x of [-0.78, 0.78]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.55, 0.5), metal); leg.position.set(x, 0.3, 0); bench.add(leg); }
      const back = new THREE.Mesh(new RoundedBoxGeometry(2.25, 0.62, 0.1, 2, 0.03), wood); back.position.set(0, 0.98, -0.29); back.rotation.x = -0.12; bench.add(back); this.group.add(bench);
      const hydrant = new THREE.Group(); hydrant.position.set(site.x + site.inwardX * 0.45, 0, site.z + site.inwardZ * 0.45);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.23, 0.7, 16), red); body.position.y = 0.36;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 9), red); cap.position.y = 0.76; hydrant.add(body, cap); this.group.add(hydrant);
    });
  }

  private buildEtollGantries(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x7d8489, metalness: 0.72, roughness: 0.36 });
    const purple = new THREE.MeshStandardMaterial({ color: 0x4b2e83, metalness: 0.3, roughness: 0.5 });
    for (const gantry of ETOLL_GANTRIES) {
      const assembly = new THREE.Group(); assembly.position.set(gantry.x, 0, gantry.z); assembly.rotation.y = gantry.angle;
      for (const side of [-17, 17]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 7, 12), steel); post.position.set(side, 3.5, 0); assembly.add(post); }
      const truss = new THREE.Mesh(new THREE.BoxGeometry(36, 0.9, 1.1), steel); truss.position.y = 6.6; assembly.add(truss);
      for (const x of [-8, 0, 8]) { const camera = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.6), purple); camera.position.set(x, 5.9, 0.3); assembly.add(camera); }
      const board = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.4), new THREE.MeshBasicMaterial({ map: makeSignTexture('E-TOLL · SANRAL', '#4b2e83'), side: THREE.DoubleSide }));
      board.position.set(0, 6.65, 0.62); assembly.add(board);
      assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
      this.group.add(assembly);
    }
  }

  private buildTransitStops(): void {
    const stops: Array<[number, number, number, string]> = [[-48, 222, 0.15, 'BREE RANK'], [166, 173, -0.2, 'WANDERERS'], [-210, -224, 0.12, 'MTN RANK'], [125, -265, -0.08, 'NOORD RANK']];
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x6e9da3, roughness: 0.16, metalness: 0.08, clearcoat: 0.7, transparent: true, opacity: 0.66 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x293638, metalness: 0.72, roughness: 0.35 });
    for (const [x, z, angle, label] of stops) {
      if (this.isRoad(x, z, 2.8)) continue;
      const shelter = new THREE.Group(); shelter.position.set(x, 0, z); shelter.rotation.y = angle;
      const back = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.7, 0.08), glass); back.position.y = 1.45;
      const roof = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.16, 1.65, 3, 0.06), metal); roof.position.set(0, 2.9, 0.7);
      const seat = new THREE.Mesh(new RoundedBoxGeometry(3.4, 0.16, 0.55, 2, 0.04), metal); seat.position.set(0, 0.65, 0.42);
      const nameMaterial = new THREE.MeshBasicMaterial({ map: makeSignTexture(label, '#c7982c', '#172023') });
      registerPowered(nameMaterial, 0xffffff, 0x3a3a38);
      const name = new THREE.Mesh(new THREE.PlaneGeometry(3.8, 0.65), nameMaterial); name.position.set(0, 2.45, 0.06);
      shelter.add(back, roof, seat, name); shelter.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(shelter);
    }
  }
}
