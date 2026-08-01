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
/** `teflon`: the police never take an interest — wanted heat can never rise while it is set. */
export interface CheatSettings { fastRun: boolean; bigJump: boolean; invulnerable: boolean; teflon: boolean; }
/** Carried kit beside the weapon loadout: an armour pool plus consumable stims and parachutes.
 *  Lock picks are TOOLS, not consumables — they open locked doors (interiors) and never wear out. */
export interface Inventory { armour: number; stims: number; parachutes: number; lockpicks: number; }
export interface SavedVehicle { kind: VehicleKind; color: number; health: number; }
/** Best results from replayable open-world activities. Optional fields keep future activities additive. */
export interface ActivityRecords {
  /** Fastest Robot Run lap, in seconds. */
  robotRunBest?: number;
  /** Largest clean Jozi Flow pot banked, in rand. */
  joziFlowBest?: number;
}
export interface SavedGame {
  version: 3;
  money: number;
  completedMissions: string[];
  storyFlags: string[]; // StoryDirector flags: act gates, choice:<mission>:<option>, taught hints
  diaryPages: number[]; // collected Grid Diary pages (1..12)
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
  /** One slot for every lazily loaded feature (src/features/): each stores its slice under its own
   *  save key. Adding a feature never touches this file again — see src/features/README.md. */
  features: Record<string, unknown>;
  activityRecords: ActivityRecords;
  /** STICKY, MONOTONIC: true the moment ANY cheat is ever used in this save — a cheat-classified
   *  console command (see Console.commandIsCheat) or a Testing-tools grant/toggle — and never unset
   *  again for the life of the save. Reloading an earlier checkpoint does not lower it; only a new
   *  game starts clean. This is what tells a truly organic save apart from one that was ever helped. */
  everCheated: boolean;
}
/** Tiers the world subsystems understand. `ultra` is a render-only super-tier (High visuals + extra AA);
 *  it maps down to `high` for everything except the renderer's pixel ratio and post-processing.
 *  `potato` (the settings menu calls it Skorokoro) is the mirror image below `low`: low visuals plus
 *  a sub-native render scale, shorter streaming rings, denser fog and thinner crowds. */
export type BaseQuality = 'low' | 'medium' | 'high';
export type Quality = 'potato' | BaseQuality | 'ultra';

export interface GameSettings {
  masterVolume: number;
  quality: Quality;
  showFps: boolean;
  showPerfChart: boolean; // scrolling stacked-area graph of the per-frame loop cost; toggled by the `perfchart` console command
  mouseSensitivity: number;
  touchSwapSides: boolean; // mirror the touch clusters: stick right, buttons left (touch mode only)
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
  // Story-mission context (all optional: absent means "not applicable this frame").
  hour?: number;
  blackout?: number; // eased 0..1 grid-down factor (DayNight); 1 = full load-shedding dark
  isNight?: boolean;
  onTrain?: boolean;
  drivingTrain?: boolean;
  trainSpeed?: number;
  stationName?: string; // station the ridden train is currently dwelling at, if any
  inPlane?: boolean;
  altitude?: number; // metres above ground while airborne/flying
  parachuted?: boolean; // canopy deployed during the current airborne state
  playerSpeed?: number;
  vehicleHealthPct?: number; // 0..1 health of the current/required mission vehicle
  torchOn?: boolean;
  district?: string;
  detected?: boolean; // mission-owned detection verdict (e.g. depot security)
  escortAlive?: boolean; // false the frame a protected NPC/vehicle dies
  followDistance?: number; // distance to the current follow quarry
  followArrived?: boolean; // quarry reached its scripted destination
}
