import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticServer } from './server.mjs';

describe('production static server', () => {
  let root; let server; let baseUrl;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'san-cordova-server-'));
    await mkdir(join(root, 'assets'));
    await mkdir(join(root, 'admin'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>San Cordova</title>');
    await writeFile(join(root, 'admin', 'index.html'), '<!doctype html><title>Game analytics</title>');
    await writeFile(join(root, 'assets', 'game.js'), 'export const city = "San Cordova";'.repeat(80));
    server = createStaticServer({ root });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it('reports healthy without accessing the build', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('serves hashed assets with immutable caching and compression', async () => {
    const response = await fetch(`${baseUrl}/assets/game.js`, { headers: { 'Accept-Encoding': 'gzip' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(await response.text()).toContain('San Cordova');
  });

  it('falls back to index.html for client-side routes and supports HEAD', async () => {
    const route = await fetch(`${baseUrl}/mission/delivery-run`);
    expect(await route.text()).toContain('<title>San Cordova</title>');
    expect(route.headers.get('cache-control')).toBe('no-cache');
    const head = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('serves the isolated admin shell and never falls API requests through to game HTML', async () => {
    const admin = await fetch(`${baseUrl}/admin`); expect(await admin.text()).toContain('<title>Game analytics</title>');
    const api = await fetch(`${baseUrl}/api/not-found`); expect(api.status).toBe(404); expect(api.headers.get('content-type')).toContain('application/json');
    expect(await api.text()).not.toContain('San Cordova');
  });

  it('rejects unsupported methods', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});
