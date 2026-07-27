#!/usr/bin/env python3
"""DOES THE DAM LOOK LIKE A DAM? In-engine frames plus a per-pixel surface attribution.

Every frame goes through the game's own renderer and composer, at the fog density the owner plays at.
No top-down map crop anywhere in this file: three separate passes have "fixed" the shore's colour on
the evidence of a 2D map render, which cannot contain the colour of a surface as the player's own
composer resolves it.

For each viewpoint it renders the frame, then casts a ray through a 8 x 17 lattice of its pixels and
buckets the SAMPLED PIXEL by WHAT THE RAY HIT. That is how "the water is not blue" was pinned down:
every pixel whose ray hit the Water group came back rgb(196,180,140), the fog colour to the unit.

Shore stands are SOLVED, not guessed — they were placed with a signed-distance search against the
shipped ocean polygon (see the commit) and aimed down the gradient at the water. Hand-picked stands
in earlier passes turned out to be UNDER WATER, which has no horizon and no shore.

usage: look.py <outdir>   env: PORT QUALITY FOG ONLY
       QUALITY=low is the `flat` water tier (phones), medium is `physical`, high is the planar mirror.
"""
import base64, json, os, sys, colorsys
from playwright.sync_api import sync_playwright
from PIL import Image

OUT = sys.argv[1]
PORT = os.environ.get('PORT', '5477')
QUALITY = os.environ.get('QUALITY', 'low')
FOG = float(os.environ.get('FOG', '0.00025'))
os.makedirs(OUT, exist_ok=True)
SEED = ("localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify("
        "{version: 2, settings: {quality: '%s', masterVolume: 0}}))" % QUALITY)
W, H = 1280, 720

# name, px, pz, az(None = solve, face the water), pitch, eye-above-feet, note
VIEWS = [
    ('eye-water',   -2780, -3591, 340,   0, 1.30, 'WATERLINE of the widest reach, eye height, facing the water'),
    ('eye-misty',   -4220, -2478, 295,   0, 1.30, 'MISTY BAY beach at the waterline, eye height'),
    ('eye-leboya',  -2959, -3390, 355,   0, 1.30, 'LEBOYA BAAI shore at the waterline, eye height'),
    ('roof-water',  -2780, -3591, 340,  -4, 8.00, 'same reach, roof height, slight downward pitch'),
    ('roof-misty',  -4220, -2478, 295,  -8, 9.00, 'MISTY BAY from a first-floor roof, down at the water'),
    ('air-misty',   -3700, -2000, 300, -18, 260,  'AIR 260 u over the Misty Bay basin (the review shot)'),
    ('air-groot',   -3200, -2700, 290, -20, 320,  'AIR 320 u over Grooteiland and its channel'),
    ('groot-w',     -3922, -3145, 345,   0, 1.30, 'STANDING ON GROOTEILAND at its own waterline, over the channel'),
    ('groot-n',     -3922, -3145,   0,  -3, 1.30, 'STANDING ON GROOTEILAND, north up the channel'),
    ('groot-e',     -3922, -3145,  90,   0, 1.30, 'STANDING ON GROOTEILAND, east'),
    ('veld-band',   -4300, -2000,  90,   0, 1.30, 'the west band between shore and city, looking EAST'),
    ('city-street',  1200,   600, 270,   0, 1.30, 'CONTROL: CBD street, eye height'),
    ('city-air',     1200,   600, 270, -18, 320,  'CONTROL: air over the CBD, same rig as air-misty'),
]
ONLY=os.environ.get('ONLY')
if ONLY: VIEWS=[v for v in VIEWS if v[0] in set(ONLY.split(','))]

