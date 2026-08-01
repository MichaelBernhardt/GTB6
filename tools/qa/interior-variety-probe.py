#!/usr/bin/env python3
"""Variety verification for pass 3 (fix/interiors-round2), in-engine.

Round 2's audit numbers moved and the owner still read the stairs as samey, so this
probe is the eyeball check for the round-3 claims, through the real game on SwiftShader:

  1. a MID-class island core — stair mid-plate, rooms in front AND behind, walk around it;
  2. a FRONT-class stair — in the door and the switchback is right there;
  3. a SIDE-class stair — the shaft hard against a side wall;
  4. a BACK-class stair standing far off the corridor (the unchained x);
  5. an honest SMALL interior — a spaza that is its own true size, one room, no corridor;
  6. a LONG THIN full layout — aspect preserved from the model;
  7. the roof hatch, AT NIGHT with no pick: real E out onto the roof, real E back in —
     hatches open from the roof side always, so night and pocket contents are irrelevant.

Each visit asserts unreachable=0 and climbs the stair where there is one, through the
same clamp the player walks. Saves screenshots to --out for a human to LOOK at.

Usage: python3 tools/qa/interior-variety-probe.py [--port 5297] [--out DIR]
"""
import argparse, base64, json, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5297)
ap.add_argument('--host', default='127.0.0.1')  # pass the vite bind address when it is LAN-only
ap.add_argument('--out', default='.')
args = ap.parse_args()
OUT = Path(args.out)

