import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const TOKEN_BYTES = 32;
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export const createToken = () => randomBytes(TOKEN_BYTES).toString('base64url');

export class MemoryProfileStore {
  profiles = new Map();

  async init() {}
  async load(token, name) {
    const hash = token ? tokenHash(token) : undefined;
    const existing = hash ? this.profiles.get(hash) : undefined;
    if (existing) { existing.name = name; return { token, profile: { ...existing } }; }
    const nextToken = createToken();
    const profile = { name, kills: 0, deaths: 0 };
    this.profiles.set(tokenHash(nextToken), profile);
    return { token: nextToken, profile: { ...profile } };
  }
  async save(token, profile) { this.profiles.set(tokenHash(token), { ...profile }); }
  async close() {}
}

export class PostgresProfileStore {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false } });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS multiplayer_profiles (
      token_hash TEXT PRIMARY KEY,
      display_name VARCHAR(24) NOT NULL,
      kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }
  async load(token, name) {
    if (token) {
      const result = await this.pool.query('SELECT display_name, kills, deaths FROM multiplayer_profiles WHERE token_hash = $1', [tokenHash(token)]);
      if (result.rowCount) {
        await this.pool.query('UPDATE multiplayer_profiles SET display_name = $2, updated_at = NOW() WHERE token_hash = $1', [tokenHash(token), name]);
        const row = result.rows[0];
        return { token, profile: { name, kills: row.kills, deaths: row.deaths } };
      }
    }
    const nextToken = createToken();
    await this.pool.query('INSERT INTO multiplayer_profiles (token_hash, display_name) VALUES ($1, $2)', [tokenHash(nextToken), name]);
    return { token: nextToken, profile: { name, kills: 0, deaths: 0 } };
  }
  async save(token, profile) {
    await this.pool.query('UPDATE multiplayer_profiles SET display_name = $2, kills = $3, deaths = $4, updated_at = NOW() WHERE token_hash = $1', [tokenHash(token), profile.name, profile.kills, profile.deaths]);
  }
  async close() { await this.pool.end(); }
}

export function createProfileStore(env = process.env) {
  return env.DATABASE_URL ? new PostgresProfileStore(env.DATABASE_URL) : new MemoryProfileStore();
}
