import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url));
const COMPRESSIBLE = new Set(['.bin', '.css', '.html', '.js', '.json', '.map', '.svg']);

function filesBelow(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

let count = 0; let rawBytes = 0; let brotliBytes = 0; let gzipBytes = 0;
for (const path of filesBelow(ROOT)) {
  if (!COMPRESSIBLE.has(extname(path)) || statSync(path).size <= 1024) continue;
  const source = readFileSync(path);
  const brotli = brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
  const gzip = gzipSync(source, { level: 9 });
  if (brotli.length < source.length) writeFileSync(`${path}.br`, brotli);
  if (gzip.length < source.length) writeFileSync(`${path}.gz`, gzip);
  count++; rawBytes += source.length; brotliBytes += brotli.length; gzipBytes += gzip.length;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
console.log(`Precompressed ${count} production assets: ${mb(rawBytes)} raw, ${mb(brotliBytes)} Brotli, ${mb(gzipBytes)} gzip.`);
