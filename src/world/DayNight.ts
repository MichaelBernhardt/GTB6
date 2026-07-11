import * as THREE from 'three';
import type { Vehicle } from '../entities/Vehicle';
import type { GameSettings } from '../types';
import type { City } from './City';
import type { EnvironmentHandle } from './Environment';
import { powerOn } from './powerGrid';

/** One full 24h cycle in 10 real minutes. */
export const DAY_CYCLE_SECONDS = 600;
export const DEFAULT_HOUR = 10;

export const DAWN_START = 5.2; export const DAWN_END = 6.9;
export const DUSK_START = 17.7; export const DUSK_END = 19.5;

/** Real light pools per quality: PointLights under the nearest streetlamps, SpotLights on the nearest vehicles. */
export const STREETLIGHT_POOL: Record<GameSettings['quality'], number> = { low: 4, medium: 8, high: 12 };
export const HEADLIGHT_POOL: Record<GameSettings['quality'], number> = { low: 2, medium: 4, high: 6 };

const STREETLIGHT_RADIUS = 18; const STREETLIGHT_INTENSITY = 30; const STREETLIGHT_COLOR = 0xffb45e;
const HEADLIGHT_RANGE = 36; const HEADLIGHT_INTENSITY = 48; const HEADLIGHT_COLOR = 0xfff3cf;
const LAMP_HEIGHT = 5.7; // just below the fixture built in UrbanInfrastructure (bulb at y=6.02)
const DISC_DISTANCE = 1750; // sun/moon disc distance from the focus (camera far is 2600)
const FACADE_NIGHT_EMISSIVE = 1.25;

export interface SkyKeyframe { hour: number; sky: number; fog: number; sun: number; sunIntensity: number; hemiSky: number; hemiGround: number; hemiIntensity: number; ambient: number; ambientIntensity: number; }

const NIGHT: Omit<SkyKeyframe, 'hour'> = { sky: 0x0b1322, fog: 0x0d1726, sun: 0x93a9d6, sunIntensity: 0.4, hemiSky: 0x1e2d4a, hemiGround: 0x11171c, hemiIntensity: 0.55, ambient: 0x31436a, ambientIntensity: 0.2 };

/** Sorted by hour; the first frame must sit at hour 0 and the last wraps back to it across midnight. */
export const SKY_KEYFRAMES: SkyKeyframe[] = [
  { hour: 0, ...NIGHT },
  { hour: 4.6, ...NIGHT },
  { hour: 6.1, sky: 0xcf8a52, fog: 0xc08a67, sun: 0xffb26b, sunIntensity: 2.1, hemiSky: 0xe2ad80, hemiGround: 0x4a4034, hemiIntensity: 1.0, ambient: 0xffd2a4, ambientIntensity: 0.24 },
  { hour: 8, sky: 0x82b0d9, fog: 0xc0b294, sun: 0xffe0a8, sunIntensity: 3.8, hemiSky: 0xd4e4f2, hemiGround: 0x8a7c4d, hemiIntensity: 1.5, ambient: 0xffead0, ambientIntensity: 0.27 },
  { hour: 12, sky: 0x6fa8dd, fog: 0xc4b48c, sun: 0xffd9a0, sunIntensity: 4.4, hemiSky: 0xcfe4f5, hemiGround: 0x8a7c4d, hemiIntensity: 1.6, ambient: 0xffead0, ambientIntensity: 0.28 },
  { hour: 16.5, sky: 0x7aa5cc, fog: 0xc2ab84, sun: 0xffd092, sunIntensity: 3.7, hemiSky: 0xccdfe9, hemiGround: 0x83764a, hemiIntensity: 1.45, ambient: 0xffe6c2, ambientIntensity: 0.26 },
  { hour: 18.2, sky: 0xd07a40, fog: 0xbd7a55, sun: 0xff8e48, sunIntensity: 1.9, hemiSky: 0xe0925e, hemiGround: 0x3b322b, hemiIntensity: 0.9, ambient: 0xffbe86, ambientIntensity: 0.22 },
  { hour: 19.6, sky: 0x2a2440, fog: 0x282742, sun: 0x8d94c8, sunIntensity: 0.55, hemiSky: 0x353057, hemiGround: 0x171a20, hemiIntensity: 0.6, ambient: 0x4a4a78, ambientIntensity: 0.21 },
  { hour: 21, ...NIGHT },
];

