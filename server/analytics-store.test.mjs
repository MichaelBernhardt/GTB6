import { describe, expect, it, vi } from 'vitest';
import { buildAnalyticsDashboard, MemoryAnalyticsStore, PostgresAnalyticsStore } from './analytics-store.mjs';

const session = (overrides = {}) => ({
  sessionId: 'session-1', visitorHash: 'visitor-1', startedAt: new Date('2026-07-20T10:00:00Z'), lastSeenAt: new Date('2026-07-20T10:30:00Z'),
  mode: 'singleplayer', active: true, visible: true, build: 'abc1234', browser: 'chromium', platform: 'windows', device: 'desktop', viewport: 'large', quality: 'high', country: 'ZA',
  returning: false, fpsSum: 118, fpsCount: 2, modeSeconds: { loading: 10, menu: 20, singleplayer: 1200, multiplayer: 0, paused: 30, hidden: 0 }, ...overrides,
});
const event = (eventId, type, overrides = {}) => ({ eventId, sessionId: 'session-1', type, at: new Date('2026-07-20T10:20:00Z'), payload: {}, build: 'abc1234', browser: 'chromium', platform: 'windows', ...overrides });

describe('analytics aggregation', () => {
  it('calculates live, gameplay, mission, retention, and error groups without identity fields', () => {
    const sessions = [session(), session({ sessionId: 'session-2', visitorHash: 'visitor-1', returning: true, mode: 'multiplayer', country: 'US', modeSeconds: { loading: 1, menu: 2, singleplayer: 0, multiplayer: 600, paused: 0, hidden: 0 } })];
    const events = [
      event('e1', 'mission_start', { payload: { missionId: 'couch-run' } }),
      event('e2', 'mission_complete', { payload: { missionId: 'couch-run', durationSeconds: 300 } }),
      event('e3', 'player_death'), event('e4', 'vehicle_collision'), event('e5', 'aircraft_crash'),
      event('e6', 'technical_error', { fingerprint: 'fingerprint', severity: 'fatal', payload: { errorType: 'TypeError', message: 'broken' } }),
      event('e7', 'technical_error', { sessionId: 'session-2', fingerprint: 'fingerprint', severity: 'recoverable', payload: { errorType: 'TypeError', message: 'broken' } }),
      event('e8', 'multiplayer_join', { payload: { concurrency: 3 } }), event('e9', 'multiplayer_kill'), event('e10', 'hot_bakkie_start'), event('e11', 'hot_bakkie_delivery'),
    ];
    const result = buildAnalyticsDashboard({ sessions, events, range: '24h', now: new Date('2026-07-20T10:30:10Z'), multiplayer: { connected: 2 } });
    expect(result.live).toMatchObject({ playingNow: 2, singleplayer: 1, multiplayer: 1, multiplayerConnected: 2, sessions: 2, uniquePlayers: 1, technicalCrashes: 1, errorFreeSessionRate: 0 });
    expect(result.gameplay.missions[0]).toMatchObject({ missionId: 'couch-run', starts: 1, completions: 1, completionRate: 100, medianCompletionSeconds: 300 });
    expect(result.gameplay).toMatchObject({ deaths: 1, vehicleCrashes: 1, aircraftCrashes: 1 });
    expect(result.gameplay.multiplayer).toMatchObject({ joins: 1, peakConcurrency: 3, kills: 1, deaths: 1 });
    expect(result.technical[0]).toMatchObject({ fingerprint: 'fingerprint', count: 2, affectedSessions: 2, severity: 'fatal' });
    expect(result.geography).toEqual([
      { country: 'US', sessions: 1, uniquePlayers: 1, share: 50 },
      { country: 'ZA', sessions: 1, uniquePlayers: 1, share: 50 },
    ]);
    expect(JSON.stringify(result)).not.toContain('displayName');
  });
});

describe('memory analytics store', () => {
  it('hash-independent storage deduplicates events, tracks mode time/FPS, rolls up, and expires retention windows', async () => {
    const store = new MemoryAnalyticsStore(); const at = new Date('2026-07-20T10:00:00Z');
    await store.startSession({ ...session(), at, sessionId: 's1' });
    await store.heartbeat({ sessionId: 's1', at: new Date('2026-07-20T10:00:30Z'), mode: 'singleplayer', active: true, visible: true, elapsedSeconds: 30, fps: 55 });
    const stored = event('same', 'player_death', { sessionId: 's1', at: new Date('2026-07-20T10:00:31Z') });
    expect(await store.addEvent(stored)).toBe(true); expect(await store.addEvent(stored)).toBe(false);
    expect((await store.getSession('s1')).modeSeconds.singleplayer).toBe(30); expect((await store.getSession('s1')).fpsSum).toBe(55);
    await store.aggregate(new Date('2026-07-21T12:00:00Z')); expect(store.rollups.get('2026-07-20')).toMatchObject({ sessions: 1, uniquePlayers: 1 });
    await store.cleanup(new Date('2027-08-01T00:00:00Z')); expect(store.sessions.size).toBe(0); expect(store.events.size).toBe(0); expect(store.rollups.size).toBe(0);
  });
});

describe('PostgreSQL analytics store', () => {
  it('creates all analytics tables and applies bounded retention queries', async () => {
    const query = vi.fn(async () => ({ rowCount: 0, rows: [] }));
    const store = new PostgresAnalyticsStore('postgres://localhost/test'); store.pool = { query, end: vi.fn() };
    await store.init();
    await store.startSession({
      sessionId: 'session', visitorHash: 'visitor', at: new Date('2026-07-20T10:00:00Z'), mode: 'loading', visible: true,
      build: 'build', browser: 'chromium', platform: 'windows', device: 'desktop', viewport: 'large', quality: 'high', country: 'ZA',
    });
    await store.cleanup(new Date('2026-07-21T00:00:00Z'));
    const sql = query.mock.calls.map(([statement]) => String(statement)).join('\n');
    expect(sql).toContain('analytics_sessions'); expect(sql).toContain('analytics_events'); expect(sql).toContain('analytics_daily_rollups');
    expect(sql).toContain('"returning" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sql).toContain('country, "returning")');
    expect(sql).toContain("country CHAR(2) NOT NULL DEFAULT 'ZZ'");
    expect(sql.match(/DELETE FROM/g)).toHaveLength(3); expect(store.available).toBe(true);
  });
});
