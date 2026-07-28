/**
 * Shore parameter sweep: patch config.ts constants, run the real offline build, measure the
 * EMITTED map, restore config.ts. Every number in the report comes out of a real build.
 *
 *   node tools/mapgen/sweep.mjs '<json array of {label, set:{CONST:value}}>'
 *   node tools/mapgen/sweep.mjs --file cases.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const CONFIG = new URL('./config.ts', import.meta.url).pathname;
const original = readFileSync(CONFIG, 'utf8');

const cases = process.argv[2] === '--file'
  ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
  : JSON.parse(process.argv[2]);

const patch = (src, name, value) => {
  const re = new RegExp(`(export const ${name}\\s*=\\s*)([^;]+)(;)`);
  if (!re.test(src)) throw new Error(`config.ts has no export const ${name}`);
  return src.replace(re, `$1${value}$3`);
};

const OUT = '/tmp/sweep-map.json';
const results = [];
try {
  for (const c of cases) {
    let src = original;
    for (const [k, v] of Object.entries(c.set)) src = patch(src, k, typeof v === 'string' ? v : String(v));
    writeFileSync(CONFIG, src);
    let build;
    try {
      build = execFileSync('npx', ['tsx', 'tools/mapgen/index.ts'], {
        cwd: new URL('../..', import.meta.url).pathname,
        env: { ...process.env, MAPGEN_OUT: OUT, MAPGEN_PREVIEW_OUT: '/tmp/sweep-preview.html' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      console.log(`\n### ${c.label}: BUILD FAILED`);
      console.log(String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? ''));
      results.push({ label: c.label, failed: true });
      continue;
    }
    if (process.env.SWEEP_PNG) {
      execFileSync('npx', ['tsx', 'tools/mapgen/render-png.ts', '--size', process.env.SWEEP_PNG_SIZE ?? '1400',
        '--out', `${process.env.SWEEP_PNG}/${c.label.replace(/[^a-z0-9]+/gi, '-')}.png`],
        { cwd: new URL('../..', import.meta.url).pathname, env: { ...process.env, MAPGEN_OUT: OUT },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const measured = execFileSync('node', ['tools/mapgen/measure-shore.mjs', OUT], {
      cwd: new URL('../..', import.meta.url).pathname, encoding: 'utf8',
    });
    const grab = (re) => (measured.match(re)?.[1] ?? '?');
    const row = {
      label: c.label,
      pts: grab(/points\s+(\d+)/),
      segs: grab(/segment len\s+(.+)/),
      cv: grab(/seg CV\s+([\d.]+)/),
      turn: grab(/TOTAL TURNING\s+(\d+)/),
      sinu: grab(/sinuosity\s+([\d.]+)/),
      wet: grab(/wet total\s+.+= ([\d.]+)%/),
      above: grab(/land above\s+(\d+)/),
      below: grab(/land below\s+(\d+)/),
      reach: grab(/max shore east.+\((\d+) u from the west edge\)/),
      area: grab(/dam water area\s+([\d.]+)/),
      cap: grab(/ocean#\d+: len (\d+ u .+?), closest approach (\d+ u)/) ,
      capline: (measured.match(/\n {2}ocean#\d+:.*/) ?? ['(no ocean straight run within 3 km)'])[0].trim(),
      scale: (build.match(/fitted at (1:[\d.]+)/) ?? ['', '?'])[1],
      wetruns: grab(/runs\s+(.+)/),
    };
    results.push(row);
    console.log(`\n### ${c.label}   scale ${row.scale}`);
    console.log(`  pts ${row.pts}  seg ${row.segs}  CV ${row.cv}  turning ${row.turn} deg  sinuosity ${row.sinu}`);
    console.log(`  wet ${row.wet}% (${row.wetruns})  land above ${row.above} below ${row.below}  reach ${row.reach} u  water ${row.area} km2`);
    console.log(`  worst ocean run: ${row.capline}`);
  }
} finally {
  writeFileSync(CONFIG, original);
}
