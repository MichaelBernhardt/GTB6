import * as THREE from 'three';
import type { AudioManager } from '../core/AudioManager';

export type PropTier = 'solid' | 'knockover';
export type PropKind = 'tree' | 'palm' | 'fountain' | 'monument' | 'crane' | 'shelter' | 'signal' | 'post' | 'streetlight' | 'sign' | 'hydrant' | 'bench' | 'shrub';

/** Solid props stop a car dead (trunk-sized colliders, not crown-sized); the rest tip over when hit fast enough. */
export const PROP_TIERS: Record<PropKind, PropTier> = {
  tree: 'solid', palm: 'solid', fountain: 'solid', monument: 'solid', crane: 'solid', shelter: 'solid', signal: 'solid', post: 'solid',
  streetlight: 'knockover', sign: 'knockover', hydrant: 'knockover', bench: 'knockover', shrub: 'knockover',
};

export const KNOCKOVER_MIN_SPEED = 9; // m/s — below this a knock-over prop only nudges the car to a stop
export const KNOCKOVER_SPEED_KEEP = 0.8; // car keeps 80% of its speed per felled prop (~20% loss)
export const SOLID_PROP_DAMAGE_FACTOR = 0.55; // building walls use 0.35 — wrapping a car around a tree hurts more
export const FALL_DURATION = 0.55;
export const FALL_REST_ANGLE = Math.PI / 2 * 0.94;
export const MAX_ACTIVE_FALLS = 10;
export const HYDRANT_SPRAY_DURATION = 10;
export const MAX_ACTIVE_SPRAYS = 3;
const SPRAY_DROPS = 30;

export const knockoverDamage = (speed: number): number => Math.min(12, 2 + Math.abs(speed) * 0.18);
export const solidImpactDamage = (speed: number): number => Math.max(0, Math.abs(speed) - 8) * SOLID_PROP_DAMAGE_FACTOR;

/** Axis (up × travel direction) to rotate a prop about its base so the top tips the way the car was going. */
export const fallAxis = (dirX: number, dirZ: number): { x: number; z: number } => {
  const length = Math.hypot(dirX, dirZ) || 1;
  return { x: dirZ / length, z: -dirX / length };
};

/** Tip angle over time: accelerating fall to the rest angle, one small bounce, then settled. */
export const fallAngle = (elapsed: number, duration = FALL_DURATION): number => {
  const progress = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
  if (progress < 0.78) { const p = progress / 0.78; return FALL_REST_ANGLE * p * p; }
  return FALL_REST_ANGLE * (1 - Math.sin((progress - 0.78) / 0.22 * Math.PI) * 0.09);
};

export interface PropCollider {
  id: number; kind: PropKind; tier: PropTier;
  x: number; z: number; radius: number; height: number; down: boolean;
  /** Removes the standing visual (zeroes the InstancedMesh slots); props animated in place skip this. */
  hide?: () => void;
  /** Base-pivoted stand-in that animates the fall and then stays behind as drive-over debris. */
  debris?: () => THREE.Object3D;
}

export interface PropKnockEvent { prop: PropCollider; dirX: number; dirZ: number; speed: number; }

const overlaps = (prop: PropCollider, x: number, z: number, radius: number): boolean => {
  const dx = prop.x - x; const dz = prop.z - z; const reach = prop.radius + radius;
  return dx * dx + dz * dz < reach * reach;
};

/** Coarse uniform grid: props are inserted into every cell their circle touches, so queries stay O(nearby). */
export class PropGrid {
  private cells = new Map<string, PropCollider[]>();
  constructor(private cellSize = 12) {}

  add(prop: PropCollider): void {
    this.forEachCell(prop.x, prop.z, prop.radius, (key) => { const cell = this.cells.get(key); if (cell) cell.push(prop); else this.cells.set(key, [prop]); });
  }

  nearby(x: number, z: number, radius: number): PropCollider[] {
    const found: PropCollider[] = []; const seen = new Set<number>();
    this.forEachCell(x, z, radius, (key) => { for (const prop of this.cells.get(key) ?? []) if (!seen.has(prop.id)) { seen.add(prop.id); found.push(prop); } });
    return found;
  }

  private forEachCell(x: number, z: number, radius: number, visit: (key: string) => void): void {
    const minX = Math.floor((x - radius) / this.cellSize); const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize); const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) for (let cz = minZ; cz <= maxZ; cz++) visit(`${cx},${cz}`);
  }
}

/** Every street-prop collider, built once at city construction; vehicles and walkers consult it per move. */
export class PropRegistry {
  props: PropCollider[] = [];
  private grid = new PropGrid();
  private knockdowns: PropKnockEvent[] = [];

  register(kind: PropKind, x: number, z: number, radius: number, height: number, visual: Pick<PropCollider, 'hide' | 'debris'> = {}): PropCollider {
    const prop: PropCollider = { id: this.props.length, kind, tier: PROP_TIERS[kind], x, z, radius, height, down: false, ...visual };
    this.props.push(prop); this.grid.add(prop); return prop;
  }

  /** Standing props block movement; downed props are debris anything can roll or walk over. */
  blocked(x: number, z: number, radius: number): boolean {
    return this.grid.nearby(x, z, radius).some((prop) => !prop.down && overlaps(prop, x, z, radius));
  }

  solidBlocked(x: number, z: number, radius: number): boolean {
    return this.grid.nearby(x, z, radius).some((prop) => prop.tier === 'solid' && overlaps(prop, x, z, radius));
  }

