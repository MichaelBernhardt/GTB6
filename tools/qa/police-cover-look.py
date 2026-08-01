#!/usr/bin/env python3
"""DO ARREST OFFICERS ACTUALLY TAKE COVER BEHIND THEIR CRUISER — AND DOES IT READ?

Provokes a two-star on-foot arrest at the CBD spawn through the real systems (a cop-witnessed
crime, the real wanted/knowledge/police state machines, real ped updates), then reports the AI
STATE alongside the screenshots — a pose bug and a logic bug look identical in a picture, so both
are captured:

  1. STATE LOG each burst: every cruiser (distance, speed, crew out) and every officer
     (state, takingCover, aimingWeapon, distance to player).
  2. FRAMES once cover forms: over-the-shoulder from the player, a low side profile of a ducked
     officer (crouch + drawn pistol are only legible side-on), a muzzle-flash frame caught by
     single-stepping until a flash goes live, and a top-down of the whole scene geometry.

usage: police-cover-look.py <outdir>    env: PORT HOST QUALITY
"""
import base64, os, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
HOST = os.environ.get('HOST', '127.0.0.1')
PORT = os.environ.get('PORT', '5271')
QUALITY = os.environ.get('QUALITY', 'low')
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)
W, H = 1280, 720

SUPPRESS = """() => { const g = window.__game;
    window.__realRender = { composer: g.composer ? g.composer.render.bind(g.composer) : null,
                            renderer: g.renderer.render.bind(g.renderer) };
    if (g.composer) g.composer.render = () => {};
    g.renderer.render = () => {}; }"""

PROVOKE = """() => { const g = window.__game; const p = g.player.group.position;
    try { let n = 0; while (n < 400) { g.city.updateBuildingChunks(p.x, p.z); n++; } } catch (e) {}
    g.dayNight.hour = 11;
    g.wanted.addCrime(40);
    g.knowledge.copWitness(p.x, p.z); }"""

BURST = """(frames) => { const g = window.__game; const p = g.player.group.position;
    for (let i = 0; i < frames; i++) { g.player.health = 200; g.dayNight.hour = 11; g.update(1 / 30); }
    const cars = g.police.vehicles.map((v) => ({ d: +v.group.position.distanceTo(p).toFixed(1),
        v: +Math.abs(v.speed).toFixed(1), crewOut: !v.occupied }));
    const cover = g.police.coverAssignments().map(({ ped, car }) => ({
        state: ped.state, takingCover: ped.takingCover, aiming: ped.aimingWeapon,
        rig: ped.riggedVisual ? ped.riggedVisual.status : 'none',
        dPlayer: +ped.group.position.distanceTo(p).toFixed(1),
        x: +ped.group.position.x.toFixed(1), y: +ped.group.position.y.toFixed(2), z: +ped.group.position.z.toFixed(1),
        carX: +car.group.position.x.toFixed(1), carZ: +car.group.position.z.toFixed(1) }));
    return { wanted: g.wanted.level, cars, cover, px: +p.x.toFixed(1), py: +p.y.toFixed(2), pz: +p.z.toFixed(1) }; }"""

SHOOT = """([cx, cy, cz, tx, ty, tz]) => { const g = window.__game; const r = window.__realRender;
    g.player.group.visible = false; // the camera often stands in the player's skull otherwise
    g.camera.position.set(cx, cy, cz);
    g.camera.lookAt(tx, ty, tz);
    g.camera.updateMatrixWorld();
    if (g.composer && r.composer) { g.composer.render = r.composer; g.composer.render(); g.composer.render = () => {}; }
    else { g.renderer.render = r.renderer; g.renderer.render(g.scene, g.camera); g.renderer.render = () => {}; }
    return g.renderer.domElement.toDataURL('image/png'); }"""

# Single-step until a muzzle flash is live this frame (police fire cadence is ~1-2s per officer).
FLASH_HUNT = """() => { const g = window.__game;
    for (let i = 0; i < 900; i++) {
      g.player.health = 200; g.update(1 / 30);
      const live = (g.police.flashes || []).some((f) => f.ttl > 0.03 && f.mesh.visible);
      if (live) return true;
    }
    return false; }"""


def save(name, url):
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(base64.b64decode(url.split(',', 1)[1]))
    print(f'  saved {name}')


with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': W, 'height': H})
    pg.add_init_script(SEED)
    pg.goto(f'http://{HOST}:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    pg.evaluate(SUPPRESS)
    pg.evaluate(PROVOKE)

    snap = None
    for burst in range(40):  # up to ~80s of sim at 60 frames/burst
        snap = pg.evaluate(BURST, 60)
        print(f"burst {burst}: wanted={snap['wanted']} cars={snap['cars']} cover={snap['cover']}")
        # Wait for cover AND the rigged JMPD models: the GLTF loads async, and a screenshot of the
        # capsule fallback proves nothing about the pose the owner will actually see.
        if len(snap['cover']) >= 2 and all(o['rig'] == 'ready' for o in snap['cover']):
            break
        pg.wait_for_timeout(500)  # give the async template load real wall-clock time between bursts
    if not snap or len(snap['cover']) < 2:
        print('NO COVER FORMED — investigate before trusting any screenshot'); sys.exit(2)
    if any(o['rig'] != 'ready' for o in snap['cover']):
        print('WARNING: rigged visual never became ready — screenshots show the procedural fallback')

    px, py, pz = snap['px'], snap['py'], snap['pz']
    officer = snap['cover'][0]
    ox, oy, oz = officer['x'], officer['y'], officer['z']
    cx, cz = officer['carX'], officer['carZ']

    # Over the shoulder: what the suspect sees — heads and pistols over the bodywork.
    save('1-from-player.png', pg.evaluate(SHOOT, [px, py + 1.6, pz, cx, oy + 1.0, cz]))
    # Side profile of the ducked officer: crouch depth and the drawn pistol are only legible side-on.
    perp_x, perp_z = -(cz - pz), (cx - px)
    n = (perp_x ** 2 + perp_z ** 2) ** 0.5 or 1
    save('2-officer-side.png', pg.evaluate(SHOOT, [ox + perp_x / n * 6, oy + 1.2, oz + perp_z / n * 6, ox, oy + 0.9, oz]))
    # Whole-scene geometry from the air: both officers on the far side, distinct slots.
    save('3-top-down.png', pg.evaluate(SHOOT, [cx, oy + 30, cz + 0.1, cx, oy, cz]))
    # A live muzzle-flash frame, from the player's point of view.
    if pg.evaluate(FLASH_HUNT):
        state = pg.evaluate(BURST, 0)
        if state['cover']:
            o2 = state['cover'][0]
            save('4-muzzle-flash.png', pg.evaluate(SHOOT, [px, py + 1.6, pz, o2['x'], o2['y'] + 1.1, o2['z']]))
        else:
            save('4-muzzle-flash.png', pg.evaluate(SHOOT, [px, py + 1.6, pz, ox, oy + 1.1, oz]))
    else:
        print('  no muzzle flash caught in 900 frames — check officer fire')
    print('final state:', pg.evaluate(BURST, 0))
    br.close()
