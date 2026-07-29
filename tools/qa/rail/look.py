#!/usr/bin/env python3
"""IS THE RAIL CLEAR OF THE ROAD, AND ARE BOTH FULLY DRAWN?

In-engine frames through the game's own renderer, plus two machine checks a screenshot cannot fake.
Both work by firing a ray straight DOWN and reporting how high the top surface sits above the
terrain, because that number identifies the surface outright:

    0.00 bare ground   0.09 ballast   0.15 tar   0.21 ballast riding over tar
    0.37 pavement      ~0.35+ platform slab

Names would read better and are not available: mergeStaticGeometry folds the whole city into one mesh
per material at boot and takes every mesh name with it. Heights survive the merge, and the height
order IS the question — "partially covered" is a claim about which sheet ends up on top.

  1. SURFACE TRANSECTS walk that ray across the corridor, so the cross-section prints as a profile:
     road, open ground, ballast.
  2. PLATFORM CENSUS fires it down both slab centrelines of every station. A platform stands ~0.35
     proud of the ground; a missing side reads as ballast or bare ground.

usage: look.py <outdir>    env: PORT QUALITY ONLY SITES VIEWS TRANSECTS
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5480')
QUALITY = os.environ.get('QUALITY', 'low')
SITES = os.environ.get('SITES', 'stations.json')
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)
W, H = 1280, 720
PLATFORM_MIN_RISE = 0.30   # a slab top is ~0.35 over the terrain; below this it is not a platform

def _env_list(name, default):
    raw = os.environ.get(name)
    return default if raw is None else json.loads(raw)


# name, stand x, stand z, look-at x, look-at z, pitch, eye-above-feet, note
VIEWS = _env_list('VIEWS', [
    ['owner-eye',      -449.1, 1543.2,  -465.8, 1633.6,  -1, 1.30,
     "THE OWNER'S STAND (-449.1,1543.2), eye height, facing the track"],
    ['owner-across',   -459.4, 1599.2,  -468.6, 1649.3,  -6, 1.60,
     'ACROSS the corridor: ballast at ~35 u, Albertina Sisulu Road behind it'],
    ['owner-air',      -449.1, 1543.2,  -467.0, 1640.0, -35, 90.0,
     'AIR over the same corridor'],
    ['grosvenor-road', -583.5, 1651.6,  -567.3, 1609.6,  -2, 1.60,
     'GROSVENOR from the ROAD SIDE - the side whose platform was missing'],
    ['grosvenor-far',  -551.1, 1567.6,  -567.3, 1609.6,  -2, 1.60,
     'GROSVENOR from the far side'],
    ['grosvenor-air',  -600.0, 1660.0,  -567.3, 1609.6, -40, 70.0,
     'GROSVENOR from the air: both platforms in one frame'],
    ['braam-side',      846.6, 1272.5,   840.9, 1227.9,  -2, 1.60,
     'BRAAMFONTEIN STATION, the comparison stop, from the same angle'],
    ['braam-air',       880.0, 1275.0,   840.9, 1227.9, -40, 70.0,
     'BRAAMFONTEIN from the air: both platforms'],
    ['crossing',         22.5, 1691.8,    15.6, 1731.2,  -3, 2.20,
     'LEVEL CROSSING on the main line, from a driver eye height'],
    ['crossing-air',     40.0, 1690.0,    15.6, 1731.2, -35, 55.0,
     'the same crossing from the air'],
    ['park-rail',      2814.0, -743.0,  2789.4, -743.2,  -8, 1.60,
     'BALLAST INSIDE The Wilds Nature Reserve - the drape the bed used to vanish under'],
])

# name, origin x, origin z, unit dx, unit dz, from, to, step, note
TRANSECTS = _env_list('TRANSECTS', [
    ['owner-corridor', -465.75, 1633.63, 0.1808, -0.9835, -34, 16, 2,
     'ACROSS the Grosvenor corridor: Albertina Sisulu Road, open ground, then the ballast'],
    ['grosvenor', -567.3, 1609.6, -0.359, 0.933, -14, 14, 1,
     'ACROSS Grosvenor Station: platform, ballast, platform'],
    ['crossing', 15.6, 1731.2, -0.173, 0.985, -20, 20, 2,
     'ALONG the road through the level crossing: tar, ballast over it, tar'],
    ['park-rail', 2789.4, -743.2, 0.985, 0.173, -12, 12, 1,
     'ACROSS the ballast inside The Wilds: lawn, ballast, lawn'],
])

ONLY = os.environ.get('ONLY')
if ONLY:
    VIEWS = [v for v in VIEWS if v[0] in set(ONLY.split(','))]

DOWN_RAY = """
    const Vector3 = window.__game.player.group.position.constructor;
    const Raycaster = Object.getPrototypeOf(window.__game.combat.raycaster).constructor;
    const overTerrain = (x, z) => {
      const g = window.__game;
      const rc = new Raycaster(new Vector3(x, 600, z), new Vector3(0, -1, 0), 0.1, 1200);
      // Deliberately NOT filtered on `visible`: the question is what was BUILT, and the chunk a
      // station sits in may be distance-culled at the moment the ray is cast.
      const h = rc.intersectObjects(g.scene.children, true).filter((q) => q.object.isMesh)[0];
      return h ? { over: h.point.y - g.city.terrainHeightAt(x, z), y: h.point.y } : null;
    };
