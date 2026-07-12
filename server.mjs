import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
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

const COMPRESSIBLE = new Set(['.css', '.html', '.js', '.json', '.map', '.svg']);

const fileDetails = async (path) => {
  try {
    const details = await stat(path);
    return details.isFile() ? details : undefined;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
};

export const createStaticServer = ({ root = resolve('dist') } = {}) => {
  const staticRoot = resolve(root);
  const indexPath = resolve(staticRoot, 'index.html');

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');

    if (request.url === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    } catch {
      response.writeHead(400); response.end('Bad request'); return;
    }

    const requestedPath = resolve(staticRoot, `.${pathname}`);
    if (requestedPath !== staticRoot && !requestedPath.startsWith(`${staticRoot}${sep}`)) {
      response.writeHead(403); response.end('Forbidden'); return;
    }

    let path = requestedPath; let details = await fileDetails(path);
    if (!details) { path = indexPath; details = await fileDetails(path); }
    if (!details) { response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Production build is unavailable'); return; }

    const extension = extname(path).toLowerCase();
    const immutable = pathname.startsWith('/assets/');
    const gzip = details.size > 1024 && COMPRESSIBLE.has(extension) && request.headers['accept-encoding']?.includes('gzip');
    const headers = {
      'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : extension === '.html' ? 'no-cache' : 'public, max-age=3600',
      Vary: 'Accept-Encoding',
    };
    if (gzip) headers['Content-Encoding'] = 'gzip'; else headers['Content-Length'] = details.size;
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }

    const stream = createReadStream(path);
    if (gzip) pipeline(stream, createGzip(), response, () => undefined);
    else { stream.on('error', () => response.destroy()); stream.pipe(response); }
  });
};

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 4173;
  const server = createStaticServer();
  const multiplayer = await attachMultiplayer(server);
  server.listen(port, '0.0.0.0', () => console.log(`Groot Theft Bakkie listening on port ${port} with one global multiplayer world`));
  const shutdown = () => server.close(() => { void multiplayer.close().finally(() => process.exit(0)); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
