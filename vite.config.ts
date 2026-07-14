import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

// The deployed git release, stamped into the build for a subtle version marker on the menu. Heroku exposes the
// deploy commit as SOURCE_VERSION; locally we ask git; anything unversioned falls back to 'dev'.
const buildHash = (() => {
  if (process.env.SOURCE_VERSION) return process.env.SOURCE_VERSION.slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'dev'; }
})();

export default defineConfig({
  define: { __BUILD_HASH__: JSON.stringify(buildHash) },
  server: { host: '0.0.0.0', proxy: { '/multiplayer': { target: 'ws://127.0.0.1:4173', ws: true } } },
  build: { target: 'es2022' },
  test: { environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
});