"""

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': W, 'height': H})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    pg.evaluate("() => { window.__game.player.group.visible = false; }")

    def pump(hour=11):
        pg.evaluate("""(hour) => { const g=window.__game; const p=g.player.group.position;
            g.dayNight.hour=hour; let n=0;
            while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<25;i++) { g.dayNight.hour=hour; g.update(1/60); } }""", hour)

    SHOOT = """([tx, tz, pitch, ch]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible=false;
        const eyeY=p.y+ch;
        const ax=tx-p.x, az=tz-p.z, ah=Math.hypot(ax,az)||1;
        const t=pitch*Math.PI/180, ct=Math.cos(t);
        const dx=(ax/ah)*ct, dz=(az/ah)*ct, dy=Math.sin(t);
        g.camera.position.set(p.x,eyeY,p.z);
        g.camera.lookAt(p.x+dx*1000, eyeY+dy*1000, p.z+dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene,g.camera);
        return { url: g.renderer.domElement.toDataURL('image/png'),
                 px:+p.x.toFixed(1), py:+p.y.toFixed(2), pz:+p.z.toFixed(1), eyeY:+eyeY.toFixed(2) }; }"""

    TRANSECT = """([x0, z0, dx, dz, a, b, step]) => {
        %s
        const out=[];
        for (let t=a; t<=b+1e-9; t+=step) {
          const x=x0+dx*t, z=z0+dz*t; const hit=overTerrain(x,z);
          out.push({ t:+t.toFixed(1), x:+x.toFixed(1), z:+z.toFixed(1),
                     over: hit?+hit.over.toFixed(3):null, y: hit?+hit.y.toFixed(3):null });
        }
        return out; }""" % DOWN_RAY

    CENSUS = """([site, offset]) => {
        %s
        // Un-cull first: the chunk a station sits in is distance-culled when the probe stands
        // elsewhere, and three's raycaster skips invisible objects. The question is what was BUILT.
        window.__game.city.group.traverse((o) => { if (o.userData && o.userData.chunk) o.visible = true; });
        const heading=Math.atan2(site.dirX, site.dirZ), c=Math.cos(heading), sn=Math.sin(heading);
        const sides=[-1,1].map((side)=>{
          let best=-1;
          for (let lz=-site.length/2+4; lz<=site.length/2-4; lz+=6) {
            const lx=side*offset;
            const hit=overTerrain(site.x+lx*c+lz*sn, site.z-lx*sn+lz*c);
            if (hit && hit.over>best) best=hit.over;
          }
          return +best.toFixed(3);
        });
        return { name:site.name, x:+site.x.toFixed(0), z:+site.z.toFixed(0), sides }; }""" % DOWN_RAY

    results = []
    for (name, px, pz, tx, tz, pitch, ch, note) in VIEWS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [px, pz])
        pump()
        pg.evaluate(SHOOT, [tx, tz, pitch, ch])   # warm the frame, then take the real one
        d = pg.evaluate(SHOOT, [tx, tz, pitch, ch])
        open(f'{OUT}/{name}.png', 'wb').write(base64.b64decode(d['url'].split(',', 1)[1]))
        d.pop('url')
        d.update({'name': name, 'note': note})
        results.append(d)
        print(f"== {name}: {note}", flush=True)
        print(f"   stand ({d['px']},{d['pz']}) feet={d['py']} eye={d['eyeY']} -> ({tx},{tz}) pitch={pitch}", flush=True)

    print('\n== SURFACE TRANSECTS (height of the top surface over the terrain) ==', flush=True)
    transects = {}
    for (tname, x0, z0, dx, dz, a, b, step, note) in TRANSECTS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [x0, z0])
        pump()
        rows = pg.evaluate(TRANSECT, [x0, z0, dx, dz, a, b, step])
        transects[tname] = rows
        print(f"  -- {tname}: {note}", flush=True)
        for r in rows:
            print(f"     t={r['t']:>6}  ({r['x']:>8},{r['z']:>8})  over terrain {str(r['over']):>7}", flush=True)

    print('\n== PLATFORM CENSUS (top surface over the terrain, down each slab centreline) ==', flush=True)
    print(f'   a built platform stands ~0.35 proud; below {PLATFORM_MIN_RISE} is ballast or bare ground', flush=True)
    sites = json.load(open(SITES))
    census = []
    for site in sites['sites']:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [site['x'], site['z']])
        pump()
        census.append(pg.evaluate(CENSUS, [site, sites['offset']]))
    whole = 0
    for c in census:
        built = [v for v in c['sides'] if v >= PLATFORM_MIN_RISE]
        if len(built) == 2:
            whole += 1
        flag = '' if len(built) == 2 else '   <== A SIDE IS MISSING'
        print(f"   {c['name']:<34} ({c['x']:>6},{c['z']:>6})  sides {c['sides'][0]:>7.3f} {c['sides'][1]:>7.3f}"
              f"  {len(built)} of 2{flag}", flush=True)
    print(f"   stations with BOTH platforms: {whole} of {len(census)}", flush=True)

    json.dump({'views': results, 'census': census, 'transects': transects}, open(f'{OUT}/shots.json', 'w'), indent=1)
    br.close()
print('SHOTS DONE')
