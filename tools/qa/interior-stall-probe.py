#!/usr/bin/env python3
"""Interior stall probe: walk a real interior (spine -> room -> past the release dwell -> spine,
six cycles), render at a fixed cadence, and record per-render wall time, renderer.info.programs,
draw calls/triangles and the scene light census around every floor raise/drop.

This is the evidence route for the interiors stall fix (fix/interiors-round2 pass 1) and the
baseline any later interiors pass (furniture/decor especially) must re-check against:
  - the light census must NEVER change between the entry fade and the exit fade,
  - programs may grow only by first-render one-timers (a couple per session, not per cycle),
  - draw calls inside must stay interior-sized (~10^2), not city-sized (~10^3).
Absolute ms are SwiftShader + shared-box noise; the counters are the load-immune truth.

Usage: python3 tools/qa/interior-stall-probe.py [--port 52xx] [--label before|after] [--out DIR]
"""
import argparse, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5211)
ap.add_argument('--label', default='before')
ap.add_argument('--out', default='.')
ap.add_argument('--shots', action='store_true')
args = ap.parse_args()

PROBE_JS = r"""
async () => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const out = { samples: [], events: [], notes: [] };

  // A tall building near spawn: multi-storey so the spine sightline raises floor 1.
  const p = g.player.group.position;
  const cand = doorsMod.doorsNear(p.x, p.z, 3000)
    .map(d => ({ d, core: coreMod.buildCore(d.facts) }))
    .filter(e => e.core.storeys >= 3 && e.core.storeys <= 8);
  cand.sort((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
  if (!cand.length) return { error: 'no tall door' };
  const door = cand[0].d; const core = cand[0].core;
  out.door = { id: door.id, name: door.name, x: door.x, z: door.z, storeys: core.storeys,
               corridorX: core.corridorX, width: core.width, depth: core.depth };

  // Stand on the step, pump chunks, settle.
  g.teleportPlayer(door.x, door.z);
  let guard = 0; while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 500) g.city.updateBuildingChunks(door.x, door.z);
  for (let i = 0; i < 12; i++) g.update(1/30);

  const render = () => {
    const t0 = performance.now();
    if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera);
    return performance.now() - t0;
  };
  const census = () => {
    let point = 0, ambient = 0, other = 0;
    g.scene.traverse(o => { if (o.isPointLight) point++; else if (o.isAmbientLight) ambient++; else if (o.isLight) other++; });
    return { point, ambient, other, programs: g.renderer.info.programs.length };
  };
  const sample = (tag) => {
    g.update(1/60); g.updateCamera(1/60);
    const ms = render();
    const c = census();
    out.samples.push({ tag, ms: Math.round(ms * 10) / 10, calls: g.renderer.info.render.calls,
                       tris: g.renderer.info.render.triangles, ...c });
  };

  // Baseline outside, warmed: several renders so shader warmup is out of the numbers.
  for (let i = 0; i < 6; i++) sample('outside-warm');

  // In through the real path.
  const entered = await g.features.qa('interiors', 'enter', {});
  if (entered !== 'ok') return { error: 'enter: ' + entered };
  for (let i = 0; i < 6; i++) sample('inside-settle');

  // Walk loop: room (off-spine, past the release dwell) -> spine (raises floor 1) -> repeat.
  // Every qa walk stride runs the real clamp/holdNeighbour with dt=1/60.
  const roomX = core.corridorX + (core.corridorX <= 0 ? 1 : -1) * (3.3/2 + 4.0);
  const spineTargets = [ { x: core.corridorX, z: core.depth * 0.1 } ];
  const roomTargets = [ { x: roomX, z: 0 } ];
  const walkTo = async (t, tag, maxStride) => {
    for (let i = 0; i < maxStride; i++) {
      const r = await g.features.qa('interiors', 'walk', { x: t.x, z: t.z });
      if (typeof r === 'string' && !r.startsWith('ok')) { out.notes.push(tag + ':' + r); break; }
      if (i % 4 === 3) sample(tag);
      const [, lx, lz] = r.split('|');
      if (Math.hypot(parseFloat(lx) - t.x, parseFloat(lz) - t.z) < 0.3) break;
    }
  };
  const dwell = async (tag, steps) => {   // stand still off the spine so the release dwell expires
    for (let i = 0; i < steps; i++) {
      const r = await g.features.qa('interiors', 'walk', { x: roomX, z: 0 });
      if (i % 6 === 5) sample(tag);
    }
  };

  const CYCLES = 6;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    await walkTo(spineTargets[0], `c${cycle}-to-spine`, 120);
    sample(`c${cycle}-on-spine`);
    await walkTo(roomTargets[0], `c${cycle}-to-room`, 120);
    await dwell(`c${cycle}-dwell`, 60);   // 60 strides ~= 1.0 s sim > 0.8 s RELEASE_DWELL
    sample(`c${cycle}-dropped`);
  }

  // status for residency truth
  out.status = await g.features.qa('interiors', 'status', {});
  await g.features.qa('interiors', 'leave', {});
  for (let i = 0; i < 4; i++) sample('outside-after');
  return out;
}
"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=[
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage', '--no-sandbox'])
    page = browser.new_page(viewport={'width': 960, 'height': 600})
    page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
    page.set_default_timeout(600000)
    page.goto(f'http://127.0.0.1:{args.port}/', timeout=120000)
    for _ in range(40):
        time.sleep(3)
        if page.evaluate("() => !!window.__game"):
            break
    page.evaluate("() => { window.__game.startGame(true); return 0; }")
    time.sleep(2)
    result = page.evaluate(PROBE_JS)
    Path(args.out, f'perf-{args.label}.json').write_text(json.dumps(result, indent=1))
    if 'error' in result:
        print('ERROR', result['error'])
    else:
        samples = result['samples']
        print(f"door: {result['door']}")
        print(f"status: {result.get('status')}")
        print(f"notes: {result.get('notes')}")
        ms = sorted(s['ms'] for s in samples)
        def pct(p):
            return ms[min(len(ms)-1, int(len(ms)*p))]
        print(f"renders={len(ms)} p50={pct(0.5)}ms p90={pct(0.9)}ms p99={pct(0.99)}ms max={ms[-1]}ms")
        spikes = [s for s in samples if s['ms'] > pct(0.5) * 3]
        print(f"spikes (>3x median): {len(spikes)}")
        for s in spikes[:20]:
            print('  SPIKE', s)
        # programs / light census over time (transitions only)
        last = None
        for s in samples:
            key = (s['point'], s['ambient'], s['programs'])
            if key != last:
                print(f"  lights/programs change @ {s['tag']}: point={s['point']} ambient={s['ambient']} programs={s['programs']} ms={s['ms']} calls={s['calls']}")
                last = key
    browser.close()
