CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_id TEXT PRIMARY KEY,
  visitor_hash CHAR(64) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  mode VARCHAR(20) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  build_version VARCHAR(40) NOT NULL,
  browser VARCHAR(32) NOT NULL,
  platform VARCHAR(32) NOT NULL,
  device VARCHAR(16) NOT NULL,
  viewport VARCHAR(16) NOT NULL,
  quality VARCHAR(16),
  returning BOOLEAN NOT NULL DEFAULT FALSE,
  fps_sum DOUBLE PRECISION NOT NULL DEFAULT 0,
  fps_count INTEGER NOT NULL DEFAULT 0,
  loading_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  menu_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  singleplayer_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  multiplayer_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  paused_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
  hidden_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint CHAR(64),
  severity VARCHAR(16),
  build_version VARCHAR(40) NOT NULL,
  browser VARCHAR(32) NOT NULL,
  platform VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS analytics_daily_rollups (
  day DATE PRIMARY KEY,
  sessions INTEGER NOT NULL,
  unique_players INTEGER NOT NULL,
  playtime_seconds DOUBLE PRECISION NOT NULL,
  technical_crashes INTEGER NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS analytics_sessions_last_seen_idx ON analytics_sessions (last_seen_at);
CREATE INDEX IF NOT EXISTS analytics_events_occurred_idx ON analytics_events (occurred_at);
