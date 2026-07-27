import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

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

// A static import cycle between chunks is a shipped crash, not advice. Rollup only *warns*
// ("Circular chunk: a -> b -> a"), exits 0 and emits the bundle; the dev server is fine because it
// serves unbundled modules, every unit test is fine because vitest never bundles, and the deployed
// page then dies on load with "Cannot access 'X' before initialization" while every HTTP request
// returns 200. This walks the real emitted files, so the gate holds even if that warning is silenced
// or a cycle arrives by some route rollup does not warn about. Dynamic imports are excluded on
// purpose: they are ordinary lazy edges and cannot deadlock initialisation.
const label = (name) => name.replace(/-[A-Za-z0-9_-]{8}\.js$/, '');
const staticImports = new Map(files.map((name) => {
  const targets = new Set();
  for (const node of parseAst(readFileSync(new URL(name, ASSETS), 'utf8')).body) {
    const isImportEdge = node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration';
    if (isImportEdge && node.source) targets.add(basename(node.source.value));
  }
  return [name, targets];
}));
const settled = new Set();
const onStack = new Set();
const walkChunk = (name, trail) => {
  if (settled.has(name)) return;
  if (onStack.has(name)) {
    const cycle = [...trail.slice(trail.indexOf(name)), name].map(label).join(' -> ');
    throw new Error(`Circular chunk: ${cycle}. These chunks import each other statically, so no initialisation order exists and the production bundle throws "Cannot access 'X' before initialization" on load. A chunk split out of another may only be a genuine leaf — nothing in it may import back. Fix the manualChunk() layering in vite.config.ts.`);
  }
  onStack.add(name);
  for (const target of staticImports.get(name)) if (staticImports.has(target)) walkChunk(target, [...trail, name]);
  onStack.delete(name);
  settled.add(name);
};
for (const name of files) walkChunk(name, []);

const html = readFileSync(new URL('index.html', DIST), 'utf8');
const bootRefs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+\.js)"/g)].map((match) => match[1]);
const uniqueBootRefs = [...new Set(bootRefs)];
const bootBytes = uniqueBootRefs.reduce((total, ref) => total + statSync(join(DIST_PATH, ref)).size, 0);
if (bootBytes > BOOT_JS_LIMIT) throw new Error(`Boot shell preloads ${bootBytes} bytes of JS; budget is ${BOOT_JS_LIMIT}.`);
if (uniqueBootRefs.some((ref) => /(?:PostProcessing|three-(?:postprocessing|gtao))/.test(basename(ref)))) {
  throw new Error('Optional post-processing leaked into the initial HTML preload set.');
}

// "Is it actually lazy?" as a build failure rather than a code-review opinion, forever, for every
// feature. Each feature in src/features/<id>/ is entered through <id>.ts, so rollup names its chunk
// <id>-<hash>.js. A feature chunk in the boot preload set means a static import crept in somewhere —
// or the vite manualChunk rule swept the body into an eager chunk, which silently beats the dynamic
// import. Both defeat the whole design and neither shows up in the byte budgets above.
const FEATURE_DIR = new URL('../src/features/', import.meta.url);
const featureIds = readdirSync(FEATURE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
for (const id of featureIds) {
  const chunk = new RegExp(`^${id}-[^.]+\\.js$`);
  // The entry file must be named after the feature, or rollup emits an illegible `index-<hash>.js`
  // that nothing here (or in a review) can match back to the feature it came from.
  if (!files.some((name) => chunk.test(name))) {
    throw new Error(`Feature "${id}" emitted no async chunk. Name its entry src/features/${id}/${id}.ts, reach it only through registry.ts's load(), and add no manualChunk rule for src/features/${id}/ — a chunk assignment silently beats a dynamic import.`);
  }
  const leaked = uniqueBootRefs.filter((ref) => chunk.test(basename(ref)));
  if (leaked.length > 0) throw new Error(`Lazy feature chunk leaked into the initial HTML preload set: ${leaked.join(', ')}. Something imports src/features/${id}/ statically. See src/features/README.md.`);
}

const kb = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
const features = featureIds.length === 0 ? 'none' : `${featureIds.length} lazy (${featureIds.join(', ')})`;
console.log(`Bundle budgets valid: ${files.length} chunks acyclic, boot ${kb(bootBytes)}, largest code ${basename(largestCode.name)} ${kb(largestCode.bytes)}, map data ${kb(mapBytes)}, features ${features}.`);
