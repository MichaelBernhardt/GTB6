export type AnalyticsMode = 'loading' | 'menu' | 'singleplayer' | 'multiplayer' | 'paused';
export type AnalyticsEventType = 'session_end' | 'player_death' | 'mission_start' | 'mission_complete' | 'mission_fail' | 'vehicle_collision' | 'aircraft_crash' | 'technical_error';

const BROWSER_ID_KEY = 'groot-theft-bakkie-anonymous-browser-id';
const HEARTBEAT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ErrorSource = 'boot' | 'runtime' | 'promise' | 'asset' | 'network';
interface ErrorContext { source: ErrorSource; severity: 'fatal' | 'recoverable'; asset?: string; }
type IntervalScheduler = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => number;
type IntervalCanceller = (id?: number) => void;
interface TelemetryOptions {
  window?: Window;
  document?: Document;
  navigator?: Navigator;
  storage?: Storage;
  fetch?: typeof fetch;
  now?: () => number;
  uuid?: () => string;
  setInterval?: IntervalScheduler;
  clearInterval?: IntervalCanceller;
}

export function coarseBrowser(userAgent: string): 'chromium' | 'firefox' | 'safari' | 'other' {
  if (/Firefox\//i.test(userAgent)) return 'firefox';
  if (/Safari\//i.test(userAgent) && !/(Chrome|Chromium|CriOS|Edg)\//i.test(userAgent)) return 'safari';
  if (/(Chrome|Chromium|CriOS|Edg)\//i.test(userAgent)) return 'chromium';
  return 'other';
}

export function coarsePlatform(userAgent: string, platform = ''): 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'other' {
  if (/Android/i.test(userAgent)) return 'android';
  if (/(iPhone|iPad|iPod)/i.test(userAgent)) return 'ios';
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return 'windows';
  if (/Mac/i.test(platform) || /Macintosh/i.test(userAgent)) return 'macos';
  if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) return 'linux';
  return 'other';
}

export function viewportBucket(width: number): 'small' | 'medium' | 'large' | 'wide' {
  if (width < 640) return 'small';
  if (width < 1024) return 'medium';
  if (width < 1600) return 'large';
  return 'wide';
}

function errorDetails(error: unknown): { errorType: string; message: string; stack: string } {
  if (error instanceof Error) return { errorType: error.name || 'Error', message: error.message || String(error), stack: error.stack ?? '' };
  if (typeof error === 'string') return { errorType: 'Error', message: error, stack: '' };
  try { return { errorType: 'UnknownError', message: JSON.stringify(error), stack: '' }; }
  catch { return { errorType: 'UnknownError', message: String(error), stack: '' }; }
}

export class TelemetryClient {
  readonly sessionId: string;
  readonly browserId: string;
  private mode: AnalyticsMode = 'loading';
  private quality = 'unknown';
  private visible = true;
  private started = false;
  private ended = false;
  private bootComplete = false;
  private lastHeartbeat: number;
  private startedAt: number;
  private fps = 0;
  private heartbeatTimer?: number;
  private startRequest: Promise<void> = Promise.resolve();
  private readonly win?: Window;
  private readonly doc?: Document;
  private readonly nav?: Navigator;
  private readonly storage?: Storage;
  private readonly request: typeof fetch;
  private readonly clock: () => number;
  private readonly randomId: () => string;
  private readonly schedule: IntervalScheduler;
  private readonly unschedule: IntervalCanceller;

  constructor(options: TelemetryOptions = {}) {
    this.win = options.window ?? (typeof window === 'undefined' ? undefined : window);
    this.doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    this.nav = options.navigator ?? (typeof navigator === 'undefined' ? undefined : navigator);
    let browserStorage = options.storage;
    if (!browserStorage && this.win) { try { browserStorage = this.win.localStorage; } catch { browserStorage = undefined; } }
    this.storage = browserStorage;
    this.request = options.fetch ?? (this.win?.fetch ? this.win.fetch.bind(this.win) : fetch);
    this.clock = options.now ?? (() => performance.now());
    this.randomId = options.uuid ?? (() => crypto.randomUUID());
    this.schedule = options.setInterval ?? (this.win?.setInterval ? this.win.setInterval.bind(this.win) : () => 0);
    this.unschedule = options.clearInterval ?? (this.win?.clearInterval ? this.win.clearInterval.bind(this.win) : () => undefined);
    this.browserId = this.persistentBrowserId(); this.sessionId = this.randomId();
    this.visible = this.doc?.visibilityState !== 'hidden'; this.startedAt = this.clock(); this.lastHeartbeat = this.startedAt;
  }

  private persistentBrowserId(): string {
    try {
      const existing = this.storage?.getItem(BROWSER_ID_KEY); if (existing && UUID.test(existing)) return existing;
      const created = this.randomId(); this.storage?.setItem(BROWSER_ID_KEY, created); return created;
    } catch { return this.randomId(); }
  }

  start(): void {
    if (this.started || !this.win || !this.doc || this.win.location.pathname.startsWith('/admin')) return;
    this.started = true;
    const userAgent = this.nav?.userAgent ?? '';
    const payload = {
      sessionId: this.sessionId, browserId: this.browserId, mode: this.mode, visible: this.visible, build: __BUILD_HASH__,
      browser: coarseBrowser(userAgent), platform: coarsePlatform(userAgent, this.nav?.platform),
      device: this.deviceCategory(userAgent), viewport: viewportBucket(this.win.innerWidth), quality: this.quality,
    };
    this.startRequest = this.post('/api/analytics/session', payload);
    this.heartbeatTimer = this.schedule(() => { void this.heartbeat(); }, HEARTBEAT_MS);
    this.doc.addEventListener('visibilitychange', this.onVisibility);
    this.win.addEventListener('pagehide', this.onEnd);
    this.win.addEventListener('error', this.onError);
    this.win.addEventListener('unhandledrejection', this.onRejection);
  }

  private deviceCategory(userAgent: string): 'desktop' | 'tablet' | 'mobile' {
    if (/iPad|Tablet/i.test(userAgent)) return 'tablet';
    if (/Mobi|Android|iPhone|iPod/i.test(userAgent) || (this.win?.innerWidth ?? 1000) < 640) return 'mobile';
    return 'desktop';
  }

  setMode(mode: AnalyticsMode): void {
    if (mode === this.mode) return;
    if (this.started) void this.heartbeat();
    this.mode = mode; this.lastHeartbeat = this.clock();
    if (this.started) void this.heartbeat(0);
  }
  setQuality(quality: string): void {
    const next = ['potato', 'low', 'medium', 'high', 'ultra'].includes(quality) ? quality : 'unknown'; if (next === this.quality) return;
    this.quality = next; if (this.started) void this.heartbeat(0);
  }
  sampleFps(value: number): void { if (Number.isFinite(value) && value >= 0) this.fps = this.fps ? this.fps * 0.94 + value * 0.06 : value; }
  markBootComplete(): void { this.bootComplete = true; }

  async heartbeat(elapsedOverride?: number): Promise<void> {
    if (!this.started || this.ended) return;
    const now = this.clock(); const elapsedSeconds = elapsedOverride ?? Math.max(0, Math.min(60, (now - this.lastHeartbeat) / 1000)); this.lastHeartbeat = now;
    const mode = this.mode; const visible = this.visible; const fps = this.fps; const quality = this.quality;
    await this.startRequest;
    await this.post('/api/analytics/heartbeat', {
      eventId: this.randomId(), sessionId: this.sessionId, mode, visible,
      elapsedSeconds, fps: fps ? Math.round(fps * 10) / 10 : undefined, quality,
    });
  }

  record(type: Exclude<AnalyticsEventType, 'technical_error' | 'session_end'>, data: Record<string, string | number> = {}): void {
    if (!this.started || this.ended) return;
    const payload = { eventId: this.randomId(), sessionId: this.sessionId, type, data };
    void this.startRequest.then(() => this.post('/api/analytics/event', payload));
  }

  captureError(error: unknown, context: ErrorContext): void {
    if (!this.started || this.ended) return;
    const details = errorDetails(error);
    const payload = { eventId: this.randomId(), sessionId: this.sessionId, type: 'technical_error', data: { ...details, ...context } };
    void this.startRequest.then(() => this.post('/api/analytics/event', payload));
  }

  private onVisibility = (): void => {
    void this.heartbeat();
    this.visible = this.doc?.visibilityState !== 'hidden'; this.lastHeartbeat = this.clock();
    void this.heartbeat(0);
  };
  private onError = (event: ErrorEvent): void => this.captureError(event.error ?? event.message, { source: this.bootComplete ? 'runtime' : 'boot', severity: 'fatal' });
  private onRejection = (event: PromiseRejectionEvent): void => this.captureError(event.reason, { source: this.bootComplete ? 'promise' : 'boot', severity: this.bootComplete ? 'recoverable' : 'fatal' });
  private onEnd = (): void => {
    if (this.ended || !this.started) return;
    const now = this.clock(); const elapsedSeconds = Math.max(0, Math.min(60, (now - this.lastHeartbeat) / 1000));
    this.beacon('/api/analytics/heartbeat', { eventId: this.randomId(), sessionId: this.sessionId, mode: this.mode, visible: this.visible, elapsedSeconds, fps: this.fps || undefined, quality: this.quality });
    this.beacon('/api/analytics/event', { eventId: this.randomId(), sessionId: this.sessionId, type: 'session_end', data: { durationSeconds: Math.max(0, (now - this.startedAt) / 1000) } });
    this.ended = true; if (this.heartbeatTimer) this.unschedule(this.heartbeatTimer);
  };

  end(): void { this.onEnd(); }
  private async post(path: string, payload: object): Promise<void> {
    try { await this.request(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true }); }
    catch { /* Telemetry must never interfere with game boot or input. */ }
  }
  private beacon(path: string, payload: object): void {
    try { this.nav?.sendBeacon(path, new Blob([JSON.stringify(payload)], { type: 'application/json' })); }
    catch { /* Page exit is best effort. */ }
  }
}

export const analytics = new TelemetryClient();
