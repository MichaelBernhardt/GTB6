#!/usr/bin/env python3
"""IS THE RAIL CLEAR OF THE ROAD, AND ARE BOTH FULLY DRAWN?

In-engine frames through the game's own renderer, plus two machine checks that a screenshot cannot
fake:

  1. PER-PIXEL ATTRIBUTION. A ray is cast through a lattice of each frame's pixels and the pixel is
     bucketed by WHAT IT HIT. Meshes carry names — "Metrorail Main Line ballast", "Albertina Sisulu
     Road", "Grosvenor Station" — so the frame can be shown to contain the ballast AND the road as
     separate surfaces, rather than argued about.
  2. PLATFORM CENSUS. Every station group in the live scene is walked and its platform slabs counted.
     "One of the rail station sides is missing" is a claim about the scene graph, so it is answered
     against the scene graph: 2 slabs is a whole station, 1 is the bug.

usage: look.py <outdir>    env: PORT QUALITY ONLY
"""
import base64, json, os, sys
from playwright.sync_api import sync_playwright
from PIL import Image

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5480')
QUALITY = os.environ.get('QUALITY', 'low')
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)
W, H = 1280, 720

# name, stand x, stand z, look-at x, look-at z, pitch, eye-above-feet, note
VIEWS = [
    ('owner-eye',      -449.1, 1543.2,  -465.8, 1633.6,  -1, 1.30,
     "THE OWNER'S STAND (-449.1,1543.2), eye height, facing the track"),
    ('owner-across',   -459.4, 1599.2,  -468.6, 1649.3,  -6, 1.60,
     'ACROSS the corridor: ballast at ~35 u, Albertina Sisulu Road behind it at ~51 u'),
    ('owner-air',      -449.1, 1543.2,  -467.0, 1640.0, -35, 90.0,
     'AIR over the same corridor: the two ribbons apart'),
    ('grosvenor-road', -583.5, 1651.6,  -567.3, 1609.6,  -2, 1.60,
     'GROSVENOR from the ROAD SIDE — the side whose platform was missing'),
    ('grosvenor-far',  -551.1, 1567.6,  -567.3, 1609.6,  -2, 1.60,
     'GROSVENOR from the far side'),
    ('grosvenor-air',  -600.0, 1660.0,  -567.3, 1609.6, -40, 70.0,
     'GROSVENOR from the air: both platforms in one frame'),
    ('braam-side',      846.6, 1272.5,   840.9, 1227.9,  -2, 1.60,
     'BRAAMFONTEIN STATION, the comparison stop, from the same angle'),
    ('braam-air',       880.0, 1275.0,   840.9, 1227.9, -40, 70.0,
     'BRAAMFONTEIN from the air: both platforms'),
    ('crossing',         22.5, 1691.8,    15.6, 1731.2,  -3, 2.20,
     'LEVEL CROSSING on the main line at (15.6,1731.2), from a driver eye height'),
    ('crossing-air',     40.0, 1690.0,    15.6, 1731.2, -35, 55.0,
     'the same crossing from the air'),
    ('park-rail',      2814.0, -743.0,  2789.4, -743.2,  -8, 1.60,
     'BALLAST INSIDE The Wilds Nature Reserve — the drape the bed used to vanish under'),
]
ONLY = os.environ.get('ONLY')
if ONLY:
    VIEWS = [v for v in VIEWS if v[0] in set(ONLY.split(','))]

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
        const isPlayer=(o)=>{ let n=o; while(n){ if(n===g.player.group) return true; n=n.parent; } return false; };
        const eyeY=p.y+ch;
        const ax=tx-p.x, az=tz-p.z, ah=Math.hypot(ax,az)||1;
        const t=pitch*Math.PI/180, ct=Math.cos(t);
        const dx=(ax/ah)*ct, dz=(az/ah)*ct, dy=Math.sin(t);
        g.camera.position.set(p.x,eyeY,p.z);
        g.camera.lookAt(p.x+dx*1000, eyeY+dy*1000, p.z+dz*1000);
        g.camera.updateMatrixWorld();
        if (g.composer) g.composer.render(); else g.renderer.render(g.scene,g.camera);
        const url = g.renderer.domElement.toDataURL('image/png');
        const Vector3=p.constructor, Raycaster=Object.getPrototypeOf(g.combat.raycaster).constructor;
        const Wd=%d, Ht=%d, fov=g.camera.fov*Math.PI/180, aspect=Wd/Ht;
        const fwd=new Vector3(dx,dy,dz).normalize();
        const right=new Vector3().crossVectors(fwd,new Vector3(0,1,0)).normalize();
        const up=new Vector3().crossVectors(right,fwd).normalize();
        const pick=(o)=>o.visible&&o.isMesh&&!isPlayer(o);
        const label=(o)=>{ let n=o; while(n){ if(n.name && n.name!=='Joburg') return n.name; n=n.parent; } return o.type; };
        const grid=[];
        for (let row=40; row<Ht; row+=40) for (let col=60; col<Wd; col+=60) {
          const ndcX=2*(col/Wd)-1, ndcY=1-2*(row/Ht), ty=Math.tan(fov/2);
          const dir=new Vector3().copy(fwd).addScaledVector(right,ndcX*ty*aspect).addScaledVector(up,ndcY*ty).normalize();
          const rc=new Raycaster(new Vector3(p.x,eyeY,p.z),dir,0.5,40000);
          const hits=rc.intersectObjects(g.scene.children,true).filter(h=>pick(h.object));
          const h=hits[0];
          grid.push({row,col,what: h?label(h.object):'SKY', d: h?Math.round(h.distance):null, y: h?+h.point.y.toFixed(2):null});
        }
        return { url, grid, px:+p.x.toFixed(1), py:+p.y.toFixed(2), pz:+p.z.toFixed(1), eyeY:+eyeY.toFixed(2) }; }""" % (W, H)

    # ---- WHAT IS THE TOP SURFACE, step by step across the corridor? -------------------------------
    # A grazing camera ray always strikes the terrain before the thin sheet draped on it, so per-pixel
    # attribution cannot answer "is the ballast drawn". A vertical ray can: it hits the top surface
    # first, every time. Walking one across the corridor prints the cross-section — tar, then ground,
    # then ballast — which is the whole claim ("separated, and both fully drawn") in one line.
    TRANSECT = """([x0, z0, dx, dz, a, b, step]) => { const g=window.__game;
        const Vector3=g.player.group.position.constructor;
        const Raycaster=Object.getPrototypeOf(g.combat.raycaster).constructor;
        const label=(o)=>{ let n=o; while(n){ if(n.name && n.name!=='Joburg') return n.name; n=n.parent; } return o.type; };
        const out=[];
        for (let t=a; t<=b+1e-9; t+=step) {
          const x=x0+dx*t, z=z0+dz*t;
          const rc=new Raycaster(new Vector3(x,600,z), new Vector3(0,-1,0), 0.1, 1200);
          const h=rc.intersectObjects(g.scene.children,true).filter(q=>q.object.visible&&q.object.isMesh)[0];
          out.push({ t:+t.toFixed(1), x:+x.toFixed(1), z:+z.toFixed(1),
                     what: h?label(h.object):'NOTHING', y: h?+h.point.y.toFixed(3):null });
        }
        return out; }"""

    # name, origin x, origin z, unit dx, unit dz, from, to, step, note
    TRANSECTS = [
        ('owner-corridor', -465.75, 1633.63, 0.1808, -0.9835, -34, 16, 2,
         'ACROSS the Grosvenor corridor: Albertina Sisulu Road, then open ground, then the ballast'),
        ('grosvenor', -567.3, 1609.6, -0.359, 0.933, -14, 14, 1,
         'ACROSS Grosvenor Station: platform, ballast, platform'),
        ('crossing', 15.6, 1731.2, -0.173, 0.985, -20, 20, 2,
         'ALONG the road through the level crossing: tar, ballast over it, tar'),
        ('park-rail', 2789.4, -743.2, 0.985, 0.173, -12, 12, 1,
         'ACROSS the ballast inside The Wilds: lawn, ballast, lawn'),
    ]

    # ---- platform census straight off the scene graph --------------------------------------------
    CENSUS = """() => { const g=window.__game; const out=[];
        g.city.group.traverse((o)=>{
          if (!o.isGroup || !o.name) return;
          let slabs=0; const xs=[];
          o.traverse((m)=>{ const p=m.geometry && m.geometry.parameters;
            if (m.isMesh && p && Math.abs(p.width-3.6)<1e-6 && p.depth>=40) { slabs++; xs.push(+m.position.x.toFixed(2)); } });
          if (slabs>0) out.push({ name:o.name, slabs, xs, x:+o.position.x.toFixed(1), z:+o.position.z.toFixed(1) });
        });
        return out; }"""

    results = []
    for (name, px, pz, tx, tz, pitch, ch, note) in VIEWS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [px, pz])
        pump()
        pg.evaluate(SHOOT, [tx, tz, pitch, ch])   # warm the frame, then the real one
        d = pg.evaluate(SHOOT, [tx, tz, pitch, ch])
        path = f'{OUT}/{name}.png'
        open(path, 'wb').write(base64.b64decode(d['url'].split(',', 1)[1]))
        d.pop('url')
        im = Image.open(path).convert('RGB')
        buckets = {}
        for c in d['grid']:
            buckets.setdefault(c['what'], []).append(c)
        d.update({'name': name, 'note': note})
        results.append(d)
        print(f"== {name}: {note}", flush=True)
        print(f"   stand ({d['px']},{d['pz']}) feet={d['py']} eye={d['eyeY']} -> ({tx},{tz}) pitch={pitch}", flush=True)
        for k, v in sorted(buckets.items(), key=lambda kv: -len(kv[1]))[:8]:
            near = min(c['d'] for c in v if c['d'] is not None) if any(c['d'] is not None for c in v) else None
            print(f"   {k:<34} px={len(v):<4} nearest={near}", flush=True)

    print('\n== SURFACE TRANSECTS (top surface under a vertical ray, step by step) ==', flush=True)
    transects = {}
    for (tname, x0, z0, dx, dz, a, b, step, note) in TRANSECTS:
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [x0, z0])
        pump()
        rows = pg.evaluate(TRANSECT, [x0, z0, dx, dz, a, b, step])
        transects[tname] = rows
        print(f"  -- {tname}: {note}", flush=True)
        for r in rows:
            print(f"     t={r['t']:>6}  ({r['x']:>8},{r['z']:>8})  y={str(r['y']):>8}  {r['what']}", flush=True)

    print('\n== PLATFORM CENSUS (scene graph) ==', flush=True)
    census = pg.evaluate(CENSUS)
    whole = sum(1 for c in census if c['slabs'] >= 2)
    for c in sorted(census, key=lambda c: c['name']):
        flag = '' if c['slabs'] >= 2 else '   <== A SIDE IS MISSING'
        print(f"   {c['name']:<36} slabs={c['slabs']} at x={c['xs']} ({c['x']},{c['z']}){flag}", flush=True)
    print(f"   stations with BOTH platforms: {whole} of {len(census)}", flush=True)

    json.dump({'views': results, 'census': census, 'transects': transects}, open(f'{OUT}/shots.json', 'w'), indent=1)
    br.close()
print('SHOTS DONE')
