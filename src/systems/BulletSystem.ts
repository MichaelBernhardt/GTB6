import * as THREE from 'three';
import type { WeaponId, WeaponSpec } from '../config';
import { calculateDamage } from '../core/GameRules';
import type { Pedestrian } from '../entities/Pedestrian';
import type { Vehicle } from '../entities/Vehicle';
import type { PopulationSystem } from './PopulationSystem';
import type { City } from '../world/City';
import type { ShotResult } from './CombatSystem';
import { type PropCollider, type PropRegistry, SHOT_KNOCK_SPEED } from './PropSystem';

/** Hard cap on live rounds — the pool is preallocated and pellets past the cap are dropped, never allocated. */
export const MAX_BULLETS = 240;
const PED_HIT_RADIUS = 0.5; // forgiving next to the ~0.3 mesh, but far under the metres a mover travels in flight
const PED_HIT_HEIGHT = 1.85;
const CORPSE_HIT_RADIUS = 0.8; // a sprawled body covers more ground than a standing one...
const CORPSE_HIT_HEIGHT = 0.5; // ...but hugs it
const VEHICLE_HIT_MARGIN = 0.12;
const WALL_SAMPLE = 0.8; // stride for sampling city geometry along the swept segment
const ROUND_RADIUS = 0.12; // the round's own girth, used by every city-geometry probe
const PROP_QUERY_MARGIN = 1; // widest shootable prop plus slop: the grid pre-filter around the swept segment
const TRACER_LENGTH = 7;
const TRACER_MIN_TRAVEL = 3; // no streak in the shooter's face; it fades in past the muzzle

