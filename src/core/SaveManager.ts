import type { GameSettings, SavedGame } from '../types';

const KEY = 'san-cordova-save-v1';
export const DEFAULT_SETTINGS: GameSettings = { masterVolume: 0.65, quality: 'high', showFps: false, mouseSensitivity: 0.0025 };
export const DEFAULT_SAVE: SavedGame = { version: 1, money: 750, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SETTINGS };

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
      return {
        ...structuredClone(DEFAULT_SAVE), ...parsed,
        completedMissions: Array.isArray(parsed.completedMissions) ? parsed.completedMissions : [],
        settings,
      };
    } catch { return structuredClone(DEFAULT_SAVE); }
  }
  save(game: SavedGame): void { this.storage.setItem(KEY, JSON.stringify(game)); }
  reset(): SavedGame { this.storage.removeItem(KEY); return structuredClone(DEFAULT_SAVE); }
}
