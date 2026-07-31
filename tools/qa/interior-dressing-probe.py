#!/usr/bin/env python3
"""Dressing contact sheet (pass 3): walk INTO specific room kinds and photograph the new pieces —
pictures, standing lamps, chairs, the toilet — plus three same-family houses in a row to show the
palette/ornament spread. Usage: dev server on 5212."""
import base64, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path('/tmp/claude-1000/-home-sai-ai-gta3js/bd130fd1-ffb2-44ea-b99e-bff4ccaf6e3b/scratchpad')

JS = r"""
async (spec) => {
  const g = window.__game;
  const doorsMod = await import('/src/features/interiors/doors.ts');
  const coreMod = await import('/src/features/interiors/core.ts');
  const floorMod = await import('/src/features/interiors/floor.ts');
  const out = { checks: [], shots: {} };
  const p = g.player.group.position;
  const pump = (x, z) => { let guard = 0; do { g.city.updateBuildingChunks(x, z); } while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 600); g.city.updateVisibility(p, true); };
  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };
  const render = () => { if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera); };
  const snap = (name) => { render(); out.shots[name] = g.renderer.domElement.toDataURL('image/jpeg', 0.8); };

  g.teleportPlayer(spec.x, spec.z); pump(spec.x, spec.z); settle(10);
  const cand = doorsMod.doorsNear(p.x, p.z, 2500)
    .map(d => ({ d, core: coreMod.buildCore(d.facts) }))
    .filter(e => (spec.family ? e.core.family === spec.family : true) && (spec.finish ? e.core.finish === spec.finish : true)
      && (spec.minStoreys ? e.core.storeys >= spec.minStoreys : true))
    .sort((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
  const picked = cand[spec.skip ?? 0];
  if (!picked) return { error: 'no candidate for ' + JSON.stringify(spec) };
  const door = picked.d, core = picked.core;
  out.door = { id: door.id, name: door.name, family: core.family, finish: core.finish, storeys: core.storeys };

  g.teleportPlayer(door.x, door.z); pump(door.x, door.z);
  const entered = await g.features.qa('interiors', 'enter', {});
  if (entered !== 'ok') return { error: 'enter: ' + entered };
  settle(8);
  const floorIndex = spec.floor ?? 0;
  if (floorIndex > 0) { await g.features.qa('interiors', 'floor', { n: floorIndex }); settle(6); }
  const plan = floorMod.solveFloor(door.facts, floorIndex, core);
  out.rooms = plan.rooms.map(r => r.kind).join(',');
  out.decor = JSON.stringify(plan.decor);
  const room = plan.rooms.find(r => r.kind === spec.room) ?? plan.rooms[0];
  out.room = room.kind;
  // Walk through the doorway to the room centre, the honest way.
  const walkTo = async (x, z, steps) => {
    for (let i = 0; i < steps; i++) {
      const r = await g.features.qa('interiors', 'walk', { x, z });
      if (typeof r === 'string' && !r.startsWith('ok')) return r;
      const [, lx, lz] = r.split('|');
      if (Math.hypot(parseFloat(lx) - x, parseFloat(lz) - z) < 0.35) break;
    }
    return 'ok';
  };
  await walkTo(core.corridorX, room.doorZ, 400);
  await walkTo(room.rect.x, room.rect.z, 400);
  settle(4);
  // Pose the camera high in the room's doorway corner looking across the room, so the furniture
  // and the walls are BOTH in frame regardless of chase-camera settle time.
  const toWorldPt = (lx, lz) => {
    const h = door.heading + Math.PI, c = Math.cos(h), s = Math.sin(h);
    return { x: door.facts.x + lx * c + lz * s, z: door.facts.z - lx * s + lz * c };
  };
  const floorY = p.y - 0.02;
  // Camera INSIDE the room, just past its doorway, looking across at the far half — walls, floor
  // and furniture all in frame, nothing between the lens and the room.
  const innerX = room.doorSide === 'left' ? core.corridorX + 1.65 : core.corridorX - 1.65;
  const camL = { x: innerX + (room.rect.x - innerX) * 0.3, z: room.doorZ + (room.rect.z - room.doorZ) * 0.3 };
  const aimL = { x: room.rect.x + (room.rect.x - innerX) * 0.35, z: room.rect.z };
  const cam = toWorldPt(camL.x, camL.z);
  const aim = toWorldPt(aimL.x, aimL.z);
  g.camera.position.set(cam.x, floorY + 2.6, cam.z);
  g.camera.lookAt(aim.x, floorY + 0.7, aim.z);
  snap(spec.tag);
  await g.features.qa('interiors', 'leave', {});
  return out;
}
"""

SPECS = [
    # The new pieces, walked to and photographed.
    {"tag": "dress-lounge-smart", "x": -2417, "z": -1551, "family": "suburban", "finish": "smart", "room": "lounge"},
    {"tag": "dress-bathroom", "x": -2417, "z": -1551, "family": "suburban", "finish": "smart", "minStoreys": 2, "floor": 1, "room": "bathroom"},
    {"tag": "dress-lounge-homely", "x": -2417, "z": -1551, "family": "suburban", "finish": "homely", "room": "lounge"},
    # Three suburban houses in one suburb — the palette/ornament spread on camera.
    {"tag": "dress-house-a", "x": 2792, "z": 1366, "family": "suburban", "room": "lounge", "skip": 0},
    {"tag": "dress-house-b", "x": 2792, "z": 1366, "family": "suburban", "room": "lounge", "skip": 1},
    {"tag": "dress-house-c", "x": 2792, "z": 1366, "family": "suburban", "room": "lounge", "skip": 2},
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
    for spec in SPECS:
        result = page.evaluate(JS, spec)
        if 'error' in result:
            print(spec['tag'], 'ERROR', result['error'])
            continue
        print(spec['tag'], result['door'], 'room:', result.get('room'), 'rooms:', result.get('rooms'), 'decor:', result.get('decor'))
        for name, data in result['shots'].items():
            Path(OUT, name + '.jpg').write_bytes(base64.b64decode(data.split(',', 1)[1]))
    browser.close()
