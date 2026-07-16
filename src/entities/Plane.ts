import * as THREE from 'three';
import type { InputManager } from '../core/InputManager';
import {
  createPlaneState, PLANE_WRECK_RESPAWN, stepPlane, type PlaneState, type PlaneStick,
} from '../systems/FlightSystem';
import { clampToWorld } from '../systems/Teleport';
import { APRON_LIFT, buildLightAircraft, rectFromQuad, rectPoint } from '../world/Airport';
import type { City } from '../world/City';
import { AIRPORT } from '../world/mapData';

const BODY_RADIUS = 2.2; // plan-view collision capsule: the fuselage, not the wingtips — clipping a wing is forgiven, arcade style
const CABIN_BAND: [number, number] = [0.5, 2.6]; // y band above the wheels tested against building/fence colliders
const VISUAL_BANK = 0.9; // how much of the flight-model roll the airframe shows
const TAXI_BUMP_SPEED = 16; // below this a ground collision just stops the roll; above it the field files an incident report

export interface PlaneSpawn { x: number; z: number; heading: number; }
export interface PlaneUpdate { crashed: boolean; sink: number; speed: number; }

/** Two flight-ready aircraft on the apron's outer stands, noses at the taxiway — clear of the three static
 *  dressing planes Airport.ts parks at ±0.3·hw, and computed from the same generated map block so worldgen
 *  determinism is untouched. */
export function functionalPlaneSpawns(): PlaneSpawn[] {
  if (!AIRPORT) return [];
  const rect = rectFromQuad(AIRPORT.apron.points);
  const buildings = AIRPORT.buildings[0] ?? AIRPORT.apron;
  const s = (buildings.cx - rect.cx) * rect.vx + (buildings.cz - rect.cz) * rect.vz >= 0 ? 1 : -1; // terminal side of the apron
  const heading = Math.atan2(rect.vx * -s, rect.vz * -s); // nose at the taxiway, away from the terminal row
  return [-0.55, 0.55].map((lx) => { const spot = rectPoint(rect, rect.hw * lx, s * (rect.hd - 40)); return { x: spot.x, z: spot.z, heading }; });
}

/** A flyable light aircraft: the Airport.ts airframe with a live prop, driven by the pure FlightSystem step.
 *  Not a Vehicle — planes have their own physics, their own wreck/respawn loop, and only minimal Game hooks. */
export class Plane {
  group: THREE.Group;
  state: PlaneState;
  name = 'Karoo Kite';
  pilot = false;
  wrecked = false;
  private prop: THREE.Group;
  private respawnTimer = 0;
  private propSpin = 0; // smoothed prop angular speed so the blades wind down instead of freezing

  constructor(scene: THREE.Scene, private spawn: PlaneSpawn, city: City, seed: number) {
    const built = buildLightAircraft(seed);
    this.group = built.group; this.prop = built.prop;
    this.group.rotation.order = 'YXZ'; // yaw, then pitch in the yawed frame, then bank about the nose
    this.group.name = this.name; this.group.userData.plane = this;
    this.state = createPlaneState(spawn.heading);
    this.placeAtSpawn(city);
    scene.add(this.group);
  }

  /** One piloted tick: stick from the keys, the pure step, then world clamps — bounds, buildings, terrain. */
  updatePlayer(dt: number, input: InputManager, city: City): PlaneUpdate {
    // GTA-style deck: W/S throttle, ↑/↓ pitch, and BOTH A/D and ←/→ bank (either muscle memory works).
    const stick: PlaneStick = {
      throttle: Number(input.down('KeyW')) - Number(input.down('KeyS')),
      steer: Math.max(-1, Math.min(1,
        Number(input.down('KeyA')) - Number(input.down('KeyD'))
        + Number(input.down('ArrowLeft')) - Number(input.down('ArrowRight')))),
      pitch: Number(input.down('ArrowUp')) - Number(input.down('ArrowDown')),
    };
    return this.step(stick, dt, city);
  }

