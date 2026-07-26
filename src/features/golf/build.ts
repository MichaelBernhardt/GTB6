/**
 * The course, as geometry. Built on FIRST ENTRY into the feature group and thrown away on exit —
 * nothing here is in prepareAssets() or City.buildStages(), which is the whole point of golf being
 * the lazy-loading headline. Pushes ZERO colliders: FeatureGameApi exposes no collider seam, which
 * neatly settles the plan's "golf leaves invisible walls behind" risk by construction.
 *
 * The look is the satire. Water restrictions mean the club waters the GREENS and nothing else, so
 * the fairways are July-dormant kikuyu — straw gold, baked hard, and they run like a runway.
 */
import * as THREE from 'three';
import type { CourseLayout, Hole } from './layout';

const FAIRWAY_LIFT = 0.12;
const BUNKER_LIFT = 0.18;
const GREEN_LIFT = 0.24;
const TEE_LIFT = 0.30;

type Ground = (x: number, z: number) => number;

/** Everything created here is owned here, so dispose() can be complete without a scavenger hunt. */
export class CourseScene {
  readonly group = new THREE.Group();
  readonly ball: THREE.Mesh;
  readonly aim: THREE.Line;
  readonly targetRing: THREE.Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly flags: THREE.Object3D[] = [];
  private readonly birds: Array<{ node: THREE.Object3D; phase: number; home: THREE.Vector3; scared: number }> = [];
  private clock = 0;

