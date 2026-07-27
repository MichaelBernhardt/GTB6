#!/usr/bin/env python3
"""MEASURE THE SHORE PALETTE INSTEAD OF DERIVING IT.

Three passes have set coast.ts's albedos by inverting a transfer table on paper, and every one of
them landed somewhere else on screen: the table is only valid for the lighting it was sampled under,
and the lighting has moved twice (sun/hemisphere keyframes, then the veld going green). This script
re-samples the transfer with the game doing the rendering, so the numbers in coast.ts can be honest
about being measurements.

Two modes:

  calibrate.py out/            the TRANSFER. Paints every vertex of the shipped bed sheet a known
                               albedo, renders the frame through the game's own composer from a real
                               strand stand, reads the pixel back. Invert the printed table for the
                               screen colour you want.

  calibrate.py out/ --veld     the VELD MATCH. Same idea, but the question is "does the sheet's
                               inland fade arrive at the colour of the ground it abuts?" — so it
                               reads the sheet patch AND the neighbouring ground-mesh patch out of
                               ONE render and prints the RGB distance between them. VELD_TONE was 65
                               units off when this was written, which is a pale-green band lying
                               along the sheet's whole inland edge.

env: PORT QUALITY FOG.  Needs the dev server up and playwright + pillow installed.
"""
import base64, colorsys, json, os, sys
from playwright.sync_api import sync_playwright
from PIL import Image

OUT = sys.argv[1]
VELD_MODE = '--veld' in sys.argv[2:]
PORT = os.environ.get('PORT', '5601')
QUALITY = os.environ.get('QUALITY', 'low')
FOG = float(os.environ.get('FOG', '0.00025'))
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)

# TRANSFER mode: greys spanning the strand's range, then a few biased candidates. The sheet is lit by
# a warm sun over a green hemisphere bounce, so a NEUTRAL albedo already renders at hue ~35, sat ~0.28.
GREYS = [0.020, 0.030, 0.042, 0.055, 0.068, 0.085, 0.105, 0.130]
BIASED = [(0.067, 0.064, 0.059), (0.094, 0.093, 0.090), (0.060, 0.054, 0.044), (0.074, 0.064, 0.048)]
# VELD mode: candidates around the ground mesh's measured tone.
VELD_CANDS = [(0.078, 0.215, 0.018), (0.081, 0.212, 0.022), (0.085, 0.210, 0.025),
              (0.095, 0.224, 0.031), (0.164, 0.285, 0.121)]

# name, x, z, azimuth, eye height. TRANSFER stands on the natural strand at z=0; VELD stands at the
# NW dry corner, where the sheet's inland edge and the ground mesh are both in frame.
STAND = (-4800, -4600, 250, 1.30) if VELD_MODE else (-4120, 0, 250, 1.30)
STRAND_BOX = (520, 780, 600, 700)    # transfer mode: the strand under the player's feet
SHEET_BOX = (500, 800, 395, 432)     # veld mode: the sheet side of the seam
GROUND_BOX = (500, 800, 448, 520)    # veld mode: the ground-mesh side


def patch(im, box):
    x0, x1, y0, y1 = box
    acc = [0, 0, 0]; n = 0
    for y in range(y0, y1, 3):
        for x in range(x0, x1, 6):
            q = im.getpixel((x, y)); acc = [acc[0] + q[0], acc[1] + q[1], acc[2] + q[2]]; n += 1
    r, g, b = [v / n for v in acc]
    hh, ss, vv = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return (r, g, b, hh * 360, ss, vv)


