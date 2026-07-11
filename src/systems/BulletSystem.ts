import * as THREE from 'three';
import type { WeaponId, WeaponSpec } from '../config';
import { calculateDamage } from '../core/GameRules';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';
import type { ShotResult } from './CombatSystem';

/** Hard cap on live rounds — the pool is preallocated and pellets past the cap are dropped, never allocated. */
export const MAX_BULLETS = 240;
const PED_HIT_RADIUS = 0.5; // forgiving next to the ~0.3 mesh, but far under the metres a mover travels in flight
const PED_HIT_HEIGHT = 1.85;
const VEHICLE_HIT_MARGIN = 0.12;
const WALL_SAMPLE = 0.8; // stride for sampling city geometry along the swept segment
const TRACER_LENGTH = 7;
const TRACER_MIN_TRAVEL = 3; // no streak in the shooter's face; it fades in past the muzzle

interface Shot { live: number; position: THREE.Vector3; weapon: WeaponId; damage: number; falloffFloor?: number; exclude?: Vehicle; victim?: Pedestrian; killed: boolean; policeHit: boolean; hitPoint?: THREE.Vector3; hitVehicles: Set<Vehicle>; }
interface Bullet { shot: Shot; position: THREE.Vector3; direction: THREE.Vector3; speed: number; range: number; traveled: number; primary: boolean; tracer?: THREE.Mesh; }
interface Effect { mesh: THREE.Mesh; life: number; }
/** One trigger pull fully resolved (every pellet landed or expired): feed `result` straight into Game.handleGunshot. */
export interface ResolvedShot { result: ShotResult; position: THREE.Vector3; weapon: WeaponId; }

/** Simulated small-arms rounds: each shot flies at the weapon's muzzle velocity and is swept per frame against
 *  pedestrians and vehicles at their CURRENT positions (movers must be led) and against city geometry (walls
 *  genuinely block). Damage falls off by distance travelled, and the aggregated outcome mirrors the old hitscan
 *  ShotResult so the aftermath path is unchanged — just delayed by time of flight. */
