import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from '../server.mjs';
import { AnalyticsService } from './analytics.mjs';
import { MemoryAnalyticsStore } from './analytics-store.mjs';

const browserId = '123e4567-e89b-42d3-a456-426614174000';
const sessionId = '223e4567-e89b-42d3-a456-426614174000';
const eventId = '323e4567-e89b-42d3-a456-426614174000';

describe('analytics and admin HTTP APIs', () => {
  const resources = [];
  afterEach(async () => { for (const { server, root, service } of resources.splice(0)) { await new Promise((resolve) => server.close(resolve)); await service.close(); await rm(root, { recursive: true, force: true }); } });

  async function setup(env = { ADMIN_PASSWORD: 'correct horse', ADMIN_SESSION_SECRET: 'admin-secret', ANALYTICS_SECRET: 'analytics-secret', SOURCE_VERSION: 'build-123' }, countryLookup = () => ({ country: 'ZA' })) {
    const root = await mkdtemp(join(tmpdir(), 'gtb-analytics-')); await mkdir(join(root, 'admin'));
    await writeFile(join(root, 'index.html'), '<title>Game</title>'); await writeFile(join(root, 'admin/index.html'), '<title>Admin analytics</title>');
    let now = new Date('2026-07-20T10:00:00Z'); const service = new AnalyticsService({ env, store: new MemoryAnalyticsStore(), now: () => now, countryLookup }); await service.init({ maintenance: false });
    const server = createStaticServer({ root, analytics: service }); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); const base = `http://127.0.0.1:${address.port}`; resources.push({ server, root, service });
    return { base, service, setNow: (value) => { now = value; } };
  }
  const post = (base, path, body, origin = base) => fetch(`${base}${path}`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const session = { sessionId, browserId, mode: 'loading', visible: true, build: 'client-build', browser: 'chromium', platform: 'windows', device: 'desktop', viewport: 'large', quality: 'high', ignored: 'not stored' };

  it('accepts valid telemetry, rejects cross-origin and invalid payloads, deduplicates IDs, sanitizes errors, and protects dashboard data', async () => {
    const { base, service } = await setup();
    expect((await post(base, '/api/analytics/session', session)).status).toBe(202);
    expect((await post(base, '/api/analytics/heartbeat', { eventId, sessionId, mode: 'singleplayer', visible: true, elapsedSeconds: 30, fps: 58 })).status).toBe(202);
    const crash = { eventId: '423e4567-e89b-42d3-a456-426614174000', sessionId, type: 'technical_error', data: { errorType: 'TypeError', message: 'Failed https://127.0.0.1/a?token=supersecret and user@example.com', stack: 'TypeError\n at boot (https://game.test/app.js?key=abcdef)', source: 'boot', severity: 'fatal', unknown: 'discard' } };
    const first = await post(base, '/api/analytics/event', crash); expect(first.status).toBe(202); expect(await first.json()).toMatchObject({ duplicate: false });
    const duplicate = await post(base, '/api/analytics/event', crash); expect(await duplicate.json()).toMatchObject({ duplicate: true });
    expect((await post(base, '/api/analytics/session', session, 'https://attacker.test')).status).toBe(403);
    expect((await post(base, '/api/analytics/event', { ...crash, eventId: 'bad', type: 'made-up' })).status).toBe(400);
    const stored = [...service.store.events.values()][0]; expect(stored.fingerprint).toHaveLength(64); expect(stored.payload.message).toContain('<redacted>'); expect(stored.payload.message).not.toContain('user@example.com'); expect(stored.payload.message).not.toContain('127.0.0.1'); expect(stored.payload.unknown).toBeUndefined();
    expect((await service.store.getSession(sessionId)).visitorHash).toHaveLength(64); expect((await service.store.getSession(sessionId)).visitorHash).not.toBe(browserId); expect((await service.store.getSession(sessionId)).country).toBe('ZA');
    const normalizedA = service.fingerprint({ errorType: 'TypeError', message: 'request 123 failed', stack: 'at boot (app.js:10:2)' }, 'build');
    const normalizedB = service.fingerprint({ errorType: 'TypeError', message: 'request 456 failed', stack: 'at boot (app.js:99:8)' }, 'build'); expect(normalizedA).toBe(normalizedB);
    const api = await fetch(`${base}/api/admin/dashboard`); expect(api.status).toBe(401); expect(api.headers.get('content-type')).toContain('application/json'); expect(await api.text()).not.toContain('<title>Game');

    expect((await post(base, '/api/admin/login', { password: 'wrong' })).status).toBe(401);
    const login = await post(base, '/api/admin/login', { password: 'correct horse' }); expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Max-Age=28800');
    const dashboard = await fetch(`${base}/api/admin/dashboard?range=7d`, { headers: { Cookie: cookie.split(';')[0] } }); expect(dashboard.status).toBe(200);
    const body = await dashboard.json(); expect(body).toMatchObject({ range: '7d', live: { singleplayer: 1, technicalCrashes: 1 }, geography: [{ country: 'ZA', sessions: 1, uniquePlayers: 1, share: 100 }], operations: { build: 'build-123', database: { available: true } } });
    expect(JSON.stringify(body)).not.toContain(browserId); expect(JSON.stringify(body)).not.toContain('supersecret');
    const logout = await post(base, '/api/admin/logout', {}); expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('expires signed cookies, rate-limits login, caps request bodies, and disables admin without both secrets', async () => {
    const { base, setNow } = await setup();
    const login = await post(base, '/api/admin/login', { password: 'correct horse' }); const cookie = login.headers.get('set-cookie').split(';')[0];
    setNow(new Date('2026-07-20T19:00:01Z')); expect((await fetch(`${base}/api/admin/dashboard`, { headers: { Cookie: cookie } })).status).toBe(401);
    for (let index = 0; index < 5; index++) expect((await post(base, '/api/admin/login', { password: 'bad' })).status).toBe(401);
    expect((await post(base, '/api/admin/login', { password: 'bad' })).status).toBe(429);
    const oversized = await fetch(`${base}/api/analytics/session`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(5000) }) }); expect(oversized.status).toBe(413);

    const disabled = await setup({ ANALYTICS_SECRET: 'only-analytics' });
    expect((await post(disabled.base, '/api/admin/login', { password: 'anything' })).status).toBe(503);
    expect((await fetch(`${disabled.base}/api/admin/dashboard`)).status).toBe(503);
  });

  it('serves the isolated admin shell and never falls unknown APIs through to HTML', async () => {
    const { base } = await setup();
    expect(await (await fetch(`${base}/admin`)).text()).toContain('Admin analytics');
    const unknown = await fetch(`${base}/api/not-real`); expect(unknown.status).toBe(404); expect(unknown.headers.get('content-type')).toContain('application/json');
  });
});