with sync_playwright() as pw:
    br = pw.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader',
                                                 '--disable-gpu-sandbox', '--no-sandbox', '--disable-dev-shm-usage'])
    pg = br.new_page(viewport={'width': W, 'height': H})
    pg.add_init_script(SEED)
    pg.goto(f'http://127.0.0.1:{PORT}/', wait_until='domcontentloaded', timeout=180000)
    pg.wait_for_function('() => !!window.__game && !!window.__game.player', timeout=900000)
    env = pg.evaluate("""(fog) => { const g=window.__game; g.scene.fog.density=fog; g.player.group.visible=false;
        return { quality: g.settings && g.settings.quality, tier: g.city.waterHandle && g.city.waterHandle.tier,
                 fogColor:'#'+g.scene.fog.color.getHexString(), far: g.camera.far,
                 far2: g.camera.far }; }""", FOG)
    print('ENV', json.dumps(env), flush=True)

    def pump(hour=12):
        pg.evaluate("""(hour) => { const g=window.__game; const p=g.player.group.position;
            g.dayNight.hour=hour; let n=0;
            while ((g.city.buildQueue?.length || g.city.pending) && n<6000) { g.city.updateBuildingChunks(p.x,p.z); n++; }
            for (let i=0;i<25;i++) { g.dayNight.hour=hour; g.update(1/60); } }""", hour)

    SHOOT = """([az, pitch, ch, fog]) => { const g=window.__game; const p=g.player.group.position;
        g.player.group.visible=false; g.scene.fog.density=fog;
        const isPlayer=(o)=>{ let n=o; while(n){ if(n===g.player.group) return true; n=n.parent; } return false; };
        const eyeY=p.y+ch, a=az*Math.PI/180, t=pitch*Math.PI/180;
        const dx=Math.sin(a)*Math.cos(t), dz=-Math.cos(a)*Math.cos(t), dy=Math.sin(t);
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
        const grid=[];
        for (let row=40; row<Ht; row+=40) for (let col=80; col<Wd; col+=160) {
          const ndcX=2*(col/Wd)-1, ndcY=1-2*(row/Ht), ty=Math.tan(fov/2);
          const dir=new Vector3().copy(fwd).addScaledVector(right,ndcX*ty*aspect).addScaledVector(up,ndcY*ty).normalize();
          const rc=new Raycaster(new Vector3(p.x,eyeY,p.z),dir,0.5,40000);
          const hits=rc.intersectObjects(g.scene.children,true).filter(h=>pick(h.object));
          const h=hits[0];
          let what='SKY', d=null, y=null;
          if (h) { const o=h.object;
            what = (o.parent&&o.parent.name==='Water') ? 'WATER'
                 : (o.name||(o.parent&&o.parent.name)||o.type);
            d=Math.round(h.distance); y=+h.point.y.toFixed(2); }
          grid.push({row,col,what,d,y});
        }
        const down=new Raycaster(new Vector3(p.x,p.y+80,p.z), new Vector3(0,-1,0), 0.1, 500);
        const gh=down.intersectObjects(g.scene.children,true).filter(h=>pick(h.object))[0];
        const under = gh ? { what:(gh.object.parent&&gh.object.parent.name==='Water')?'WATER':((gh.object.parent&&gh.object.parent.name)||gh.object.name||gh.object.type),
                             y:+gh.point.y.toFixed(2) } : null;
        return { url, grid, under, px:+p.x.toFixed(0), py:+p.y.toFixed(2), pz:+p.z.toFixed(0), eyeY:+eyeY.toFixed(2) }; }""" % (W, H)

    results = []
    for (name, px, pz, az, pitch, ch, note) in VIEWS:
        solved = None
        pg.evaluate("([x,z]) => window.__game.teleportPlayer(x,z,'shots')", [px, pz])
        pump()
        pg.evaluate(SHOOT, [az, pitch, ch, FOG])
        d = pg.evaluate(SHOOT, [az, pitch, ch, FOG])
        path = f'{OUT}/{name}.png'
        open(path, 'wb').write(base64.b64decode(d['url'].split(',', 1)[1]))
        d.pop('url')
        im = Image.open(path).convert('RGB')
        buckets = {}
        for c in d['grid']:
            c['rgb'] = im.getpixel((c['col'], c['row']))
            buckets.setdefault(c['what'], []).append(c['rgb'])
        d.update({'name': name, 'note': note, 'az': az, 'pitch': pitch, 'solved': solved})
        results.append(d)
        print(f"== {name}: {note}", flush=True)
        print(f"   stand ({d['px']},{d['pz']}) feet={d['py']} eye={d['eyeY']} az={az} under={json.dumps(d['under'])} solved={json.dumps(solved)}", flush=True)
        for k, v in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
            if len(v) < 2:
                continue
            r = sum(p[0] for p in v) / len(v); g_ = sum(p[1] for p in v) / len(v); b = sum(p[2] for p in v) / len(v)
            hh, ll, ss = colorsys.rgb_to_hls(r / 255, g_ / 255, b / 255)
            print(f"   {k:<16} n={len(v):<3} rgb({r:.0f},{g_:.0f},{b:.0f})  hue {hh*360:5.0f}  sat {ss:.2f}  lum {0.2126*r+0.7152*g_+0.0722*b:5.0f}", flush=True)

    json.dump({'env': env, 'views': results}, open(f'{OUT}/shots.json', 'w'), indent=1)
    br.close()
print('SHOTS DONE')
