import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: '0.0.0.0', proxy: { '/multiplayer': { target: 'ws://127.0.0.1:4173', ws: true } } },
  build: { target: 'es2022' },
  test: { environment: 'node', exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'] },
});
