import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { buildAnalyticsDashboard, createAnalyticsStore } from './analytics-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(['loading', 'menu', 'singleplayer', 'multiplayer', 'paused']);
const DEVICES = new Set(['desktop', 'tablet', 'mobile']);
const BROWSERS = new Set(['chromium', 'firefox', 'safari', 'other']);
const PLATFORMS = new Set(['windows', 'macos', 'linux', 'android', 'ios', 'other']);
const VIEWPORTS = new Set(['small', 'medium', 'large', 'wide']);
const QUALITIES = new Set(['potato', 'low', 'medium', 'high', 'ultra', 'unknown']);
const RANGES = new Set(['24h', '7d', '30d', '90d']);
const EVENT_TYPES = new Set(['session_end', 'player_death', 'mission_start', 'mission_complete', 'mission_fail', 'vehicle_collision', 'aircraft_crash', 'technical_error']);
const RANGE_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000, '90d': 7_776_000_000 };
const COOKIE_NAME = 'gtb_admin_session';
const ADMIN_LIFETIME_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = 5;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

const json = (response, status, body, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
};

async function readJson(request, limit) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON content type is required');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request body is too large');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new HttpError(400, 'A JSON object is required'); }
}

const bounded = (value, max, fallback = '') => typeof value === 'string' ? value.trim().slice(0, max) : fallback;
const finite = (value, min, max, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
const id = (value, name) => { if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `Invalid ${name}`); return value.toLowerCase(); };
const enumValue = (value, values, name) => { if (typeof value !== 'string' || !values.has(value)) throw new HttpError(400, `Invalid ${name}`); return value; };

