#!/usr/bin/env python3
"""Layout + roof verification for pass 2 (fix/interiors-round2), in-engine.

Walks, through the real game on SwiftShader:
  1. a SINGLE-STOREY house — no stair, rooms on the whole plate;
  2. a multi-storey building — seeded-offset switchback climbable both ways, under-stair
     storage on the ground floor instead of a shutter;
  3. the TOP floor — stair head (rails + well), no flight into the ceiling;
  4. a qualifying commercial building — ladder + hatch on the top floor, REAL E press out
     onto the real roof (screenshot), stand there without falling, REAL E press back in
     through the hatch, then out the street door onto the doorstep.

Saves screenshots to --out for a human (or the driving agent) to LOOK at.

Usage: python3 tools/qa/interior-layout-probe.py [--port 5211] [--out DIR]
"""
import argparse, base64, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5211)
ap.add_argument('--out', default='.')
args = ap.parse_args()
OUT = Path(args.out)

PROBE_JS = r"""
async () => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const out = { checks: [], shots: {}, doors: {} };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const p = g.player.group.position;
  const qa = (a, x) => g.features.qa('interiors', a, x || {});

  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };
  const render = () => { if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera); };
  const snap = (name) => { settle(4); render(); out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.8); };
  // Face the player (and so the chase camera) at a floor-local point before a shot. The visit's
  // local frame has heading = door.heading + PI, and CameraController sits behind the heading, so
  // turning the player is what turns the shot. Forward for yaw h is (+sin h, +cos h).
  const buildMod = await import('/src/features/interiors/build.ts');
  const face = (door, lx, lz) => {
    const target = buildMod.toWorld({ x: door.facts.x, z: door.facts.z }, door.heading + Math.PI, lx, lz);
    g.player.setHeading(Math.atan2(target.x - p.x, target.z - p.z));
    settle(50);
  };
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); g.update(1/60); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  // Architecture shot with a hand-placed camera (floor-local coords + height over the floor the
  // player stands on). One g.update re-runs the partition cull against the new camera position;
  // updateCamera is deliberately NOT called so the chase camera cannot yank the framing back.
  const snapAt = (name, door, cam, look) => {
    const base = { x: door.facts.x, z: door.facts.z };
    const h = door.heading + Math.PI;
    const c = buildMod.toWorld(base, h, cam.x, cam.z);
    const l = buildMod.toWorld(base, h, look.x, look.z);
    const floorY = p.y;
    g.camera.position.set(c.x, floorY + cam.y, c.z);
    g.update(1/60);
    g.camera.position.set(c.x, floorY + cam.y, c.z);
    g.camera.lookAt(l.x, floorY + look.y, l.z);
    render();
    out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.8);
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const pump = (x, z) => { let guard = 0; while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 500) g.city.updateBuildingChunks(x, z); };
  const goto2 = (x, z) => { g.teleportPlayer(x, z); pump(x, z); settle(12); };
  const walkTo = async (x, z, max) => {
    let last = '';
    for (let i = 0; i < (max || 300); i++) {
      last = await qa('walk', { x, z });
      if (typeof last === 'string' && !last.startsWith('ok')) return last;
      const [, lx, lz] = last.split('|');
      if (Math.hypot(parseFloat(lx) - x, parseFloat(lz) - z) < 0.18) break;
      if (i % 3 === 2) { g.update(1/60); g.updateCamera(1/60); }
    }
    return last;
  };
  const pick = (filter, sortBy) => {
    const all = doorsMod.doorsNear(p.x, p.z, 4000).map(d => ({ d, core: coreMod.buildCore(d.facts) })).filter(filter);
    all.sort(sortBy || ((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z)));
    return all[0];
  };

  // ---------- 1. single-storey house: no stair ----------
  {
    const e = pick(x => x.core.storeys === 1 && (x.core.family === 'suburban' || x.core.family === 'rural'));
    if (!e) return { error: 'no single-storey house' };
    out.doors.single = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), family: e.core.family };
    goto2(e.d.x, e.d.z);
    const entered = await qa('enter', {});
    check('1: enter single-storey', entered === 'ok', entered);
    check('1: core has no stair', !e.core.stair, JSON.stringify(e.core.stair));
    let stairGroups = 0;
    g.scene.traverse(o => { if (o.name === 'Stair') stairGroups++; });
    check('1: no Stair group in scene', stairGroups === 0, stairGroups);
    key('KeyV'); key('KeyV'); settle(30);       // third person for the wide look
    await walkTo(e.core.corridorX, e.core.depth * 0.30);
    face(e.d, e.core.corridorX, e.core.depth / 2);
    snap('single-storey-inside');
    snapAt('single-storey-plan', e.d,
      { x: e.core.corridorX, z: -e.core.depth / 2 + 1.5, y: 4.4 }, { x: e.core.corridorX, z: e.core.depth / 2, y: 0.4 });
    // The back band is rooms now, not a dead shaft: walk deep and confirm containment.
    const deep = await walkTo(e.core.corridorX, e.core.depth / 2 - 1.2);
    check('1: back of plate reachable (was dead shaft band)', String(deep).startsWith('ok'), deep);
    face(e.d, e.core.corridorX, -e.core.depth / 2);
    snap('single-storey-back');
    await qa('leave', {});
  }

  // ---------- 2. multi-storey: offset stair, climb both ways, under-stair storage ----------
  {
    const e = pick(x => x.core.storeys >= 2 && x.core.storeys <= 4 && x.core.stair
      && Math.abs(x.core.stair.x - x.core.corridorX) > 1.2);
    if (!e) return { error: 'no offset-stair building nearby' };
    const core = e.core; const s = core.stair;
    out.doors.multi = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z),
      family: core.family, storeys: core.storeys, corridorX: core.corridorX, stairX: s.x, dir: core.stairDir };
    goto2(e.d.x, e.d.z);
    const entered = await qa('enter', {});
    check('2: enter multi-storey', entered === 'ok', entered);
    key('KeyV'); key('KeyV'); settle(30);
    await walkTo(core.corridorX, s.z - s.d / 2 - 3.4);
    face(e.d, s.x, s.z);
    snap('multi-ground-stairmouth');   // switchback + understair storage, offset off the spine
    snapAt('multi-ground-switchback', e.d,
      { x: core.corridorX, z: s.z - s.d / 2 - 7.5, y: 3.6 }, { x: s.x, z: s.z, y: 1.6 });
    // climb up a storey and back through the real clamp
    const lane = s.w / 4, up = core.stairDir;
    const minZ = s.z - s.d / 2, maxZ = s.z + s.d / 2;
    for (const [x, z] of [[s.x + up*lane, minZ + 0.3], [s.x + up*lane, maxZ - 0.3], [s.x - up*lane, maxZ - 0.3], [s.x - up*lane, minZ + 0.3], [core.corridorX, minZ - 1.8]]) await walkTo(x, z);
    let st = await qa('status', {});
    check('2: climbed to floor 1 on the seeded switchback', st.includes('floor=1'), st);
    for (const [x, z] of [[s.x - up*lane, minZ + 0.3], [s.x - up*lane, maxZ - 0.3], [s.x + up*lane, maxZ - 0.3], [s.x + up*lane, minZ + 0.3], [core.corridorX, minZ - 1.8]]) await walkTo(x, z);
    st = await qa('status', {});
    check('2: walked back down to the ground', st.includes('floor=0'), st);
    // top floor: the stair head
    await qa('floor', { n: core.storeys - 1 });
    await walkTo(core.corridorX, minZ - 3.0);
    face(e.d, s.x, s.z);
    snap('multi-topfloor-stairhead');  // rails + dark well, NO flight into the ceiling
    snapAt('multi-topfloor-stairhead2', e.d,
      { x: core.corridorX, z: s.z - s.d / 2 - 7.5, y: 3.6 }, { x: s.x, z: s.z, y: 0.8 });
    await qa('leave', {});
  }

  // ---------- 3/4. qualifying commercial: ladder, real E out to the roof, real E back in ----------
  {
    const e = pick(x => x.core.stair && x.d.roof && coreMod.hasRoofAccess(x.core) && x.core.storeys <= 6);
    if (!e) return { error: 'no roof-qualifying building nearby' };
    const core = e.core; const s = core.stair;
    out.doors.roofy = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z),
      family: core.family, storeys: core.storeys };
    goto2(e.d.x, e.d.z);
    snap('roofy-doorstep');
    const entered = await qa('enter', {});
    check('3: enter roof-qualifying', entered === 'ok', entered);
    key('KeyV'); key('KeyV'); settle(30);
    await qa('floor', { n: core.storeys - 1 });
    const foot = coreMod.hatchFoot(s, core.stairDir);
    await walkTo(foot.x, foot.z - 1.5);
    face(e.d, foot.x, foot.z + 1.5);
    snap('roofy-top-ladder');          // stair head with the ladder + ceiling hatch
    // THE REAL PRESS: E at the ladder foot must offer 'Up to the roof' and deliver.
    key('KeyE');
    await sleep(700); settle(10);
    st = await qa('status', {});
    check('4: E at the ladder leaves the interior', st === 'outside', st);
    const ground = g.city.surfaceHeightAt(p.x, p.z);
    check('4: standing high above the street', p.y > ground + 6, `y=${p.y.toFixed(1)} ground=${ground.toFixed(1)}`);
    const yBefore = p.y;
    settle(60);                        // stand there a second: supportHeight must hold the player up
    check('4: the roof bears weight (no falling)', Math.abs(p.y - yBefore) < 0.6, `y ${yBefore.toFixed(2)} -> ${p.y.toFixed(2)}`);
    g.player.setHeading(e.d.heading); settle(50);
    snap('on-the-roof');               // the money shot: player on the real roof, city around
    // THE REAL PRESS BACK IN: E on the roof drops into the top floor (grace window).
    key('KeyE');
    await sleep(700); settle(10);
    st = await qa('status', {});
    check('4: E on the roof re-enters the top floor', st.startsWith('inside') && st.includes(`floor=${core.storeys - 1}`), st);
    face(e.d, s.x, s.z);
    snap('back-inside-top');
    // out the street door: down by lift-jump, then leave; must land on the DOORSTEP, not the roof.
    await qa('floor', { n: 0 });
    await qa('leave', {});
    settle(140);
    const dStep = Math.hypot(p.x - e.d.x, p.z - e.d.z);
    check('4: street door after roof entry lands on the doorstep', dStep < 0.5, `${dStep.toFixed(2)}u from step, y=${p.y.toFixed(1)}`);
    snap('back-on-doorstep');
  }

  // ---------- 5. a second multi-storey building, for the sameness eyeball ----------
  {
    const e = pick(x => x.core.storeys >= 2 && x.core.stair && x.core.stairDir === -1
      && Math.abs(x.core.stair.x - x.core.corridorX) > 1.0, (a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
    if (e) {
      out.doors.second = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), family: e.core.family, dir: e.core.stairDir };
      goto2(e.d.x, e.d.z);
      const entered = await qa('enter', {});
      check('5: enter second building', entered === 'ok', entered);
      key('KeyV'); key('KeyV'); settle(30);
      await walkTo(e.core.corridorX, e.core.stair.z - e.core.stair.d / 2 - 3.4);
      face(e.d, e.core.stair.x, e.core.stair.z);
      snap('second-ground-stairmouth'); // compare against multi-ground-stairmouth: mirrored turn, different offset
      await qa('leave', {});
    }
  }

  out.status = await qa('status', {});
  return out;
}
"""

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=[
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage', '--no-sandbox'])
    page = browser.new_page(viewport={'width': 1100, 'height': 680})
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
    if 'error' in result:
        print('ERROR', result['error'])
    else:
        print('doors:', json.dumps(result['doors']))
        print('final status:', result.get('status'))
        fails = 0
        for c in result['checks']:
            print(('PASS ' if c['ok'] else 'FAIL ') + c['name'] + '  [' + c['detail'] + ']')
            fails += 0 if c['ok'] else 1
        for name, data in result.get('shots', {}).items():
            OUT.joinpath(f'{name}.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1]))
            print('shot:', OUT / f'{name}.jpg')
        print(f'RESULT: {"GREEN" if fails == 0 else str(fails) + " FAILURES"}')
    browser.close()
