import { MAP_WORLD_SIZE } from './world/mapData';

/** World footprint comes from the generated OSM map (stats.targetSize). */
export const WORLD_SIZE = MAP_WORLD_SIZE;
export const ROAD_WIDTH = 14; // widest common surface street (primary) in the generated map
export const BLOCK_SIZE = 76;
export const TRAFFIC_SPEED_FACTOR = 0.42;
/** Agents beyond this range from the player freeze entirely: no motion, routing, or animation. */
export const AI_FREEZE_RADIUS = 500;
/** Frozen agents wake only once the player is back inside this range (hysteresis avoids boundary flicker). */
export const AI_THAW_RADIUS = 450;
/** Pure freeze/thaw hysteresis: takes the current frozen state and squared distance to the player. */
export function resolveFrozen(frozen: boolean, distanceSq: number): boolean {
  return distanceSq > (frozen ? AI_THAW_RADIUS * AI_THAW_RADIUS : AI_FREEZE_RADIUS * AI_FREEZE_RADIUS);
}
export const PLAYER = {
  walkSpeed: 8,
  sprintSpeed: 13,
  jumpSpeed: 10,
  gravity: 27,
  radius: 0.65,
  height: 1.8,
  stepUp: 0.55, // curbs, plinths and low ledges are stepped onto, not collided with
  maxHealth: 100,
};
export const CHEATS = { runMultiplier: 1.8, jumpMultiplier: 2 };

export type VehicleKind = 'compact' | 'sport' | 'van' | 'police' | 'taxi' | 'cab' | 'bicycle' | 'motorbike' | 'superbike';
export interface VehicleSpec {
  kind: VehicleKind;
  name: string;
  color: number;
  maxSpeed: number;
  acceleration: number;
  brake: number;
  steering: number;
  drag: number;
  health: number;
  size: [number, number, number];
  twoWheeler?: boolean;
  saddle?: [number, number]; // rider group offset from the vehicle origin: [y, z]
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  compact: { kind: 'compact', name: 'Citi Golf', color: 0xe7b23b, maxSpeed: 34, acceleration: 22, brake: 34, steering: 2.2, drag: 0.7, health: 100, size: [1.8, 1.35, 3.7] },
  sport: { kind: 'sport', name: 'Golf GTI (Vrrr Phaa)', color: 0xd83a40, maxSpeed: 48, acceleration: 31, brake: 42, steering: 2.45, drag: 0.55, health: 80, size: [1.9, 1.15, 4.15] },
  van: { kind: 'van', name: 'Hilux Bakkie', color: 0x58a596, maxSpeed: 27, acceleration: 16, brake: 28, steering: 1.75, drag: 0.85, health: 145, size: [2.15, 2.15, 4.9] },
  police: { kind: 'police', name: 'JMPD Interceptor', color: 0x202b38, maxSpeed: 42, acceleration: 28, brake: 40, steering: 2.35, drag: 0.6, health: 130, size: [1.95, 1.4, 4.35] },
  taxi: { kind: 'taxi', name: 'Quantum Express', color: 0xf0f1ea, maxSpeed: 44, acceleration: 27, brake: 30, steering: 2.1, drag: 0.6, health: 120, size: [2.05, 2, 5.05] },
  cab: { kind: 'cab', name: 'Jozi Meter Cab', color: 0xf2c521, maxSpeed: 38, acceleration: 24, brake: 36, steering: 2.3, drag: 0.62, health: 110, size: [1.85, 1.4, 4.2] },
  // maxSpeed = 2x sprint (13): W cruises at BICYCLE_CRUISE_FACTOR of this, Shift pedals hard for the full cap
  bicycle: { kind: 'bicycle', name: 'Kasi Cruiser', color: 0x3d7dc4, maxSpeed: 26, acceleration: 11, brake: 20, steering: 2.9, drag: 0.9, health: 40, size: [0.55, 1.1, 1.85], twoWheeler: true, saddle: [0.12, -0.2] },
  motorbike: { kind: 'motorbike', name: 'Soweto Scrambler', color: 0x9a3b2c, maxSpeed: 46, acceleration: 35, brake: 40, steering: 2.95, drag: 0.6, health: 60, size: [0.75, 1.2, 2.25], twoWheeler: true, saddle: [0.08, -0.18] },
  superbike: { kind: 'superbike', name: 'Sandton Rocket', color: 0x84f01c, maxSpeed: 60, acceleration: 46, brake: 46, steering: 3.1, drag: 0.5, health: 55, size: [0.78, 1.05, 2.2], twoWheeler: true, saddle: [0.1, -0.3] },
};

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rpg' | 'sniper';
export type WeaponSound = 'punch' | 'pistol' | 'smg' | 'shotgun' | 'launcher' | 'sniper';
export interface ProjectileSpec { speed: number; radius: number; damage: number; }
export interface WeaponSpec {
  id: WeaponId;
  name: string;
  melee: boolean;
  auto: boolean;
  starter: boolean;
  damage: number;
  cooldown: number;
  range: number;
  magazine: number;
  reserve: number;
  reloadTime: number;
  spread: number;
  pellets: number;
  projectile?: ProjectileSpec;
  falloffFloor?: number; // minimum damage falloff multiplier; the sniper's 1 means full damage at any range
  sound: WeaponSound;
}

export const WEAPONS: WeaponSpec[] = [
  { id: 'fists', name: 'FISTS', melee: true, auto: false, starter: true, damage: 34, cooldown: 0.42, range: 2.4, magazine: 0, reserve: 0, reloadTime: 0, spread: 0, pellets: 0, sound: 'punch' },
  { id: 'pistol', name: '9MM', melee: false, auto: false, starter: true, damage: 38, cooldown: 0.19, range: 130, magazine: 12, reserve: 84, reloadTime: 1.05, spread: 0, pellets: 1, sound: 'pistol' },
  { id: 'smg', name: 'MICRO SMG', melee: false, auto: true, starter: false, damage: 16, cooldown: 0.09, range: 90, magazine: 30, reserve: 120, reloadTime: 1.6, spread: 0.022, pellets: 1, sound: 'smg' },
  { id: 'shotgun', name: 'PUMP SHOTGUN', melee: false, auto: false, starter: false, damage: 13, cooldown: 0.85, range: 42, magazine: 6, reserve: 24, reloadTime: 2.2, spread: 0.05, pellets: 7, sound: 'shotgun' },
  { id: 'rpg', name: 'RPG', melee: false, auto: false, starter: false, damage: 150, cooldown: 0.9, range: 200, magazine: 1, reserve: 4, reloadTime: 3, spread: 0, pellets: 0, projectile: { speed: 62, radius: 7, damage: 150 }, sound: 'launcher' },
  // Bolt-action: the 1.6s cooldown is the bolt cycle. Range sits inside the 950 camera far plane and light fog.
  { id: 'sniper', name: 'HUNTER .303', melee: false, auto: false, starter: false, damage: 110, cooldown: 1.6, range: 420, magazine: 5, reserve: 15, reloadTime: 2.8, spread: 0, pellets: 1, falloffFloor: 1, sound: 'sniper' },
];
export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((spec) => [spec.id, spec])) as Record<WeaponId, WeaponSpec>;

export const COLORS = {
  sky: 0x7fb2e0,
  fog: 0xc9b98f,
  road: 0x30363b,
  sidewalk: 0xa9aaa0,
  grass: 0x9a8a4e,
  water: 0x6b7d5a,
};
