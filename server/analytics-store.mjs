import pg from 'pg';

const DAY_MS = 86_400_000;
const DETAIL_RETENTION_MS = 90 * DAY_MS;
const ROLLUP_RETENTION_MS = 365 * DAY_MS;

const asDate = (value) => value instanceof Date ? value : new Date(value);
const modeSeconds = () => ({ loading: 0, menu: 0, singleplayer: 0, multiplayer: 0, paused: 0, hidden: 0 });
const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round = (value, places = 1) => {
  const scale = 10 ** places;
  return Math.round((Number(value) || 0) * scale) / scale;
};
const dayKey = (value) => asDate(value).toISOString().slice(0, 10);

function rangeConfig(range) {
  if (range === '7d') return { duration: 7 * DAY_MS, bucket: 2 * 60 * 60 * 1000 };
  if (range === '30d') return { duration: 30 * DAY_MS, bucket: DAY_MS };
  if (range === '90d') return { duration: 90 * DAY_MS, bucket: DAY_MS };
  return { duration: DAY_MS, bucket: 15 * 60 * 1000 };
}

function eventCount(events, type) { return events.filter((event) => event.type === type).length; }

export function buildAnalyticsDashboard({ sessions, events, rollups = [], range = '24h', now = new Date(), multiplayer = {} }) {
  const end = asDate(now); const config = rangeConfig(range); const since = new Date(end.getTime() - config.duration);
  const selectedSessions = sessions.filter((session) => asDate(session.lastSeenAt).getTime() >= since.getTime());
  const selectedEvents = events.filter((event) => asDate(event.at).getTime() >= since.getTime());
  const liveCutoff = end.getTime() - 45_000;
  const liveSessions = sessions.filter((session) => asDate(session.lastSeenAt).getTime() >= liveCutoff && session.active && session.visible);
  const liveSingleplayer = liveSessions.filter((session) => session.mode === 'singleplayer').length;
  const heartbeatMultiplayer = liveSessions.filter((session) => session.mode === 'multiplayer').length;
  const liveMultiplayer = heartbeatMultiplayer;
  const inactiveLive = sessions.filter((session) => asDate(session.lastSeenAt).getTime() >= liveCutoff && (!session.active || !session.visible || session.mode === 'paused' || session.mode === 'menu')).length;
  const visitors = new Set(selectedSessions.map((session) => session.visitorHash));
  const playtimes = selectedSessions.map((session) => (session.modeSeconds.singleplayer ?? 0) + (session.modeSeconds.multiplayer ?? 0));
  const errorSessions = new Set(selectedEvents.filter((event) => event.type === 'technical_error').map((event) => event.sessionId));
  const fatalEvents = selectedEvents.filter((event) => event.type === 'technical_error' && event.severity === 'fatal');
  const countryMap = new Map();
  for (const session of selectedSessions) {
    const country = /^[A-Z]{2}$/.test(session.country ?? '') ? session.country : 'ZZ';
    const item = countryMap.get(country) ?? { country, sessions: 0, visitors: new Set() };
    item.sessions += 1; item.visitors.add(session.visitorHash); countryMap.set(country, item);
  }
  const geography = [...countryMap.values()].map((item) => ({
    country: item.country, sessions: item.sessions, uniquePlayers: item.visitors.size,
    share: selectedSessions.length ? round(item.sessions / selectedSessions.length * 100) : 0,
  })).sort((a, b) => b.sessions - a.sessions || a.country.localeCompare(b.country));

  const bucketStart = Math.floor(since.getTime() / config.bucket) * config.bucket;
  const points = [];
  for (let time = bucketStart; time <= end.getTime(); time += config.bucket) {
    const bucketEnd = time + config.bucket;
    const active = selectedSessions.filter((session) => asDate(session.startedAt).getTime() < bucketEnd && asDate(session.lastSeenAt).getTime() >= time);
    const started = selectedSessions.filter((session) => { const value = asDate(session.startedAt).getTime(); return value >= time && value < bucketEnd; });
    const bucketEvents = selectedEvents.filter((event) => { const value = asDate(event.at).getTime(); return value >= time && value < bucketEnd; });
    const activeVisitors = new Set(active.map((session) => session.visitorHash));
    const windowVisitors = (windowMs) => new Set(sessions.filter((session) => {
      const value = asDate(session.lastSeenAt).getTime(); return value >= bucketEnd - windowMs && value < bucketEnd;
    }).map((session) => session.visitorHash)).size;
    const fpsSamples = active.flatMap((session) => session.fpsCount ? [session.fpsSum / session.fpsCount] : []);
    const seconds = started.reduce((sum, session) => sum + (session.modeSeconds.singleplayer ?? 0) + (session.modeSeconds.multiplayer ?? 0), 0);
    points.push({
      time: new Date(time).toISOString(),
      concurrency: active.length,
      singleplayer: active.filter((session) => session.mode === 'singleplayer').length,
      multiplayer: active.filter((session) => session.mode === 'multiplayer').length,
      dau: activeVisitors.size,
      wau: windowVisitors(7 * DAY_MS),
      mau: windowVisitors(30 * DAY_MS),
      sessions: started.length,
      playtimeMinutes: round(seconds / 60),
      returningRate: started.length ? round(started.filter((session) => session.returning).length / started.length * 100) : 0,
      crashes: bucketEvents.filter((event) => event.type === 'technical_error' && event.severity === 'fatal').length,
      fps: fpsSamples.length ? round(fpsSamples.reduce((sum, value) => sum + value, 0) / fpsSamples.length) : 0,
    });
  }

  const missionMap = new Map();
  for (const event of selectedEvents.filter((item) => item.type.startsWith('mission_'))) {
    const id = event.payload.missionId ?? 'unknown'; const item = missionMap.get(id) ?? { missionId: id, starts: 0, completions: 0, failures: 0, completionTimes: [] };
    if (event.type === 'mission_start') item.starts += 1;
    else if (event.type === 'mission_complete') { item.completions += 1; if (event.payload.durationSeconds) item.completionTimes.push(event.payload.durationSeconds); }
    else if (event.type === 'mission_fail') item.failures += 1;
    missionMap.set(id, item);
  }
  const missions = [...missionMap.values()].map((item) => ({
    missionId: item.missionId, starts: item.starts, completions: item.completions, failures: item.failures,
    completionRate: item.starts ? round(item.completions / item.starts * 100) : 0,
    medianCompletionSeconds: round(median(item.completionTimes)),
  })).sort((a, b) => b.starts - a.starts);

  const errors = new Map();
  for (const event of selectedEvents.filter((item) => item.type === 'technical_error')) {
    const key = event.fingerprint ?? 'unknown';
    const item = errors.get(key) ?? { fingerprint: key, message: event.payload.message ?? 'Unknown error', errorType: event.payload.errorType ?? 'Error', severity: event.severity ?? 'recoverable', build: event.build, browser: event.browser, platform: event.platform, count: 0, sessionIds: new Set(), firstSeen: event.at, lastSeen: event.at };
    item.count += 1; item.sessionIds.add(event.sessionId);
    if (asDate(event.at) < asDate(item.firstSeen)) item.firstSeen = event.at;
    if (asDate(event.at) > asDate(item.lastSeen)) item.lastSeen = event.at;
    if (event.severity === 'fatal') item.severity = 'fatal';
    errors.set(key, item);
  }

  const multiplayerJoins = eventCount(selectedEvents, 'multiplayer_join');
  const multiplayerLeaves = eventCount(selectedEvents, 'multiplayer_leave');
  const multiplayerKills = eventCount(selectedEvents, 'multiplayer_kill');
  const hotStarts = eventCount(selectedEvents, 'hot_bakkie_start');
  const hotDeliveries = eventCount(selectedEvents, 'hot_bakkie_delivery');
  const hotTimeouts = eventCount(selectedEvents, 'hot_bakkie_timeout');
  const peakFromEvents = selectedEvents.filter((event) => event.type === 'multiplayer_join').reduce((peak, event) => Math.max(peak, Number(event.payload.concurrency) || 0), 0);
  const peak24h = Math.max(liveSingleplayer + liveMultiplayer, ...points.filter((point) => asDate(point.time).getTime() >= end.getTime() - DAY_MS).map((point) => point.concurrency), 0);
  return {
    generatedAt: end.toISOString(), range,
    live: {
      playingNow: liveSingleplayer + liveMultiplayer, singleplayer: liveSingleplayer, multiplayer: liveMultiplayer,
      multiplayerConnected: Number.isFinite(multiplayer.connected) ? multiplayer.connected : heartbeatMultiplayer,
      multiplayerCapacity: Number.isFinite(multiplayer.capacity) ? multiplayer.capacity : undefined,
      hotBakkiePhase: typeof multiplayer.hotBakkie?.phase === 'string' ? multiplayer.hotBakkie.phase : undefined,
      inactive: inactiveLive, peak24h, sessions: selectedSessions.length, uniquePlayers: visitors.size,
      medianPlaytimeSeconds: round(median(playtimes)), technicalCrashes: fatalEvents.length,
      errorFreeSessionRate: selectedSessions.length ? round((selectedSessions.length - errorSessions.size) / selectedSessions.length * 100) : 100,
    },
    geography,
    series: {
      concurrency: points.map(({ time, concurrency: value, singleplayer, multiplayer: multi }) => ({ time, value, singleplayer, multiplayer: multi })),
      activeUsers: points.map(({ time, dau, wau, mau }) => ({ time, dau, wau, mau })),
      sessions: points.map(({ time, sessions: value }) => ({ time, value })),
      playtime: points.map(({ time, playtimeMinutes: value }) => ({ time, value })),
      returningRate: points.map(({ time, returningRate: value }) => ({ time, value })),
      crashes: points.map(({ time, crashes: value }) => ({ time, value })),
      fps: points.map(({ time, fps: value }) => ({ time, value })),
    },
    gameplay: {
      missions,
      deaths: eventCount(selectedEvents, 'player_death'),
      vehicleCrashes: eventCount(selectedEvents, 'vehicle_collision'),
      aircraftCrashes: eventCount(selectedEvents, 'aircraft_crash'),
      multiplayer: { joins: multiplayerJoins, leaves: multiplayerLeaves, peakConcurrency: Math.max(peakFromEvents, liveMultiplayer), kills: multiplayerKills, deaths: multiplayerKills },
      hotBakkie: { starts: hotStarts, deliveries: hotDeliveries, timeouts: hotTimeouts, deliveryRate: hotStarts ? round(hotDeliveries / hotStarts * 100) : 0 },
    },
    technical: [...errors.values()].map((item) => ({ ...item, affectedSessions: item.sessionIds.size, sessionIds: undefined })).sort((a, b) => b.count - a.count),
    rollups,
  };
}

