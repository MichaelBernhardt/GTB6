/**
 * Protest: the props. Barricade junk, tyre fires, the plume, and the stains nobody comes to fix.
 *
 * LAZY — this module is only ever reached through `import('./protest/protest')` in the registry, so
 * it lives outside every manualChunk rule and rides in the protest async chunk. Nothing here may be
 * imported statically from anywhere.
 *
 * A note on what is deliberately absent: there is no `parent` parameter anywhere in this file. Every
 * tyre and every fire is placed by world coordinate into a group this feature owns, and the ignition
 * sweep runs its candidates through `ignitableTargets`. That is the necklacing block expressed as an
 * API shape rather than as a rule someone has to remember — see protest.state.ts and the tests.
 */
import * as THREE from 'three';
import { assertNotLivingHost, ignitableTargets, SCORCH_CAP, type BlockadeSize } from '../protest.state';
import { stablePositionRandom } from '../../world/StableRandom';

export interface BarricadeSite { x: number; z: number; y: number; heading: number; }
export interface ScorchMark { x: number; z: number; r: number }

/** Deterministic per-site stream: no Math.random anywhere in a world-generation path. */
function siteRandom(x: number, z: number): () => number {
  let salt = 0;
  return () => stablePositionRandom(x, z, salt++);
}

// ---- shared textures ---------------------------------------------------------------------------

/** Headless-safe canvas. Vitest runs in a node environment and the QA harness drives a real Game in
 *  a browser, so both paths must work: without a document the texture is simply flat. */
function makeCanvas(width: number, height: number): HTMLCanvasElement | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  return canvas;
}

function radialTexture(inner: string, outer: string): THREE.Texture {
  const canvas = makeCanvas(64, 64);
  if (!canvas) return new THREE.Texture();
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, inner); gradient.addColorStop(0.55, inner); gradient.addColorStop(1, outer);
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.needsUpdate = true;
  return texture;
}

/**
 * The stain: a glossy black bitumen bleed where the rubber melted into the tar, a grey ash halo, and
 * a few bright flecks of steel belt wire that never burn away. This one asset carries most of the
 * satire — after a few hours of play the failed suburbs' arterials are leopard-printed and the rich
 * district's tar is spotless, and nobody ever says a word about it.
 */
function scorchTexture(): THREE.Texture {
  const size = 128;
  const canvas = makeCanvas(size, size);
  if (!canvas) return new THREE.Texture();
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const halo = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
    halo.addColorStop(0, 'rgba(10,9,9,0.94)');
    halo.addColorStop(0.42, 'rgba(16,15,15,0.82)');
    halo.addColorStop(0.72, 'rgba(96,92,88,0.34)'); // ash
    halo.addColorStop(1, 'rgba(120,116,112,0)');
    ctx.fillStyle = halo; ctx.fillRect(0, 0, size, size);
    // Bitumen ran downhill and cooled in streaks.
    ctx.globalAlpha = 0.5; ctx.strokeStyle = '#050505'; ctx.lineWidth = 3;
    for (let index = 0; index < 7; index++) {
      const angle = (index / 7) * Math.PI * 2 + 0.4;
      ctx.beginPath(); ctx.moveTo(64, 64);
      ctx.lineTo(64 + Math.cos(angle) * (26 + index * 4), 64 + Math.sin(angle) * (26 + index * 4));
      ctx.stroke();
    }
    // Steel belt wire.
    ctx.globalAlpha = 0.75; ctx.strokeStyle = '#b9b2a4'; ctx.lineWidth = 1;
    for (let index = 0; index < 9; index++) {
      const angle = index * 2.3; const radius = 14 + (index % 4) * 9;
      ctx.beginPath();
      ctx.moveTo(64 + Math.cos(angle) * radius, 64 + Math.sin(angle) * radius);
      ctx.lineTo(64 + Math.cos(angle + 0.5) * (radius + 5), 64 + Math.sin(angle + 0.5) * (radius + 5));
      ctx.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.needsUpdate = true;
  return texture;
}

/** Scrap cardboard, permanent marker, running out of space near the right-hand edge. */
function placardTexture(line: string): THREE.Texture {
  const canvas = makeCanvas(256, 160);
  if (!canvas) return new THREE.Texture();
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#c2a884'; ctx.fillRect(0, 0, 256, 160);
    ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(0, 96, 256, 8);
    ctx.fillStyle = '#141414'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const words = line.split(' ');
    const rows: string[] = []; let row = '';
    for (const word of words) { const next = row ? `${row} ${word}` : word; if (next.length > 11) { rows.push(row); row = word; } else row = next; }
    if (row) rows.push(row);
    const height = 150 / Math.max(rows.length, 1);
    rows.forEach((text, index) => {
      ctx.font = `bold ${Math.min(46, Math.floor(230 / Math.max(text.length, 1) * 1.7))}px sans-serif`;
      ctx.fillText(text, 128, 18 + height * (index + 0.5));
    });
  }
  const texture = new THREE.CanvasTexture(canvas); texture.needsUpdate = true;
  return texture;
}