interface Shot { live: number; position: THREE.Vector3; weapon: WeaponId; damage: number; falloffFloor?: number; exclude?: Vehicle; victim?: Pedestrian; killed: boolean; policeHit: boolean; hitPoint?: THREE.Vector3; hitVehicles: Set<Vehicle>; kickedCorpses: Set<Pedestrian>; }
interface Bullet {
  shot: Shot; position: THREE.Vector3; direction: THREE.Vector3; speed: number; range: number; traveled: number; primary: boolean; tracer?: THREE.Mesh;
  /** True when the round STARTED below the terrain — i.e. inside a feature interior, which stands
   *  ~30 u under its own building. For such a round the ground far overhead is not a wall it can
   *  meet: without this, the sampler read "below terrainHeightAt" at its first step and every
   *  indoor shot died at the muzzle — the owner's "people inside buildings seem immortal".
   *  Decided once on the first update (spawn has no city in hand); reset on reuse in spawnShot. */
  subterranean?: boolean;
}
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
  // Shared spark geometry — impacts used to new an IcosahedronGeometry per hit and never dispose it,
  // the same per-event GPU-buffer churn the explosion path had (puffs, decals). One buffer forever.
  private impactGeometry = new THREE.IcosahedronGeometry(0.12, 0);

  constructor(private scene: THREE.Scene) {
    for (let i = 0; i < MAX_BULLETS; i++) this.free.push({ shot: undefined as unknown as Shot, position: new THREE.Vector3(), direction: new THREE.Vector3(), speed: 0, range: 0, traveled: 0, primary: false });
  }

  /** One trigger pull: `position` is the shooter (crime reports), `origin`/`directions` the aim rays (camera or hip). */
  spawnShot(position: THREE.Vector3, origin: THREE.Vector3, directions: THREE.Vector3[], count: number, spec: WeaponSpec, exclude?: Vehicle): void {
    const shot: Shot = { live: 0, position: position.clone(), weapon: spec.id, damage: spec.damage, falloffFloor: spec.falloffFloor, exclude, killed: false, policeHit: false, hitVehicles: new Set(), kickedCorpses: new Set() };
    for (let i = 0; i < count; i++) {
      const bullet = this.free.pop(); const direction = directions[i];
      if (!bullet || !direction) break; // pool exhausted: drop the extra pellets rather than allocate
      bullet.shot = shot; bullet.position.copy(origin); bullet.direction.copy(direction).normalize();
      bullet.speed = spec.bulletSpeed ?? 300; bullet.range = spec.range; bullet.traveled = 0; bullet.primary = i === 0;
      bullet.subterranean = undefined; // pooled: the previous flight's answer must not leak
      if (spec.tracer) { bullet.tracer = this.tracerPool.pop() ?? this.makeTracer(); bullet.tracer.visible = false; bullet.tracer.quaternion.setFromUnitVectors(this.forward, bullet.direction); this.scene.add(bullet.tracer); }
      shot.live += 1; this.bullets.push(bullet);
    }
    if (shot.live === 0) this.resolved.push({ result: { fired: true }, position: shot.position, weapon: shot.weapon }); // fully starved shot still reports as a miss
  }

  update(dt: number, city: City, population: PopulationSystem, policeVehicles: Vehicle[]): ResolvedShot[] {
    const out = this.resolved; this.resolved = [];
    const props = city.props as PropRegistry | undefined; // sim tests mock City without a prop registry
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const bullet = this.bullets[i]; if (!bullet) continue;
      if (bullet.subterranean === undefined) {
        bullet.subterranean = bullet.position.y < city.terrainHeightAt(bullet.position.x, bullet.position.z) - 2;
      }
      const step = Math.min(bullet.speed * dt, bullet.range - bullet.traveled);
      let hitT = Infinity; let hitPed: Pedestrian | undefined; let hitVehicle: Vehicle | undefined; let hitProp: PropCollider | undefined;
      for (const ped of population.pedestrians) {
        // An indoor round lives UNDER the terrain; a body at or above the surface is in another
        // world as far as it is concerned. The sampled terrain check below can race a ped
        // intercept inside one fast step, so the boundary is enforced on the target too.
        if (bullet.subterranean && ped.group.position.y >= city.terrainHeightAt(ped.group.position.x, ped.group.position.z) - 1.5) continue;
        if (ped.state === 'down') {
          // Overkill: rounds pass THROUGH a settled corpse (it never shields a live target or eats the
          // hit) but jolt its ragdoll — once per trigger pull, so a shotgun blast is one kick, not nine.
          if (ped.health === 0 && !bullet.shot.kickedCorpses.has(ped) && this.corpseGrazeT(bullet, step, ped) >= 0) {
            bullet.shot.kickedCorpses.add(ped);
            ped.corpseHit(bullet.position, bullet.shot.damage);
          }
          continue;
        }
        const t = this.pedInterceptT(bullet, step, ped);
        if (t >= 0 && t < hitT) { hitT = t; hitPed = ped; }
      }
      // Vehicles never stand inside a feature interior; an indoor round cannot bill one.
      if (!bullet.subterranean) {
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
      }
      const propHit = props ? this.propInterceptT(props, city, bullet, step, Math.min(hitT, 1)) : undefined;
      if (propHit && propHit.t < hitT) { hitT = propHit.t; hitPed = undefined; hitVehicle = undefined; hitProp = propHit.prop; }
      const wallT = this.wallInterceptT(city, bullet, step, Math.min(hitT, 1));
      // Strictly closer, so a wall SAMPLE that landed inside the hydrant it flew into does not steal the hit
      // from the prop sweep: the sweep reports the disc's entry point, which is never later than that sample.
      if (wallT >= 0 && wallT < hitT) { hitT = wallT; hitPed = undefined; hitVehicle = undefined; hitProp = undefined; }
      if (hitT <= 1) {
        if (hitProp) props?.fell(hitProp, bullet.direction.x, bullet.direction.z, SHOT_KNOCK_SPEED); // bursts down the car's path
        this.land(out, bullet, i, step * hitT, hitPed, hitVehicle, true); continue;
      }
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
      if (effect.life <= 0) { this.scene.remove(effect.mesh); (effect.mesh.material as THREE.MeshBasicMaterial).dispose(); this.effects.splice(i, 1); } // per-impact material (opacity animates); geometry is shared
    }
    return out;
  }

  /** A round lands (flesh, steel, wall) or expires at max range: apply the hitscan-equivalent consequences,
   *  recycle the bullet, and once the last pellet of the trigger pull is down emit the aggregated resolution. */
  private land(out: ResolvedShot[], bullet: Bullet, index: number, advance: number, ped: Pedestrian | undefined, vehicle: Vehicle | undefined, impact: boolean): void {
    const shot = bullet.shot; const distance = bullet.traveled + advance;
    this.point.copy(bullet.position).addScaledVector(bullet.direction, advance);
    if (ped) {
      const dead = ped.takeDamage(calculateDamage(shot.damage, distance, 0, shot.falloffFloor), this.point.clone().addScaledVector(bullet.direction, -1)); // impact source: one unit back along the round's path
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

  /** pedInterceptT for a body on the deck: wider ground-level disc, low vertical band. */
  private corpseGrazeT(bullet: Bullet, step: number, ped: Pedestrian): number {
    const px = ped.group.position.x - bullet.position.x; const pz = ped.group.position.z - bullet.position.z;
    const dx = bullet.direction.x * step; const dz = bullet.direction.z * step;
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 1e-8 ? THREE.MathUtils.clamp((px * dx + pz * dz) / lengthSq, 0, 1) : 0;
    const ox = px - dx * t; const oz = pz - dz * t;
    if (ox * ox + oz * oz > CORPSE_HIT_RADIUS * CORPSE_HIT_RADIUS) return -1;
    const y = bullet.position.y + bullet.direction.y * step * t;
    return y >= ped.group.position.y - 0.05 && y <= ped.group.position.y + CORPSE_HIT_HEIGHT ? t : -1;
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

  /** Where the swept round ENTERS a shootable prop's circle (today: a fire hydrant), nearest first.
   *
   *  It needs its own test rather than a ride on the wall sampler above. That sampler walks the segment in
   *  0.8u strides, and a hydrant is 0.6u across: unless the round is within ~0.18u of dead centre the stride
   *  steps clean over it, so leaning on it would make bursting a hydrant a coin flip. This is exact — the
   *  same swept circle used for a pedestrian, plus the prop's vertical band, so a round that sails OVER the
   *  bonnet leaves it standing. Entry, not closest approach: it must not be later than the wall sample that
   *  the same hydrant would have tripped, or the wall would win the tie and swallow the burst. */
  private propInterceptT(props: PropRegistry, city: City, bullet: Bullet, step: number, limit: number): { prop: PropCollider; t: number } | undefined {
    const dx = bullet.direction.x * step; const dz = bullet.direction.z * step;
    const lengthSq = dx * dx + dz * dz;
    if (lengthSq < 1e-8) return undefined;
    const length = Math.sqrt(lengthSq);
    let best: { prop: PropCollider; t: number } | undefined;
    for (const prop of props.shootableNear(bullet.position.x + dx / 2, bullet.position.z + dz / 2, length / 2 + PROP_QUERY_MARGIN)) {
      const fx = bullet.position.x - prop.x; const fz = bullet.position.z - prop.z;
      const reach = prop.radius + ROUND_RADIUS;
      const b = 2 * (fx * dx + fz * dz);
      const discriminant = b * b - 4 * lengthSq * (fx * fx + fz * fz - reach * reach);
      if (discriminant < 0) continue;
      const root = Math.sqrt(discriminant);
      const enter = Math.max(0, (-b - root) / (2 * lengthSq));
      const exit = Math.min(1, (-b + root) / (2 * lengthSq));
      if (exit < enter || enter > limit + 1e-6 || (best && enter >= best.t)) continue;
      // Band test over the whole chord, not just its ends: a steeply angled round can enter the circle above
      // the cap and still be at hydrant height by the middle of it.
      const base = city.surfaceHeightAt(prop.x, prop.z);
      const yEnter = bullet.position.y + bullet.direction.y * step * enter;
      const yExit = bullet.position.y + bullet.direction.y * step * exit;
      if (Math.max(yEnter, yExit) < base || Math.min(yEnter, yExit) > base + prop.height) continue; // over the top, or under the pavement
      best = { prop, t: enter };
    }
    return best;
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
      // The terrain stops rounds from WHICHEVER side they meet it: an outdoor round buries itself
      // in the ground, and an indoor (subterranean) round fired upward dies in the earth above the
      // room's ceiling instead of sailing through the pavement into the street's pedestrians.
      const terrainStops = bullet.subterranean
        ? y >= city.terrainHeightAt(x, z) - 0.05
        : y <= city.terrainHeightAt(x, z) + 0.05;
      if (terrainStops || city.collidesAt(x, z, ROUND_RADIUS, y, y)) return t;
    }
    return -1;
  }

  private makeTracer(): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, TRACER_LENGTH), new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0.68, depthWrite: false }));
    mesh.frustumCulled = false;
    return mesh;
  }

  private impact(position: THREE.Vector3, color: number): void {
    const mesh = new THREE.Mesh(this.impactGeometry, new THREE.MeshBasicMaterial({ color, transparent: true }));
    mesh.position.copy(position); this.scene.add(mesh); this.effects.push({ mesh, life: 0.24 });
  }
}
