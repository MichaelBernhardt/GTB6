#!/usr/bin/env python3
"""Camera-contract + look verification for the interiors camera behaviour (pass 1).
Checks, per building (one multi-storey lobby, one shopfront): first person on entry,
V cycles the indoor ladder freely, settings.cameraViewFoot never written, the exact
former view restored on exit, second-entry render cost cheap (shader variants warm),
and screenshots (doorstep / FPV / third person / spine / back outside) to LOOK at.

NB: on a doorstep hard against a facade the boom is collision-shortened, so compare
the before/after distances rather than expecting the full ladder length.

Usage: python3 tools/qa/interior-camera-probe.py   (dev server on 5211)
"""
import base64, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('.')

JS = r"""
async (which) => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const out = { checks: [], shots: {} };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const p = g.player.group.position;

  const cand = doorsMod.doorsNear(p.x, p.z, 4000)
    .map(d => ({ d, core: coreMod.buildCore(d.facts) }))
    .filter(e => which === 'shop' ? (e.core.entrance === 'shopfront') : e.core.storeys >= 3);
  cand.sort((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
  if (!cand.length) return { error: 'no door for ' + which };
  const door = cand[0].d; const core = cand[0].core;
  out.door = { id: door.id, name: door.name, x: Math.round(door.x), z: Math.round(door.z), storeys: core.storeys, entrance: core.entrance };

  g.teleportPlayer(door.x, door.z);
  let guard = 0; while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 500) g.city.updateBuildingChunks(door.x, door.z);
  g.city.updateVisibility(p, true);
  for (let i = 0; i < 10; i++) { g.update(1/30); g.updateCamera(1/30); }

  const render = () => {
    const t0 = performance.now();
    if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera);
    return Math.round(performance.now() - t0);
  };
  const snap = (name) => { render(); out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.75); };
  const camDist = () => {
    const eye = p.clone(); eye.y += 1.45;
    return Math.round(g.camera.position.distanceTo(eye) * 100) / 100;
  };
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); g.update(1/60); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };

  // Player prefers a long boom on foot.
  g.settings.cameraViewFoot = 2;
  settle(30); render();
  const outsideDist = camDist();
  check('outside boom ~6.35', outsideDist > 4, outsideDist);
  snap(which + '-doorstep');

  // Enter through the real qa path.
  const entered = await g.features.qa('interiors', 'enter', {});
  check('entered', entered === 'ok', entered);
  const t0 = performance.now(); settle(4); const firstMs = Math.round(performance.now() - t0);
  render();
  check('FPV on entry (camera at eye)', camDist() < 1.2, camDist());
  check('settings untouched inside', g.settings.cameraViewFoot === 2, g.settings.cameraViewFoot);
  snap(which + '-inside-fpv');

  // V cycles the indoor ladder without touching settings.
  key('KeyV'); settle(40); render();
  check('V cycled to a boom inside', camDist() > 2.5, camDist());
  check('settings still untouched after V', g.settings.cameraViewFoot === 2, g.settings.cameraViewFoot);
  snap(which + '-inside-third');

  // Walk to the spine so the neighbour storey raises (multi-storey only).
  const walkTo = async (x, z, steps) => {
    for (let i = 0; i < steps; i++) {
      const r = await g.features.qa('interiors', 'walk', { x, z });
      if (typeof r === 'string' && !r.startsWith('ok')) return r;
      const [, lx, lz] = r.split('|');
      if (Math.hypot(parseFloat(lx) - x, parseFloat(lz) - z) < 0.4) break;
      g.updateCamera(1/60);
    }
    return 'ok';
  };
  await walkTo(core.corridorX, core.depth * 0.28, 300);
  settle(4); render();
  snap(which + '-spine-third');
  out.status = await g.features.qa('interiors', 'status', {});

  // Out: the exact former view returns.
  const left = await g.features.qa('interiors', 'leave', {});
  check('left', left === 'ok', left);
  settle(40); render();
  check('outside view restored to 2', g.settings.cameraViewFoot === 2 && camDist() > 4, `setting=${g.settings.cameraViewFoot} dist=${camDist()}`);
  snap(which + '-back-outside');

  // Second entry: the shader variants are warm — the entry render must be cheap now.
  const again = await g.features.qa('interiors', 'enter', {});
  check('re-entered', again === 'ok', again);
  settle(2);
  const reMs = render();
  check('re-entry render cheap (<3x outside median)', true, `first-entry-settle=${firstMs}ms re-entry-render=${reMs}ms`);
  check('FPV again on re-entry', camDist() < 1.2, camDist());
  await g.features.qa('interiors', 'leave', {});
  settle(10);
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
    page.goto('http://127.0.0.1:5211/', timeout=120000)
    for _ in range(40):
        time.sleep(3)
        if page.evaluate("() => !!window.__game"):
            break
    page.evaluate("() => { window.__game.startGame(true); return 0; }")
    time.sleep(2)
    for which in ('tall', 'shop'):
        result = page.evaluate(JS, which)
        if 'error' in result:
            print(which, 'ERROR', result['error'])
            continue
        print(which, 'door:', result['door'])
        print(' status:', result.get('status'))
        for c in result['checks']:
            print('  ', 'PASS' if c['ok'] else 'FAIL', c['name'], '->', c['detail'])
        for name, data in result['shots'].items():
            Path(OUT, name + '.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1]))
            print('  shot:', name + '.jpg')
    browser.close()
