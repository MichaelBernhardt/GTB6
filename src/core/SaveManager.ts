import { VEHICLE_SPECS, WEAPONS, WEAPON_BY_ID, type VehicleKind, type WeaponId } from '../config';
import { DEFAULT_CAMERA_VIEW, sanitizeView } from './CameraController';
import { ARMOUR_MAX, PARACHUTE_MAX, STIM_MAX } from './GameRules';
import { DEFAULT_MINIMAP_ZOOM, sanitizeMinimapZoom } from '../ui/MinimapView';
import type { CheatSettings, GameSettings, Inventory, SavedGame, SavedVehicle, SavedWeaponState, SavedWeapons } from '../types';
import { defaultLivingCityState, sanitizeLivingCityState } from '../systems/LivingCitySystem';
import { SAFEHOUSE_IDS, type SafehouseId } from '../systems/SafehouseSystem';
import { PLAYER_SPAWN } from '../world/placements';
import { distanceToRoadEdge, MAP_WORLD_SIZE, ROAD_EDGE_CAP } from '../world/mapData';

const KEY = 'groot-theft-bakkie-save-v1';
const CHECKPOINT_KEY = 'groot-theft-bakkie-checkpoint-v1';
export const DEFAULT_SETTINGS: GameSettings = { masterVolume: 0.65, quality: 'high', showFps: false, showPerfChart: false, mouseSensitivity: 0.0025, cameraViewFoot: DEFAULT_CAMERA_VIEW, cameraViewVehicle: DEFAULT_CAMERA_VIEW, minimapZoom: DEFAULT_MINIMAP_ZOOM };
export const DEFAULT_CHEATS: CheatSettings = { fastRun: false, bigJump: false, invulnerable: false };

export function sanitizeCheats(raw?: Partial<CheatSettings>): CheatSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CHEATS };
  return { fastRun: raw.fastRun === true, bigJump: raw.bigJump === true, invulnerable: raw.invulnerable === true };
}

export function defaultWeapons(): SavedWeapons {
  const loadout = Object.fromEntries(WEAPONS.map((spec) => [spec.id, { ammo: spec.starter ? spec.magazine : 0, reserve: spec.starter ? spec.reserve : 0, owned: spec.starter }])) as Record<WeaponId, SavedWeaponState>;
  return { current: 'pistol', loadout };
}

export function sanitizeWeapons(raw?: Partial<SavedWeapons>): SavedWeapons {
  const base = defaultWeapons();
  if (!raw || typeof raw !== 'object') return base;
  if (typeof raw.current === 'string' && raw.current in WEAPON_BY_ID) base.current = raw.current;
  for (const spec of WEAPONS) {
    const entry = raw.loadout?.[spec.id];
    if (entry && Number.isFinite(entry.ammo) && Number.isFinite(entry.reserve)) base.loadout[spec.id] = { ammo: Math.max(0, Math.round(entry.ammo)), reserve: Math.max(0, Math.round(entry.reserve)), owned: entry.owned !== false };
  }
  base.loadout.fists.owned = true;
  if (!base.loadout[base.current].owned) base.current = base.loadout.pistol.owned ? 'pistol' : 'fists';
  return base;
}

export const DEFAULT_TIME_OF_DAY = 10;

/** Hour-of-day float: any finite number wraps into [0, 24); everything else falls back to mid-morning. */
export function sanitizeTimeOfDay(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? ((raw % 24) + 24) % 24 : DEFAULT_TIME_OF_DAY;
}

export function sanitizeGarage(raw: unknown): SavedVehicle | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as { kind?: unknown; color?: unknown; health?: unknown };
  const migratedKind = value.kind === 'cab' ? 'taxi' : value.kind;
  if (typeof migratedKind !== 'string' || !(migratedKind in VEHICLE_SPECS)) return null;
  const spec = VEHICLE_SPECS[migratedKind as VehicleKind];
  const color = spec.kind === 'taxi' ? spec.color : typeof value.color === 'number' && Number.isFinite(value.color) ? Math.min(0xffffff, Math.max(0, Math.round(value.color))) : spec.color;
  const health = typeof value.health === 'number' && Number.isFinite(value.health) ? Math.min(spec.health, Math.max(1, Math.round(value.health))) : spec.health;
  return { kind: spec.kind, color, health };
}

/** Saved spawns from older map layouts get re-anchored: a valid spawn is in bounds and near a road. */
export function sanitizeSpawn(raw: unknown): [number, number, number] {
  if (Array.isArray(raw) && raw.length === 3 && raw.every((value) => Number.isFinite(value))) {
    const [x, y, z] = raw as [number, number, number];
    const inBounds = Math.abs(x) < MAP_WORLD_SIZE / 2 - 10 && Math.abs(z) < MAP_WORLD_SIZE / 2 - 10;
    if (inBounds && distanceToRoadEdge(x, z) < ROAD_EDGE_CAP) return [x, y, z];
  }
  return [...PLAYER_SPAWN];
}

/** Resume position: any in-bounds point is valid (unlike a spawn, it needn't be near a road — you can save
 *  mid-field or on a roof). Missing/invalid (old saves) falls back to the respawn anchor. */