export interface SkySample { sky: THREE.Color; fog: THREE.Color; sun: THREE.Color; hemiSky: THREE.Color; hemiGround: THREE.Color; ambient: THREE.Color; sunIntensity: number; hemiIntensity: number; ambientIntensity: number; }

export function createSkySample(): SkySample {
  return { sky: new THREE.Color(), fog: new THREE.Color(), sun: new THREE.Color(), hemiSky: new THREE.Color(), hemiGround: new THREE.Color(), ambient: new THREE.Color(), sunIntensity: 0, hemiIntensity: 0, ambientIntensity: 0 };
}

export function wrapHour(hour: number): number { return ((hour % 24) + 24) % 24; }

export function advanceHour(hour: number, dt: number, cycleSeconds = DAY_CYCLE_SECONDS): number { return wrapHour(hour + dt * 24 / cycleSeconds); }

export function formatClock(hour: number): string {
  const total = Math.floor(wrapHour(hour) * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const smooth = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** 0 in full daylight, 1 at night, smooth ramps through dawn and dusk. Drives streetlights, windows, and headlights. */
export function nightFactor(hour: number): number {
  const h = wrapHour(hour);
  if (h < DAWN_START || h >= DUSK_END) return 1;
  if (h < DAWN_END) return 1 - smooth((h - DAWN_START) / (DAWN_END - DAWN_START));
  if (h < DUSK_START) return 0;
  return smooth((h - DUSK_START) / (DUSK_END - DUSK_START));
}

const LERP_TMP = new THREE.Color();
const lerpHex = (a: number, b: number, t: number, out: THREE.Color): THREE.Color => out.setHex(a).lerp(LERP_TMP.setHex(b), t);

export function sampleSky(hour: number, out: SkySample): SkySample {
  const frames = SKY_KEYFRAMES; const h = wrapHour(hour);
  let index = frames.length - 1;
  while (index > 0 && frames[index]!.hour > h) index--;
  const a = frames[index]!; const b = frames[(index + 1) % frames.length]!;
  const span = (index + 1 === frames.length ? 24 : b.hour) - a.hour;
  const t = span > 0 ? (h - a.hour) / span : 0;
  lerpHex(a.sky, b.sky, t, out.sky); lerpHex(a.fog, b.fog, t, out.fog); lerpHex(a.sun, b.sun, t, out.sun);
  lerpHex(a.hemiSky, b.hemiSky, t, out.hemiSky); lerpHex(a.hemiGround, b.hemiGround, t, out.hemiGround); lerpHex(a.ambient, b.ambient, t, out.ambient);
  out.sunIntensity = THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t);
  out.hemiIntensity = THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, t);
  out.ambientIntensity = THREE.MathUtils.lerp(a.ambientIntensity, b.ambientIntensity, t);
  return out;
}

/** Sun arc: rises ~6:00 in the east, peaks at noon, sets ~18:00. Feed hour+12 for the moon. */
export function sunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  const angle = ((hour - 6) / 24) * Math.PI * 2;
  return out.set(Math.cos(angle) * 0.92, Math.sin(angle) * 0.88 + 0.03, 0.42).normalize();
}

/** Writes the indices of the `count` nearest xz pairs to (fx, fz) into outIndices, ascending by distance.
 *  Allocation-free partial insertion sort; `total` limits the scan for partially-filled buffers. Returns how many were written. */
export function selectNearest(xz: ArrayLike<number>, fx: number, fz: number, count: number, outIndices: number[], outDistances: number[], total = xz.length >> 1): number {
  let found = 0;
  for (let i = 0; i < total; i++) {
    const dx = xz[i * 2]! - fx; const dz = xz[i * 2 + 1]! - fz; const d = dx * dx + dz * dz;
    if (found === count && d >= outDistances[found - 1]!) continue;
    let at = found < count ? found : count - 1;
    while (at > 0 && outDistances[at - 1]! > d) { outDistances[at] = outDistances[at - 1]!; outIndices[at] = outIndices[at - 1]!; at--; }
    outDistances[at] = d; outIndices[at] = i;
    if (found < count) found++;
  }
  return found;
}

