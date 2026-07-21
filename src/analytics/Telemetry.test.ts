import { describe, expect, it, vi } from 'vitest';
import { coarseBrowser, coarsePlatform, TelemetryClient, viewportBucket } from './Telemetry';

const ids = [
  '123e4567-e89b-42d3-a456-426614174000', '223e4567-e89b-42d3-a456-426614174000', '323e4567-e89b-42d3-a456-426614174000',
  '423e4567-e89b-42d3-a456-426614174000', '523e4567-e89b-42d3-a456-426614174000', '623e4567-e89b-42d3-a456-426614174000',
  '723e4567-e89b-42d3-a456-426614174000', '823e4567-e89b-42d3-a456-426614174000', '923e4567-e89b-42d3-a456-426614174000',
];

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function harness(storage = new MemoryStorage()) {
  let now = 0; let nextId = 0;
  const win = new EventTarget() as Window; Object.defineProperties(win, { innerWidth: { value: 1280 }, location: { value: { pathname: '/' } } });
  const doc = new EventTarget() as Document; Object.defineProperty(doc, 'visibilityState', { value: 'visible', configurable: true });
  const beacons = vi.fn(); const nav = { userAgent: 'Mozilla/5.0 Chrome/126.0 Safari/537.36', platform: 'Win32', sendBeacon: beacons } as unknown as Navigator;
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const request = vi.fn(async (path: string | URL | Request, init?: RequestInit) => { requests.push({ path: String(path), body: JSON.parse(String(init?.body)) }); return new Response(null, { status: 202 }); }) as typeof fetch;
  const client = new TelemetryClient({ window: win, document: doc, navigator: nav, storage, fetch: request, now: () => now, uuid: () => ids[nextId++] ?? crypto.randomUUID(), setInterval: (() => 1) as unknown as typeof setInterval, clearInterval: vi.fn() });
  return { client, win, doc, requests, beacons, storage, advance: (milliseconds: number) => { now += milliseconds; } };
}

const settle = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };

describe('telemetry classifications', () => {
  it('uses deliberately coarse browser, platform, and viewport categories', () => {
    expect(coarseBrowser('Firefox/125')).toBe('firefox'); expect(coarseBrowser('Version/17 Safari/605')).toBe('safari'); expect(coarseBrowser('Chrome/126 Safari/537')).toBe('chromium');
    expect(coarsePlatform('Android Mobile')).toBe('android'); expect(coarsePlatform('Mozilla', 'MacIntel')).toBe('macos');
    expect([viewportBucket(500), viewportBucket(800), viewportBucket(1200), viewportBucket(1900)]).toEqual(['small', 'medium', 'large', 'wide']);
  });
});

describe('TelemetryClient', () => {
  it('persists only the anonymous browser ID while issuing a new session ID', () => {
    const storage = new MemoryStorage(); const first = harness(storage).client; const second = harness(storage).client;
    expect(first.browserId).toBe(second.browserId); expect(first.sessionId).not.toBe(second.sessionId); expect(storage.length).toBe(1);
  });

  it('starts before play, attributes transition time to the old mode, samples FPS, and excludes hidden time', async () => {
    const { client, doc, requests, advance } = harness(); client.setQuality('high'); client.start(); await settle();
    expect(requests[0]).toMatchObject({ path: '/api/analytics/session', body: { mode: 'loading', browser: 'chromium', platform: 'windows', viewport: 'large', quality: 'high' } });
    advance(30_000); client.sampleFps(50); client.setMode('singleplayer'); await settle();
    const transition = requests.filter((item) => item.path.endsWith('heartbeat'));
    expect(transition[0].body).toMatchObject({ mode: 'loading', visible: true, elapsedSeconds: 30, fps: 50 });
    expect(transition[1].body).toMatchObject({ mode: 'singleplayer', visible: true, elapsedSeconds: 0 });
    advance(10_000); Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true }); doc.dispatchEvent(new Event('visibilitychange')); await settle();
    const hiddenTransition = requests.filter((item) => item.path.endsWith('heartbeat')).slice(-2);
    expect(hiddenTransition[0].body).toMatchObject({ mode: 'singleplayer', visible: true, elapsedSeconds: 10 });
    expect(hiddenTransition[1].body).toMatchObject({ mode: 'singleplayer', visible: false, elapsedSeconds: 0 });
  });

  it('captures errors and uses beacons for a best-effort final heartbeat and end event', async () => {
    const { client, requests, beacons, advance } = harness(); client.start(); client.markBootComplete(); await settle();
    client.captureError(new TypeError('broken'), { source: 'runtime', severity: 'fatal' }); await settle();
    expect(requests.find((item) => item.body.type === 'technical_error')?.body).toMatchObject({ type: 'technical_error', data: { errorType: 'TypeError', message: 'broken', source: 'runtime', severity: 'fatal' } });
    advance(4_000); client.end(); expect(beacons).toHaveBeenCalledTimes(2);
    const payloads = await Promise.all(beacons.mock.calls.map(async (call) => JSON.parse(await (call[1] as Blob).text()) as Record<string, unknown>));
    expect(beacons.mock.calls[0]?.[0]).toBe('/api/analytics/heartbeat'); expect(beacons.mock.calls[1]?.[0]).toBe('/api/analytics/event');
    expect(payloads[0]).toMatchObject({ elapsedSeconds: 4 }); expect(payloads[1]).toMatchObject({ type: 'session_end', data: { durationSeconds: 4 } });
  });
});