export class BulletSystem {
  bullets: Bullet[] = [];
  private free: Bullet[] = [];
  private resolved: ResolvedShot[] = [];
  private effects: Effect[] = [];
  private tracerPool: THREE.Mesh[] = [];
  private point = new THREE.Vector3(); // scratch: per-frame advance is allocation-free
  private forward = new THREE.Vector3(0, 0, 1);

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < MAX_BULLETS; i++) this.free.push({ shot: undefined as unknown as Shot, position: new THREE.Vector3(), direction: new THREE.Vector3(), speed: 0, range: 0, traveled: 0, primary: false });
  }

  /** One trigger pull: `position` is the shooter (crime reports), `origin`/`directions` the aim rays (camera or hip). */
  spawnShot(position: THREE.Vector3, origin: THREE.Vector3, directions: THREE.Vector3[], count: number, spec: WeaponSpec, exclude?: Vehicle): void {
    const shot: Shot = { live: 0, position: position.clone(), weapon: spec.id, damage: spec.damage, falloffFloor: spec.falloffFloor, exclude, killed: false, policeHit: false, hitVehicles: new Set() };
    for (let i = 0; i < count; i++) {
      const bullet = this.free.pop(); const direction = directions[i];
      if (!bullet || !direction) break; // pool exhausted: drop the extra pellets rather than allocate
      bullet.shot = shot; bullet.position.copy(origin); bullet.direction.copy(direction).normalize();
      bullet.speed = spec.bulletSpeed ?? 300; bullet.range = spec.range; bullet.traveled = 0; bullet.primary = i === 0;
      if (spec.tracer) { bullet.tracer = this.tracerPool.pop() ?? this.makeTracer(); bullet.tracer.visible = false; bullet.tracer.quaternion.setFromUnitVectors(this.forward, bullet.direction); this.scene.add(bullet.tracer); }
      shot.live += 1; this.bullets.push(bullet);
    }
    if (shot.live === 0) this.resolved.push({ result: { fired: true }, position: shot.position, weapon: shot.weapon }); // fully starved shot still reports as a miss
  }

  update(dt: number, city: City, population: PopulationSystem, policeVehicles: Vehicle[]): ResolvedShot[] {
    const out = this.resolved; this.resolved = [];
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i]; if (!bullet) continue;
      const step = Math.min(bullet.speed * dt, bullet.range - bullet.traveled);
      let hitT = Infinity; let hitPed: Pedestrian | undefined; let hitVehicle: Vehicle | undefined;
      for (const ped of population.pedestrians) {
        if (ped.state === 'down') continue;
        const t = this.pedInterceptT(bullet, step, ped);
        if (t >= 0 && t < hitT) { hitT = t; hitPed = ped; }
      }
      for (const vehicle of population.vehicles) {
        if (vehicle === bullet.shot.exclude) continue;
        const t = this.vehicleInterceptT(bullet, step, vehicle);
        if (t >= 0 && t < hitT) { hitT = t; hitPed = undefined; hitVehicle = vehicle; }
      }
      for (const vehicle of policeVehicles) {
        if (vehicle === bullet.shot.exclude) continue;
        const t = this.vehicleInterceptT(bullet, step, vehicle);
        if (t >= 0 && t < hitT) { hitT = t; hitPed = undefined; hitVehicle = vehicle; }
      }
      const wallT = this.wallInterceptT(city, bullet, step, Math.min(hitT, 1));
      if (wallT >= 0 && wallT < hitT) { hitT = wallT; hitPed = undefined; hitVehicle = undefined; }
      if (hitT <= 1) { this.land(out, bullet, i, step * hitT, hitPed, hitVehicle, true); continue; }
      bullet.position.addScaledVector(bullet.direction, step); bullet.traveled += step;
      if (bullet.traveled >= bullet.range - 1e-6) { this.land(out, bullet, i, 0, undefined, undefined, false); continue; }
      if (bullet.tracer) { // streak trails the round; scale covers the ramp-up just past the muzzle
        const length = Math.min(TRACER_LENGTH, bullet.traveled - TRACER_MIN_TRAVEL);
        bullet.tracer.visible = length > 0.5;
        if (bullet.tracer.visible) { bullet.tracer.position.copy(bullet.position).addScaledVector(bullet.direction, -length / 2); bullet.tracer.scale.z = length / TRACER_LENGTH; }
      }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const effect = this.effects[i]; if (!effect) continue; effect.life -= dt;
      effect.mesh.scale.multiplyScalar(1 + dt * 4); (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, effect.life * 4);
      if (effect.life <= 0) { this.scene.remove(effect.mesh); this.effects.splice(i, 1); }
    }
    return out;
  }

  /** A round lands (flesh, steel, wall) or expires at max range: apply the hitscan-equivalent consequences,
   *  recycle the bullet, and once the last pellet of the trigger pull is down emit the aggregated resolution. */
  private land(out: ResolvedShot[], bullet: Bullet, index: number, advance: number, ped: Pedestrian | undefined, vehicle: Vehicle | undefined, impact: boolean): void {
    const shot = bullet.shot; const distance = bullet.traveled + advance;
    this.point.copy(bullet.position).addScaledVector(bullet.direction, advance);
    if (ped) {
      const dead = ped.takeDamage(calculateDamage(shot.damage, distance, 0, shot.falloffFloor));
      shot.policeHit ||= ped.police;
      if (!shot.victim || ped === shot.victim) { shot.victim = ped; shot.killed ||= dead; shot.hitPoint ??= this.point.clone(); } // first ped struck is the reported victim, as with hitscan pellets
      this.impact(this.point, 0xffcc72);
    } else if (vehicle) {
      if (!shot.hitVehicles.has(vehicle)) { shot.hitVehicles.add(vehicle); vehicle.takeDamage(calculateDamage(shot.damage * 0.6, distance, 0, shot.falloffFloor)); shot.policeHit ||= vehicle.police; } // one damage tick per vehicle per trigger pull
      this.impact(this.point, 0xffcc72);
    } else if (impact || bullet.primary) this.impact(this.point, 0xa9c0c4); // wall strike, or the lead pellet's expiry spark
    if (bullet.tracer) { bullet.tracer.visible = false; this.scene.remove(bullet.tracer); this.tracerPool.push(bullet.tracer); bullet.tracer = undefined; }
    const last = this.bullets.length - 1; const tail = this.bullets[last];
    if (tail && index !== last) this.bullets[index] = tail; // swap-remove keeps the live list dense
    this.bullets.pop(); this.free.push(bullet);
    shot.live -= 1;
    if (shot.live <= 0) out.push({ result: { fired: true, victim: shot.victim, killed: shot.killed, policeHit: shot.policeHit, hitPoint: shot.hitPoint }, position: shot.position, weapon: shot.weapon });
  }

  /** Closest 2D approach of the swept segment to the ped's current position, then a vertical band check. */
  private pedInterceptT(bullet: Bullet, step: number, ped: Pedestrian): number {
    const px = ped.group.position.x - bullet.position.x; const pz = ped.group.position.z - bullet.position.z;
    const dx = bullet.direction.x * step; const dz = bullet.direction.z * step;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-8 ? THREE.MathUtils.clamp((px * dx + pz * dz) / lengthSq, 0, 1) : 0;
    const ox = px - dx * t; const oz = pz - dz * t;
    if (ox * ox + oz * oz > PED_HIT_RADIUS * PED_HIT_RADIUS) return -1;
    const y = bullet.position.y + bullet.direction.y * step * t;
    return y >= ped.group.position.y - 0.05 && y <= ped.group.position.y + PED_HIT_HEIGHT ? t : -1;
  }

  /** Slab test of the swept segment against the vehicle's heading-aligned box (bounce/pitch wobble ignored). */
  private vehicleInterceptT(bullet: Bullet, step: number, vehicle: Vehicle): number {
    const cos = Math.cos(vehicle.heading); const sin = Math.sin(vehicle.heading);
    const wx = bullet.position.x - vehicle.group.position.x; const wy = bullet.position.y - vehicle.group.position.y; const wz = bullet.position.z - vehicle.group.position.z;
    const px = wx * cos - wz * sin; const pz = wx * sin + wz * cos; // world→local: forward is +z at heading
    const dxw = bullet.direction.x * step; const dzw = bullet.direction.z * step;
    const dx = dxw * cos - dzw * sin; const dy = bullet.direction.y * step; const dz = dxw * sin + dzw * cos;
    const [width, height, length] = vehicle.spec.size;
    let tMin = 0; let tMax = 1;
    for (const [p, d, min, max] of [[px, dx, -width / 2 - VEHICLE_HIT_MARGIN, width / 2 + VEHICLE_HIT_MARGIN], [wy, dy, -0.3, height], [pz, dz, -length / 2 - VEHICLE_HIT_MARGIN, length / 2 + VEHICLE_HIT_MARGIN]] as const) {
      if (Math.abs(d) < 1e-8) { if (p < min || p > max) return -1; continue; }
      const t1 = (min - p) / d; const t2 = (max - p) / d;
      tMin = Math.max(tMin, Math.min(t1, t2)); tMax = Math.min(tMax, Math.max(t1, t2));
      if (tMin > tMax) return -1;
    }
    return tMin;
  }

  /** Sampled 3D occupancy along the segment — the same collidesAt/terrain tests the rocket flies against. */
  private wallInterceptT(city: City, bullet: Bullet, step: number, limit: number): number {
    const samples = Math.max(1, Math.ceil(step / WALL_SAMPLE));
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      if (t > limit + 1e-6) return -1;
      const x = bullet.position.x + bullet.direction.x * step * t;
      const y = bullet.position.y + bullet.direction.y * step * t;
      const z = bullet.position.z + bullet.direction.z * step * t;
      if (y <= city.terrainHeightAt(x, z) + 0.05 || city.collidesAt(x, z, 0.12, y, y)) return t;
    }
    return -1;
  }

  private makeTracer(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, TRACER_LENGTH), new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.68, depthWrite: false }));
    mesh.frustumCulled = false;
    return mesh;
  }

  private impact(position: THREE.Vector3, color: number): void {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.copy(position); this.scene.add(mesh); this.effects.push({ mesh, life: 0.24 });
  }
}