  /** Pilotless tick: a bailed-out plane flies on with the throttle bleeding off — it slows, stalls, noses
   *  over and comes down ballistically. A wreck counts down to being towed back to its stand; a plane parked
   *  and idle just lets the prop wind down. Returns the crash site once, the frame it hits. */
  updateAmbient(dt: number, city: City): { x: number; z: number } | undefined {
    if (this.wrecked) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.restore(city);
      return undefined;
    }
    if (this.state.grounded && this.state.speed < 0.5 && this.state.throttle <= 0) { this.spinProp(dt); return undefined; }
    const result = this.step({ throttle: -0.3, steer: 0, pitch: 0 }, dt, city);
    if (!result.crashed) return undefined;
    const site = { x: this.group.position.x, z: this.group.position.z };
    this.wreck();
    return site;
  }

  private step(stick: PlaneStick, dt: number, city: City): PlaneUpdate {
    const position = this.group.position;
    const support = city.surfaceHeightAt(position.x, position.z) + APRON_LIFT;
    const step = stepPlane(this.state, stick, dt, position.y, support);
    let crashed = step.crashed;
    const nx = clampToWorld(position.x + step.dx); const nz = clampToWorld(position.z + step.dz); // world edge: a gentle clamp, the plane slides along it
    if (city.collidesAt(nx, nz, BODY_RADIUS, step.y + CABIN_BAND[0], step.y + CABIN_BAND[1])) {
      if (this.state.grounded && this.state.speed < TAXI_BUMP_SPEED) { this.state.speed = 0; this.pose(dt); this.spinProp(dt); return { crashed: false, sink: 0, speed: 0 }; } // taxi bump: just stop
      crashed = true; // flew (or barrelled) into something solid
    } else position.set(nx, step.y, nz);
    this.pose(dt); this.spinProp(dt);
    return { crashed, sink: step.sink, speed: this.state.speed };
  }

  private pose(dt: number): void {
    this.group.rotation.y = this.state.heading;
    this.group.rotation.x = -this.state.pitch; // nose is local +z: positive model pitch tips it up
    const bank = -this.state.roll * VISUAL_BANK; // dip the wing on the inside of the turn
    this.group.rotation.z += (bank - this.group.rotation.z) * Math.min(1, dt * 8);
  }

  private spinProp(dt: number): void {
    const target = this.state.throttle * 46 + Math.abs(this.state.speed) * 0.35 + (this.pilot ? 3 : 0);
    this.propSpin += (target - this.propSpin) * Math.min(1, dt * 1.6);
    this.prop.rotation.z += this.propSpin * dt;
  }

  /** Written off: charred livery, dead prop, and the tow-truck timer starts. */
  wreck(): void {
    if (this.wrecked) return;
    this.wrecked = true; this.respawnTimer = PLANE_WRECK_RESPAWN;
    this.state.speed = 0; this.state.throttle = 0; this.state.grounded = true; this.propSpin = 0;
    this.forEachMaterial((material) => {
      if (material.userData.originalColor === undefined) material.userData.originalColor = material.color.getHex();
      material.color.lerp(new THREE.Color(0x0d0c0b), 0.88);
    });
  }

  /** Towed back to the stand: fresh paint, parked at the spawn, ready to fly again. */
  private restore(city: City): void {
    this.wrecked = false;
    this.forEachMaterial((material) => { if (material.userData.originalColor !== undefined) material.color.setHex(material.userData.originalColor as number); });
    this.state = createPlaneState(this.spawn.heading);
    this.placeAtSpawn(city);
  }

  private placeAtSpawn(city: City): void {
    this.group.position.set(this.spawn.x, city.surfaceHeightAt(this.spawn.x, this.spawn.z) + APRON_LIFT, this.spawn.z);
    this.group.rotation.set(0, this.spawn.heading, 0);
  }

  private forEachMaterial(apply: (material: THREE.MeshStandardMaterial) => void): void {
    const seen = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const material = object.material as THREE.MeshStandardMaterial;
      if (seen.has(material)) return;
      seen.add(material); apply(material);
    });
  }
}