export function sanitizePosition(raw: unknown, fallback: [number, number, number]): [number, number, number] {
  if (Array.isArray(raw) && raw.length === 3 && raw.every((value) => Number.isFinite(value))) {
    const [x, y, z] = raw as [number, number, number];
    if (Math.abs(x) < MAP_WORLD_SIZE / 2 - 10 && Math.abs(z) < MAP_WORLD_SIZE / 2 - 10) return [x, y, z];
  }
  return [...fallback];
}

export const DEFAULT_HEADING = Math.PI; // matches the Player's own starting heading

/** Facing angle: any finite number wraps into [0, 2π); everything else falls back to the default heading. */
export function sanitizeHeading(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) : DEFAULT_HEADING;
}

export const DEFAULT_INVENTORY: Inventory = { armour: 0, stims: 0, parachutes: 0 };

/** Item inventory: old saves carry none (everything zeroes); live values clamp to the carry caps. */
export function sanitizeInventory(raw: unknown): Inventory {
  const clampItem = (value: unknown, max: number): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.round(value))) : 0;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_INVENTORY };
  const value = raw as Partial<Inventory>;
  return { armour: clampItem(value.armour, ARMOUR_MAX), stims: clampItem(value.stims, STIM_MAX), parachutes: clampItem(value.parachutes, PARACHUTE_MAX) };
}

export const STARTER_SAFEHOUSE: SafehouseId = 'brixton';

/** Owned safehouses: keeps only known ids, deduped, and the starter flat is always owned. */
export function sanitizeSafehouses(raw: unknown): SafehouseId[] {
  const valid = Array.isArray(raw) ? raw.filter((id): id is SafehouseId => (SAFEHOUSE_IDS as readonly string[]).includes(id as string)) : [];
  return [...new Set<SafehouseId>([STARTER_SAFEHOUSE, ...valid])];
}

export const DEFAULT_SAVE: SavedGame = { version: 2, money: 750, completedMissions: [], spawn: [...PLAYER_SPAWN], position: [...PLAYER_SPAWN], heading: DEFAULT_HEADING, settings: DEFAULT_SETTINGS, weapons: defaultWeapons(), cheats: DEFAULT_CHEATS, garage: null, livingCity: defaultLivingCityState(), timeOfDay: DEFAULT_TIME_OF_DAY, safehouses: [STARTER_SAFEHOUSE], inventory: DEFAULT_INVENTORY };

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }

/** Parse + sanitize a stored save string into a full SavedGame; malformed/absent/old data → defaults. */
function deserialize(value: string | null): SavedGame {
  try {
    if (!value) return structuredClone(DEFAULT_SAVE);
    const parsed = JSON.parse(value) as Partial<Omit<SavedGame, 'version'>> & { version?: number };
    if (parsed.version !== 1 && parsed.version !== 2) return structuredClone(DEFAULT_SAVE);
    const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
    if (settings.quality !== 'low' && settings.quality !== 'medium' && settings.quality !== 'high' && settings.quality !== 'ultra') settings.quality = 'high';
    settings.cameraViewFoot = sanitizeView(settings.cameraViewFoot); settings.cameraViewVehicle = sanitizeView(settings.cameraViewVehicle);
    settings.minimapZoom = sanitizeMinimapZoom(settings.minimapZoom);
    const spawn = sanitizeSpawn(parsed.spawn);
    return {
      ...structuredClone(DEFAULT_SAVE), ...parsed, version: 2,
      completedMissions: Array.isArray(parsed.completedMissions) ? parsed.completedMissions : [],
      spawn,
      position: sanitizePosition(parsed.position, spawn), // old saves (no position) resume at the respawn anchor
      heading: sanitizeHeading(parsed.heading),
      settings,
      weapons: sanitizeWeapons(parsed.weapons),
      cheats: sanitizeCheats(parsed.cheats),
      garage: sanitizeGarage(parsed.garage),
      livingCity: sanitizeLivingCityState(parsed.livingCity),
      timeOfDay: sanitizeTimeOfDay(parsed.timeOfDay),
      safehouses: sanitizeSafehouses(parsed.safehouses),
      inventory: sanitizeInventory(parsed.inventory),
    };
  } catch { return structuredClone(DEFAULT_SAVE); }
}

export class SaveManager {
  constructor(private storage: StorageLike = localStorage) {}
  hasSave(): boolean { return this.storage.getItem(KEY) !== null; }
  load(): SavedGame { return deserialize(this.storage.getItem(KEY)); }
  save(game: SavedGame): void { this.storage.setItem(KEY, JSON.stringify(game)); }
  reset(): SavedGame { this.storage.removeItem(KEY); this.storage.removeItem(CHECKPOINT_KEY); return structuredClone(DEFAULT_SAVE); }

  /** Manual checkpoint (`save`/`reload`): a full snapshot the autosave never touches, so `reload` always
   *  returns to the exact state the player last chose to stamp. */
  hasCheckpoint(): boolean { return this.storage.getItem(CHECKPOINT_KEY) !== null; }
  saveCheckpoint(game: SavedGame): void { this.storage.setItem(CHECKPOINT_KEY, JSON.stringify(game)); }
  loadCheckpoint(): SavedGame | null { const value = this.storage.getItem(CHECKPOINT_KEY); return value === null ? null : deserialize(value); }
  clearCheckpoint(): void { this.storage.removeItem(CHECKPOINT_KEY); }
}
