import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = new URL('../dist/', import.meta.url);
const DIST_PATH = fileURLToPath(DIST);
const ASSETS = new URL('assets/', DIST);
const CODE_LIMIT = 500_000;
const MAP_DATA_LIMIT = 1_000_000;
const BOOT_JS_LIMIT = 25_000;

const files = readdirSync(ASSETS).filter((name) => name.endsWith('.js'));
let largestCode = { name: '', bytes: 0 };
let mapBytes = 0;
for (const name of files) {
  const bytes = statSync(new URL(name, ASSETS)).size;
  if (name.startsWith('joburg-map-data-')) {
    mapBytes = bytes;
    if (bytes > MAP_DATA_LIMIT) throw new Error(`Generated map chunk is ${bytes} bytes; budget is ${MAP_DATA_LIMIT}.`);
  } else {
    if (bytes > CODE_LIMIT) throw new Error(`${name} is ${bytes} bytes; executable chunk budget is ${CODE_LIMIT}.`);
    if (bytes > largestCode.bytes) largestCode = { name, bytes };
  }
}
if (!mapBytes) throw new Error('Generated map chunk was not emitted as an independent cache unit.');

const html = readFileSync(new URL('index.html', DIST), 'utf8');
const bootRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.js)"/g)].map((match) => match[1]);
const uniqueBootRefs = [...new Set(bootRefs)];
const bootBytes = uniqueBootRefs.reduce((total, ref) => total + statSync(join(DIST_PATH, ref)).size, 0);
if (bootBytes > BOOT_JS_LIMIT) throw new Error(`Boot shell preloads ${bootBytes} bytes of JS; budget is ${BOOT_JS_LIMIT}.`);
if (uniqueBootRefs.some((ref) => /(?:PostProcessing|three-(?:postprocessing|gtao))/.test(basename(ref)))) {
  throw new Error('Optional post-processing leaked into the initial HTML preload set.');
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
console.log(`Bundle budgets valid: boot ${kb(bootBytes)}, largest code ${basename(largestCode.name)} ${kb(largestCode.bytes)}, map data ${kb(mapBytes)}.`);
