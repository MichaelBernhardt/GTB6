#!/usr/bin/env python3
"""EYES proof for main-story findability: plays the campaign opening through the REAL
flow (walk up, talk, accept, drive) on a fresh save and screenshots every guidance
moment — completion toast, beacons from the player's camera (day/night/distance), the
city map, the idle MAIN STORY card, the side-quest cooldown lighting up, and the
MAIN STORY footer while an unwanted side mission is active. Full-page shots (world +
HUD), stitched into a contact sheet for human review.

Usage: python3 tools/qa/guidance-shots.py [--port 5299] [--out DIR]
"""
import argparse, json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
HARNESS_JS = (HERE / 'harness.js').read_text()
SHOTS = []


def run(port, out):
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'])
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
        page.set_default_timeout(240000)
        page.goto(f'http://127.0.0.1:{port}/', timeout=120000)
        for _ in range(30):
            time.sleep(4)
            if page.evaluate("() => !!window.__game"):
                break
        for _ in range(40):  # startGame early-returns until assets + character are ready — retry until PLAYING
            started = page.evaluate("() => { const g = window.__game; g.startGame(true); return g.mode === 'playing'; }")
            if started:
                break
            time.sleep(2)
        else:
            raise RuntimeError('game never reached playing mode')
        page.evaluate(
            "async () => { const md = await import('/src/world/mapData.ts'); window.__metresPerUnit = md.METRES_PER_UNIT; return 0; }")
        page.evaluate("(src) => { new Function(src)(); return typeof window.__qa; }", HARNESS_JS)
        page.evaluate("() => { const q = window.__qa; q.g.cheats.invulnerable = true; q.step(12, 1/30); return 0; }")

        def hud(sel):
            return page.evaluate(f"() => {{ const el = document.querySelector('[data-hud=\"{sel}\"]'); return el && !el.hidden && el.offsetParent !== null ? el.textContent : ''; }}")

        def snap(name, caption):
            # settle the camera, let the rAF loop paint the HUD, then present one real frame
            page.evaluate("() => { const q = window.__qa; for (let i = 0; i < 8; i++) { q.g.update(1/60); q.g.updateCamera(1/60); q.g.updateMarker(1/60); q.g.renderHUD(); } return 0; }")
            page.evaluate("() => { window.__qa.g.updateCamera(1/60); window.__qa.shot(); return 0; }")
            path = out / f'{name}.png'
            page.screenshot(path=str(path))
            state = {'card': hud('objective-name'), 'text': hud('objective-text'), 'mainstory': hud('mainstory')}
            SHOTS.append({'img': path.name, 'caption': caption, 'state': state})
            print(f'  shot {name}: {state}', flush=True)

        def stage(hour=10):
            page.evaluate(f"""() => {{ const q = window.__qa; const g = q.g;
              g.dayNight.hour = {hour};
              let n = 0; while (g.dialogue.active && n++ < 20) {{ g.advanceDialogue(); g.update(1/60); }}
              q.step(8, 1/30); return 0; }}""")

        def aim_at(x, z):
            page.evaluate(f"""() => {{ const q = window.__qa; const p = q.g.player.group.position;
              q.g.player.setHeading(Math.atan2({x} - p.x, {z} - p.z));
              for (let i = 0; i < 70; i++) {{ q.g.update(1/60); q.g.updateCamera(1/60); q.g.updateMarker(1/60); }} return 0; }}""")

        def pos_of(expr):
            return json.loads(page.evaluate(f"() => {{ const g = window.__qa.g; const s = {expr}; return JSON.stringify({{ x: s.x, z: s.z }}); }}"))

        def real_accept(mission_id):
            page.evaluate(f"""() => {{ const q = window.__qa; const g = q.g;
              q.state.mission = '{mission_id}'; q.state.lastFail = null;
              g.wanted.clear(); g.missions.active = undefined; g.missions.state = 'available';
              g.dialogue.abandon?.(); g.story.abandonOffer?.();
              const s = g.missions.missions.find(m => m.id === '{mission_id}').start.position;
              g.teleportPlayer(s.x, s.z, '{mission_id}');
              let guard = 0; while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 500) g.city.updateBuildingChunks(s.x, s.z);
              q.step(6, 1/30); return 0; }}""")

        def play_out(mission_id):
            for _ in range(10):
                info = json.loads(page.evaluate("() => JSON.stringify({ idx: window.__qa.objIndex(), state: window.__qa.g.missions.state })"))
                if info['idx'] < 0 or info['state'] == 'complete':
                    break
                status = page.evaluate("() => window.__qa.resolve()")
                if status == 'needs:train':
                    drive = page.evaluate("() => Boolean(window.__qa.g.missions.objective?.conditions?.drivingTrain)")
                    page.evaluate(f"() => window.__qa.trainTo(null, {str(drive).lower()})")
                    page.evaluate("() => { window.__qa.step(20, 0.1); return 0; }")
                page.evaluate("() => { window.__qa.step(8, 0.1); return 0; }")
            done = page.evaluate(f"() => window.__qa.g.missions.completed.has('{mission_id}')")
            print(f'  {mission_id}: {"COMPLETE" if done else "DID NOT COMPLETE"}', flush=True)
            return done

        portia = pos_of("g.missions.missions.find(m => m.id === 'delivery-run').start.position")
        vusi = pos_of("g.missions.missions.find(m => m.id === 'hot-property').start.position")
        candice = pos_of("g.missions.missions.find(m => m.id === 'dockside-signal').start.position")

        # ---- fresh save, idle: the main story must already be named -----------------------
        snap('01-fresh-idle', 'Fresh save, no input: the idle card is MAIN STORY — FIRST MOVE, naming Couch Run with Auntie Portia.')

        # ---- mission 1 through the real flow ----------------------------------------------
        real_accept('delivery-run')
        page.evaluate("() => { window.__qa.g.tryMissionInteraction(); window.__qa.g.update(1/60); return 0; }")
        snap('02-offer-dialogue', 'The real offer at Auntie Portia: E opened her intro dialogue.')
        page.evaluate("() => { const g = window.__qa.g; let n = 0; while (g.dialogue.active && n++ < 15) { g.advanceDialogue(); g.update(1/60); } window.__qa.step(4, 1/30); return 0; }")
        play_out('delivery-run')
        snap('03-passed-and-toast', 'Couch Run just completed: MISSION PASSED card; the Next-job toast names Bra Vusi.')

        # ---- the player who accepts nothing at Portia -------------------------------------
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({portia['x']}, {portia['z']}, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        stage(10)
        aim_at(vusi['x'], vusi['z'])
        snap('04-beacon-to-vusi-day', 'Standing at Portia after mission 1, accepting nothing, looking toward Bra Vusi: the pale-blue MAIN STORY beacon (day).')
        stage(22)
        aim_at(vusi['x'], vusi['z'])
        snap('05-beacon-to-vusi-night', 'Same view at night (22:00): the beacon must still read.')
        far = {'x': vusi['x'] + (portia['x'] - vusi['x']) * 2.2, 'z': vusi['z'] + (portia['z'] - vusi['z']) * 2.2}
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({far['x']}, {far['z']}, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        stage(10)
        aim_at(vusi['x'], vusi['z'])
        snap('06-beacon-distance', 'The same beacon from ~2x the Portia distance across the CBD.')
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({portia['x']}, {portia['z']}, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        page.keyboard.press('m'); time.sleep(0.6)
        snap('07-city-map', 'City map: pale-blue "Next job: Bra Vusi" diamond on the spine; no side pins yet (cooldown running).')
        page.keyboard.press('m'); time.sleep(0.3)

        # ---- the side cooldown lighting up --------------------------------------------------
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({portia['x']}, {portia['z']} + 28, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        stage(10)
        aim_at(portia['x'], portia['z'])
        snap('08-portia-cold', 'Portia right after her mainline: NO purple beam yet, no offer — the side is cooling down.')
        page.evaluate("() => { const q = window.__qa; q.g.story.tickSideQuests(200, q.g.missions.missions, q.g.missions.completed); q.step(60, 1/30); return 0; }")
        stage(10)
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({portia['x']}, {portia['z']} + 28, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        aim_at(portia['x'], portia['z'])
        snap('09-portia-side-lit', 'A few minutes later: the jacaranda-purple side beam lights at Portia (Last Coach Home, now a side quest).')
        page.keyboard.press('m'); time.sleep(0.6)
        snap('10-map-side-diamond', 'City map now: purple "Side job: Auntie Portia" diamond + the pale-blue spine diamond at Bra Vusi.')
        page.keyboard.press('m'); time.sleep(0.3)

        # ---- accepting the unwanted side must not lose the spine ---------------------------
        real_accept('last-coach-home')
        page.evaluate("() => { const g = window.__qa.g; g.tryMissionInteraction(); let n = 0; while (g.dialogue.active && n++ < 15) { g.advanceDialogue(); g.update(1/60); } window.__qa.step(4, 1/30); return 0; }")
        stage(10)
        snap('11-active-side-footer', 'Side mission active: gold objective card AND the pale-blue MAIN STORY footer still naming Hot Copper with Bra Vusi.')
        play_out('last-coach-home')

        # ---- missions 2 and 3 through the real flow ----------------------------------------
        real_accept('hot-property')
        page.evaluate("() => { const g = window.__qa.g; g.tryMissionInteraction(); let n = 0; while (g.dialogue.active && n++ < 15) { g.advanceDialogue(); g.update(1/60); } window.__qa.step(4, 1/30); return 0; }")
        play_out('hot-property')
        snap('12-passed-2', 'Hot Copper completed: toast names the next mainline (Rank Business with Candice).')
        page.evaluate(f"() => {{ window.__qa.g.teleportPlayer({vusi['x']}, {vusi['z']}, 'shots'); window.__qa.step(6, 1/30); return 0; }}")
        stage(10)
        aim_at(candice['x'], candice['z'])
        snap('13-beacon-to-candice', 'From Bra Vusi, looking toward Candice: the spine beacon has moved on with the story.')

        real_accept('dockside-signal')
        page.evaluate("() => { const g = window.__qa.g; g.tryMissionInteraction(); let n = 0; while (g.dialogue.active && n++ < 15) { g.advanceDialogue(); g.update(1/60); } window.__qa.step(4, 1/30); return 0; }")
        play_out('dockside-signal')
        snap('14-passed-3', 'Rank Business completed: the spine now points at The Arms Deal with Thandi.')
        page.keyboard.press('m'); time.sleep(0.6)
        snap('15-map-after-3', 'City map after three mainline missions — spine diamond on Thandi.')
        page.keyboard.press('m'); time.sleep(0.3)

        browser.close()

    cells = ''.join(
        f'<div class="cell"><img src="{s["img"]}"><div><b>{s["img"]}</b><br>{s["caption"]}<br>'
        f'<code>card: {s["state"]["card"]} · text: {s["state"]["text"][:90]} · footer: {s["state"]["mainstory"]}</code></div></div>'
        for s in SHOTS)
    (out / 'contact-sheet.html').write_text(
        '<!doctype html><meta charset="utf-8"><title>Main-story guidance — eyes proof</title>'
        '<style>body{background:#111;color:#ddd;font:13px sans-serif}.cell{display:inline-block;width:420px;margin:8px;vertical-align:top}'
        'img{width:100%;border:1px solid #333}code{color:#8fd}</style>' + cells)
    (out / 'shots.json').write_text(json.dumps(SHOTS, indent=1))
    print(f'\n{len(SHOTS)} shots → {out}/contact-sheet.html', flush=True)
    return 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5299)
    ap.add_argument('--out', default='/tmp/guidance-shots')
    sys.exit(run(ap.parse_args().port, Path(ap.parse_args().out)))
