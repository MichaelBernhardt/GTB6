import { describe, expect, it } from 'vitest';
import { DEFAULT_CHEATS, DEFAULT_INVENTORY, DEFAULT_SAVE, DEFAULT_TIME_OF_DAY, STARTER_SAFEHOUSE, SaveManager, defaultWeapons, sanitizeActivityRecords, sanitizeCheats, sanitizeCompletedMissions, sanitizeEverCheated, sanitizeGarage, sanitizeInventory, sanitizeDiaryPages, sanitizeSafehouses, sanitizeStoryFlags, sanitizeTimeOfDay, sanitizeWeapons, type StorageLike } from './SaveManager';
import { ARMOUR_MAX, LOCKPICK_MAX, PARACHUTE_MAX, STIM_MAX } from './GameRules';
import type { CheatSettings, GameSettings, Inventory, SavedVehicle, SavedWeapons } from '../types';
import { MAP_WORLD_SIZE } from '../world/mapData';

class MemoryStorage implements StorageLike {
  value = new Map<string, string>();
  getItem(key: string): string | null { return this.value.get(key) ?? null; }
  setItem(key: string, value: string): void { this.value.set(key, value); }
  removeItem(key: string): void { this.value.delete(key); }
}

describe('SaveManager', () => {
  it('reports whether persisted progress exists', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage); expect(manager.hasSave()).toBe(false);
    manager.save(DEFAULT_SAVE); expect(manager.hasSave()).toBe(true); manager.reset(); expect(manager.hasSave()).toBe(false);
  });

  it('round trips progress', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, money: 2300, completedMissions: ['delivery-run'] });
    expect(manager.load().money).toBe(2300);
    expect(manager.load().completedMissions).toEqual(['delivery-run']);
  });

  it('round trips the live player position and facing, kept separate from the respawn anchor', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    // An arbitrary in-bounds point well off any road, sized from the world rather than pinned: the old
    // literal (1234, 2, -5678) was inside the 19,200-unit world and outside the 9,806-unit one, so
    // sanitizePosition correctly re-anchored it and the round trip looked broken when it was not.
    const edge = MAP_WORLD_SIZE / 2 - 10;
    const off: [number, number, number] = [Math.round(edge * 0.25), 2, -Math.round(edge * 0.58)];
    manager.save({ ...DEFAULT_SAVE, position: off, heading: 1.25 }); // spawn stays the (valid) default anchor
    const loaded = manager.load();
    expect(loaded.position).toEqual(off); // full x/y/z resume, even off-road
    expect(loaded.heading).toBeCloseTo(1.25); // facing is restored too
    expect(loaded.spawn).toEqual(DEFAULT_SAVE.spawn); // death still sends you to the safehouse anchor, independent of position
  });

  it('defaults an old save with no position/heading to sane values', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 2, money: 900, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings }));
    const loaded = manager.load();
    expect(loaded.position).toEqual(loaded.spawn); // no live position stored yet → resume at the anchor, not a wrong spot
    expect(loaded.heading).toBe(Math.PI); // missing heading → default facing
  });

  it('keeps the manual checkpoint in its own slot, untouched by ordinary saves', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    expect(manager.hasCheckpoint()).toBe(false);
    expect(manager.loadCheckpoint()).toBeNull();
    manager.saveCheckpoint({ ...DEFAULT_SAVE, money: 5000, position: [10, 1, 20], heading: 2 });
    manager.save({ ...DEFAULT_SAVE, money: 1, position: [999, 1, 999] }); // an ordinary/autosave write
    expect(manager.hasCheckpoint()).toBe(true);
    const checkpoint = manager.loadCheckpoint()!;
    expect(checkpoint.money).toBe(5000); // checkpoint is not overwritten by the ordinary save
    expect(checkpoint.position).toEqual([10, 1, 20]);
    expect(manager.load().money).toBe(1); // the main slot moved on independently
    manager.clearCheckpoint();
    expect(manager.hasCheckpoint()).toBe(false);
  });

  it('reset() wipes both the save and the checkpoint', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save(DEFAULT_SAVE); manager.saveCheckpoint(DEFAULT_SAVE);
    manager.reset();
    expect(manager.hasSave()).toBe(false);
    expect(manager.hasCheckpoint()).toBe(false);
  });

  it('recovers from malformed storage and resets', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('groot-theft-bakkie-save-v1', 'bad json');
    expect(manager.load()).toEqual(DEFAULT_SAVE);
    expect(manager.reset()).toEqual(DEFAULT_SAVE);
  });

  it('migrates old saves without weapons to the default loadout', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 1, money: 900, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings }));
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

  it('accepts the Ultra and Skorokoro (potato) quality tiers and rejects unknown ones', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, quality: 'ultra' } });
    expect(manager.load().settings.quality).toBe('ultra'); // Ultra is a valid saved tier
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, quality: 'potato' } });
    expect(manager.load().settings.quality).toBe('potato'); // the touch default must survive a reload
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, quality: 'insane' } as unknown as GameSettings });
    expect(manager.load().settings.quality).toBe('high'); // anything unknown falls back to High
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

  it('round trips the minimap zoom and defaults invalid or missing values', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, minimapZoom: 4 } });
    expect(manager.load().settings.minimapZoom).toBe(4);
    manager.save({ ...DEFAULT_SAVE, settings: { ...DEFAULT_SAVE.settings, minimapZoom: 'street' } as unknown as GameSettings });
    expect(manager.load().settings.minimapZoom).toBe(5); // DEFAULT_MINIMAP_ZOOM (Standard) on the 8-step ladder
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 1, money: 100, completedMissions: [], spawn: [-20, 1, 260], settings: { masterVolume: 0.5, quality: 'high', showFps: false, mouseSensitivity: 0.0025 } }));
    expect(manager.load().settings.minimapZoom).toBe(5); // DEFAULT_MINIMAP_ZOOM (Standard) on the 8-step ladder
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

  it('migrates old saves without cheats to everything off', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('san-cordova-save-v1', JSON.stringify({ version: 1, money: 500, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings, weapons: defaultWeapons() }));
    expect(manager.load().cheats).toEqual({ fastRun: false, bigJump: false, invulnerable: false, teflon: false });
  });

  it('starts a fresh game with teflon off, like every other cheat', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, cheats: { ...DEFAULT_CHEATS, teflon: true } });
    expect(manager.load().cheats.teflon).toBe(true);
    expect(manager.reset().cheats.teflon).toBe(false); // "new game" restores DEFAULT_SAVE, which Game assigns over the live cheats
    expect(DEFAULT_SAVE.cheats.teflon).toBe(false);
  });

  it('round trips cheat toggles', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, cheats: { fastRun: true, bigJump: false, invulnerable: true, teflon: true } });
    expect(manager.load().cheats).toEqual({ fastRun: true, bigJump: false, invulnerable: true, teflon: true });
  });

  it('round trips a stored garage vehicle', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, garage: { kind: 'sport', color: 0xd83a40, health: 64 } });
    expect(manager.load().garage).toEqual({ kind: 'sport', color: 0xd83a40, health: 64 });
  });

  it('defaults old saves without a garage to an empty slot', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('san-cordova-save-v1', JSON.stringify({ version: 1, money: 500, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings, weapons: defaultWeapons() }));
    expect(manager.load().garage).toBeNull();
  });

  it('sanitizes garbage garage data', () => {
    expect(sanitizeGarage(undefined)).toBeNull();
    expect(sanitizeGarage('van')).toBeNull();
    expect(sanitizeGarage({ kind: 'tank', color: 0, health: 50 })).toBeNull();
    expect(sanitizeGarage({ kind: 'van' })).toEqual({ kind: 'van', color: 0x58a596, health: 145 });
    expect(sanitizeGarage({ kind: 'compact', color: -5, health: 9999 } as SavedVehicle)).toEqual({ kind: 'compact', color: 0, health: 100 });
    expect(sanitizeGarage({ kind: 'compact', color: Number.NaN, health: 0 } as SavedVehicle)).toEqual({ kind: 'compact', color: 0xe7b23b, health: 1 });
  });

  it('migrates legacy meter-taxi saves to the uniform Quantum fleet without losing valid health', () => {
    expect(sanitizeGarage({ kind: 'cab', color: 0xf2c521, health: 64 })).toEqual({ kind: 'taxi', color: 0xf0f1ea, health: 64 });
    expect(sanitizeGarage({ kind: 'taxi', color: 0x123456, health: 110 })).toEqual({ kind: 'taxi', color: 0xf0f1ea, health: 110 });
  });

  it('round trips the time of day and defaults it on old saves', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, timeOfDay: 19.75 });
    expect(manager.load().timeOfDay).toBeCloseTo(19.75);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 1, money: 500, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings, weapons: defaultWeapons() }));
    expect(manager.load().timeOfDay).toBe(DEFAULT_TIME_OF_DAY);
  });

  it('sanitizes garbage time of day values', () => {
    expect(sanitizeTimeOfDay(undefined)).toBe(DEFAULT_TIME_OF_DAY);
    expect(sanitizeTimeOfDay('noon')).toBe(DEFAULT_TIME_OF_DAY);
    expect(sanitizeTimeOfDay(Number.NaN)).toBe(DEFAULT_TIME_OF_DAY);
    expect(sanitizeTimeOfDay(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TIME_OF_DAY);
    expect(sanitizeTimeOfDay(-3)).toBeCloseTo(21);
    expect(sanitizeTimeOfDay(25.5)).toBeCloseTo(1.5);
    expect(sanitizeTimeOfDay(24)).toBe(0);
    expect(sanitizeTimeOfDay(13.2)).toBeCloseTo(13.2);
  });

  it('sanitizes invalid cheat data to strict booleans', () => {
    expect(sanitizeCheats(undefined)).toEqual(DEFAULT_CHEATS);
    expect(sanitizeCheats('yes' as unknown as CheatSettings)).toEqual(DEFAULT_CHEATS);
    expect(sanitizeCheats({ fastRun: 1, bigJump: 'true', invulnerable: true } as unknown as CheatSettings)).toEqual({ fastRun: false, bigJump: false, invulnerable: true, teflon: false });
    expect(sanitizeCheats({ fastRun: true })).toEqual({ fastRun: true, bigJump: false, invulnerable: false, teflon: false });
    expect(sanitizeCheats({ teflon: true })).toEqual({ fastRun: false, bigJump: false, invulnerable: false, teflon: true }); // teflon rides the same cheats slot, so it persists and resets with the rest
    const defaults = sanitizeCheats(undefined); defaults.fastRun = true;
    expect(DEFAULT_CHEATS.fastRun).toBe(false);
  });

  it('round trips owned safehouses and defaults old saves to the starter flat', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, safehouses: [STARTER_SAFEHOUSE] });
    expect(manager.load().safehouses).toEqual([STARTER_SAFEHOUSE]);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 1, money: 500, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings, weapons: defaultWeapons() }));
    expect(manager.load().safehouses).toEqual([STARTER_SAFEHOUSE]);
  });

  it('sanitizes safehouse lists: junk ids drop, the starter is always owned, duplicates collapse', () => {
    expect(sanitizeSafehouses(undefined)).toEqual([STARTER_SAFEHOUSE]);
    expect(sanitizeSafehouses('brixton')).toEqual([STARTER_SAFEHOUSE]);
    expect(sanitizeSafehouses(['penthouse', 7, null])).toEqual([STARTER_SAFEHOUSE]);
    expect(sanitizeSafehouses(['brixton', 'brixton'])).toEqual([STARTER_SAFEHOUSE]);
  });

  it('round trips the item inventory', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, inventory: { armour: 60, stims: 2, parachutes: 1, lockpicks: 1 } });
    expect(manager.load().inventory).toEqual({ armour: 60, stims: 2, parachutes: 1, lockpicks: 1 });
  });

  it('defaults old saves without an inventory to empty pockets', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ version: 1, money: 500, completedMissions: [], spawn: [-20, 1, 260], settings: DEFAULT_SAVE.settings, weapons: defaultWeapons() }));
    expect(manager.load().inventory).toEqual({ armour: 0, stims: 0, parachutes: 0, lockpicks: 0 });
  });

  it('sanitizes garbage inventory data and clamps to the carry caps', () => {
    expect(sanitizeInventory(undefined)).toEqual(DEFAULT_INVENTORY);
    expect(sanitizeInventory('full')).toEqual(DEFAULT_INVENTORY);
    expect(sanitizeInventory({ armour: 999, stims: 999, parachutes: 999, lockpicks: 999 })).toEqual({ armour: ARMOUR_MAX, stims: STIM_MAX, parachutes: PARACHUTE_MAX, lockpicks: LOCKPICK_MAX });
    expect(sanitizeInventory({ armour: -20, stims: 1.6, parachutes: Number.NaN, lockpicks: -3 } as Inventory)).toEqual({ armour: 0, stims: 2, parachutes: 0, lockpicks: 0 });
    expect(sanitizeInventory({ armour: 'lots', stims: 'many' } as unknown as Inventory)).toEqual(DEFAULT_INVENTORY);
    const defaults = sanitizeInventory(undefined); defaults.armour = 40;
    expect(DEFAULT_INVENTORY.armour).toBe(0);
  });

  it('migrates version 1 saves to neutral Living City state without losing progress', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ ...DEFAULT_SAVE, version: 1, money: 4321, completedMissions: ['hot-property'], livingCity: undefined }));
    const loaded = manager.load();
    expect(loaded.version).toBe(3); expect(loaded.money).toBe(4321); expect(loaded.completedMissions).toEqual(['hot-property']);
    expect(loaded.livingCity.districts['Joburg CBD']).toEqual({ communityStanding: 0, policePressure: 0 });
  });

  it('round trips and sanitizes Living City state', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const save = structuredClone(DEFAULT_SAVE); save.livingCity.districts['Joburg CBD'] = { communityStanding: 55, policePressure: 30 }; save.livingCity.joziArmsResolution = 'protected';
    manager.save(save); expect(manager.load().livingCity).toEqual(save.livingCity);
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({ ...save, livingCity: { districts: { 'Joburg CBD': { communityStanding: -999, policePressure: 'high' } }, joziArmsResolution: 'invalid' } }));
    expect(manager.load().livingCity.districts['Joburg CBD']).toEqual({ communityStanding: -100, policePressure: 0 });
    expect(manager.load().livingCity.joziArmsResolution).toBeNull();
  });
});

