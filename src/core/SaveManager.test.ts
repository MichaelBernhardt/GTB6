import { describe, expect, it } from 'vitest';
import { DEFAULT_SAVE, SaveManager, type StorageLike } from './SaveManager';

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
});
