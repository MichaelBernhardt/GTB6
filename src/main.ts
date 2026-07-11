import './styles.css';
import { installProfiler } from './dev/Profiler';
import { Game } from './Game';

const container = document.querySelector<HTMLElement>('#game');
if (!container) throw new Error('Game container not found');
new Game(container);
if (import.meta.env.DEV && new URLSearchParams(location.search).has('profile')) installProfiler(); // dev-only headless perf harness; the DEV gate makes it dead code in production builds
