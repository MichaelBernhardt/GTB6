import type { Vector3 } from 'three';
import type { WeaponId } from './config';

export type GameMode = 'loading' | 'menu' | 'playing' | 'paused' | 'dead';
export type District = 'Downtown' | 'Las Palmas' | 'Mercado Industrial' | 'Costa Azul' | 'Cordova Commons';
export interface Damageable { health: number; maxHealth: number; takeDamage(amount: number): void; }
export interface WorldTarget { position: Vector3; label: string; color?: string; }
export interface SavedWeaponState { ammo: number; reserve: number; owned: boolean; }
export interface SavedWeapons { current: WeaponId; loadout: Record<WeaponId, SavedWeaponState>; }
export interface SavedGame {
  version: 1;
  money: number;
  completedMissions: string[];
  spawn: [number, number, number];
  settings: GameSettings;
  weapons: SavedWeapons;
}
export interface GameSettings {
  masterVolume: number;
  quality: 'low' | 'high';
  showFps: boolean;
  mouseSensitivity: number;
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