function sanitizeTechnicalText(value, max) {
  return [...bounded(value, max, 'Unknown error')].map((character) => {
    const code = character.charCodeAt(0); return code < 32 || code === 127 ? ' ' : character;
  }).join('')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gi, '$1?<redacted>')
    .replace(/([?&](?:token|key|secret|password|auth|session)=)[^\s&#]+/gi, '$1<redacted>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<email>')
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sanitizeStack(value) {
  if (typeof value !== 'string') return '';
  return value.split('\n').slice(0, 12).map((line) => sanitizeTechnicalText(line, 240)).filter(Boolean).join('\n').slice(0, 2000);
}

function eventPayload(type, raw) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (type === 'session_end') return { durationSeconds: finite(data.durationSeconds, 0, 86_400) };
  if (type === 'player_death') return { mode: MODES.has(data.mode) ? data.mode : 'singleplayer' };
  if (type === 'mission_start') return { missionId: bounded(data.missionId, 80) };
  if (type === 'mission_complete') return { missionId: bounded(data.missionId, 80), durationSeconds: finite(data.durationSeconds, 0, 86_400) };
  if (type === 'mission_fail') return { missionId: bounded(data.missionId, 80), durationSeconds: finite(data.durationSeconds, 0, 86_400), reason: bounded(data.reason, 100) };
  if (type === 'vehicle_collision') return { impact: finite(data.impact, 0, 250), vehicleKind: bounded(data.vehicleKind, 32, 'unknown') };
  if (type === 'aircraft_crash') return { speed: finite(data.speed, 0, 500), sink: finite(data.sink, 0, 500) };
  if (type === 'technical_error') {
    return {
      errorType: sanitizeTechnicalText(data.errorType, 80), message: sanitizeTechnicalText(data.message, 500),
      stack: sanitizeStack(data.stack), source: ['boot', 'runtime', 'promise', 'asset', 'network'].includes(data.source) ? data.source : 'runtime',
      asset: data.asset ? sanitizeTechnicalText(data.asset, 120) : undefined,
    };
  }
  return {};
}

function requestOrigin(request) {
  const protocol = bounded(request.headers['x-forwarded-proto']?.split(',')[0], 12, request.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${request.headers.host}`;
}
function isSameOrigin(request, required = false) {
  const origin = request.headers.origin;
  if (!origin) return !required && request.headers['sec-fetch-site'] !== 'cross-site';
  return origin === requestOrigin(request);
}
function cookieValue(request, name) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('='); if (key === name) return rest.join('=');
  }
  return undefined;
}

export class AnalyticsService {
  constructor({ env = process.env, store = createAnalyticsStore(env), now = () => new Date() } = {}) {
    this.env = env; this.store = store; this.now = now; this.startedAt = now(); this.ready = false; this.lastTelemetryAt = undefined;
    this.adminEnabled = Boolean(env.ADMIN_PASSWORD && env.ADMIN_SESSION_SECRET);
    this.analyticsSecretPersistent = Boolean(env.ANALYTICS_SECRET);
    this.analyticsSecret = env.ANALYTICS_SECRET || randomBytes(32).toString('base64url');
    this.build = bounded(env.SOURCE_VERSION || env.HEROKU_SLUG_COMMIT, 40, 'dev');
    this.rates = new Map(); this.loginRates = new Map(); this.heartbeatIds = new Map(); this.multiplayerProvider = () => ({});
  }

  async init({ maintenance = true } = {}) {
    try { await this.store.init(); this.ready = true; }
    catch (error) { this.store.available = false; this.initError = error; }
    if (maintenance && this.ready) {
      try { await this.maintain(); } catch (error) { console.error('[analytics] Initial rollup maintenance failed.', error); }
      this.maintenanceTimer = setInterval(() => { void this.maintain().catch((error) => console.error('[analytics] Rollup maintenance failed.', error)); }, 24 * 60 * 60 * 1000);
      this.maintenanceTimer.unref?.();
    }
  }
  async maintain() { if (!this.ready) return; await this.store.aggregate(this.now()); await this.store.cleanup(this.now()); }
  setMultiplayerProvider(provider) { this.multiplayerProvider = provider; }
  visitorHash(browserId) { return createHmac('sha256', this.analyticsSecret).update(browserId).digest('hex'); }
  fingerprint(payload, build) {
    const topFrame = payload.stack.split('\n').find((line) => line.includes('at ')) ?? payload.stack.split('\n')[0] ?? '';
    const normalize = (value) => String(value).toLowerCase().replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/:\d+:\d+/g, ':<line>').replace(/\b\d+\b/g, '<n>');
    return createHash('sha256').update([payload.errorType, payload.message, topFrame, build].map(normalize).join('|')).digest('hex');
  }
  rateLimit(key, maximum = 120, windowMs = 60_000) {
    const now = this.now().getTime(); const recent = (this.rates.get(key) ?? []).filter((time) => now - time < windowMs);
    if (recent.length >= maximum) throw new HttpError(429, 'Too many requests');
    recent.push(now); this.rates.set(key, recent);
  }
  requestRateLimit(request, maximum) {
    const address = request.socket.remoteAddress ?? 'unknown'; const key = createHmac('sha256', this.analyticsSecret).update(address).digest('hex');
    this.rateLimit(`address:${key}`, maximum);
  }
  normalizeSession(body) {
    return {
      sessionId: id(body.sessionId, 'session ID'), visitorHash: this.visitorHash(id(body.browserId, 'browser ID')), at: this.now(),
      mode: enumValue(body.mode, MODES, 'mode'), visible: body.visible !== false, build: bounded(body.build, 40, 'unknown'),
      browser: enumValue(body.browser, BROWSERS, 'browser'), platform: enumValue(body.platform, PLATFORMS, 'platform'),
      device: enumValue(body.device, DEVICES, 'device'), viewport: enumValue(body.viewport, VIEWPORTS, 'viewport'),
      quality: enumValue(body.quality ?? 'unknown', QUALITIES, 'quality'),
    };
  }
  normalizeHeartbeat(body) {
    const mode = enumValue(body.mode, MODES, 'mode'); const visible = body.visible !== false;
    return {
      eventId: id(body.eventId, 'event ID'), sessionId: id(body.sessionId, 'session ID'), at: this.now(), mode, visible,
      active: visible && (mode === 'singleplayer' || mode === 'multiplayer'), elapsedSeconds: finite(body.elapsedSeconds, 0, 60),
      fps: typeof body.fps === 'number' && Number.isFinite(body.fps) ? finite(body.fps, 0, 240) : undefined,
      quality: body.quality === undefined ? undefined : enumValue(body.quality, QUALITIES, 'quality'),
    };
  }
  normalizeEvent(body, session) {
    const type = enumValue(body.type, EVENT_TYPES, 'event type'); const payload = eventPayload(type, body.data);
    if ((type.startsWith('mission_') && !payload.missionId)) throw new HttpError(400, 'Mission ID is required');
    const severity = type === 'technical_error' ? (body.data?.severity === 'fatal' ? 'fatal' : 'recoverable') : undefined;
    return {
      eventId: id(body.eventId, 'event ID'), sessionId: id(body.sessionId, 'session ID'), type, at: this.now(), payload,
      severity, fingerprint: type === 'technical_error' ? this.fingerprint(payload, session?.build ?? 'unknown') : undefined,
      build: session?.build ?? 'unknown', browser: session?.browser ?? 'other', platform: session?.platform ?? 'other',
    };
  }
  async recordSystemEvent(type, payload = {}) {
    if (!this.ready) return false;
    const event = { eventId: randomUUID(), sessionId: 'server', type, at: this.now(), payload, build: this.build, browser: 'server', platform: 'server' };
    const stored = await this.store.addEvent(event); this.lastTelemetryAt = event.at; return stored;
  }

  loginLimited(request) {
    const address = request.socket.remoteAddress ?? 'unknown'; const key = createHmac('sha256', this.analyticsSecret).update(address).digest('hex');
    const now = this.now().getTime(); const recent = (this.loginRates.get(key) ?? []).filter((time) => now - time < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_ATTEMPTS) return true;
    recent.push(now); this.loginRates.set(key, recent); return false;
  }
  passwordMatches(candidate) {
    const expected = createHash('sha256').update(String(this.env.ADMIN_PASSWORD ?? '')).digest();
    const actual = createHash('sha256').update(String(candidate ?? '')).digest();
    return timingSafeEqual(expected, actual);
  }
  issueCookie() {
    const now = Math.floor(this.now().getTime() / 1000); const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + ADMIN_LIFETIME_SECONDS, nonce: randomBytes(12).toString('base64url') })).toString('base64url');
    const signature = createHmac('sha256', this.env.ADMIN_SESSION_SECRET).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }
  validAdmin(request) {
    if (!this.adminEnabled) return false;
    const value = cookieValue(request, COOKIE_NAME); if (!value) return false;
    const [payload, signature, extra] = value.split('.'); if (!payload || !signature || extra) return false;
    const expected = createHmac('sha256', this.env.ADMIN_SESSION_SECRET).update(payload).digest();
    let actual; try { actual = Buffer.from(signature, 'base64url'); } catch { return false; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    try { const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); return Number.isFinite(claims.exp) && claims.exp > Math.floor(this.now().getTime() / 1000); }
    catch { return false; }
  }

  async handle(request, response, pathname) {
    try {
      if (pathname === '/api/analytics/session') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' }); return true; }
        if (!isSameOrigin(request)) throw new HttpError(403, 'Cross-origin request rejected');
        if (!this.ready) throw new HttpError(503, 'Analytics storage unavailable');
        this.requestRateLimit(request, 60);
        const body = await readJson(request, 4096); const input = this.normalizeSession(body); this.rateLimit(`session:${input.sessionId}`, 5);
        await this.store.startSession(input); this.lastTelemetryAt = input.at; json(response, 202, { accepted: true }); return true;
      }
      if (pathname === '/api/analytics/heartbeat') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' }); return true; }
        if (!isSameOrigin(request)) throw new HttpError(403, 'Cross-origin request rejected');
        if (!this.ready) throw new HttpError(503, 'Analytics storage unavailable');
        this.requestRateLimit(request, 300);
        const body = await readJson(request, 4096); const input = this.normalizeHeartbeat(body); this.rateLimit(`heartbeat:${input.sessionId}`, 10);
        const seen = this.heartbeatIds.get(input.sessionId) ?? { ids: [], values: new Set() };
        if (seen.values.has(input.eventId)) { json(response, 202, { accepted: true, duplicate: true }); return true; }
        seen.ids.push(input.eventId); seen.values.add(input.eventId);
        if (seen.ids.length > 256) seen.values.delete(seen.ids.shift());
        this.heartbeatIds.set(input.sessionId, seen);
        if (!await this.store.heartbeat(input)) throw new HttpError(404, 'Unknown session');
        this.lastTelemetryAt = input.at; json(response, 202, { accepted: true }); return true;
      }
      if (pathname === '/api/analytics/event') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' }); return true; }
        if (!isSameOrigin(request)) throw new HttpError(403, 'Cross-origin request rejected');
        if (!this.ready) throw new HttpError(503, 'Analytics storage unavailable');
        this.requestRateLimit(request, 300);
        const body = await readJson(request, 16_384); const sessionId = id(body.sessionId, 'session ID'); this.rateLimit(`event:${sessionId}`);
        const session = await this.store.getSession(sessionId);
        if (!session) throw new HttpError(404, 'Unknown session');
        const event = this.normalizeEvent(body, session); const accepted = await this.store.addEvent(event); this.lastTelemetryAt = event.at;
        json(response, 202, { accepted: true, duplicate: !accepted }); return true;
      }
      if (pathname === '/api/admin/login') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' }); return true; }
        if (!this.adminEnabled) throw new HttpError(503, 'Admin access is not configured');
        if (!isSameOrigin(request, true)) throw new HttpError(403, 'Cross-origin request rejected');
        if (this.loginLimited(request)) throw new HttpError(429, 'Too many login attempts');
        const body = await readJson(request, 1024);
        if (!this.passwordMatches(body.password)) throw new HttpError(401, 'Invalid credentials');
        this.loginRates.clear(); const cookie = `${COOKIE_NAME}=${this.issueCookie()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ADMIN_LIFETIME_SECONDS}`;
        json(response, 200, { authenticated: true }, { 'Set-Cookie': cookie }); return true;
      }
      if (pathname === '/api/admin/logout') {
        if (request.method !== 'POST') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' }); return true; }
        if (!isSameOrigin(request, true)) throw new HttpError(403, 'Cross-origin request rejected');
        json(response, 200, { authenticated: false }, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` }); return true;
      }
      if (pathname === '/api/admin/dashboard') {
        if (request.method !== 'GET') { json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' }); return true; }
        if (!this.adminEnabled) throw new HttpError(503, 'Admin access is not configured');
        if (!this.validAdmin(request)) throw new HttpError(401, 'Authentication required');
        if (!this.ready) throw new HttpError(503, 'Analytics storage unavailable');
        const requestUrl = new URL(request.url, 'http://localhost'); const range = RANGES.has(requestUrl.searchParams.get('range')) ? requestUrl.searchParams.get('range') : '24h';
        const records = await this.store.read(new Date(this.now().getTime() - RANGE_MS[range]));
        const data = buildAnalyticsDashboard({ ...records, range, now: this.now(), multiplayer: this.multiplayerProvider() });
        data.operations = { uptimeSeconds: Math.max(0, Math.floor((this.now().getTime() - this.startedAt.getTime()) / 1000)), build: this.build, database: { kind: this.store.kind, available: this.store.available !== false }, lastTelemetryAt: this.lastTelemetryAt?.toISOString(), analyticsSecretPersistent: this.analyticsSecretPersistent };
        json(response, 200, data); return true;
      }
      return false;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[analytics] Request failed.', error);
      json(response, status, { error: status === 500 ? 'Analytics request failed' : error.message }); return true;
    }
  }
  async close() { clearInterval(this.maintenanceTimer); await this.store.close(); }
}

export function createAnalyticsService(options) { return new AnalyticsService(options); }
