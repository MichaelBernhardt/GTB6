import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { createAnalyticsService } from './server/analytics.mjs';
import { attachMultiplayer } from './server/multiplayer.mjs';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.bin', '.css', '.html', '.js', '.json', '.map', '.svg']);

const fileDetails = async (path) => {
  try {
    const details = await stat(path);
    return details.isFile() ? details : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
};

export const createStaticServer = ({ root = resolve('dist'), analytics } = {}) => {
  const staticRoot = resolve(root);
  const indexPath = resolve(staticRoot, 'index.html');
  const adminPath = resolve(staticRoot, 'admin/index.html');

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');

    let pathname; let requestUrl;
    try {
      requestUrl = new URL(request.url ?? '/', 'http://localhost');
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400); response.end('Bad request'); return;
    }

    if (pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (analytics && await analytics.handle(request, response, pathname)) return;
    if (pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'API endpoint not found' }));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }

    const requestedPath = pathname === '/admin' || pathname === '/admin/' ? adminPath : resolve(staticRoot, `.${pathname}`);
    if (requestedPath !== staticRoot && !requestedPath.startsWith(`${staticRoot}${sep}`)) {
      response.writeHead(403); response.end('Forbidden'); return;
    }

    let path = requestedPath; let details = await fileDetails(path);
    // Missing file-like requests must be real 404s. Returning index.html with a year-long asset cache
    // poisons dynamic imports and makes a missing bake/model look like a successful binary response.
    if (!details && extname(pathname)) { response.writeHead(404); response.end('Not found'); return; }
    if (!details) { path = indexPath; details = await fileDetails(path); }
    if (!details) { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Production build is unavailable'); return; }

    const extension = extname(path).toLowerCase();
    const immutable = pathname.startsWith('/assets/') || (pathname.startsWith('/baked/') && requestUrl.searchParams.has('v'));
    const compressible = details.size > 1024 && COMPRESSIBLE.has(extension);
    const accepted = request.headers['accept-encoding'] ?? '';
    let responsePath = path; let responseDetails = details; let contentEncoding; let dynamicGzip = false;
    if (compressible && accepted.includes('br')) {
      const compressed = await fileDetails(`${path}.br`);
      if (compressed) { responsePath = `${path}.br`; responseDetails = compressed; contentEncoding = 'br'; }
    }
    if (!contentEncoding && compressible && accepted.includes('gzip')) {
      const compressed = await fileDetails(`${path}.gz`);
      if (compressed) { responsePath = `${path}.gz`; responseDetails = compressed; contentEncoding = 'gzip'; }
      else { contentEncoding = 'gzip'; dynamicGzip = true; }
    }
    const headers = {
      'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : extension === '.html' ? 'no-cache' : 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    };
    if (contentEncoding) headers['Content-Encoding'] = contentEncoding;
    if (!dynamicGzip) headers['Content-Length'] = responseDetails.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }

    const stream = createReadStream(responsePath);
    if (dynamicGzip) pipeline(stream, createGzip(), response, () => undefined);
    else { stream.on('error', () => response.destroy()); stream.pipe(response); }
  });
};

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  const analytics = createAnalyticsService(); await analytics.init();
  const server = createStaticServer({ analytics });
  const multiplayer = await attachMultiplayer(server, { analyticsEvent: (type, payload) => analytics.recordSystemEvent(type, payload) });
  analytics.setMultiplayerProvider(() => ({ connected: multiplayer.world.players.size, capacity: multiplayer.world.capacity, hotBakkie: multiplayer.world.hotBakkieSnapshot() }));
  server.listen(port, '0.0.0.0', () => console.log(`Groot Theft Bakkie listening on port ${port} with one global multiplayer world`));
  const shutdown = () => server.close(() => { void Promise.all([multiplayer.close(), analytics.close()]).finally(() => process.exit(0)); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
