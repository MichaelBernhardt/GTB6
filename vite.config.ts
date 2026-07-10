import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { host: '0.0.0.0' },
  build: { target: 'es2022' },
  test: { environment: 'node' },
});