export class MemoryAnalyticsStore {
  kind = 'memory';
  available = true;
  sessions = new Map();
  events = new Map();
  rollups = new Map();

  async init() {}
  async startSession(input) {
    const existing = this.sessions.get(input.sessionId);
    if (existing) { existing.lastSeenAt = input.at; return existing; }
    const returning = [...this.sessions.values()].some((session) => session.visitorHash === input.visitorHash);
    const session = { ...input, startedAt: input.at, lastSeenAt: input.at, endedAt: undefined, active: false, visible: input.visible, fpsSum: 0, fpsCount: 0, modeSeconds: modeSeconds(), returning };
    this.sessions.set(input.sessionId, session); return session;
  }
  async heartbeat(input) {
    const session = this.sessions.get(input.sessionId); if (!session) return false;
    session.lastSeenAt = input.at; session.mode = input.mode; session.active = input.active; session.visible = input.visible;
    const bucket = input.visible ? input.mode : 'hidden'; session.modeSeconds[bucket] = (session.modeSeconds[bucket] ?? 0) + input.elapsedSeconds;
    if (input.fps !== undefined) { session.fpsSum += input.fps; session.fpsCount += 1; }
    if (input.quality) session.quality = input.quality;
    return true;
  }
  async getSession(sessionId) { return this.sessions.get(sessionId); }
  async addEvent(event) {
    if (this.events.has(event.eventId)) return false;
    this.events.set(event.eventId, event);
    const session = this.sessions.get(event.sessionId); if (session) { session.lastSeenAt = event.at; if (event.type === 'session_end') { session.endedAt = event.at; session.active = false; } }
    return true;
  }
  async read(since) {
    return {
      sessions: [...this.sessions.values()].filter((session) => asDate(session.lastSeenAt) >= since),
      events: [...this.events.values()].filter((event) => asDate(event.at) >= since),
      rollups: [...this.rollups.values()].filter((rollup) => asDate(`${rollup.day}T00:00:00Z`) >= since),
    };
  }
  async aggregate(now = new Date()) {
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY_MS);
    const next = new Date(day.getTime() + DAY_MS);
    const sessions = [...this.sessions.values()].filter((session) => asDate(session.startedAt) >= day && asDate(session.startedAt) < next);
    const events = [...this.events.values()].filter((event) => asDate(event.at) >= day && asDate(event.at) < next);
    const visitors = new Set(sessions.map((session) => session.visitorHash));
    const row = { day: dayKey(day), sessions: sessions.length, uniquePlayers: visitors.size, playtimeSeconds: round(sessions.reduce((sum, session) => sum + session.modeSeconds.singleplayer + session.modeSeconds.multiplayer, 0)), technicalCrashes: events.filter((event) => event.type === 'technical_error' && event.severity === 'fatal').length };
    this.rollups.set(row.day, row); return row;
  }
  async cleanup(now = new Date()) {
    const detailCutoff = now.getTime() - DETAIL_RETENTION_MS; const rollupCutoff = now.getTime() - ROLLUP_RETENTION_MS;
    for (const [id, session] of this.sessions) if (asDate(session.lastSeenAt).getTime() < detailCutoff) this.sessions.delete(id);
    for (const [id, event] of this.events) if (asDate(event.at).getTime() < detailCutoff) this.events.delete(id);
    for (const [day] of this.rollups) if (asDate(`${day}T00:00:00Z`).getTime() < rollupCutoff) this.rollups.delete(day);
  }
  async close() {}
}