  /** Fells every standing knock-over prop under a fast-enough car; slow hits leave them standing (solid-ish nudge). */
  tryKnockdown(x: number, z: number, radius: number, speed: number, dirX: number, dirZ: number): number {
    if (Math.abs(speed) < KNOCKOVER_MIN_SPEED) return 0;
    let felled = 0;
    for (const prop of this.grid.nearby(x, z, radius)) {
      if (prop.down || prop.tier !== 'knockover' || !overlaps(prop, x, z, radius)) continue;
      prop.down = true; prop.hide?.(); this.knockdowns.push({ prop, dirX, dirZ, speed }); felled++;
    }
    return felled;
  }

  consumeKnockdowns(): PropKnockEvent[] { return this.knockdowns.splice(0); }
}

interface FallingProp { object: THREE.Object3D; axis: THREE.Vector3; base: THREE.Quaternion; elapsed: number; }
interface SprayDrop { mesh: THREE.Mesh; velocity: THREE.Vector3; }
interface HydrantSpray { x: number; z: number; life: number; drops: SprayDrop[]; }

/** Scene-side prop effects: animates knocked props tipping over (capped) and runs hydrant water jets. Debris persists. */
export class PropSystem {
  private falling: FallingProp[] = [];
  private sprays: HydrantSpray[] = [];
  private dropGeometry = new THREE.SphereGeometry(0.07, 6, 5);
  private dropMaterial = new THREE.MeshBasicMaterial({ color: 0xcfeaf6, transparent: true, opacity: 0.82 });
  private quaternion = new THREE.Quaternion();

  constructor(private scene: THREE.Scene, private registry: PropRegistry, private audio: AudioManager, private groundHeight: (x: number, z: number) => number = () => 0) {}

  update(dt: number): void {
    for (const event of this.registry.consumeKnockdowns()) this.knock(event);
    for (let index = this.falling.length - 1; index >= 0; index--) {
      const fall = this.falling[index]; if (!fall) continue;
      fall.elapsed += dt;
      fall.object.quaternion.copy(this.quaternion.setFromAxisAngle(fall.axis, fallAngle(fall.elapsed))).multiply(fall.base);
      if (fall.elapsed >= FALL_DURATION) this.falling.splice(index, 1); // finished falls stay behind as static debris
    }
    this.updateSprays(dt);
  }

  private knock(event: PropKnockEvent): void {
    this.audio.propKnock(Math.abs(event.speed), event.prop.x, event.prop.z);
    const object = event.prop.debris?.();
    if (object) {
      if (!object.parent) this.scene.add(object);
      while (this.falling.length >= MAX_ACTIVE_FALLS) { // over budget: snap the oldest fall straight to its rest pose
        const oldest = this.falling.shift(); if (!oldest) break;
        oldest.object.quaternion.copy(this.quaternion.setFromAxisAngle(oldest.axis, fallAngle(FALL_DURATION))).multiply(oldest.base);
      }
      const axis = fallAxis(event.dirX, event.dirZ);
      this.falling.push({ object, axis: new THREE.Vector3(axis.x, 0, axis.z), base: object.quaternion.clone(), elapsed: 0 });
    }
    if (event.prop.kind === 'hydrant') this.startSpray(event.prop.x, event.prop.z);
  }

  private startSpray(x: number, z: number): void {
    while (this.sprays.length >= MAX_ACTIVE_SPRAYS) this.removeSpray(0);
    this.audio.hydrantHiss(x, z, HYDRANT_SPRAY_DURATION);
    this.sprays.push({ x, z, life: HYDRANT_SPRAY_DURATION, drops: [] });
  }

  private updateSprays(dt: number): void {
    for (let index = this.sprays.length - 1; index >= 0; index--) {
      const spray = this.sprays[index]; if (!spray) continue;
      spray.life -= dt;
      if (spray.life > 1 && spray.drops.length < SPRAY_DROPS) {
        const drop: SprayDrop = { mesh: new THREE.Mesh(this.dropGeometry, this.dropMaterial), velocity: new THREE.Vector3() };
        this.launch(drop, spray); this.scene.add(drop.mesh); spray.drops.push(drop);
      }
      for (let d = spray.drops.length - 1; d >= 0; d--) {
        const drop = spray.drops[d]; if (!drop) continue;
        drop.velocity.y -= 24 * dt; drop.mesh.position.addScaledVector(drop.velocity, dt);
        if (drop.mesh.position.y > this.groundHeight(drop.mesh.position.x, drop.mesh.position.z) + 0.04) continue;
        if (spray.life > 1) this.launch(drop, spray); // recycle while the main is still open
        else { this.scene.remove(drop.mesh); spray.drops.splice(d, 1); }
      }
      if (spray.life <= 0 && spray.drops.length === 0) this.sprays.splice(index, 1);
    }
  }

  private launch(drop: SprayDrop, spray: HydrantSpray): void {
    const x = spray.x + (Math.random() - 0.5) * 0.16; const z = spray.z + (Math.random() - 0.5) * 0.16;
    drop.mesh.position.set(x, this.groundHeight(x, z) + 0.3, z);
    drop.velocity.set((Math.random() - 0.5) * 2.2, 8.5 + Math.random() * 4.5, (Math.random() - 0.5) * 2.2);
  }

  private removeSpray(index: number): void {
    const spray = this.sprays[index]; if (!spray) return;
    for (const drop of spray.drops) this.scene.remove(drop.mesh);
    this.sprays.splice(index, 1);
  }
}
