#!/usr/bin/env python3
"""Live proof for the identity fix (pass 3): ONE building wears ONE name, before, during and after
a visit — the owner's reproduced case was four unrelated names in one visit (board TYRES & SONS,
prompt Sizwe se Spaza, builder KOTA KING, after-exit NO CREDIT).

Walks the exact reproduced building (scatter spaza s-4314:-2430), captures the board on approach,
the E prompt, the interior, and the board again after stepping out; asserts the prompt name is the
identity name, that the sign atlas never overflows, and then tours three more families for
dressing screenshots (pictures, lamps, toilets, dado/cornice — the variety half of the pass).

Usage: python3 tools/qa/interior-identity-probe.py   (dev server on 5212)
"""
import base64, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('/tmp/claude-1000/-home-sai-ai-gta3js/bd130fd1-ffb2-44ea-b99e-bff4ccaf6e3b/scratchpad')

JS = r"""
async (spec) => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const materials = await import('/src/world/ProceduralMaterials.ts');
  const out = { checks: [], shots: {} };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const p = g.player.group.position;

  const pump = (x, z) => {
    let guard = 0;
    // do-while: the first call ENQUEUES the cells around the focus; a plain while sees an empty
    // queue after a long teleport and never builds anything — the door rung then (correctly)
    // refuses to offer on the unbuilt chunk.
    do { g.city.updateBuildingChunks(x, z); } while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 600);
    g.city.updateVisibility(p, true);
  };
  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };
  const render = () => { if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera); };
  const snap = (name) => { render(); out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.8); };

  // Find the door.
  g.teleportPlayer(spec.x, spec.z); pump(spec.x, spec.z); settle(10);
  let door;
  if (spec.id) {
    door = doorsMod.doorsNear(spec.x, spec.z, 300).find(d => d.id === spec.id);
    if (!door) return { error: 'door ' + spec.id + ' not found near ' + spec.x + ',' + spec.z };
  } else {
    const cand = doorsMod.doorsNear(spec.x, spec.z, 2500)
      .map(d => ({ d, core: coreMod.buildCore(d.facts) }))
      .filter(e => spec.filter === 'smart-house' ? (e.core.family === 'suburban' && e.core.finish === 'smart' && e.core.storeys >= 2)
        : spec.filter === 'bare-house' ? (e.core.family === 'suburban' && e.core.finish === 'bare')
        : spec.filter === 'lobby' ? (e.core.entrance === 'lobby' && e.core.storeys >= 3 && e.core.finish === 'smart')
        : spec.filter === 'estate' ? (e.core.family === 'estate')
        : true)
      .sort((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
    if (!cand.length) return { error: 'no door for ' + spec.filter };
    door = cand[0].d;
  }
  const core = coreMod.buildCore(door.facts);
  out.door = { id: door.id, name: door.name, x: Math.round(door.x), z: Math.round(door.z),
               storeys: core.storeys, family: core.family, finish: core.finish, decorSeed: core.seed };

  // The name BOARD, framed head-on: pose the render camera on the street looking at the tagged
  // face (the chase camera needs seconds to swing after a teleport and kept framing the horizon).
  const outX = Math.sin(door.heading), outZ = Math.cos(door.heading);
  g.teleportPlayer(door.x, door.z);
  pump(door.x, door.z);
  g.settings.cameraViewFoot = 2;
  settle(20);
  const ground = g.city.surfaceHeightAt(door.faceX, door.faceZ);
  const boardShot = (name) => {
    g.camera.position.set(door.faceX + outX * 11, ground + 3.4, door.faceZ + outZ * 11);
    g.camera.lookAt(door.faceX, ground + 2.2, door.faceZ);
    snap(name);
  };
  boardShot(spec.tag + '-approach-board');

  // Onto the step: the prompt must name the same building. The interiors BODY loads lazily off the
  // street-proximity preload (registry.ts), so give the dynamic import real time to land the way a
  // walking player does — poll across genuine awaits, not sync frames.
  g.teleportPlayer(door.x, door.z); pump(door.x, door.z); settle(20);
  let offer;
  for (let i = 0; i < 25 && !offer; i++) {
    settle(4);
    offer = g.features.offer('foot');
    if (!offer) await new Promise(r => setTimeout(r, 200));
  }
  check('prompt offered on the step', !!offer, offer ? offer.prompt : 'none');
  if (offer) check('prompt names the identity', offer.prompt.includes(door.name), offer.prompt);
  snap(spec.tag + '-doorstep');

  const statsBefore = materials.signAtlasStats();
  const entered = await g.features.qa('interiors', 'enter', {});
  check('entered', entered === 'ok', entered);
  settle(8); snap(spec.tag + '-inside-fpv');
  // Third person + a wander for the dressing shots.
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); g.update(1/60); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  key('KeyV'); settle(40); snap(spec.tag + '-inside-third');
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
  // Into the first room off the spine (the band beside the corridor), for furniture in frame.
  const roomX = core.corridorX + (core.width / 2 - core.corridorX) * 0.55;
  await walkTo(roomX, -core.depth * 0.15, 400);
  settle(10); snap(spec.tag + '-room');
  out.status = await g.features.qa('interiors', 'status', {});
  check('walkable (unreachable=0)', String(out.status).includes('unreachable=0'), out.status);

  const left = await g.features.qa('interiors', 'leave', {});
  check('left', left === 'ok', left);
  const statsAfter = materials.signAtlasStats();
  check('sign atlas never overflowed', statsAfter.overflowed === 0, JSON.stringify({ before: statsBefore, after: statsAfter }));
  // The board again, after the visit — the frame that used to show a different name.
  settle(20);
  boardShot(spec.tag + '-after-exit-board');
  return out;
}
"""

SPECS = [
    {"tag": "id-spaza", "x": -4319, "z": -2429, "id": "s-4314:-2430"},
    {"tag": "smart-house", "x": -2417, "z": -1551, "filter": "smart-house"},
    {"tag": "bare-house", "x": -840, "z": -1303, "filter": "bare-house"},
    {"tag": "lobby", "x": 2716, "z": 1368, "filter": "lobby"},
    {"tag": "estate", "x": 1550, "z": -1143, "filter": "estate"},
]

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=[
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage', '--no-sandbox'])
    page = browser.new_page(viewport={'width': 1100, 'height': 680})
    page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
    page.set_default_timeout(600000)
    page.goto('http://127.0.0.1:5212/', timeout=120000)
    for _ in range(60):
        time.sleep(3)
        if page.evaluate("() => !!window.__game"):
            break
    page.evaluate("() => { window.__game.startGame(true); return 0; }")
    time.sleep(2)
    failures = 0
    for spec in SPECS:
        result = page.evaluate(JS, spec)
        if 'error' in result:
            print(spec['tag'], 'ERROR', result['error'])
            failures += 1
            continue
        print(spec['tag'], 'door:', result['door'])
        print('  status:', result.get('status'))
        for c in result['checks']:
            print('  ', 'PASS' if c['ok'] else 'FAIL', c['name'], '->', c['detail'])
            if not c['ok']:
                failures += 1
        for name, data in result['shots'].items():
            Path(OUT, name + '.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1]))
    print('RESULT:', 'GREEN' if failures == 0 else f'{failures} FAILURES')
    browser.close()
