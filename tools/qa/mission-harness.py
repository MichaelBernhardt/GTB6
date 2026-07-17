#!/usr/bin/env python3
"""Headless end-to-end mission QA: plays EVERY mission through the real game on a dev server.

Usage: python3 tools/qa/mission-harness.py [--port 5214] [--out /tmp/qa] [--missions id,id,...]

Per mission: real dialogue accept (prerequisites synthesized as completed), then each
objective is audited (marker + minimap identity, surface sanity, road-route reachability,
timer feasibility at >=1.8x measured drive time) and resolved through per-kind drivers
(teleport-drive along real road routes, real vehicle/train/plane boarding, real key
events, collider-respecting walking; documented shortcuts noted in the report). A JPEG
is captured per objective into a contact sheet. Exit code 1 if any 'fail' finding.
"""
import argparse, base64, json, os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
HARNESS_JS = (HERE / 'harness.js').read_text()

MISSION_ORDER = [
    'delivery-run', 'hot-property', 'dockside-signal', 'arms-deal',
    'last-coach-home', 'copper-wire-blues', 'rank-cold-war', 'reading-signs',
    'the-audition', 'pull-the-plug', 'stage-fright', 'genny-round',
    'paper-round', 'the-wrong-train', 'crosswinds', 'two-fires',
    'paper-fire', 'catch-them-cutting', 'dark-house',
    'long-live-the-king', 'carcass', 'the-switch',
    'padstal-run', 'pier-pressure',
]

def boot(browser, port):
    page = browser.new_page(viewport={'width': 960, 'height': 600})
    page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
    page.set_default_timeout(240000)
    page.goto(f'http://127.0.0.1:{port}/', timeout=120000)
    for _ in range(30):
        time.sleep(4)
        if page.evaluate("() => !!window.__game"):
            break
    page.evaluate("() => { window.__game.startGame(true); return 0; }")
    # NB: never let evaluate() return the __qa object itself — serializing the Game graph hangs Playwright
    page.evaluate("(src) => { new Function(src)(); return typeof window.__qa; }", HARNESS_JS)
    page.evaluate("() => { const q = window.__qa; q.g.update(1/60); return 0; }")
    return page


def play_mission(page, mission, out, all_findings, all_measurements, sheet_rows):
    print(f'=== {mission} ===', flush=True)
    status = page.evaluate(f"() => window.__qa.prep('{mission}')")
    if status != 'ready':
        all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': f'prep: {status}'})
        return
    status = page.evaluate("() => window.__qa.accept()")
    if status != 'armed':
        all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': f'accept path broke: {status}'})
        return
    for _safety in range(10):  # objectives + checkpoint re-entries per mission
        info = json.loads(page.evaluate("() => JSON.stringify({ audit: window.__qa.audit(), idx: window.__qa.objIndex(), state: window.__qa.g.missions.state })"))
        if info['idx'] < 0 or info['state'] in ('complete',):
            break
        audit = info['audit']
        all_measurements.append({'mission': mission, 'objective': info['idx'], **{k: audit.get(k) for k in ('kind', 'text', 'timer', 'roadDistance', 'timerNeed')}})
        shot = page.evaluate("() => window.__qa.shot()")
        name = f'{mission}-{info["idx"]}.jpg'
        (out / name).write_bytes(base64.b64decode(shot.split(',')[1]))
        if not any(r['img'] == name for r in sheet_rows):
            sheet_rows.append({'mission': mission, 'objective': info['idx'], 'text': audit.get('text', ''), 'img': name})
        if mission == 'dark-house' and info['idx'] == 1:
            status = page.evaluate("() => window.__qa.breachYard()")
        elif mission == 'dark-house' and info['idx'] == 3:
            status = page.evaluate("() => window.__qa.escapeYard()")
        elif mission == 'crosswinds' and info['idx'] == 2:
            status = page.evaluate("() => { const q = window.__qa; const t = q.g.markerTarget ?? q.g.missionTargetRaw(); return q.bailAndLand(t.position.x, t.position.z); }")
        else:
            status = page.evaluate("() => window.__qa.resolve()")
            if status == 'needs:train':
                drive = page.evaluate("() => Boolean(window.__qa.g.missions.objective?.conditions?.drivingTrain)")
                page.evaluate(f"() => window.__qa.trainTo(null, {str(drive).lower()})")
                page.evaluate("() => { window.__qa.step(20, 0.1); return 0; }")
                status = 'carrier'
            elif status == 'needs:plane':
                page.evaluate("() => window.__qa.flyTo()")
                page.evaluate("() => { window.__qa.step(20, 0.1); return 0; }")
                status = 'carrier'
            elif status == 'needs:blackout':
                page.evaluate("() => { const q = window.__qa; q.g.dayNight.hour = 22; if (!q.g.loadShedding.active) q.g.applyEskom(q.g.loadShedding.force()); q.step(40, 0.2); return 0; }")
                status = 'carrier'
        # empirical timer check: sim seconds actually used vs the objective clock
        sim_used = page.evaluate("() => window.__qa.state.simSeconds ?? null")
        timer = audit.get('timer')
        # empirical backstop at the bumbling ratio: the bot drives at 65% cruise, a bumbling player
        # at ~50% with detours — so the bot's time scales by ~1.6, then 1.8x slack on top
        if timer and sim_used and sim_used * 1.6 * 1.8 > timer:
            all_findings.append({'mission': mission, 'objective': info['idx'], 'severity': 'fail', 'what': f'timer {round(timer)}s < 1.8x bumbling-scaled play time {round(sim_used * 1.6)}s — raise it'})
        after = json.loads(page.evaluate("() => JSON.stringify({ idx: window.__qa.objIndex(), state: window.__qa.g.missions.state })"))
        if after['state'] == 'failed':
            fail_reason = page.evaluate("() => window.__qa.state.lastFail")
            all_findings.append({'mission': mission, 'objective': info['idx'], 'severity': 'fail', 'what': f'mission FAILED during honest play: {fail_reason} (driver status {status})'})
            return
        if status == 'carrier':
            page.evaluate("() => { window.__qa.step(30, 0.1); return 0; }")
            after = json.loads(page.evaluate("() => JSON.stringify({ idx: window.__qa.objIndex(), state: window.__qa.g.missions.state })"))
            if after['idx'] == info['idx'] and after['state'] == 'active':
                all_findings.append({'mission': mission, 'objective': info['idx'], 'severity': 'fail', 'what': 'carrier objective (train/plane/blackout) never completed after positioning'})
                return
        elif after['idx'] == info['idx'] and after['state'] == 'active' and (str(status).startswith('stuck') or status == 'no-offer'):
            all_findings.append({'mission': mission, 'objective': info['idx'], 'severity': 'fail', 'what': f'objective did not advance: {status}'})
            return
    done = page.evaluate(f"() => window.__qa.g.missions.completed.has('{mission}')")
    print(f'    -> {"COMPLETE" if done else "DID NOT COMPLETE"}', flush=True)
    if not done:
        all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': 'mission never completed under the harness'})