function rowToSession(row) {
  return {
    sessionId: row.session_id, visitorHash: row.visitor_hash, startedAt: row.started_at, lastSeenAt: row.last_seen_at, endedAt: row.ended_at,
    mode: row.mode, active: row.active, visible: row.visible, build: row.build_version, browser: row.browser, platform: row.platform,
    device: row.device, viewport: row.viewport, quality: row.quality, country: row.country?.trim() || 'ZZ', returning: row.returning, fpsSum: Number(row.fps_sum), fpsCount: Number(row.fps_count),
    modeSeconds: { loading: Number(row.loading_seconds), menu: Number(row.menu_seconds), singleplayer: Number(row.singleplayer_seconds), multiplayer: Number(row.multiplayer_seconds), paused: Number(row.paused_seconds), hidden: Number(row.hidden_seconds) },
  };
}

export class PostgresAnalyticsStore {
  kind = 'postgres';
  available = false;
  constructor(connectionString) { this.pool = new pg.Pool({ connectionString, ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false } }); }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS analytics_sessions (
      session_id TEXT PRIMARY KEY, visitor_hash CHAR(64) NOT NULL, started_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ, mode VARCHAR(20) NOT NULL, active BOOLEAN NOT NULL DEFAULT FALSE, visible BOOLEAN NOT NULL DEFAULT TRUE,
      build_version VARCHAR(40) NOT NULL, browser VARCHAR(32) NOT NULL, platform VARCHAR(32) NOT NULL, device VARCHAR(16) NOT NULL,
      viewport VARCHAR(16) NOT NULL, quality VARCHAR(16), country CHAR(2) NOT NULL DEFAULT 'ZZ', "returning" BOOLEAN NOT NULL DEFAULT FALSE, fps_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
      fps_count INTEGER NOT NULL DEFAULT 0, loading_seconds DOUBLE PRECISION NOT NULL DEFAULT 0, menu_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      singleplayer_seconds DOUBLE PRECISION NOT NULL DEFAULT 0, multiplayer_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      paused_seconds DOUBLE PRECISION NOT NULL DEFAULT 0, hidden_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS analytics_events (
      event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, event_type VARCHAR(40) NOT NULL, occurred_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb, fingerprint CHAR(64), severity VARCHAR(16), build_version VARCHAR(40) NOT NULL,
      browser VARCHAR(32) NOT NULL, platform VARCHAR(32) NOT NULL
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
      day DATE PRIMARY KEY, sessions INTEGER NOT NULL, unique_players INTEGER NOT NULL, playtime_seconds DOUBLE PRECISION NOT NULL,
      technical_crashes INTEGER NOT NULL, payload JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query("ALTER TABLE analytics_sessions ADD COLUMN IF NOT EXISTS country CHAR(2) NOT NULL DEFAULT 'ZZ'");
    await this.pool.query('CREATE INDEX IF NOT EXISTS analytics_sessions_last_seen_idx ON analytics_sessions (last_seen_at)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS analytics_events_occurred_idx ON analytics_events (occurred_at)');
    this.available = true;
  }
  async startSession(input) {
    await this.pool.query(`INSERT INTO analytics_sessions (session_id, visitor_hash, started_at, last_seen_at, mode, visible, build_version, browser, platform, device, viewport, quality, country, returning)
      VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,EXISTS(SELECT 1 FROM analytics_sessions WHERE visitor_hash=$2))
      ON CONFLICT (session_id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at`,
    [input.sessionId, input.visitorHash, input.at, input.mode, input.visible, input.build, input.browser, input.platform, input.device, input.viewport, input.quality, input.country]);
  }
  async heartbeat(input) {
    const column = input.visible ? `${input.mode}_seconds` : 'hidden_seconds';
    const allowed = new Set(['loading_seconds', 'menu_seconds', 'singleplayer_seconds', 'multiplayer_seconds', 'paused_seconds', 'hidden_seconds']);
    if (!allowed.has(column)) return false;
    const result = await this.pool.query(`UPDATE analytics_sessions SET last_seen_at=$2, mode=$3, active=$4, visible=$5, ${column}=${column}+$6,
      fps_sum=fps_sum+$7, fps_count=fps_count+$8, quality=COALESCE($9, quality) WHERE session_id=$1`,
    [input.sessionId, input.at, input.mode, input.active, input.visible, input.elapsedSeconds, input.fps ?? 0, input.fps === undefined ? 0 : 1, input.quality]);
    return Boolean(result.rowCount);
  }
  async getSession(sessionId) {
    const result = await this.pool.query('SELECT * FROM analytics_sessions WHERE session_id=$1', [sessionId]);
    return result.rowCount ? rowToSession(result.rows[0]) : undefined;
  }
  async addEvent(event) {
    const result = await this.pool.query(`INSERT INTO analytics_events (event_id, session_id, event_type, occurred_at, payload, fingerprint, severity, build_version, browser, platform)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (event_id) DO NOTHING`,
    [event.eventId, event.sessionId, event.type, event.at, event.payload, event.fingerprint, event.severity, event.build, event.browser, event.platform]);
    if (event.type === 'session_end') await this.pool.query('UPDATE analytics_sessions SET ended_at=$2, last_seen_at=$2, active=FALSE WHERE session_id=$1', [event.sessionId, event.at]);
    return Boolean(result.rowCount);
  }
  async read(since) {
    const [sessionResult, eventResult, rollupResult] = await Promise.all([
      this.pool.query('SELECT * FROM analytics_sessions WHERE last_seen_at >= $1 ORDER BY started_at', [since]),
      this.pool.query('SELECT * FROM analytics_events WHERE occurred_at >= $1 ORDER BY occurred_at', [since]),
      this.pool.query('SELECT day, sessions, unique_players, playtime_seconds, technical_crashes, payload FROM analytics_daily_rollups WHERE day >= $1::date ORDER BY day', [since]),
    ]);
    return {
      sessions: sessionResult.rows.map(rowToSession),
      events: eventResult.rows.map((row) => ({ eventId: row.event_id, sessionId: row.session_id, type: row.event_type, at: row.occurred_at, payload: row.payload ?? {}, fingerprint: row.fingerprint?.trim(), severity: row.severity, build: row.build_version, browser: row.browser, platform: row.platform })),
      rollups: rollupResult.rows.map((row) => ({ day: dayKey(row.day), sessions: row.sessions, uniquePlayers: row.unique_players, playtimeSeconds: Number(row.playtime_seconds), technicalCrashes: row.technical_crashes, ...row.payload })),
    };
  }
  async aggregate(now = new Date()) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); const start = new Date(end.getTime() - DAY_MS);
    await this.pool.query(`INSERT INTO analytics_daily_rollups (day, sessions, unique_players, playtime_seconds, technical_crashes)
      SELECT $1::date, COUNT(*), COUNT(DISTINCT visitor_hash), COALESCE(SUM(singleplayer_seconds+multiplayer_seconds),0),
      (SELECT COUNT(*) FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2 AND event_type='technical_error' AND severity='fatal')
      FROM analytics_sessions WHERE started_at >= $1 AND started_at < $2
      ON CONFLICT (day) DO UPDATE SET sessions=EXCLUDED.sessions, unique_players=EXCLUDED.unique_players, playtime_seconds=EXCLUDED.playtime_seconds, technical_crashes=EXCLUDED.technical_crashes, updated_at=NOW()`, [start, end]);
  }
  async cleanup(now = new Date()) {
    await this.pool.query('DELETE FROM analytics_events WHERE occurred_at < $1', [new Date(now.getTime() - DETAIL_RETENTION_MS)]);
    await this.pool.query('DELETE FROM analytics_sessions WHERE last_seen_at < $1', [new Date(now.getTime() - DETAIL_RETENTION_MS)]);
    await this.pool.query('DELETE FROM analytics_daily_rollups WHERE day < $1::date', [new Date(now.getTime() - ROLLUP_RETENTION_MS)]);
  }
  async close() { await this.pool.end(); }
}

export function createAnalyticsStore(env = process.env) {
  return env.DATABASE_URL ? new PostgresAnalyticsStore(env.DATABASE_URL) : new MemoryAnalyticsStore();
}

export const ANALYTICS_RETENTION = { detailDays: DETAIL_RETENTION_MS / DAY_MS, rollupDays: ROLLUP_RETENTION_MS / DAY_MS };