describe('save v3: story flags and diary pages', () => {
  it('round trips story flags and diary pages', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, storyFlags: ['act1', 'choice:two-fires:sindi'], diaryPages: [3, 7] });
    const loaded = manager.load();
    expect(loaded.version).toBe(3);
    expect(loaded.storyFlags).toEqual(['act1', 'choice:two-fires:sindi']);
    expect(loaded.diaryPages).toEqual([3, 7]);
  });

  it('migrates v2 saves: no flags, no pages, everything else intact', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const v2 = JSON.parse(JSON.stringify({ ...DEFAULT_SAVE, money: 4200, completedMissions: ['arms-deal'] })) as Record<string, unknown>;
    v2.version = 2; delete v2.storyFlags; delete v2.diaryPages;
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify(v2));
    const loaded = manager.load();
    expect(loaded.version).toBe(3);
    expect(loaded.money).toBe(4200);
    expect(loaded.completedMissions).toEqual(['arms-deal']);
    expect(loaded.storyFlags).toEqual([]);
    expect(loaded.diaryPages).toEqual([]);
  });

  it('sanitizes junk flags and pages', () => {
    expect(sanitizeStoryFlags(['act1', 'act1', 'UPPER', 'ok-flag:x', 42, '', 'a'.repeat(65)])).toEqual(['act1', 'ok-flag:x']);
    expect(sanitizeStoryFlags('not-an-array')).toEqual([]);
    expect(sanitizeDiaryPages([1, 1, 12, 13, 0, 2.5, 'x'])).toEqual([1, 12]);
    expect(sanitizeDiaryPages(undefined)).toEqual([]);
  });
});

