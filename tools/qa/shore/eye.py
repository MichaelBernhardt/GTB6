#!/usr/bin/env python3
"""D2/D3/D4 evidence: IN-ENGINE frames from player EYE HEIGHT, pitch 0, at the v5 placement.

Boots the real game headless (SwiftShader) against the worktree's vite dev server, teleports the
player to viewpoints derived from the SHIPPED map JSON, hides the player mesh, puts the camera at the
player's eye on a given azimuth with pitch 0 and renders through the game's own composer.
NO top-down map crops anywhere in this file.

Fog is forced to the density the owner plays at unless FOG=engine.

usage: eye.py <outdir> [cap|sand|dark|all]   env: PORT QUALITY FOG ONLY
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
SET = sys.argv[2] if len(sys.argv) > 2 else 'all'
PORT = os.environ.get('PORT', '5411')
QUALITY = os.environ.get('QUALITY', 'low')
FOGENV = os.environ.get('FOG', '0.00025')
FOG = None if FOGENV == 'engine' else float(FOGENV)
EYE = 1.30
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)

# name, px, pz, azimuth deg (270 = due west, 0 = north/-z), eye height, note
CAP = [
    # stand on the natural shore at the eastmost waterline and look dead west over the dam
    ('cap-w-zN3600', -2700, -3600, 270, EYE, 'widest reach: water -5540..-2764, cap 2840 u out'),
    ('cap-w-zN3800', -2590, -3800, 270, EYE, 'water -5603..-2651, cap 3013 u out'),
    ('cap-w-zN2800', -2830, -2800, 270, EYE, 'CONTROL: water ends at -4875, entirely inside the square'),
    ('cap-w-zN2200', -4590, -2200, 270, EYE, 'cap 1013 u out'),
    ('cap-w-zN2000', -4855, -2000, 270, EYE, 'WORST: cap wall only 748 u out'),
    ('cap-w-z400',   -4870,   400, 270, EYE, 'WORST: cap wall only 276 u out'),
    ('cap-w-z1400',  -4820,  1400, 270, EYE, 'cap 783 u out'),
    ('cap-w-z2000',  -4250,  2000, 270, EYE, 'S arm, cap 1289 u out'),
    ('cap-w-z4200',  -4835,  4200, 270, EYE, 'far south, cap 768 u out'),
    ('cap-w-z3200',  -3990,  3200, 270, EYE, 'S arm, water -4931..-4048'),
    # dry corners: land wraps over the head of the reach
    ('cap-nw-dry',   -4800, -4600, 250, EYE, 'dry NW veld, WSW over the head'),
    ('cap-sw-dry',   -4800,  4800, 290, EYE, 'dry SW veld, WNW over the head'),
    # obliques and along-edge, where a north-south closure would show
    ('cap-obl-nw',   -4600, -3200, 300, EYE, 'WNW along the north shore'),
    ('cap-obl-sw',   -4600,  3400, 240, EYE, 'WSW along the south shore'),
    ('cap-n-edge',   -4850, -1000,   0, EYE, 'due NORTH along the west edge'),
    ('cap-s-edge',   -4850,  1000, 180, EYE, 'due SOUTH along the west edge'),
    # worst case for a horizon line: higher eye
    ('cap-roof-zN3600', -2700, -3600, 270, 6.0, 'widest reach, bakkie-roof height'),
    ('cap-roof-z2000',  -4250,  2000, 270, 6.0, 'S arm, roof height'),
]

SAND = [
    ('sand-natural',       -2700, -3600, 270, EYE, 'NATURAL strand, waterline -2764, outside every beach band'),
    ('sand-natural-down',  -2700, -3600, 250, EYE, 'NATURAL strand, oblique so the strand fills the lower frame'),
    ('sand-natural2',      -4120,     0, 270, EYE, 'NATURAL strand z=0, waterline -4185'),
    ('sand-natural2-down', -4120,     0, 250, EYE, 'NATURAL strand z=0, oblique'),
    ('sand-natural3',      -4290,  2000, 270, EYE, 'NATURAL strand, S arm, waterline -4313'),
    ('sand-resort',        -3860, -2450, 270, EYE, 'MISTY BAY beach band z -2592..-2362'),
    ('sand-resort-down',   -3860, -2450, 250, EYE, 'MISTY BAY beach, oblique'),
    ('sand-resort2',       -2900, -3300, 270, EYE, 'LEBOYA BAY beach band z -3398..-3220'),
    ('sand-resort2-down',  -2900, -3300, 250, EYE, 'LEBOYA BAY beach, oblique'),
]

DARK = [
    ('dark-band-e',   -4300, -2000,  90, EYE, 'west band between shore and city, looking EAST'),
    ('dark-band-w',   -4300, -2000, 270, EYE, 'same spot, back over the water'),
    ('dark-band-n',   -4300, -2000,   0, EYE, 'same spot, north'),
    ('dark-ridge',    -4135, -2600,  90, EYE, 'ridge peninsula between two drowned valleys, east'),
    ('dark-ridge-n',  -4135, -2600,   0, EYE, 'same ridge, north up the peninsula'),
    ('dark-strip-e',  -4700,  -800,  90, EYE, 'dry strip at a latitude the dam misses, east'),
    ('dark-corridor', -3300,  1000,  90, EYE, 'farm corridor east of the shore, east'),
    ('dark-mistybay', -4371, -2477,  90, EYE, 'Misty Bay itself, looking east inland'),
    ('dark-veld-nw',  -4600, -4600,  90, EYE, 'NW veld looking east'),
    ('dark-veld-sw',  -4600,  4600,  90, EYE, 'SW veld looking east'),
    ('dark-night-e',  -4300, -2000,  90, EYE, 'NIGHT 22h: west band looking east'),
    ('dark-night-w',  -4300, -2000, 270, EYE, 'NIGHT 22h: over the water'),
    ('dark-night-strand', -4700, -800, 90, EYE, 'NIGHT 22h: ON the drawdown strand, east'),
    ('dark-night-misty',  -4371, -2477, 60, EYE, 'NIGHT 22h: Misty Bay street'),
    # CONTROLS: open veld the dam never touches, same hour, same camera
    ('dark-ctrl-veld',   3600,  3200,  90, EYE, 'CONTROL: open veld far east of the city'),
    ('dark-ctrl-veld2',  2400, -4200,  90, EYE, 'CONTROL: open veld north-east'),
    ('dark-night-ctrl',  3600,  3200,  90, EYE, 'NIGHT CONTROL: open veld far east'),
    ('dark-night-ctrl2', 2400, -4200,  90, EYE, 'NIGHT CONTROL: open veld north-east'),
]

VIEWS = {'cap': CAP, 'sand': SAND, 'dark': DARK, 'all': CAP + SAND + DARK}[SET]
ONLY = os.environ.get('ONLY')
if ONLY:
    keep = set(ONLY.split(','))
    VIEWS = [v for v in VIEWS if v[0] in keep]

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 1280, 'height': 720})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    print('booted', flush=True)

    env = pg.evaluate("""(fog) => { const g = window.__game;
      if (fog !== null) g.scene.fog.density = fog;
      g.player.group.visible = false;
      const f = g.scene.fog;
      return { quality: g.settings && g.settings.quality, fogDensity: f.density,
               fogColor: '#'+f.color.getHexString(), camFar: g.camera.far, camFov: g.camera.fov,
               hour: g.dayNight && g.dayNight.hour }; }""", FOG)
    print('ENV', json.dumps(env), flush=True)

    results = []

    def pump(hour):
        return pg.evaluate("""(hour) => { const g=window.__game; const p=g.player.group.position;
            if (g.dayNight) g.dayNight.hour = hour;
            let n=0; while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<25;i++) { if (g.dayNight) g.dayNight.hour = hour; g.update(1/60); }
            return n; }""", hour)

    FOGJS = 'null' if FOG is None else repr(FOG)
    SHOOT = """([az, ch]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible = false;
        const FOGV = %s; if (FOGV !== null) g.scene.fog.density = FOGV;
        const eyeY = p.y + ch;
        const a = az * Math.PI / 180;
        const dx = Math.sin(a), dz = -Math.cos(a);
        g.camera.position.set(p.x, eyeY, p.z);
        g.camera.lookAt(p.x + dx * 1000, eyeY, p.z + dz * 1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera);
        const url = g.renderer.domElement.toDataURL('image/png');
        const Vector3 = p.constructor;
        const Raycaster = Object.getPrototypeOf(g.combat.raycaster).constructor;
        const H = 720, fov = g.camera.fov * Math.PI / 180;
        const fan = [];
        for (let row = 250; row <= 500; row += 5) {
          const ndcY = 1 - 2 * (row / H);
          const ty = Math.tan(fov / 2) * ndcY;
          const dir = new Vector3(dx, ty, dz).normalize();
          const rc = new Raycaster(new Vector3(p.x, eyeY, p.z), dir, 0.5, 40000);
          const hits = rc.intersectObjects(g.scene.children, true).filter(h => h.object.visible && h.object.type === 'Mesh');
          const h = hits[0];
          fan.push(h ? { row, d: Math.round(h.distance), what: (h.object.name || (h.object.parent && h.object.parent.name) || h.object.type), y: +h.point.y.toFixed(1) } : { row, d: null, what: 'SKY' });
        }
        // what surface is the player actually standing on? (D3: two passes recoloured a sheet that
        // was buried under the ground mesh, so the palette must be attributed to a real top surface)
        const down = new Raycaster(new Vector3(p.x, p.y + 60, p.z), new Vector3(0,-1,0), 0.1, 400);
        const gh = down.intersectObjects(g.scene.children, true).filter(h => h.object.visible && h.object.type === 'Mesh')[0];
        let ground = null;
        if (gh) { const o = gh.object, m = o.material;
          const ca = o.geometry.getAttribute && o.geometry.getAttribute('color');
          let vc = null; if (ca && gh.face) vc = [ca.getX(gh.face.a), ca.getY(gh.face.a), ca.getZ(gh.face.a)].map(v => +v.toFixed(3));
          ground = { parent: o.parent && (o.parent.name || o.parent.type), mat: m && m.type, vcol: vc,
                     col: m && m.color ? '#'+m.color.getHexString() : null, y: +gh.point.y.toFixed(2) }; }
        const dir0 = new Vector3(dx, 0, dz).normalize();
        const rc0 = new Raycaster(new Vector3(p.x, eyeY, p.z), dir0, 0.5, 40000);
        const ahead = rc0.intersectObjects(g.scene.children, true)
          .filter(h => h.object.visible && h.object.type === 'Mesh')
          .slice(0, 8).map(h => ({ d: Math.round(h.distance), what: (h.object.name || (h.object.parent && h.object.parent.name) || h.object.type), y: +h.point.y.toFixed(2) }));
        return { url, ground, px: +p.x.toFixed(0), py: +p.y.toFixed(2), pz: +p.z.toFixed(0), eyeY: +eyeY.toFixed(2), fan, ahead,
                 fog: g.scene.fog.density, fogColor: '#'+g.scene.fog.color.getHexString(),
                 sky: g.scene.background && g.scene.background.isColor ? '#'+g.scene.background.getHexString() : 'texture' }; }""" % FOGJS

    for (name, px, pz, az, ch, note) in VIEWS:
        hour = 22 if 'night' in name else 12
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'d6')", [px, pz])
        pump(hour)
        pg.evaluate(SHOOT, [az, ch])   # throwaway: the sky dome snaps to the camera during a draw
        d = pg.evaluate(SHOOT, [az, ch])
        open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode(d['url'].split(',', 1)[1]))
        d.pop('url')
        d.update({'name': name, 'note': note, 'az': az, 'want': [px, pz], 'hour': hour})
        results.append(d)
        rows = ' '.join(f"{f['row']}:{(f['what'] or '?')[:9]}@{f['d']}" for f in d['fan'][::6])
        print(f"  {name}: at ({d['px']},{d['pz']}) feet={d['py']} eye={d['eyeY']} sky={d['sky']} fogc={d['fogColor']}\n"
              f"     ground={json.dumps(d.get('ground'))}\n     fan {rows}", flush=True)

    json.dump(results, open(f'{OUT}/views.json', 'w'), indent=1)
    br.close()
print('EYE DONE')
