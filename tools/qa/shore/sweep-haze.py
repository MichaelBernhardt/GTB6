#!/usr/bin/env python3
"""In-engine sweep of the ocean haze constants, scored on the D2 hard-edge metric.

One teleport per viewpoint, then every candidate rendered from that same standpoint (setHaze only
touches uniforms), so the expensive chunk pump happens four times, not once per candidate.

  step14  largest LEVEL luminance step over any 1..14 px window (the brief's own unit)
  step2   largest 2 px step                                     (what a drawn line actually is)
  dSky    sky luminance at the row above the water minus the first water row
  sepLand far-water luminance minus the strand below it: the lake must stay a lake

usage: sweep2.py <outdir>
"""
import base64, json, os, sys
import numpy as np
from PIL import Image
from io import BytesIO
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5411')
FOG = 0.00025
EYE = 1.30
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: 'low', masterVolume: 0}}))")
W = np.array([0.2126, 0.7152, 0.0722])

SPOTS = [('zN2000', -4855, -2000, 270), ('z400', -4870, 400, 270),
         ('zN3800', -2590, -3800, 270), ('z1400', -4820, 1400, 270)]

CANDS = [(0.0018, 0.65, 14), (0.0018, 0.78, 7), (0.0026, 0.70, 7), (0.0026, 0.78, 5), (0.0026, 0.78, 7),
         (0.0026, 0.78, 10), (0.0026, 0.86, 7), (0.0036, 0.78, 7), (0.0036, 0.86, 5), (0.0050, 0.86, 5)]
KEEP = {(0.0018, 0.65, 14), (0.0026, 0.78, 7), (0.0036, 0.86, 5), (0.0050, 0.86, 5)}


def score(png):
    L = np.asarray(Image.open(BytesIO(png)).convert('RGB'), dtype=np.float64) @ W
    H = L.shape[0]
    rows = L.mean(axis=1)
    y0, y1 = int(H * 0.10), int(H * 0.80)
    best14 = 0.0
    for w in range(1, 15):
        d = rows[y0:y1 - w] - rows[y0 + w:y1]
        if d.size:
            best14 = max(best14, float(np.abs(d).max()))
    d2 = rows[y0:y1 - 2] - rows[y0 + 2:y1]
    best2 = float(np.abs(d2).max()) if d2.size else 0.0
    # sky at 350, water just below the horizon, strand at 700
    return best14, best2, float(rows[350]), float(rows[364]), float(rows[700])


with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 1280, 'height': 720})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    ok = pg.evaluate("() => { const c = window.__game.city; return !!(c.waterHandle && c.waterHandle.setHaze); }")
    print('booted, setHaze reachable =', ok, flush=True)

    SHOOT = """([az, ch, den, sky, graze]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible = false; g.scene.fog.density = %f;
        g.city.waterHandle.setHaze(den, sky, graze);
        const eyeY = p.y + ch; const a = az*Math.PI/180;
        const dx = Math.sin(a), dz = -Math.cos(a);
        g.camera.position.set(p.x, eyeY, p.z);
        g.camera.lookAt(p.x + dx*1000, eyeY, p.z + dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera);
        return g.renderer.domElement.toDataURL('image/png'); }""" % FOG

    table = {c: [] for c in CANDS}
    for (name, px, pz, az) in SPOTS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'sweep')", [px, pz])
        pg.evaluate("""() => { const g=window.__game; const p=g.player.group.position;
            let n=0; while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<25;i++) g.update(1/60); }""")
        pg.evaluate(SHOOT, [az, EYE, 0.0018, 0.65, 14])   # throwaway: sky dome snaps to the camera on draw
        for c in CANDS:
            url = pg.evaluate(SHOOT, [az, EYE, c[0], c[1], c[2]])
            png = base64.b64decode(url.split(',', 1)[1])
            table[c].append(score(png))
            if c in KEEP:
                open(f'{OUT}/{name}-d{c[0]}-s{c[1]}-g{c[2]}.png', 'wb').write(png)
        print(f'  {name} done', flush=True)

    rows = []
    print(f'\n{"den":>7s} {"sky":>5s} {"grz":>4s} | {"worst14":>8s} {"mean14":>7s} {"worst2":>7s} | {"dSky":>6s} {"sepLand":>8s}')
    for c in CANDS:
        s = table[c]
        w14 = max(x[0] for x in s); m14 = float(np.mean([x[0] for x in s])); w2 = max(x[1] for x in s)
        dsky = float(np.mean([x[2] - x[3] for x in s])); sep = float(np.mean([x[3] - x[4] for x in s]))
        rows.append({'den': c[0], 'sky': c[1], 'graze': c[2], 'worst14': round(w14, 1), 'mean14': round(m14, 1),
                     'worst2': round(w2, 1), 'dSky': round(dsky, 1), 'sepLand': round(sep, 1)})
        print(f'{c[0]:7.4f} {c[1]:5.2f} {c[2]:4d} | {w14:8.1f} {m14:7.1f} {w2:7.1f} | {dsky:6.1f} {sep:8.1f}', flush=True)
    json.dump(rows, open(f'{OUT}/sweep.json', 'w'), indent=1)
    br.close()
print('SWEEP DONE')