/** Real placard grammar: hand-lettered, running out of room, and spelling is not the point. */
const SLOGANS = [
  '53 DAYS NO WATER',
  'NO WATER NO VOTE',
  'WHERE IS OUR WATER SINSE 2019',
  'WE ARE NOT ASKING AGAIN',
  'FIX THE PUMP NOT THE PHOTO',
];

// ---- the smoke column --------------------------------------------------------------------------

/**
 * The plume. Sprites, so it billboards without this module ever seeing a camera (features get the
 * scene and nothing else). Dense, black and TALL on purpose: the plume is how a blockade advertises
 * itself to the officials who otherwise never come, and it is how the player is meant to navigate
 * to one — a landmark you learn to read, exactly the way you learn to read it on the N1.
 */
class SmokeColumn {
  readonly group = new THREE.Group();
  private puffs: THREE.Sprite[] = [];
  private flames: THREE.Sprite[] = [];
  private clock = 0;
  strength = 1; // 0..1, scales height, opacity and flame size

  constructor(smokeTexture: THREE.Texture, flameTexture: THREE.Texture, private height: number, private count: number, random: () => number) {
    for (let index = 0; index < this.count; index++) {
      // fog:false deliberately. A plume that dissolves into the haze at 300 units is realistic and
      // useless: the whole point of the black smoke is that it advertises the blockade to people who
      // are nowhere near it, and the player is meant to learn to read one from the highway.
      const material = new THREE.SpriteMaterial({ map: smokeTexture, color: 0x1b1a19, transparent: true, opacity: 0.5, depthWrite: false, fog: false });
      const sprite = new THREE.Sprite(material);
      sprite.userData.phase = random();
      sprite.userData.drift = (random() - 0.5) * 0.9;
      this.puffs.push(sprite); this.group.add(sprite);
    }
    for (let index = 0; index < 4; index++) {
      const material = new THREE.SpriteMaterial({ map: flameTexture, color: 0xff8a2a, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });
      const sprite = new THREE.Sprite(material);
      sprite.userData.phase = random();
      sprite.position.set((random() - 0.5) * 1.2, 0.4, (random() - 0.5) * 1.2);
      this.flames.push(sprite); this.group.add(sprite);
    }
  }

  update(dt: number): void {
    this.clock += dt;
    const strength = Math.max(0, Math.min(1, this.strength));
    this.puffs.forEach((sprite, index) => {
      const phase = ((sprite.userData.phase as number) + this.clock * 0.09) % 1;
      const rise = phase * this.height * (0.45 + 0.55 * strength);
      const spread = 1.6 + phase * 9 * (0.5 + 0.5 * strength);
      sprite.position.set((sprite.userData.drift as number) * rise * 0.22, 1 + rise, Math.sin(phase * 3 + index) * 0.8);
      sprite.scale.setScalar(spread);
      const material = sprite.material as THREE.SpriteMaterial;
      material.opacity = (1 - phase) * 0.52 * strength;
    });
    this.flames.forEach((sprite) => {
      const flicker = 0.6 + 0.4 * Math.sin(this.clock * 11 + (sprite.userData.phase as number) * 9);
      sprite.scale.setScalar((0.8 + flicker * 0.7) * (0.35 + 0.65 * strength));
      (sprite.material as THREE.SpriteMaterial).opacity = 0.85 * flicker * strength;
      sprite.visible = strength > 0.02;
    });
  }

