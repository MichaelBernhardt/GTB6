#!/usr/bin/env python3
"""Render the SAME aerial frame several ways to attribute the dark jagged shapes.

usage: attrib.py <outdir>   env: PORT QUALITY
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5477')
QUALITY = os.environ.get('QUALITY', 'low')
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)

VARIANTS = [
    ('base',      "() => {}"),
    ('noshadow',  "() => { const g=window.__game; g.renderer.shadowMap.enabled=false; g.scene.traverse(o=>{ if(o.material){ const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>m.needsUpdate=true);} }); }"),
    ('nowater',   "() => { const g=window.__game; const w=g.scene.getObjectByName('Water'); if(w) w.visible=false; }"),
    ('nofog',     "() => { const g=window.__game; g.scene.fog.density=0.0000001; }"),
]
RESTORE = [
    ('base',      "() => {}"),
    ('noshadow',  "() => { const g=window.__game; g.renderer.shadowMap.enabled=true; g.scene.traverse(o=>{ if(o.material){ const ms=Array.isArray(o.material)?o.material:[o.material]; ms.forEach(m=>m.needsUpdate=true);} }); }"),
    ('nowater',   "() => { const g=window.__game; const w=g.scene.getObjectByName('Water'); if(w) w.visible=true; }"),
    ('nofog',     "() => { window.__game.scene.fog.density=0.00025; }"),
]

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 960, 'height': 540})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    print('booted', flush=True)
    pg.evaluate("() => { const g=window.__game; g.scene.fog.density=0.00025; g.player.group.visible=false; }")

    info = pg.evaluate("""() => { const g=window.__game;
      const out={ shadowMap: g.renderer.shadowMap.enabled, type: g.renderer.shadowMap.type, lights: [] };
      g.scene.traverse(o=>{ if(o.isLight) out.lights.push({ t:o.type, cast:o.castShadow,
        int:o.intensity, col:'#'+(o.color?o.color.getHexString():''),
        pos:[Math.round(o.position.x),Math.round(o.position.y),Math.round(o.position.z)],
        cam: o.shadow ? { l:o.shadow.camera.left, r:o.shadow.camera.right, t:o.shadow.camera.top, b:o.shadow.camera.bottom,
                          n:o.shadow.camera.near, f:o.shadow.camera.far, bias:o.shadow.bias, nb:o.shadow.normalBias,
                          map:o.shadow.mapSize.x } : null }); });
      return out; }""")
    print('LIGHTS', json.dumps(info, indent=1), flush=True)

    pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'attrib')", [-3700, -2000])
    pg.evaluate("""() => { const g=window.__game; const p=g.player.group.position;
        g.dayNight.hour=12; let n=0;
        while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
        for (let i=0;i<25;i++) { g.dayNight.hour=12; g.update(1/60); } }""")

    SHOOT = """() => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible=false;
        const eyeY=p.y+260, a=300*Math.PI/180, t=-18*Math.PI/180;
        const dx=Math.sin(a)*Math.cos(t), dz=-Math.cos(a)*Math.cos(t), dy=Math.sin(t);
        g.camera.position.set(p.x,eyeY,p.z);
        g.camera.lookAt(p.x+dx*1000, eyeY+dy*1000, p.z+dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene,g.camera);
        return g.renderer.domElement.toDataURL('image/png'); }"""

    for (name, setup), (_, undo) in zip(VARIANTS, RESTORE):
        pg.evaluate(setup)
        pg.evaluate(SHOOT)
        url = pg.evaluate(SHOOT)
        open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode(url.split(',', 1)[1]))
        pg.evaluate(undo)
        print('shot', name, flush=True)
    br.close()
print('ATTRIB DONE')