export class DayNightSystem {
  hour: number;
  private sample = createSkySample();
  private sunDir = new THREE.Vector3(); private moonDir = new THREE.Vector3();
  private moon: THREE.Mesh;
  private lampXZ: Float32Array;
  private lampIndices: number[] = []; private lampDistances: number[] = [];
  private streetPool: THREE.PointLight[] = [];
  private headPool: THREE.SpotLight[] = [];
  private facades: THREE.MeshStandardMaterial[];
  private candidates: Vehicle[] = [];
  private candidateXZ = new Float32Array(64);
  private candidateIndices: number[] = []; private candidateDistances: number[] = [];

  constructor(private scene: THREE.Scene, private environment: EnvironmentHandle, private city: City, quality: GameSettings['quality'], startHour = DEFAULT_HOUR) {
    this.hour = wrapHour(startHour);
    this.lampXZ = city.streetlightLampsXZ();
    this.facades = city.facadeMaterials();
    this.moon = new THREE.Mesh(new THREE.SphereGeometry(11, 20, 14), new THREE.MeshBasicMaterial({ color: 0xe6ecf7, fog: false }));
    this.moon.name = 'Moon'; scene.add(this.moon);
    this.buildPools(quality);
    this.apply(new THREE.Vector3());
  }

  get clockText(): string { return formatClock(this.hour); }

  setQuality(quality: GameSettings['quality']): void { this.buildPools(quality); }

  private buildPools(quality: GameSettings['quality']): void {
    for (const light of this.streetPool) this.scene.remove(light);
    for (const light of this.headPool) { this.scene.remove(light.target); this.scene.remove(light); }
    this.streetPool = Array.from({ length: STREETLIGHT_POOL[quality] }, () => {
      const light = new THREE.PointLight(STREETLIGHT_COLOR, 0, STREETLIGHT_RADIUS, 1.8); light.castShadow = false; this.scene.add(light); return light;
    });
    this.headPool = Array.from({ length: HEADLIGHT_POOL[quality] }, () => {
      const light = new THREE.SpotLight(HEADLIGHT_COLOR, 0, HEADLIGHT_RANGE, 0.52, 0.55, 1.3); light.castShadow = false; this.scene.add(light, light.target); return light;
    });
  }

  update(dt: number, focus: THREE.Vector3, traffic: readonly Vehicle[], police: readonly Vehicle[], playerVehicle?: Vehicle): void {
    this.hour = advanceHour(this.hour, dt);
    this.apply(focus, traffic, police, playerVehicle);
  }

  private apply(focus: THREE.Vector3, traffic: readonly Vehicle[] = [], police: readonly Vehicle[] = [], playerVehicle?: Vehicle): void {
    const sky = sampleSky(this.hour, this.sample); const night = nightFactor(this.hour);
    const env = this.environment;
    env.sun.color.copy(sky.sun); env.sun.intensity = sky.sunIntensity;
    env.hemisphere.color.copy(sky.hemiSky); env.hemisphere.groundColor.copy(sky.hemiGround); env.hemisphere.intensity = sky.hemiIntensity;
    env.ambient.color.copy(sky.ambient); env.ambient.intensity = sky.ambientIntensity;
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(sky.sky);
    if (this.scene.fog) this.scene.fog.color.copy(sky.fog);
    this.scene.environmentIntensity = 0.32 * (1 - night * 0.72);
    sunDirection(this.hour, this.sunDir); sunDirection(this.hour + 12, this.moonDir);
    env.setSunDirection(this.sunDir.y >= this.moonDir.y ? this.sunDir : this.moonDir); // shadow light tracks whichever body is up
    env.sunDisc.position.copy(focus).addScaledVector(this.sunDir, DISC_DISTANCE); env.sunDisc.visible = this.sunDir.y > -0.05;
    (env.sunDisc.material as THREE.MeshBasicMaterial).color.copy(sky.sun);
    this.moon.position.copy(focus).addScaledVector(this.moonDir, DISC_DISTANCE); this.moon.visible = this.moonDir.y > -0.05;
    this.city.setWaterMood(this.hour, this.sunDir.y >= this.moonDir.y ? this.sunDir : this.moonDir, sky.sun); // water tint and its specular body track the sky
    const gridNight = powerOn() ? night : 0; // load shedding: mains-fed lights go dark, whatever the hour
    this.city.setStreetlightGlow(night); // the bulb material checks the grid itself so panels also read dark by day
    for (const material of this.facades) material.emissiveIntensity = gridNight * FACADE_NIGHT_EMISSIVE;
    this.updateStreetlightPool(focus, gridNight);
    this.updateHeadlightPool(focus, night, traffic, police, playerVehicle); // cars run on batteries — Eskom can't touch these
  }