  dispose(): void {
    for (const sprite of [...this.puffs, ...this.flames]) { sprite.material.dispose(); this.group.remove(sprite); }
    this.puffs = []; this.flames = [];
  }
}

// ---- persistent scorch -------------------------------------------------------------------------

/**
 * Every stain in the city in ONE instanced draw call, capped at SCORCH_CAP and FIFO: the 49th burn
 * erases the oldest stain, never the newest. The marks are serialized into the feature's save slice,
 * so they survive a reload — a tyre fire melts a depression into the tar that becomes the next
 * generation of potholes, and protesting the potholes is what made the potholes.
 */
export class ScorchField {
  private mesh: THREE.InstancedMesh;
  private marks: ScorchMark[] = [];
  private texture: THREE.Texture;
  private dummy = new THREE.Object3D();

  constructor(private scene: THREE.Scene, private surfaceHeightAt: (x: number, z: number) => number) {
    this.texture = scorchTexture();
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthWrite: false, opacity: 0.92,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, // never z-fight the tar
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, SCORCH_CAP);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'protest-scorch';
    scene.add(this.mesh);
  }

  get count(): number { return this.marks.length; }

  add(x: number, z: number, radius: number): void {
    this.marks.push({ x, z, r: radius });
    if (this.marks.length > SCORCH_CAP) this.marks.splice(0, this.marks.length - SCORCH_CAP); // FIFO
    this.rebuild();
  }

  /** Rehydrate from the save's flat [x, z, r, …] triples. */
  load(flat: readonly number[]): void {
    this.marks = [];
    for (let index = 0; index + 2 < flat.length; index += 3) this.marks.push({ x: flat[index]!, z: flat[index + 1]!, r: flat[index + 2]! });
    if (this.marks.length > SCORCH_CAP) this.marks.splice(0, this.marks.length - SCORCH_CAP);
    this.rebuild();
  }

  serialize(): number[] {
    const flat: number[] = [];
    for (const mark of this.marks) flat.push(Math.round(mark.x * 100) / 100, Math.round(mark.z * 100) / 100, Math.round(mark.r * 100) / 100);
    return flat;
  }

  private rebuild(): void {
    this.marks.forEach((mark, index) => {
      this.dummy.position.set(mark.x, this.surfaceHeightAt(mark.x, mark.z) + 0.035, mark.z);
      this.dummy.rotation.set(0, (index * 1.31) % Math.PI, 0);
      this.dummy.scale.set(mark.r * 2, 1, mark.r * 2);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(index, this.dummy.matrix);
    });
    this.mesh.count = this.marks.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
    this.marks = [];
  }
}

// ---- a single burning tyre (the player's own verb) ----------------------------------------------

/**
 * One tyre, rolled out onto the tar and lit. Takes world coordinates — never a parent, never a
 * target object. There is no code path in this file that can attach a tyre to anything at all.
 */
export class TyreFire {
  readonly group = new THREE.Group();
  private column: SmokeColumn;
  private tyre: THREE.Mesh;
  private geometry = new THREE.TorusGeometry(0.44, 0.17, 6, 14);
  private material = new THREE.MeshLambertMaterial({ color: 0x141414 });
  life: number;

  constructor(scene: THREE.Scene, x: number, y: number, z: number, life: number, smoke: THREE.Texture, flame: THREE.Texture) {
    this.life = life;
    const random = siteRandom(x, z);
    this.tyre = new THREE.Mesh(this.geometry, this.material);
    this.tyre.rotation.x = Math.PI / 2;
    this.tyre.position.y = 0.17;
    this.group.add(this.tyre);
    this.column = new SmokeColumn(smoke, flame, 34, 10, random);
    this.group.add(this.column.group);
    this.group.position.set(x, y, z);
    scene.add(this.group);
  }

