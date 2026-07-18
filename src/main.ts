import './styles.css';
import { installProfiler } from './dev/Profiler';
import { Game } from './Game';

const container = document.querySelector<HTMLElement>('#game');
if (!container) throw new Error('Game container not found');

// Let the critical HTML loader paint before WebGL and synchronous city construction take the main thread.
// A nested frame guarantees there has been a render opportunity between parsing the page and starting Game.
requestAnimationFrame(() => requestAnimationFrame(() => {
  new Game(container);
  document.querySelector('#boot-loading')?.remove();
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('profile')) installProfiler(); // dev-only headless perf harness; the DEV gate makes it dead code in production builds
}));