with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 1280, 'height': 720})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    px, pz, az, ch = STAND
    pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'calibrate')", [px, pz])
    pg.evaluate("""(fog) => { const g=window.__game; g.scene.fog.density=fog; g.player.group.visible=false;
        const p=g.player.group.position; let n=0;
        while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
        for (let i=0;i<25;i++){ g.dayNight.hour=12; g.update(1/60); } }""", FOG)

    # the bed sheet is the biggest vertex-coloured mesh in the scene (115k verts); keep a copy of its
    # colours so a run leaves the page as it found it.
    found = pg.evaluate("""() => { const g=window.__game; let best=null;
        g.scene.traverse((o)=>{ if(!o.isMesh) return; const m=o.material, ga=o.geometry.getAttribute && o.geometry.getAttribute('color');
          if(!m||!ga||!m.vertexColors) return; if(!best||ga.count>best.n) best={n:ga.count,uuid:o.uuid}; });
        window.__bed=null; g.scene.traverse((o)=>{ if(best&&o.uuid===best.uuid) window.__bed=o; });
        if (window.__bed) window.__bedOrig = Float32Array.from(window.__bed.geometry.getAttribute('color').array);
        return best; }""")
    print('BED SHEET', json.dumps(found), flush=True)
    if not found:
        raise SystemExit('no vertex-coloured bed sheet in the scene — is OCEAN_POLYGON present?')

    SHOOT = """([az, ch, fog]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible=false; g.scene.fog.density=fog;
        const eyeY=p.y+ch, a=az*Math.PI/180, dx=Math.sin(a), dz=-Math.cos(a);
        g.camera.position.set(p.x,eyeY,p.z); g.camera.lookAt(p.x+dx*1000, eyeY, p.z+dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene,g.camera);
        return g.renderer.domElement.toDataURL('image/png'); }"""

    def render(tag):
        url = pg.evaluate(SHOOT, [az, ch, FOG])
        path = f'{OUT}/{tag}.png'
        open(path, 'wb').write(base64.b64decode(url.split(',', 1)[1]))
        return Image.open(path).convert('RGB')

    def paint(rgb):
        pg.evaluate("""(c) => { const a=window.__bed.geometry.getAttribute('color');
            for (let i=0;i<a.count;i++) a.setXYZ(i,c[0],c[1],c[2]); a.needsUpdate=true; }""", list(rgb))

    rows = []
    pg.evaluate(SHOOT, [az, ch, FOG])   # throwaway: the sky dome snaps to the camera during a draw
    if VELD_MODE:
        print('  VELD MATCH — sheet patch vs the ground mesh it abuts, same frame', flush=True)
        for tag, cand in [('shipped', None)] + [('veld-%.3f-%.3f-%.3f' % c, c) for c in VELD_CANDS]:
            if cand:
                paint(cand)
            im = render(tag)
            s = patch(im, SHEET_BOX); gnd = patch(im, GROUND_BOX)
            dist = sum((s[i] - gnd[i]) ** 2 for i in range(3)) ** 0.5
            rows.append({'tag': tag, 'sheet': [round(v, 1) for v in s[:3]], 'ground': [round(v, 1) for v in gnd[:3]], 'dist': round(dist, 1)})
            print(f"  {tag:26s} sheet rgb({s[0]:.0f},{s[1]:.0f},{s[2]:.0f}) | ground rgb({gnd[0]:.0f},{gnd[1]:.0f},{gnd[2]:.0f}) | dist {dist:5.1f}", flush=True)
    else:
        print('  TRANSFER — albedo in, sRGB pixel out, through the game composer', flush=True)
        for alb in [(g, g, g) for g in GREYS] + BIASED:
            paint(alb)
            im = render('a%.3f-%.3f-%.3f' % alb)
            r, g_, b, hue, sat, val = patch(im, STRAND_BOX)
            rows.append({'albedo': alb, 'rgb': [round(r), round(g_), round(b)], 'hue': round(hue), 'sat': round(sat, 3), 'val': round(val, 3)})
            print(f"  albedo {alb} -> rgb({r:.0f},{g_:.0f},{b:.0f}) hue {hue:3.0f} sat {sat:.3f} val {val:.3f}", flush=True)

    pg.evaluate("""() => { if (!window.__bedOrig) return; const a=window.__bed.geometry.getAttribute('color');
        a.array.set(window.__bedOrig); a.needsUpdate=true; }""")
    json.dump(rows, open(f'{OUT}/calibrate.json', 'w'), indent=1)
    br.close()
print('CALIBRATE DONE')