  update(dt: number): void {
    this.life -= dt;
    this.column.strength = Math.max(0, Math.min(1, this.life / 12)); // dies down over the last dozen seconds
    this.column.update(dt);
  }

  get spent(): boolean { return this.life <= 0; }

  dispose(scene: THREE.Scene): void {
    this.column.dispose();
    scene.remove(this.group);
    this.geometry.dispose(); this.material.dispose();
  }
}

// ---- the barricade ------------------------------------------------------------------------------

/**
 * The composite junk barricade: tyres flat and stacked, half-bricks, building rubble, a wheelie bin,
 * a mattress and cut branches, laid ACROSS the lane rather than along it. Randomised from the site
 * position so the same corner always builds the same barricade on every machine.
 *
 * It is deliberately NOT a collider. NPC traffic stops because there are people standing on the tar
 * (PopulationSystem already brakes for pedestrians in the lane) and reroutes because the road is
 * closed in the nav overlay — but the player can always shove through. A blockade that traps the
 * player is a blockade that costs patience, and patience is the resource this game spends carefully.
 */
export class Barricade {
  readonly group = new THREE.Group();
  private column: SmokeColumn;
  private smokeTexture = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  private flameTexture = radialTexture('rgba(255,236,190,1)', 'rgba(255,120,0,0)');
  private placardTextures: THREE.Texture[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private tyres: THREE.Mesh[] = [];
  private burning = true;
  /** Where the tar will be stained once this is over. */
  readonly scorchPlan: ScorchMark[] = [];

  constructor(private scene: THREE.Scene, readonly site: BarricadeSite, readonly size: BlockadeSize, tyreTotal: number) {
    const random = siteRandom(site.x, site.z);
    const across = new THREE.Vector3(Math.cos(site.heading), 0, -Math.sin(site.heading)); // perpendicular to travel
    const span = size === 'dawn' ? 9 : 6.5;

    const rubber = this.material(new THREE.MeshLambertMaterial({ color: 0x131313 }));
    const tyreGeometry = this.geometry(new THREE.TorusGeometry(0.44, 0.17, 6, 14));
    for (let index = 0; index < tyreTotal; index++) {
      const offset = (index / Math.max(tyreTotal - 1, 1) - 0.5) * span * 2;
      const stacked = random() > 0.55;
      const tyre = new THREE.Mesh(tyreGeometry, rubber);
      tyre.position.copy(across).multiplyScalar(offset + (random() - 0.5) * 1.2);
      tyre.position.y = stacked ? 0.5 + random() * 0.35 : 0.17;
      if (stacked) { tyre.rotation.x = Math.PI / 2 + (random() - 0.5) * 0.5; tyre.rotation.z = random() * 3; }
      else tyre.rotation.x = Math.PI / 2;
      this.tyres.push(tyre); this.group.add(tyre);
      this.scorchPlan.push({ x: site.x + tyre.position.x, z: site.z + tyre.position.z, r: 1.5 + random() * 1.3 });
    }

    // Half-bricks and building rubble: whatever was already lying at the corner.
    const brickGeometry = this.geometry(new THREE.BoxGeometry(0.32, 0.16, 0.16));
    const brick = this.material(new THREE.MeshLambertMaterial({ color: 0x8a5a45 }));
    for (let index = 0; index < 16; index++) {
      const mesh = new THREE.Mesh(brickGeometry, brick);
      mesh.position.copy(across).multiplyScalar((random() - 0.5) * span * 2.2);
      mesh.position.y = 0.09 + (random() > 0.8 ? 0.17 : 0);
      mesh.position.z += (random() - 0.5) * 2.4;
      mesh.rotation.y = random() * 6;
      this.group.add(mesh);
    }

    // A wheelie bin on its side, and a mattress. Both always available, both nobody's loss.
    const bin = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(0.62, 1.05, 0.55)), this.material(new THREE.MeshLambertMaterial({ color: 0x2f4b2c })));
    bin.position.copy(across).multiplyScalar(-span * 0.75); bin.position.y = 0.32; bin.rotation.z = Math.PI / 2;
    this.group.add(bin);
    const mattress = new THREE.Mesh(this.geometry(new THREE.BoxGeometry(1.9, 0.22, 1.2)), this.material(new THREE.MeshLambertMaterial({ color: 0x9a8f7d })));
    mattress.position.copy(across).multiplyScalar(span * 0.7); mattress.position.y = 0.11; mattress.rotation.y = random() * 0.6;
    this.group.add(mattress);

