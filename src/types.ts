import type { Vector3 } from 'three';
import type { VehicleKind, WeaponId } from './config';
import type { LivingCityState } from './systems/LivingCitySystem';
import type { SafehouseId } from './systems/SafehouseSystem';

export type GameMode = 'loading' | 'menu' | 'playing' | 'paused' | 'dead';
/** District names come from the generated OSM map (place nodes, plus names-overrides renames). */
export type District = string;
export interface Damageable { health: number; maxHealth: number; takeDamage(amount: number): void; }
export interface WorldTarget { position: Vector3; label: string; color?: string; }
export interface SavedWeaponState { ammo: number; reserve: number; owned: boolean; }
export interface SavedWeapons { current: WeaponId; loadout: Record<WeaponId, SavedWeaponState>; }
export interface CheatSettings { fastRun: boolean; bigJump: boolean; invulnerable: boolean; }
export interface SavedVehicle { kind: VehicleKind; color: number; health: number; }
export interface SavedGame {
  version: 2;
  money: number;
  completedMissions: string[];
  spawn: [number, number, number];
  settings: GameSettings;
  weapons: SavedWeapons;
  cheats: CheatSettings;
  garage: SavedVehicle | null;
  livingCity: LivingCityState;
  timeOfDay: number;
  safehouses: SafehouseId[];
}
export interface GameSettings {
  masterVolume: number;
  quality: 'low' | 'medium' | 'high';
  showFps: boolean;
  mouseSensitivity: number;
  cameraViewFoot: number;
  cameraViewVehicle: number;
  minimapZoom: number;
}
export interface GameSnapshot {
  playerPosition: Vector3;
  inVehicle: boolean;
  vehicleKind?: string;
  vehicleColor?: number;
  wantedLevel: number;
  shotsFired: number;
  hostileDefeated: number;
  collectedItem: boolean;
}
