export const WORLD_SIZE = 760;
export const ROAD_WIDTH = 24;
export const BLOCK_SIZE = 76;
export const TRAFFIC_SPEED_FACTOR = 0.42;
export const PLAYER = {
  walkSpeed: 8,
  sprintSpeed: 13,
  jumpSpeed: 10,
  gravity: 27,
  radius: 0.65,
  height: 1.8,
  maxHealth: 100,
};

export type VehicleKind = 'compact' | 'sport' | 'van' | 'police';
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
}

export const VEHICLE_SPECS: Record<VehicleKind, VehicleSpec> = {
  compact: { kind: 'compact', name: 'Cielo Compact', color: 0xe7b23b, maxSpeed: 34, acceleration: 22, brake: 34, steering: 2.2, drag: 0.7, health: 100, size: [1.8, 1.35, 3.7] },
  sport: { kind: 'sport', name: 'Veloce R', color: 0xd83a40, maxSpeed: 48, acceleration: 31, brake: 42, steering: 2.45, drag: 0.55, health: 80, size: [1.9, 1.15, 4.15] },
  van: { kind: 'van', name: 'Porto Utility', color: 0x58a596, maxSpeed: 27, acceleration: 16, brake: 28, steering: 1.75, drag: 0.85, health: 145, size: [2.15, 2.15, 4.9] },
  police: { kind: 'police', name: 'SCPD Interceptor', color: 0x202b38, maxSpeed: 42, acceleration: 28, brake: 40, steering: 2.35, drag: 0.6, health: 130, size: [1.95, 1.4, 4.35] },
};

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rpg';
export interface WeaponTone { freq: number; duration: number; volume: number; type: OscillatorType; }
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
  sound: WeaponTone[];
}

export const WEAPONS: WeaponSpec[] = [
  { id: 'fists', name: 'FISTS', melee: true, auto: false, starter: true, damage: 34, cooldown: 0.42, range: 2.4, magazine: 0, reserve: 0, reloadTime: 0, spread: 0, pellets: 0, sound: [{ freq: 72, duration: 0.1, volume: 0.13, type: 'square' }] },
  { id: 'pistol', name: '9MM', melee: false, auto: false, starter: true, damage: 38, cooldown: 0.19, range: 130, magazine: 12, reserve: 84, reloadTime: 1.05, spread: 0, pellets: 1, sound: [{ freq: 95, duration: 0.12, volume: 0.22, type: 'sawtooth' }, { freq: 42, duration: 0.2, volume: 0.16, type: 'square' }] },
  { id: 'smg', name: 'MICRO SMG', melee: false, auto: true, starter: false, damage: 16, cooldown: 0.09, range: 90, magazine: 30, reserve: 120, reloadTime: 1.6, spread: 0.022, pellets: 1, sound: [{ freq: 135, duration: 0.06, volume: 0.15, type: 'sawtooth' }, { freq: 58, duration: 0.09, volume: 0.09, type: 'square' }] },
  { id: 'shotgun', name: 'PUMP SHOTGUN', melee: false, auto: false, starter: false, damage: 13, cooldown: 0.85, range: 42, magazine: 6, reserve: 24, reloadTime: 2.2, spread: 0.05, pellets: 7, sound: [{ freq: 62, duration: 0.22, volume: 0.26, type: 'sawtooth' }, { freq: 34, duration: 0.3, volume: 0.2, type: 'square' }] },
  { id: 'rpg', name: 'RPG', melee: false, auto: false, starter: false, damage: 150, cooldown: 0.9, range: 200, magazine: 1, reserve: 4, reloadTime: 3, spread: 0, pellets: 0, projectile: { speed: 62, radius: 7, damage: 150 }, sound: [{ freq: 180, duration: 0.26, volume: 0.18, type: 'sawtooth' }, { freq: 88, duration: 0.36, volume: 0.12, type: 'square' }] },
];
export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map((spec) => [spec.id, spec])) as Record<WeaponId, WeaponSpec>;

export const COLORS = {
  sky: 0x9fcbd5,
  fog: 0x9fcbd5,
  road: 0x30363b,
  sidewalk: 0xa9aaa0,
  grass: 0x698b5b,
  water: 0x2e8193,
};
