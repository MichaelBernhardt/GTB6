import { VEHICLE_SPECS, WEAPONS, WEAPON_BY_ID, type VehicleKind, type WeaponId } from '../config';
import { DEFAULT_CAMERA_VIEW, sanitizeView } from './CameraController';
import type { CheatSettings, GameSettings, SavedGame, SavedVehicle, SavedWeaponState, SavedWeapons } from '../types';
import { defaultLivingCityState, sanitizeLivingCityState } from '../systems/LivingCitySystem';

const KEY = 'groot-theft-bakkie-save-v1';
export const DEFAULT_SETTINGS: GameSettings = { masterVolume: 0.65, quality: 'high', showFps: false, mouseSensitivity: 0.0025, cameraViewFoot: DEFAULT_CAMERA_VIEW, cameraViewVehicle: DEFAULT_CAMERA_VIEW };
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

export function sanitizeGarage(raw: unknown): SavedVehicle | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<SavedVehicle>;
  if (typeof value.kind !== 'string' || !(value.kind in VEHICLE_SPECS)) return null;
  const spec = VEHICLE_SPECS[value.kind as VehicleKind];
  const color = Number.isFinite(value.color) ? Math.min(0xffffff, Math.max(0, Math.round(value.color as number))) : spec.color;
  const health = Number.isFinite(value.health) ? Math.min(spec.health, Math.max(1, Math.round(value.health as number))) : spec.health;
  return { kind: spec.kind, color, health };
}

export const DEFAULT_SAVE: SavedGame = { version: 2, money: 750, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SETTINGS, weapons: defaultWeapons(), cheats: DEFAULT_CHEATS, garage: null, livingCity: defaultLivingCityState() };

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }

export class SaveManager {
  constructor(private storage: StorageLike = localStorage) {}
  hasSave(): boolean { return this.storage.getItem(KEY) !== null; }
  load(): SavedGame {
    try {
      const value = this.storage.getItem(KEY);
      if (!value) return structuredClone(DEFAULT_SAVE);
      const parsed = JSON.parse(value) as Partial<Omit<SavedGame, 'version'>> & { version?: number };
      if (parsed.version !== 1 && parsed.version !== 2) return structuredClone(DEFAULT_SAVE);
      const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
      if (settings.quality !== 'low' && settings.quality !== 'medium' && settings.quality !== 'high') settings.quality = 'high';
      settings.cameraViewFoot = sanitizeView(settings.cameraViewFoot); settings.cameraViewVehicle = sanitizeView(settings.cameraViewVehicle);
      return {
        ...structuredClone(DEFAULT_SAVE), ...parsed, version: 2,
        completedMissions: Array.isArray(parsed.completedMissions) ? parsed.completedMissions : [],
        settings,
        weapons: sanitizeWeapons(parsed.weapons),
        cheats: sanitizeCheats(parsed.cheats),
        garage: sanitizeGarage(parsed.garage),
        livingCity: sanitizeLivingCityState(parsed.livingCity),
      };
    } catch { return structuredClone(DEFAULT_SAVE); }
  }
  save(game: SavedGame): void { this.storage.setItem(KEY, JSON.stringify(game)); }
  reset(): SavedGame { this.storage.removeItem(KEY); return structuredClone(DEFAULT_SAVE); }
}
