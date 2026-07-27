#!/usr/bin/env python3
"""What is the single dark row sitting exactly on the horizon, and does anything shade it?

Renders the same eye-height frame four ways — as shipped, with the Water group hidden, with the sky
dome hidden, and with the far chunks hidden — and prints the luminance of rows 356..368 for each.
Also casts rays through the CENTRE of each of those rows (row + 0.5, which is what the rasteriser
samples) and reports what they hit and how far away.
usage: hairline.py <outdir>   env PORT
"""
import base64, json, os, sys
import numpy as np
from PIL import Image
from io import BytesIO
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5411')
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: 'low', masterVolume: 0}}))")
W = np.array([0.2126, 0.7152, 0.0722])
SPOTS = [('zN2000', -4855, -2000, 270), ('zN3800', -2590, -3800, 270)]

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 1280, 'height': 720})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    print('booted', flush=True)
    print('camera far =', pg.evaluate("() => window.__game.camera.far"), flush=True)

    SHOOT = """([az, hide]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible = false; g.scene.fog.density = 0.00025;
        const off = [];
        g.scene.traverse(o => {
          const nm = (o.name || '') + '|' + ((o.parent && o.parent.name) || '');
          if (hide === 'water' && o.parent && o.parent.name === 'Water' && o.visible) { o.visible = false; off.push(o); }
          if (hide === 'sky' && /Atmospheric Sky/.test(nm) && o.visible) { o.visible = false; off.push(o); }
          if (hide === 'far' && /chunk far/.test(nm) && o.visible) { o.visible = false; off.push(o); }
        });
        const eyeY = p.y + 1.30; const a = az*Math.PI/180;
        const dx = Math.sin(a), dz = -Math.cos(a);
        g.camera.position.set(p.x, eyeY, p.z);
        g.camera.lookAt(p.x + dx*1000, eyeY, p.z + dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera);
        const url = g.renderer.domElement.toDataURL('image/png');
        for (const o of off) o.visible = true;
        return { url, hidden: off.length }; }"""

    FAN = """([az]) => { const g=window.__game; const p=g.player.group.position;
        const eyeY = p.y + 1.30; const a = az*Math.PI/180;
        const dx = Math.sin(a), dz = -Math.cos(a);
        const Vector3 = p.constructor;
        const Raycaster = Object.getPrototypeOf(g.combat.raycaster).constructor;
        const H = 720, fov = g.camera.fov * Math.PI/180;
        const out = [];
        for (let k = 0; k <= 24; k++) {
          const row = 355 + k * 0.5;
          const ndcY = 1 - 2*((row + 0.5)/H);
          const ty = Math.tan(fov/2) * ndcY;
          const dir = new Vector3(dx, ty, dz).normalize();
          const rc = new Raycaster(new Vector3(p.x, eyeY, p.z), dir, 0.5, 60000);
          const hits = rc.intersectObjects(g.scene.children, true).filter(h => h.object.visible && h.object.type === 'Mesh');
          const h = hits[0];
          out.push({ row, what: h ? (h.object.name || (h.object.parent && h.object.parent.name) || h.object.type) : 'MISS',
                     d: h ? Math.round(h.distance) : null });
        }
        return out; }"""

    for (name, px, pz, az) in SPOTS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'hair')", [px, pz])
        pg.evaluate("""() => { const g=window.__game; const p=g.player.group.position;
            let n=0; while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<25;i++) g.update(1/60); }""")
        print(f'\n=== {name} ({px},{pz}) az {az}', flush=True)
        print('  sub-pixel ray fan:', flush=True)
        for f in pg.evaluate(FAN, [az]):
            print(f"    row {f['row']:6.1f}  {f['what']:20s} d={f['d']}", flush=True)
        prof = {}
        for hide in (None, 'water', 'sky', 'far'):
            pg.evaluate(SHOOT, [az, hide])
            d = pg.evaluate(SHOOT, [az, hide])
            png = base64.b64decode(d['url'].split(',', 1)[1])
            open(f'{OUT}/{name}-{hide or "shipped"}.png', 'wb').write(png)
            L = np.asarray(Image.open(BytesIO(png)).convert('RGB'), dtype=np.float64) @ W
            prof[hide or 'shipped'] = [round(float(L[y].mean()), 1) for y in range(354, 370)]
            print(f'  hide={hide or "-":8s} ({d["hidden"]} meshes) rows354-369: {prof[hide or "shipped"]}', flush=True)
    br.close()
print('HAIRLINE DONE')
