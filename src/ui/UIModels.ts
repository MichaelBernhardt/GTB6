import type { WeaponId } from '../config';
import type { DrinkId } from '../core/DrinkRules';
import type { CheatSettings, GameSettings } from '../types';

export type NotificationTone = 'success' | 'danger' | 'reputation' | 'info' | 'radio' | 'music';
export type MenuScreen = 'none' | 'loading' | 'main' | 'pause' | 'controls' | 'cheats' | 'shop' | 'bottle' | 'choice' | 'safehouse';

export interface TaxiTelemetry { text: string; available: boolean; }
export interface CourierTelemetry { text: string; available: boolean; }
export interface VehicleTelemetry { name: string; speedKph: number; health: number; taxi?: TaxiTelemetry; courier?: CourierTelemetry; radio?: string; }
export interface ObjectiveView { missionName: string; text: string; progress?: number; required?: number; remainingSeconds?: number; }

export interface HudState {
  health: number;
  armour: number;
  stims: number;
  parachutes: number;
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
  crosshair: boolean;
  scope?: { zoom: string };
  vehicle?: VehicleTelemetry;
  objective?: ObjectiveView;
  fps: number;
  navCalls: number; // A* solves per second (both planners), shown beside FPS when the perf display is on
  navMs: number; // wall-time per second spent in A* (ms)
  position: { x: number; y: number; z: number }; // player world position, shown on the perf line
  settings: GameSettings;
  cheatsOn: boolean;
  inebriation: number; // 0..100 skinful; the HUD shows a dop badge once it climbs off zero
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
export interface ShopArmourEntry { price: number; full: boolean; canBuy: boolean; }
export interface DrinkCatalogEntry { id: DrinkId; name: string; note: string; price: number; potency: number; canBuy: boolean; }

export interface PauseModel { settings: GameSettings; }
export interface CheatsModel { weapons: CheatWeaponEntry[]; cheats: CheatSettings; }

export function clampPercent(value: number): number { return Math.min(100, Math.max(0, Math.round(value))); }
export function objectiveProgress(objective?: ObjectiveView): number | undefined {
  if (!objective?.required || objective.progress === undefined) return undefined;
  return clampPercent(objective.progress / objective.required * 100);
}
export function reputationLabel(value: string): string { return value.replace(/(^|[-\s])\w/g, (letter) => letter.toUpperCase()); }
export function formatMoney(value: number): string { return `R${Math.max(0, Math.round(value)).toLocaleString()}`; }