def run(port: int, out: Path, missions: list[str]) -> int:
    out.mkdir(parents=True, exist_ok=True)
    all_findings, all_measurements, sheet_rows = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'])
        page = None
        for mission in missions:
            for attempt in (1, 2):  # fresh page per mission; one retry on a renderer crash
                try:
                    if page is None or attempt == 2:
                        page = boot(browser, port)
                    play_mission(page, mission, out, all_findings, all_measurements, sheet_rows)
                    try:
                        for f in json.loads(page.evaluate("() => JSON.stringify(window.__qa.state.findings.splice(0))")):
                            all_findings.append(f)
                        for line in json.loads(page.evaluate("() => JSON.stringify(window.__qa.state.log.splice(0))")):
                            print('   ', line, flush=True)
                    except Exception:
                        pass
                    page.close()
                    page = None
                    break
                except Exception as error:
                    print(f'    !! harness crash on {mission} (attempt {attempt}): {type(error).__name__}', flush=True)
                    try:
                        if page: page.close()
                    except Exception:
                        pass
                    page = None
                    try:
                        browser.close()
                    except Exception:
                        pass
                    browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'])
                    if attempt == 2:
                        all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': f'harness crashed twice: {type(error).__name__}'})
            # incremental write: a crash never loses the findings so far
            (out / 'findings.json').write_text(json.dumps({'findings': all_findings, 'measurements': all_measurements}, indent=1))
        try:
            browser.close()
        except Exception:
            pass

    (out / 'findings.json').write_text(json.dumps({'findings': all_findings, 'measurements': all_measurements}, indent=1))
    rows = ''.join(
        f'<div class="cell"><img src="{r["img"]}"><div><b>{r["mission"]}[{r["objective"]}]</b> {r["text"]}</div></div>'
        for r in sheet_rows)
    (out / 'contact-sheet.html').write_text(
        '<!doctype html><meta charset="utf-8"><title>Mission QA contact sheet</title>'
        '<style>body{background:#111;color:#ddd;font:13px sans-serif}.cell{display:inline-block;width:320px;margin:6px;vertical-align:top}img{width:100%;border:1px solid #333}</style>'
        + rows)
    fails = [f for f in all_findings if f['severity'] == 'fail']
    print(f'\n==== {len(fails)} FAIL / {len(all_findings)} findings — {out}/findings.json, contact-sheet.html ====')
    for f in fails:
        print(f' FAIL {f["mission"]}[{f["objective"]}]: {f["what"]}')
    return 1 if fails else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5214)
    ap.add_argument('--out', default='/tmp/claude-1000/-home-sai-ai-gta3js/c2aa15d6-ca81-4e80-aa98-b18a53edb12c/scratchpad/qa')
    ap.add_argument('--missions', default=','.join(MISSION_ORDER))
    args = ap.parse_args()
    sys.exit(run(args.port, Path(args.out), [m for m in args.missions.split(',') if m]))