  private updateStreetlightPool(focus: THREE.Vector3, night: number): void {
    const pool = this.streetPool;
    if (night <= 0.001) { for (const light of pool) light.intensity = 0; return; }
    const found = selectNearest(this.lampXZ, focus.x, focus.z, pool.length, this.lampIndices, this.lampDistances);
    for (let slot = 0; slot < pool.length; slot++) {
      const light = pool[slot]!;
      if (slot >= found) { light.intensity = 0; continue; }
      const lamp = this.lampIndices[slot]!;
      light.position.set(this.lampXZ[lamp * 2]!, LAMP_HEIGHT, this.lampXZ[lamp * 2 + 1]!);
      light.intensity = night * STREETLIGHT_INTENSITY;
    }
  }

  private updateHeadlightPool(focus: THREE.Vector3, night: number, traffic: readonly Vehicle[], police: readonly Vehicle[], playerVehicle?: Vehicle): void {
    for (const vehicle of traffic) vehicle.setHeadlightGlow(night);
    for (const vehicle of police) vehicle.setHeadlightGlow(night);
    const pool = this.headPool;
    if (night <= 0.001) { for (const light of pool) light.intensity = 0; return; }
    let slot = 0;
    if (playerVehicle && !playerVehicle.wrecked && playerVehicle.spec.kind !== 'bicycle' && slot < pool.length) this.aimHeadlight(pool[slot++]!, playerVehicle, night); // the player's ride always gets a real beam — bicycles carry no lamp
    const remaining = pool.length - slot;
    if (remaining > 0) {
      this.candidates.length = 0;
      for (const vehicle of traffic) if (!vehicle.wrecked && vehicle !== playerVehicle && vehicle.spec.kind !== 'bicycle') this.candidates.push(vehicle);
      for (const vehicle of police) if (!vehicle.wrecked && vehicle !== playerVehicle) this.candidates.push(vehicle);
      if (this.candidateXZ.length < this.candidates.length * 2) this.candidateXZ = new Float32Array(this.candidates.length * 4);
      for (let i = 0; i < this.candidates.length; i++) {
        const position = this.candidates[i]!.group.position;
        this.candidateXZ[i * 2] = position.x; this.candidateXZ[i * 2 + 1] = position.z;
      }
      const found = selectNearest(this.candidateXZ, focus.x, focus.z, remaining, this.candidateIndices, this.candidateDistances, this.candidates.length);
      for (let i = 0; i < found; i++) this.aimHeadlight(pool[slot++]!, this.candidates[this.candidateIndices[i]!]!, night);
    }
    for (; slot < pool.length; slot++) pool[slot]!.intensity = 0;
  }

  private aimHeadlight(light: THREE.SpotLight, vehicle: Vehicle, night: number): void {
    const position = vehicle.group.position;
    const forwardX = Math.sin(vehicle.heading); const forwardZ = Math.cos(vehicle.heading);
    const nose = vehicle.spec.size[2] / 2 + 0.2;
    light.position.set(position.x + forwardX * nose, 0.85, position.z + forwardZ * nose);
    light.target.position.set(position.x + forwardX * (nose + 14), 0.05, position.z + forwardZ * (nose + 14));
    light.intensity = night * HEADLIGHT_INTENSITY;
  }
}