describe('replayable activity records', () => {
  it('round trips Robot Run and Jozi Flow personal bests', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, activityRecords: { robotRunBest: 187.45, joziFlowBest: 935 } });
    expect(manager.load().activityRecords).toEqual({ robotRunBest: 187.45, joziFlowBest: 935 });
  });

  it('gives old saves empty records and independently rejects corrupt records', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const old = JSON.parse(JSON.stringify(DEFAULT_SAVE)) as Record<string, unknown>;
    delete old.activityRecords;
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify(old));
    expect(manager.load().activityRecords).toEqual({});
    expect(sanitizeActivityRecords({ robotRunBest: -1 })).toEqual({});
    expect(sanitizeActivityRecords({ robotRunBest: Number.POSITIVE_INFINITY })).toEqual({});
    expect(sanitizeActivityRecords({ robotRunBest: 86_401 })).toEqual({});
    expect(sanitizeActivityRecords({ robotRunBest: 180, joziFlowBest: -50 })).toEqual({ robotRunBest: 180 });
    expect(sanitizeActivityRecords({ robotRunBest: -1, joziFlowBest: 1250.6 })).toEqual({ joziFlowBest: 1251 });
    expect(sanitizeActivityRecords({ joziFlowBest: 10_000_001 })).toEqual({});
  });
});

