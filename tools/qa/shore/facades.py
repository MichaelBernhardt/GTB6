#!/usr/bin/env python3
"""D4 evidence: does the facade-material cache grow after boot, and are the late ones lit at night?

Counts City's facade materials at boot, then again after streaming the dam shore, and reports how
many of them carry a non-zero emissiveIntensity at 22:00. Under the old snapshot, the count grows and
the newcomers stay at 0 forever.
usage: facades.py   env PORT
"""
import json, os
from playwright.sync_api import sync_playwright

PORT = os.environ.get('PORT', '5411')
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: 'low', masterVolume: 0}}))")

TOUR = [(-4371, -2477), (-4300, -2000), (-3860, -2450), (-4700, -800), (-3300, 1000), (-3846, 2170), (-4600, 4600)]

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 640, 'height': 360})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)

    STATS = """() => { const g = window.__game; const mats = g.city.facadeMaterials();
        return { n: mats.length, lit: mats.filter(m => m.emissiveIntensity > 0.01).length,
                 dark: mats.filter(m => m.emissiveIntensity <= 0.01).length,
                 hour: g.dayNight.hour }; }"""

    pg.evaluate("() => { const g=window.__game; g.dayNight.hour = 22; for (let i=0;i<20;i++) { g.dayNight.hour = 22; g.update(1/60); } }")
    boot = pg.evaluate(STATS)
    print('at boot, 22:00 :', json.dumps(boot), flush=True)

    for (x, z) in TOUR:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'fac')", [x, z])
        pg.evaluate("""() => { const g=window.__game; const p=g.player.group.position;
            let n=0; while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<20;i++) { g.dayNight.hour = 22; g.update(1/60); } }""")
        s = pg.evaluate(STATS)
        print(f'  after ({x},{z}): {json.dumps(s)}', flush=True)

    # and the decisive one: freeze the cycle, stream a fresh area, and see whether the new material lit up
    print('FINAL', json.dumps(pg.evaluate(STATS)), flush=True)
    br.close()
