#!/usr/bin/env python3
"""PLATFORM CENSUS off the city's COLLIDER LIST.

Every platform slab pushes exactly one collider as it is built (City.buildRailwayStation), and that
list is a plain array on the City: no geometry merge folds it, no distance culling hides it, no chunk
streaming detaches it. Counting the colliders whose footprint sits at a station's slab positions is
therefore the exact answer to "did that side get built", which ray-casting the merged, culled scene
is not.

usage: platforms.py     env: PORT SITES QUALITY
"""
import json, os
from playwright.sync_api import sync_playwright

PORT = os.environ.get('PORT', '5480')
SITES = os.environ.get('SITES', 'stations.json')
QUALITY = os.environ.get('QUALITY', 'low')
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)

COUNT = """([sites, offset]) => {
    const cols = window.__game.city.colliders;
    return sites.map((site) => {
      const heading = Math.atan2(site.dirX, site.dirZ), c = Math.cos(heading), s = Math.sin(heading);
      const sides = [-1, 1].map((side) => {
        const lx = side * offset;
        const wx = site.x + lx * c, wz = site.z - lx * s;   // slab centre in world space
        // A platform collider is ~3.6 x (46 or 58) and centred on that point.
        return cols.some((k) => {
          const cx = (k.minX + k.maxX) / 2, cz = (k.minZ + k.maxZ) / 2;
          if (Math.hypot(cx - wx, cz - wz) > 1.5) return false;
          const hw = k.hw !== undefined ? k.hw : (k.maxX - k.minX) / 2;
          const hd = k.hd !== undefined ? k.hd : (k.maxZ - k.minZ) / 2;
          const short = Math.min(hw, hd) * 2, long = Math.max(hw, hd) * 2;
          return Math.abs(short - 3.6) < 0.3 && long > 40;
        });
      });
      return { name: site.name, x: +site.x.toFixed(0), z: +site.z.toFixed(0), sides };
    }); }"""

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': 640, 'height': 360})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    sites = json.load(open(SITES))
    rows = pg.evaluate(COUNT, [sites['sites'], sites['offset']])
    whole = 0
    for r in rows:
        built = sum(1 for v in r['sides'] if v)
        whole += 1 if built == 2 else 0
        flag = '' if built == 2 else '   <== A SIDE IS MISSING'
        print(f"  {r['name']:<34} ({r['x']:>6},{r['z']:>6})  platforms {built} of 2{flag}", flush=True)
    print(f"  stations with BOTH platforms: {whole} of {len(rows)}", flush=True)
    br.close()
