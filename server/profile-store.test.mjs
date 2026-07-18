import { describe, expect, it, vi } from 'vitest';
import { MemoryProfileStore, PostgresProfileStore } from './profile-store.mjs';

describe('multiplayer profile stores', () => {
  it('defaults runs for new and older memory profiles', async () => {
    const store = new MemoryProfileStore(); const loaded = await store.load(undefined, 'Fresh');
    expect(loaded.profile).toEqual({ name: 'Fresh', kills: 0, deaths: 0, runs: 0 });
    await store.save(loaded.token, { name: 'Fresh', kills: 2, deaths: 4 });
    expect((await store.load(loaded.token, 'Back')).profile).toMatchObject({ name: 'Back', kills: 2, deaths: 4, runs: 0 });
  });

  it('applies the additive Postgres migration and reads/writes runs', async () => {
    const query = vi.fn(async (sql) => {
      if (String(sql).startsWith('SELECT')) return { rowCount: 1, rows: [{ display_name: 'Old', kills: 5, deaths: 6, runs: 2 }] };
      return { rowCount: 1, rows: [] };
    });
    const store = new PostgresProfileStore('postgres://localhost/test'); store.pool = { query, end: vi.fn() };
    await store.init();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('ADD COLUMN IF NOT EXISTS runs'))).toBe(true);
    const loaded = await store.load('returning-token', 'Renamed'); expect(loaded.profile).toEqual({ name: 'Renamed', kills: 5, deaths: 6, runs: 2 });
    await store.save('returning-token', loaded.profile);
    const saveCall = query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE multiplayer_profiles SET display_name') && String(sql).includes('runs = $5'));
    expect(saveCall[1]).toHaveLength(5); expect(saveCall[1][4]).toBe(2);
  });
});
