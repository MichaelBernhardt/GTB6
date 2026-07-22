import './styles.css';
import { analytics } from './analytics/Telemetry';
import { bootTimelineTail } from './core/BootTimeline';
import { installProfiler } from './dev/Profiler';

const container = document.querySelector<HTMLElement>('#game');
if (!container) throw new Error('Game container not found');
analytics.start();

/** Boot error card: replaces the loading UI with a readable breakdown (what broke, where boot
 *  died, device info, Reload). Inline styles only — it must render even when the stylesheet,
 *  the UI layer, or the Game constructor itself is what broke. First failure wins: cascade
 *  errors after the first would clobber the useful message. */
let bootFailed = false;
function showBootError(title: string, message: string): void {
  if (bootFailed) return;
  bootFailed = true;
  document.getElementById('boot-loading')?.remove();
  const card = document.createElement('div');
  card.id = 'boot-error';
  card.style.cssText = 'position:fixed;inset:0;z-index:2000;display:grid;place-items:center;padding:24px;background:#111817;color:#f2edda;font-family:Inter,"Helvetica Neue",Arial,sans-serif;';
  card.innerHTML = `<section style="width:min(540px,92vw);padding:26px;border-top:7px solid #e3533f;background:#17211f;box-shadow:12px 12px 0 rgba(0,0,0,.28);">
    <p style="margin:0 0 8px;color:#e3533f;font-size:10px;font-weight:900;letter-spacing:2.2px;text-transform:uppercase;">City services · breakdown</p>
    <h1 style="margin:0 0 10px;font-size:26px;font-weight:950;line-height:1.02;text-transform:uppercase;"></h1>
    <p data-boot-message style="margin:0 0 14px;font-size:14px;line-height:1.45;color:#c8c4ad;"></p>
    <p data-boot-trail style="margin:0 0 4px;font:11px/1.5 monospace;color:#8a948f;word-break:break-all;"></p>
    <p data-boot-device style="margin:0 0 18px;font:11px/1.5 monospace;color:#8a948f;word-break:break-all;"></p>
    <button data-boot-reload style="padding:12px 22px;border:0;background:#f7c843;color:#111817;font:900 13px Inter,sans-serif;letter-spacing:1px;text-transform:uppercase;cursor:pointer;">Reload the city</button>
  </section>`;
  const trail = bootTimelineTail();
  card.querySelector('h1')!.textContent = title;
  card.querySelector('[data-boot-message]')!.textContent = message;
  card.querySelector('[data-boot-trail]')!.textContent = trail ? `Last steps: ${trail}` : '';
  card.querySelector('[data-boot-device]')!.textContent = navigator.userAgent;
  card.querySelector('[data-boot-reload]')!.addEventListener('click', () => location.reload());
  document.body.append(card);
}

// Traps stay armed for the whole boot (city build through asset load) and disarm on the game's
// boot-ready signal — a stuck bar can no longer hide a dead boot. Game.boot() rejections arrive
// as unhandledrejection; a lost WebGL context re-dispatches as an ErrorEvent from Game.
const onBootError = (event: ErrorEvent): void => showBootError('The city failed to start', event.message || 'Unknown startup error.');
const onBootRejection = (event: PromiseRejectionEvent): void =>
  showBootError('The city failed to start', event.reason instanceof Error ? event.reason.message : String(event.reason));
window.addEventListener('error', onBootError);
window.addEventListener('unhandledrejection', onBootRejection);
window.addEventListener('gtb-boot-ready', () => {
  analytics.markBootComplete();
  window.removeEventListener('error', onBootError);
  window.removeEventListener('unhandledrejection', onBootRejection);
}, { once: true });

// Probable mobile killer #1 gets its own friendly message: probe WebGL2 before building anything.
const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  const error = new Error('WebGL2 graphics could not start on this device.');
  analytics.captureError(error, { source: 'boot', severity: 'fatal' });
  showBootError("This browser can't draw Joburg", 'WebGL2 graphics could not start on this device. Try updating your browser, closing other tabs, or a different device.');
} else {
  probe.getExtension('WEBGL_lose_context')?.loseContext(); // release the probe context straight away
  // Let the critical HTML loader paint before WebGL takes the main thread. A nested frame
  // guarantees there has been a render opportunity between parsing the page and starting Game.
  requestAnimationFrame(() => requestAnimationFrame(async () => {
    try {
      // Keep the boot/error shell tiny and independently cacheable. The complete game graph starts
      // downloading only after critical HTML has had a guaranteed paint opportunity.
      const { Game } = await import('./Game');
      new Game(container);
    } catch (error) {
      analytics.captureError(error, { source: 'boot', severity: 'fatal' });
      showBootError('The city failed to start', error instanceof Error ? error.message : String(error));
    }
    // Game's own loading screen reports live progress from here (construction continues async).
    document.querySelector('#boot-loading')?.remove();
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('profile')) installProfiler(); // dev-only headless perf harness; the DEV gate makes it dead code in production builds
  }));
}
