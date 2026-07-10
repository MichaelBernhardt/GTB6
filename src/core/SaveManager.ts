import { WEAPONS, WEAPON_BY_ID, type WeaponId } from '../config';
import { DEFAULT_CAMERA_VIEW, sanitizeView } from './CameraController';
import type { GameSettings, SavedGame, SavedWeaponState, SavedWeapons } from '../types';

const KEY = 'san-cordova-save-v1';
export const DEFAULT_SETTINGS: GameSettings = { masterVolume: 0.65, quality: 'high', showFps: false, mouseSensitivity: 0.0025, cameraViewFoot: DEFAULT_CAMERA_VIEW, cameraViewVehicle: DEFAULT_CAMERA_VIEW };

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

export const DEFAULT_SAVE: SavedGame = { version: 1, money: 750, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SETTINGS, weapons: defaultWeapons() };

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }

export class SaveManager {
  constructor(private storage: StorageLike = localStorage) {}
  load(): SavedGame {
    try {
      const value = this.storage.getItem(KEY);
      if (!value) return structuredClone(DEFAULT_SAVE);
      const parsed = JSON.parse(value) as Partial<SavedGame>;
      if (parsed.version !== 1) return structuredClone(DEFAULT_SAVE);
      const settings = { ...DEFAULT_SETTINGS, ...parsed.settings };
      if (settings.quality !== 'low' && settings.quality !== 'medium' && settings.quality !== 'high') settings.quality = 'high';
      settings.cameraViewFoot = sanitizeView(settings.cameraViewFoot); settings.cameraViewVehicle = sanitizeView(settings.cameraViewVehicle);
      return {
        ...structuredClone(DEFAULT_SAVE), ...parsed,
        completedMissions: Array.isArray(parsed.completedMissions) ? parsed.completedMissions : [],
        settings,
        weapons: sanitizeWeapons(parsed.weapons),
      };
    } catch { return structuredClone(DEFAULT_SAVE); }
  }
  save(game: SavedGame): void { this.storage.setItem(KEY, JSON.stringify(game)); }
  reset(): SavedGame { this.storage.removeItem(KEY); return structuredClone(DEFAULT_SAVE); }
}