PROBE_JS = r"""
async () => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const buildMod = await import('/src/features/interiors/build.ts');
  const lockMod = await import('/src/features/interiors/lock.ts');
  const out = { checks: [], shots: {}, doors: {} };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const p = g.player.group.position;
  const qa = (a, x) => g.features.qa('interiors', a, x || {});
  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };
  const render = () => { if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera); };
  const snap = (name) => { settle(4); render(); out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.8); };
  const face = (door, lx, lz) => {
    const target = buildMod.toWorld({ x: door.facts.x, z: door.facts.z }, door.heading + Math.PI, lx, lz);
    g.player.setHeading(Math.atan2(target.x - p.x, target.z - p.z));
    settle(50);
  };
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); g.update(1/60); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
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
  const openByDay = (x) => !lockMod.doorLocked(x.d.facts, 'outside', 13);
  /** Climb one storey and back through the real clamp, the QA climber's own waypoints. */
  const climbUpDown = async (label, core) => {
    const s = core.stair, lane = s.w / 4, up = core.stairDir;
    const minZ = s.z - s.d / 2, maxZ = s.z + s.d / 2;
    const upPath = [[s.x + up*lane, minZ - 1.2], [s.x + up*lane, minZ + 0.3], [s.x + up*lane, maxZ - 0.7],
      [s.x - up*lane, maxZ - 0.7], [s.x - up*lane, minZ + 0.3], [s.x, minZ - 1.6]];
    for (const [x, z] of upPath) await walkTo(x, z);
    let st = await qa('status', {});
    check(label + ': climbed to floor 1', st.includes('floor=1'), st);
    const dnPath = [[s.x - up*lane, minZ - 1.2], [s.x - up*lane, minZ + 0.3], [s.x - up*lane, maxZ - 0.7],
      [s.x + up*lane, maxZ - 0.7], [s.x + up*lane, minZ + 0.3], [s.x, minZ - 1.6]];
    for (const [x, z] of dnPath) await walkTo(x, z);
    st = await qa('status', {});
    check(label + ': back on the ground', st.includes('floor=0'), st);
  };

  // ---------- 1. MID: the island core, rooms in front AND behind ----------
  {
    const e = pick(x => x.core.stairClass === 'mid' && openByDay(x) && coreMod.coreBackZ(x.core) !== undefined);
    if (!e) return { error: 'no mid-class building nearby' };
    const core = e.core, s = core.stair;
    out.doors.mid = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), storeys: core.storeys,
      stair: `${s.x.toFixed(1)},${s.z.toFixed(1)}`, plate: `${core.width.toFixed(1)}x${core.depth.toFixed(1)}` };
    goto2(e.d.x, e.d.z);
    const entered = await qa('enter', {});
    check('1 mid: enter', entered === 'ok', entered);
    check('1 mid: unreachable=0', (await qa('status', {})).includes('unreachable=0'), await qa('status', {}));
    key('KeyV'); key('KeyV'); settle(30);
    await walkTo(core.corridorX, s.z - s.d / 2 - 3.0);
    face(e.d, s.x, s.z);
    snap('mid-island-from-corridor');       // the player's own view on the way to it
    // Hand-placed architecture shot: the chase camera's smoothing cannot be trusted to swing in
    // time under SwiftShader, and the island IS the subject.
    await walkTo(s.x, s.z - s.d / 2 - 1.6);
    snapAt('mid-island-arch', e.d,
      { x: core.corridorX, z: s.z - s.d / 2 - 8.5, y: 4.4 }, { x: s.x, z: s.z, y: 1.2 });
    // Walk PAST the island down the corridor to the rooms behind, then look back at its sealed rear.
    const behindZ = coreMod.coreBackZ(core) + 1.6;
    const past = await walkTo(core.corridorX, behindZ);
    check('1 mid: corridor passes the island to the rooms behind', String(past).startsWith('ok'), past);
    face(e.d, s.x, s.z + s.d / 2);
    snap('mid-island-behind');
    await walkTo(s.x, Math.min(core.depth / 2 - 1.4, s.z + s.d / 2 + 1.8));
    snapAt('mid-island-rear-arch', e.d,
      { x: s.x, z: Math.min(core.depth / 2 - 1.0, s.z + s.d / 2 + 7.5), y: 4.2 }, { x: s.x, z: s.z, y: 1.6 });
    await walkTo(core.corridorX, s.z - s.d / 2 - 1.6);
    await climbUpDown('1 mid', core);
    await qa('leave', {});
  }

  // ---------- 2. FRONT: in the door and the stair is right there ----------
  {
    const e = pick(x => x.core.stairClass === 'front' && openByDay(x));
    if (!e) return { error: 'no front-class building nearby' };
    const core = e.core, s = core.stair;
    out.doors.front = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), storeys: core.storeys,
      stair: `${s.x.toFixed(1)},${s.z.toFixed(1)}`, plate: `${core.width.toFixed(1)}x${core.depth.toFixed(1)}` };
    goto2(e.d.x, e.d.z);
    check('2 front: enter', await qa('enter', {}) === 'ok', 'enter');
    key('KeyV'); key('KeyV'); settle(30);
    face(e.d, s.x, s.z);
    snap('front-stair-from-doormat');
    await walkTo(s.x, s.z - s.d / 2 - 1.6);
    snapAt('front-stair-arch', e.d,
      { x: core.entryX, z: -core.depth / 2 + 1.2, y: 3.8 }, { x: s.x, z: s.z, y: 1.2 });
    await climbUpDown('2 front', core);
    await qa('leave', {});
  }

  // ---------- 3. SIDE: the shaft hard against a side wall ----------
  {
    const e = pick(x => x.core.stairClass === 'side' && openByDay(x)
      && Math.abs(x.core.stair.x) / (x.core.width / 2) > 0.55);
    if (!e) return { error: 'no side-class building nearby' };
    const core = e.core, s = core.stair;
    out.doors.side = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), storeys: core.storeys,
      stair: `${s.x.toFixed(1)},${s.z.toFixed(1)}`, plate: `${core.width.toFixed(1)}x${core.depth.toFixed(1)}` };
    goto2(e.d.x, e.d.z);
    check('3 side: enter', await qa('enter', {}) === 'ok', 'enter');
    key('KeyV'); key('KeyV'); settle(30);
    await walkTo(core.corridorX, s.z - s.d / 2 - 2.6);
    face(e.d, s.x, s.z);
    snap('side-stair-at-wall');             // the shaft pinned to the wall, corridor clear of it
    await climbUpDown('3 side', core);
    await qa('leave', {});
  }

  // ---------- 4. BACK, x unchained: the shaft far off the corridor ----------
  {
    const e = pick(x => x.core.stairClass === 'back' && openByDay(x)
      && Math.abs(x.core.stair.x - x.core.corridorX) > 5);
    if (!e) return { error: 'no far-x back-class building nearby' };
    const core = e.core, s = core.stair;
    out.doors.back = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), storeys: core.storeys,
      stair: `${s.x.toFixed(1)},${s.z.toFixed(1)}`, corridorX: core.corridorX.toFixed(1) };
    goto2(e.d.x, e.d.z);
    check('4 back: enter', await qa('enter', {}) === 'ok', 'enter');
    key('KeyV'); key('KeyV'); settle(30);
    await walkTo(core.corridorX, s.z - s.d / 2 - 2.6);
    face(e.d, s.x, s.z);
    snap('back-stair-far-from-spine');
    await walkTo(s.x, s.z - s.d / 2 - 1.6);
    snapAt('back-stair-arch', e.d,
      { x: core.corridorX, z: s.z - s.d / 2 - 8.0, y: 4.4 }, { x: s.x, z: s.z, y: 1.2 });
    await climbUpDown('4 back', core);
    await qa('leave', {});
  }

  // ---------- 5. SMALL: the honest one-room spaza ----------
  {
    const e = pick(x => x.core.layout === 'small' && openByDay(x) && x.core.width < 9);
    if (!e) return { error: 'no small building nearby' };
    const core = e.core;
    out.doors.small = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z),
      plate: `${core.width.toFixed(1)}x${core.depth.toFixed(1)}`, foot: `${e.d.facts.width.toFixed(1)}x${e.d.facts.depth.toFixed(1)}` };
    goto2(e.d.x, e.d.z);
    const entered = await qa('enter', {});
    check('5 small: enter', entered === 'ok', entered);
    const st = await qa('status', {});
    check('5 small: one room, all reachable', st.includes('rooms=1') && st.includes('unreachable=0'), st);
    key('KeyV'); key('KeyV'); settle(30);
    face(e.d, 0, core.depth / 2);
    snap('small-spaza-inside');             // the whole shop in one look — because it IS one room
    // Containment: shove at every wall of the tiny plate.
    for (const [x, z] of [[core.width, 0], [-core.width, 0], [0, core.depth], [0, -core.depth]]) await walkTo(x, z, 60);
    const local = (await qa('walk', { x: 0, z: 0 })).split('|');
    check('5 small: contained', Math.abs(parseFloat(local[1])) < core.width / 2 + 0.1, local.join(','));
    await qa('leave', {});
    settle(20);
    snap('small-spaza-outside');            // the shack it honestly fits inside now
  }

  // ---------- 6. LONG THIN: aspect preserved from the model ----------
  {
    const e = pick(x => x.core.layout === 'full' && openByDay(x)
      && (x.core.width / x.core.depth > 1.9 || x.core.depth / x.core.width > 1.9));
    if (!e) return { error: 'no long-thin building nearby' };
    const core = e.core;
    out.doors.thin = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z),
      plate: `${core.width.toFixed(1)}x${core.depth.toFixed(1)}`, foot: `${e.d.facts.width.toFixed(1)}x${e.d.facts.depth.toFixed(1)}` };
    goto2(e.d.x, e.d.z);
    check('6 thin: enter', await qa('enter', {}) === 'ok', 'enter');
    key('KeyV'); key('KeyV'); settle(30);
    snapAt('thin-plan', e.d,
      { x: core.corridorX, z: -core.depth / 2 + 1.2, y: 4.4 }, { x: core.corridorX, z: core.depth / 2, y: 0.4 });
    await qa('leave', {});
  }

  // ---------- 7. the roof hatch AT NIGHT, pickless: out and straight back in ----------
  {
    const e = pick(x => x.core.stair && x.d.roof && coreMod.hasRoofAccess(x.core) && x.core.storeys <= 6);
    if (!e) return { error: 'no roof-qualifying building nearby' };
    const core = e.core, s = core.stair;
    out.doors.roofy = { id: e.d.id, name: e.d.name, x: Math.round(e.d.x), z: Math.round(e.d.z), storeys: core.storeys };
    goto2(e.d.x, e.d.z);
    check('7 roof: enter', await qa('enter', {}) === 'ok', 'enter');
    key('KeyV'); key('KeyV'); settle(30);
    await qa('floor', { n: core.storeys - 1 });
    const foot = coreMod.hatchFoot(s, core.stairDir);
    await walkTo(foot.x, foot.z - 1.5);
    key('KeyE');                            // the real press up the ladder
    await sleep(700); settle(10);
    let st = await qa('status', {});
    check('7 roof: E at the ladder leaves the interior', st === 'outside', st);
    // NIGHT falls while they stand there — the street door below is now locked to outsiders on
    // half this city, and it does not matter: the hatch never asks.
    g.consoleHost ? g.consoleHost.setTime(23) : null;
    settle(30);
    g.player.setHeading(e.d.heading); settle(50);
    snap('roof-at-night');                  // on the real roof, night sky, no pick in the pocket
    key('KeyE');                            // the real press back down through the hatch
    await sleep(700); settle(10);
    st = await qa('status', {});
    check('7 roof: E at night, pickless, drops back into the top floor',
      st.startsWith('inside') && st.includes(`floor=${core.storeys - 1}`), st);
    snap('roof-back-inside-top');
    await qa('floor', { n: 0 });
    await qa('leave', {});
    settle(140);
    const dStep = Math.hypot(p.x - e.d.x, p.z - e.d.z);
    check('7 roof: street door lands on the doorstep', dStep < 0.5, `${dStep.toFixed(2)}u from step`);
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
    page.goto(f'http://{args.host}:{args.port}/', timeout=120000)
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
