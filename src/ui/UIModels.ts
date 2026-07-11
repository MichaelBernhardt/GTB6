import type { WeaponId } from '../config';
import type { CheatSettings, GameSettings } from '../types';

export type NotificationTone = 'success' | 'danger' | 'reputation' | 'info' | 'radio';
export type MenuScreen = 'none' | 'loading' | 'main' | 'pause' | 'controls' | 'cheats' | 'shop' | 'choice' | 'safehouse';

export interface VehicleTelemetry { name: string; speedKph: number; health: number; }
export interface ObjectiveView { missionName: string; text: string; progress?: number; required?: number; remainingSeconds?: number; }

export interface HudState {
  health: number;
  money: number;
  weaponName: string;
  melee: boolean;
  ammo: number;
  reserve: number;
  reloading: boolean;
  wanted: number;
  district: string;
  clock: string;
  reputation?: string;
  prompt: string;
  vehicle?: VehicleTelemetry;
  objective?: ObjectiveView;
  fps: number;
  settings: GameSettings;
  cheatsOn: boolean;
}

export interface MainMenuSummary {
  hasSave: boolean;
  money: number;
  completedMissions: number;
  totalMissions: number;
  reputation: string;
}

export interface CheatWeaponEntry { id: WeaponId; name: string; owned: boolean; }
export interface WheelEntry { name: string; ammo: string; highlighted: boolean; equipped: boolean; locked: boolean; }
export interface ShopCatalogEntry { id: WeaponId; name: string; owned: boolean; price: number; ammoPrice: number; reserve: number; ammoFull: boolean; canBuy: boolean; canRefill: boolean; }

export interface PauseModel { settings: GameSettings; }
export interface CheatsModel { weapons: CheatWeaponEntry[]; cheats: CheatSettings; }

export function clampPercent(value: number): number { return Math.min(100, Math.max(0, Math.round(value))); }
export function objectiveProgress(objective?: ObjectiveView): number | undefined {
  if (!objective?.required || objective.progress === undefined) return undefined;
  return clampPercent(objective.progress / objective.required * 100);
}
export function reputationLabel(value: string): string { return value.replace(/(^|[-\s])\w/g, (letter) => letter.toUpperCase()); }
export function formatMoney(value: number): string { return `R${Math.max(0, Math.round(value)).toLocaleString()}`; }