  constructor(private readonly layout: CourseLayout, private readonly ground: Ground) {
    this.group.name = 'golf-course';
    const fairwayMat = this.material(0xb0a05a, 0.98);
    const greenMat = this.material(0x4a8a3f, 0.9);
    const collarMat = this.material(0x6e8c48, 0.95);
    const teeMat = this.material(0x5f9450, 0.92);
    const sandMat = this.material(0xdccfa6, 1);

    for (const hole of this.layout.holes) {
      this.add(ribbon(hole.tee, hole.pin, hole.fairwayHalf, this.ground, FAIRWAY_LIFT), fairwayMat);
      for (const bunker of hole.bunkers) this.add(disc(bunker.x, bunker.z, bunker.rx, bunker.rz, bunker.rot, this.ground, BUNKER_LIFT), sandMat);
      this.add(disc(hole.pin.x, hole.pin.z, hole.greenR + 3.5, hole.greenR + 3.5, 0, this.ground, GREEN_LIFT - 0.06), collarMat);
      this.add(disc(hole.pin.x, hole.pin.z, hole.greenR, hole.greenR, 0, this.ground, GREEN_LIFT), greenMat);
      this.add(disc(hole.tee.x, hole.tee.z, hole.teeR, hole.teeR * 0.7, 0, this.ground, TEE_LIFT), teeMat);
      this.buildFlag(hole);
      this.buildTeeMarkers(hole);
    }
    this.buildClubhouse();
    this.buildHadedas();

    const ballGeom = new THREE.SphereGeometry(0.22, 10, 8);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f2, roughness: 0.45, emissive: 0x222222 });
    this.disposables.push(ballGeom, ballMat);
    this.ball = new THREE.Mesh(ballGeom, ballMat);
    this.ball.visible = false;
    this.group.add(this.ball);

    const aimGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
    const aimMat = new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.85 });
    this.disposables.push(aimGeom, aimMat);
    this.aim = new THREE.Line(aimGeom, aimMat);
    this.aim.visible = false;
    this.group.add(this.aim);

    const ringGeom = new THREE.RingGeometry(1.6, 2.3, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
    this.disposables.push(ringGeom, ringMat);
    this.targetRing = new THREE.Mesh(ringGeom, ringMat);
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.visible = false;
    this.group.add(this.targetRing);
  }

  private material(color: number, roughness: number): THREE.Material {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
    this.disposables.push(material);
    return material;
  }

  private add(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = false;
    this.group.add(mesh);
    return mesh;
  }

  private box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, yaw = 0, roughness = 0.85): THREE.Mesh {
    const geometry = new THREE.BoxGeometry(w, h, d);
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
    this.disposables.push(geometry, material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    this.group.add(mesh);
    return mesh;
  }

  private buildFlag(hole: Hole): void {
    const base = this.ground(hole.pin.x, hole.pin.z);
    const cupGeom = new THREE.CircleGeometry(0.5, 16);
    const cupMat = new THREE.MeshBasicMaterial({ color: 0x12160f });
    this.disposables.push(cupGeom, cupMat);
    const cup = new THREE.Mesh(cupGeom, cupMat);
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(hole.pin.x, base + GREEN_LIFT + 0.02, hole.pin.z);
    this.group.add(cup);

    const poleGeom = new THREE.CylinderGeometry(0.055, 0.055, 3.4, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ef, roughness: 0.6 });
    this.disposables.push(poleGeom, poleMat);
    const pole = new THREE.Mesh(poleGeom, poleMat);
    pole.position.set(hole.pin.x, base + GREEN_LIFT + 1.7, hole.pin.z);
    this.group.add(pole);

    const clothGeom = new THREE.PlaneGeometry(1.05, 0.72);
    const clothMat = new THREE.MeshStandardMaterial({ color: [0xd93b3b, 0xf0c221, 0xf4f4f0][hole.number - 1] ?? 0xd93b3b, side: THREE.DoubleSide, roughness: 0.9 });
    this.disposables.push(clothGeom, clothMat);
    const cloth = new THREE.Mesh(clothGeom, clothMat);
    cloth.position.set(0.55, 1.4, 0);
    const pivot = new THREE.Group();
    pivot.position.set(hole.pin.x, base + GREEN_LIFT, hole.pin.z);
    pivot.add(cloth);
    this.group.add(pivot);
    this.flags.push(pivot);
  }

  private buildTeeMarkers(hole: Hole): void {
    const bearing = Math.atan2(hole.pin.x - hole.tee.x, hole.pin.z - hole.tee.z);
    for (const side of [-1, 1]) {
      const x = hole.tee.x + Math.cos(bearing) * side * 2.6;
      const z = hole.tee.z - Math.sin(bearing) * side * 2.6;
      this.box(0.5, 0.5, 0.5, hole.number === 1 ? 0xd93b3b : 0xf0c221, x, this.ground(x, z) + TEE_LIFT + 0.25, z, bearing);
    }
  }

  /**
   * A container pro shop under shade net — an open front you walk into, a counter, a rack of clubs
   * and the price board. Open-fronted on purpose: features cannot push colliders, so a shop with
   * four walls would be a shop you walk through. This one is a shop you walk INTO.
   */
  private buildClubhouse(): void {
    const { clubhouse, clubhouseHeading } = this.layout;
    const base = this.ground(clubhouse.x, clubhouse.z);
    const yaw = clubhouseHeading;
    const forward = (distance: number, lateral = 0): [number, number] => [
      clubhouse.x + Math.sin(yaw) * distance + Math.cos(yaw) * lateral,
      clubhouse.z + Math.cos(yaw) * distance - Math.sin(yaw) * lateral,
    ];

    // The container itself, back wall + two ends, opening toward the driveway.
    const [bx, bz] = forward(-2.6);
    this.box(9.4, 3.0, 0.35, 0x2f6b4f, bx, base + 1.5, bz, yaw);
    for (const side of [-1, 1]) {
      const [ex, ez] = forward(-1.2, side * 4.7);
      this.box(0.35, 3.0, 3.0, 0x2a5f46, ex, base + 1.5, ez, yaw);
    }
    const [rx, rz] = forward(-1.2);
    this.box(9.6, 0.28, 3.2, 0x244f3b, rx, base + 3.05, rz, yaw);
    // Counter across the opening: this is where you trade.
    const [cx, cz] = forward(0.1);
    this.box(7.4, 1.05, 0.7, 0x7a5a34, cx, base + 0.52, cz, yaw);
    // Shade-net veranda on four poles.
    const [vx, vz] = forward(3.2);
    this.box(9.6, 0.12, 6.0, 0x4c5a49, vx, base + 3.3, vz, yaw, 1);
    for (const dx of [-4.4, 4.4]) for (const dz of [0.6, 5.8]) {
      const [px, pz] = forward(dz, dx);
      this.box(0.22, 3.3, 0.22, 0x6b6b63, px, base + 1.65, pz, yaw);
    }
    // A rack of hire clubs leaning by the counter.
    for (let i = 0; i < 7; i++) {
      const [sx, sz] = forward(0.9, -3.3 + i * 0.42);
      const shaft = this.box(0.05, 1.5, 0.05, i % 2 ? 0xb9bcc2 : 0x3a3d42, sx, base + 0.78, sz, yaw);
      shaft.rotation.z = 0.16;
    }
    // The price board. The visitor rate is real and it is never what you pay.
    const board = this.sign([
      this.layout.name.toUpperCase(),
      'TWILIGHT 3 HOLES   R180',
      'VISITOR R960 · AFFILIATED R595',
      'NO TAKKIES · NO SLIP-SLOPS · NO JEANS',
    ]);
    if (board) {
      const [sx, sz] = forward(-2.35, 0);
      board.position.set(sx, base + 2.05, sz);
      board.rotation.y = yaw + Math.PI;
      this.group.add(board);
    }
    // Boom gate at the driveway: the dress code has to be enforced somewhere.
    const [gx, gz] = forward(9.5, 3.0);
    this.box(0.3, 1.5, 0.3, 0xd0d3d6, gx, base + 0.75, gz, yaw);
    const boom = this.box(0.18, 0.18, 7.0, 0xe14b3b, gx, base + 1.35, gz, yaw + Math.PI / 2);
    boom.position.x -= Math.cos(yaw) * 3.2;
    boom.position.z += Math.sin(yaw) * 3.2;
  }

  /** Canvas-textured board. Returns undefined where there is no DOM (tests, headless tooling). */
  private sign(lines: string[]): THREE.Mesh | undefined {
    if (typeof document === 'undefined') return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 192;
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.fillStyle = '#13301f'; ctx.fillRect(0, 0, 512, 192);
    ctx.strokeStyle = '#d9c98a'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, 496, 176);
    ctx.textAlign = 'center'; ctx.fillStyle = '#f2e9c9';
    const sizes = [30, 34, 20, 17];
    let y = 52;
    lines.forEach((line, index) => {
      ctx.font = `${index === 1 ? 'bold ' : ''}${sizes[index] ?? 20}px system-ui, sans-serif`;
      ctx.fillStyle = index === 1 ? '#ffd76a' : '#f2e9c9';
      ctx.fillText(line, 256, y);
      y += (sizes[index] ?? 20) + 12;
    });
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const geometry = new THREE.PlaneGeometry(5.4, 2.0);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    this.disposables.push(texture, geometry, material);
    return new THREE.Mesh(geometry, material);
  }

  /** Hadedas. They own the greens, they stab grub-holes in them, and they leave loudly. */
  private buildHadedas(): void {
    const bodyGeom = new THREE.SphereGeometry(0.42, 8, 6);
    const beakGeom = new THREE.ConeGeometry(0.09, 0.95, 6);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4a4b45, roughness: 0.95 });
    const beakMat = new THREE.MeshStandardMaterial({ color: 0x2a2620, roughness: 0.8 });
    this.disposables.push(bodyGeom, beakGeom, bodyMat, beakMat);
    for (const hole of this.layout.holes) {
      for (let i = 0; i < 3; i++) {
        const angle = (i / 3) * Math.PI * 2 + hole.number;
        const reach = hole.greenR * 0.55;
        const x = hole.pin.x + Math.sin(angle) * reach;
        const z = hole.pin.z + Math.cos(angle) * reach;
        const node = new THREE.Group();
        const body = new THREE.Mesh(bodyGeom, bodyMat);
        body.scale.set(1, 0.72, 1.5);
        node.add(body);
        const beak = new THREE.Mesh(beakGeom, beakMat);
        beak.rotation.x = Math.PI / 2.2;
        beak.position.set(0, -0.05, 0.72);
        node.add(beak);
        node.position.set(x, this.ground(x, z) + GREEN_LIFT + 0.4, z);
        node.rotation.y = angle;
        this.group.add(node);
        this.birds.push({ node, phase: i * 2.1 + hole.number, home: node.position.clone(), scared: 0 });
      }
    }
  }

  /** Send every hadeda within `radius` of a point up in the air, shouting. */
  flush(x: number, z: number, radius = 14): boolean {
    let any = false;
    for (const bird of this.birds) {
      if (bird.scared > 0) continue;
      if (Math.hypot(bird.home.x - x, bird.home.z - z) > radius) continue;
      bird.scared = 4;
      any = true;
    }
    return any;
  }

  update(dt: number): void {
    this.clock += dt;
    for (const flag of this.flags) flag.rotation.y = Math.sin(this.clock * 1.6 + flag.position.x * 0.1) * 0.5;
    for (const bird of this.birds) {
      if (bird.scared > 0) {
        bird.scared = Math.max(0, bird.scared - dt);
        const lift = Math.sin(Math.min(1, (4 - bird.scared) / 4) * Math.PI) * 9;
        bird.node.position.set(bird.home.x, bird.home.y + lift, bird.home.z);
        bird.node.rotation.y += dt * 3;
      } else {
        bird.node.position.y = bird.home.y + Math.sin(this.clock * 2.4 + bird.phase) * 0.09;
      }
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((node) => { if (node instanceof THREE.Mesh) node.geometry?.dispose?.(); });
    for (const item of this.disposables) { try { item.dispose(); } catch { /* already gone */ } }
    this.disposables.length = 0;
    this.group.clear();
    this.flags.length = 0;
    this.birds.length = 0;
  }
}