    // Cut branches — the cheapest barricade material in any suburb with a tree.
    const branchGeometry = this.geometry(new THREE.CylinderGeometry(0.05, 0.08, 2.4, 5));
    const bark = this.material(new THREE.MeshLambertMaterial({ color: 0x4a3b28 }));
    for (let index = 0; index < 4; index++) {
      const branch = new THREE.Mesh(branchGeometry, bark);
      branch.position.copy(across).multiplyScalar((random() - 0.5) * span * 1.8);
      branch.position.y = 0.1; branch.rotation.z = Math.PI / 2; branch.rotation.y = random() * 3;
      this.group.add(branch);
    }

    // Placards, standing in the crowd rather than held: nothing in this feature is ever attached to
    // a person, and that includes a stick.
    const stickGeometry = this.geometry(new THREE.CylinderGeometry(0.035, 0.035, 1.7, 5));
    const stick = this.material(new THREE.MeshLambertMaterial({ color: 0x6b5b45 }));
    const placardGeometry = this.geometry(new THREE.PlaneGeometry(0.86, 0.56));
    const placardCount = size === 'dawn' ? 4 : 2;
    for (let index = 0; index < placardCount; index++) {
      const slogan = SLOGANS[Math.floor(random() * SLOGANS.length) % SLOGANS.length]!;
      const texture = placardTexture(slogan); this.placardTextures.push(texture);
      const material = this.material(new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide }));
      const pole = new THREE.Mesh(stickGeometry, stick);
      const board = new THREE.Mesh(placardGeometry, material);
      const holder = new THREE.Group();
      pole.position.y = 0.85; board.position.y = 1.75;
      holder.add(pole); holder.add(board);
      holder.position.copy(across).multiplyScalar((random() - 0.5) * span * 1.6);
      holder.position.z += 2.6 + random() * 2.4;
      holder.rotation.y = -site.heading + (random() - 0.5) * 0.8;
      this.group.add(holder);
    }

    this.column = new SmokeColumn(this.smokeTexture, this.flameTexture, size === 'dawn' ? 62 : 44, size === 'dawn' ? 16 : 11, random);
    this.column.group.position.set(0, 0, 0);
    this.group.add(this.column.group);

    this.group.position.set(site.x, site.y, site.z);
    this.group.name = 'protest-barricade';
    scene.add(this.group);
  }

  /** 0..1 — how hard the plume is going. Driven by the picket's smoke level. */
  set strength(value: number) { this.column.strength = this.burning ? value : Math.min(value, 0.08); }

  update(dt: number): void { this.column.update(dt); }

  /**
   * Apply a light to a set of candidate things. Returns how many caught.
   *
   * The filter is the point: whatever the caller sweeps up, people are removed from it before
   * anything is set alight. There is no argument to this method that can put a fire on a person, and
   * a caller that tries to hand one over gets an exception rather than a silent no-op.
   */
  ignite(candidates: readonly unknown[]): number {
    for (const candidate of candidates) assertNotLivingHost(candidate, 'Barricade.ignite');
    const allowed = ignitableTargets(candidates);
    this.burning = true;
    return allowed.length;
  }

  /** The crowd has gone. One tyre still going, and the stains are permanent. */
  smoulder(): void { this.burning = false; this.column.strength = 0.07; }

  dispose(): void {
    this.column.dispose();
    this.scene.remove(this.group);
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.placardTextures) texture.dispose();
    this.smokeTexture.dispose(); this.flameTexture.dispose();
    this.geometries = []; this.materials = []; this.placardTextures = []; this.tyres = [];
  }

  private geometry<T extends THREE.BufferGeometry>(value: T): T { this.geometries.push(value); return value; }
  private material<T extends THREE.Material>(value: T): T { this.materials.push(value); return value; }
}

export { SmokeColumn, radialTexture };
