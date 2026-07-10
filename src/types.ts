import type { Vector3 } from 'three';

export type GameMode = 'loading' | 'menu' | 'playing' | 'paused' | 'dead';
export type District = 'Joburg CBD' | 'Sandton' | 'City Deep' | 'Braamfontein' | 'Zoo Lake';
export interface Damageable { health: number; maxHealth: number; takeDamage(amount: number): void; }
export interface WorldTarget { position: Vector3; label: string; color?: string; }
export interface SavedGame {
  version: 1;
  money: number;
  completedMissions: string[];
  spawn: [number, number, number];
  settings: GameSettings;
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
