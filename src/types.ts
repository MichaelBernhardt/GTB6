import type { Vector3 } from 'three';
import type { VehicleKind, WeaponId } from './config';
import type { LivingCityState } from './systems/LivingCitySystem';
import type { SafehouseId } from './systems/SafehouseSystem';

export type GameMode = 'loading' | 'menu' | 'playing' | 'paused' | 'dead' | 'busted';
/** District names come from the generated OSM map (place nodes, plus names-overrides renames). */
export type District = string;
export interface Damageable { health: number; maxHealth: number; takeDamage(amount: number): void; }
export interface WorldTarget { position: Vector3; label: string; color?: string; }
export interface SavedWeaponState { ammo: number; reserve: number; owned: boolean; }
export interface SavedWeapons { current: WeaponId; loadout: Record<WeaponId, SavedWeaponState>; }
export interface CheatSettings { fastRun: boolean; bigJump: boolean; invulnerable: boolean; }
/** Carried kit beside the weapon loadout: an armour pool plus consumable stims and parachutes. */
export interface Inventory { armour: number; stims: number; parachutes: number; }
export interface SavedVehicle { kind: VehicleKind; color: number; health: number; }
export interface SavedGame {
  version: 2;
  money: number;
  completedMissions: string[];
  spawn: [number, number, number]; // death/wasted respawn anchor (last safehouse, or the default)
  position: [number, number, number]; // where the player actually was at the last save (x, y, z) — Continue resumes here
  heading: number; // the direction the player was facing at the last save — restored with position
  settings: GameSettings;
  weapons: SavedWeapons;
  cheats: CheatSettings;
  garage: SavedVehicle | null;
  livingCity: LivingCityState;
  timeOfDay: number;
  safehouses: SafehouseId[];
  inventory: Inventory;
}
/** Tiers the world subsystems understand. `ultra` is a render-only super-tier (High visuals + extra AA);
 *  it maps down to `high` for everything except the renderer's pixel ratio and post-processing. */
export type BaseQuality = 'low' | 'medium' | 'high';

export interface GameSettings {
  masterVolume: number;
  quality: BaseQuality | 'ultra';
  showFps: boolean;
  showPerfChart: boolean; // scrolling stacked-area graph of the per-frame loop cost; toggled by the `perfchart` console command
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
