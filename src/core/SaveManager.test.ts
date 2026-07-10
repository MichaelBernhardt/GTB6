import { describe, expect, it } from 'vitest';
import { DEFAULT_SAVE, SaveManager, defaultWeapons, sanitizeWeapons, type StorageLike } from './SaveManager';
import type { GameSettings, SavedWeapons } from '../types';

class MemoryStorage implements StorageLike {
  value = new Map<string, string>();
  getItem(key: string): string | null { return this.value.get(key) ?? null; }
  setItem(key: string, value: string): void { this.value.set(key, value); }
  removeItem(key: string): void { this.value.delete(key); }
}

describe('SaveManager', () => {
  it('round trips progress', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, money: 2300, completedMissions: ['delivery-run'] });
    expect(manager.load().money).toBe(2300);
    expect(manager.load().completedMissions).toEqual(['delivery-run']);
  });

  it('recovers from malformed storage and resets', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('san-cordova-save-v1', 'bad json');
    expect(manager.load()).toEqual(DEFAULT_SAVE);
    expect(manager.reset()).toEqual(DEFAULT_SAVE);
  });

  it('migrates old saves without weapons to the default loadout', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('san-cordova-save-v1', JSON.stringify({ version: 1, money: 900, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings }));
    const loaded = manager.load();
    expect(loaded.money).toBe(900);
    expect(loaded.weapons).toEqual(defaultWeapons());
  });

  it('round trips the weapon loadout', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const weapons: SavedWeapons = { ...defaultWeapons(), current: 'smg' };
    weapons.loadout.smg = { ammo: 11, reserve: 60, owned: true };
    manager.save({ ...DEFAULT_SAVE, weapons });
    const loaded = manager.load();
    expect(loaded.weapons.current).toBe('smg');
    expect(loaded.weapons.loadout.smg).toEqual({ ammo: 11, reserve: 60, owned: true });
  });

  it('sanitizes invalid weapon data', () => {
    expect(sanitizeWeapons(undefined)).toEqual(defaultWeapons());
    const patched = sanitizeWeapons({ current: 'bazooka', loadout: { pistol: { ammo: -4, reserve: Number.NaN }, shotgun: { ammo: 2.6, reserve: 8 } } } as unknown as SavedWeapons);
    expect(patched.current).toBe('pistol');
    expect(patched.loadout.pistol).toEqual(defaultWeapons().loadout.pistol);
    expect(patched.loadout.shotgun).toEqual({ ammo: 3, reserve: 8, owned: true });
  });

  it('round trips the chosen camera views', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, cameraViewFoot: 0, cameraViewVehicle: 3 } });
    const loaded = manager.load();
    expect(loaded.settings.cameraViewFoot).toBe(0);
    expect(loaded.settings.cameraViewVehicle).toBe(3);
  });

  it('defaults invalid or missing camera views to Medium', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, cameraViewFoot: 9, cameraViewVehicle: 'far' } as unknown as GameSettings });
    const patched = manager.load();
    expect(patched.settings.cameraViewFoot).toBe(2);
    expect(patched.settings.cameraViewVehicle).toBe(2);
    storage.setItem('san-cordova-save-v1', JSON.stringify({ version: 1, money: 100, completedMissions: [], spawn: [-20, 1, 260], settings: { masterVolume: 0.5, quality: 'high', showFps: false, mouseSensitivity: 0.0025 } }));
    const legacy = manager.load();
    expect(legacy.settings.cameraViewFoot).toBe(2);
    expect(legacy.settings.cameraViewVehicle).toBe(2);
  });

  it('treats legacy entries without ownership as owned and fixes an unowned current', () => {
    const legacy = sanitizeWeapons({ current: 'smg', loadout: { smg: { ammo: 30, reserve: 120 } } } as unknown as SavedWeapons);
    expect(legacy.loadout.smg).toEqual({ ammo: 30, reserve: 120, owned: true });
    expect(legacy.current).toBe('smg');
    const broken = sanitizeWeapons({ current: 'shotgun', loadout: { shotgun: { ammo: 2, reserve: 4, owned: false } } } as unknown as SavedWeapons);
    expect(broken.loadout.shotgun.owned).toBe(false);
    expect(broken.current).toBe('pistol');
    expect(defaultWeapons().loadout.smg.owned).toBe(false);
    expect(defaultWeapons().loadout.rpg.owned).toBe(false);
  });
});