describe('the sticky ever-cheated flag', () => {
  it('only a literal stored true counts — junk never becomes an accusation', () => {
    expect(sanitizeEverCheated(true)).toBe(true);
    expect(sanitizeEverCheated(false)).toBe(false);
    expect(sanitizeEverCheated(undefined)).toBe(false);
    expect(sanitizeEverCheated('true')).toBe(false);
    expect(sanitizeEverCheated(1)).toBe(false);
    expect(sanitizeEverCheated({})).toBe(false);
  });

  it('round trips through save and load', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    manager.save({ ...DEFAULT_SAVE, everCheated: true });
    expect(manager.load().everCheated).toBe(true);
    manager.save({ ...DEFAULT_SAVE, everCheated: false });
    expect(manager.load().everCheated).toBe(false);
  });

  it('defaults to an honest false on saves from builds that predate the flag', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const old = JSON.parse(JSON.stringify(DEFAULT_SAVE)) as Record<string, unknown>;
    delete old.everCheated;
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify(old));
    expect(manager.load().everCheated).toBe(false);
  });

  it('starts every new game clean', () => {
    expect(DEFAULT_SAVE.everCheated).toBe(false);
  });
});

describe('moved waypoints cannot wedge a mid-campaign save (round 4 moved half the anchors)', () => {
  // The contract (see sanitizeCompletedMissions): the save persists WHICH missions are done and
  // WHERE the player is — never the active mission, objective index, or a waypoint coordinate.
  // Targets are recomputed from placements at boot, so an old save re-aims on load by construction.
  it('pins the save schema: no mission-runtime or waypoint state may creep in', () => {
    expect(Object.keys(DEFAULT_SAVE).sort()).toEqual([
      'activityRecords', 'cheats', 'completedMissions', 'diaryPages', 'everCheated', 'features',
      'garage', 'heading', 'inventory', 'livingCity', 'money', 'position', 'safehouses', 'settings',
      'spawn', 'storyFlags', 'timeOfDay', 'version', 'weapons',
    ]); // adding activeMission/objectiveIndex/waypoint here means re-answering how moved anchors load
  });

  it('keeps orphaned mission ids and drops junk from completedMissions', () => {
    expect(sanitizeCompletedMissions(['delivery-run', 'ghost-of-the-reverted-arc', 'delivery-run', 42, null, 'NOT VALID', {}]))
      .toEqual(['delivery-run', 'ghost-of-the-reverted-arc']); // orphans stay inert-but-remembered; junk drops
    expect(sanitizeCompletedMissions('delivery-run')).toEqual([]);
    expect(sanitizeCompletedMissions(undefined)).toEqual([]);
  });

  it('loads a mid-campaign save written against the old map: progress intact, positions re-anchored', () => {
    const storage = new MemoryStorage(); const manager = new SaveManager(storage);
    const half = MAP_WORLD_SIZE / 2;
    storage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({
      ...DEFAULT_SAVE,
      completedMissions: ['delivery-run', 'hot-property', 'dockside-signal'],
      storyFlags: ['act1', 'choice:arms-deal:protect'],
      diaryPages: [1, 2],
      spawn: [half + 200, 2, 0], // a pre-crop coordinate, now out of bounds
      position: [-(half + 90), 2, half + 400], // saved mid-drive toward an anchor that has since moved
    }));
    const loaded = manager.load();
    expect(loaded.completedMissions).toEqual(['delivery-run', 'hot-property', 'dockside-signal']);
    expect(loaded.storyFlags).toEqual(['act1', 'choice:arms-deal:protect']);
    expect(loaded.diaryPages).toEqual([1, 2]);
    expect(loaded.spawn).toEqual(DEFAULT_SAVE.spawn); // out-of-world spawn → the starter anchor
    expect(loaded.position).toEqual(loaded.spawn); // out-of-world resume point follows the spawn
  });
});