/** A terrain-following strip from tee to pin. */
function ribbon(from: { x: number; z: number }, to: { x: number; z: number }, half: number, ground: Ground, lift: number): THREE.BufferGeometry {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(6, Math.round(length / 9));
  const dirX = (to.x - from.x) / length; const dirZ = (to.z - from.z) / length;
  const nx = dirZ; const nz = -dirX;
  const positions: number[] = []; const indices: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Tapered like a real hole: narrow at the tee, wide through the landing zone, tight at the green.
    const width = half * (0.55 + 0.9 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
    const cx = from.x + (to.x - from.x) * t; const cz = from.z + (to.z - from.z) * t;
    for (const side of [-1, 1]) {
      const x = cx + nx * width * side; const z = cz + nz * width * side;
      positions.push(x, ground(x, z) + lift, z);
    }
    if (i > 0) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A terrain-following ellipse — greens, collars, tee boxes and bunkers all come from here. */
function disc(cx: number, cz: number, rx: number, rz: number, rot: number, ground: Ground, lift: number): THREE.BufferGeometry {
  const segments = 22; const rings = 3;
  const positions: number[] = [cx, ground(cx, cz) + lift, cz];
  const indices: number[] = [];
  const cos = Math.cos(rot); const sin = Math.sin(rot);
  for (let ring = 1; ring <= rings; ring++) {
    const scale = ring / rings;
    for (let s = 0; s < segments; s++) {
      const angle = (s / segments) * Math.PI * 2;
      const lx = Math.cos(angle) * rx * scale; const lz = Math.sin(angle) * rz * scale;
      const x = cx + lx * cos - lz * sin; const z = cz + lx * sin + lz * cos;
      positions.push(x, ground(x, z) + lift, z);
    }
  }
  for (let s = 0; s < segments; s++) indices.push(0, 1 + s, 1 + ((s + 1) % segments));
  for (let ring = 1; ring < rings; ring++) {
    const inner = 1 + (ring - 1) * segments; const outer = 1 + ring * segments;
    for (let s = 0; s < segments; s++) {
      const n = (s + 1) % segments;
      indices.push(inner + s, outer + s, outer + n, inner + s, outer + n, inner + n);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
