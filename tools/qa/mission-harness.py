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
    if status == 'ready':  # the opener exercises the real dialogue-accept flow
        status = page.evaluate("() => window.__qa.accept()")
        if status != 'armed':
            all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': f'accept path broke: {status}'})
            return
    elif status != 'armed-direct':  # everything else arms via the `mission <n>` console command
        all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': f'prep: {status}'})
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
        # low-agency cap (owner): no follow may hold the player longer than ~90s
        if audit.get('kind') == 'follow':
            follow_sim = page.evaluate("() => window.__qa.state.simSeconds ?? null")
            if follow_sim and follow_sim > 90:
                all_findings.append({'mission': mission, 'objective': info['idx'], 'severity': 'fail', 'what': f'follow objective held the player {round(follow_sim)}s — cap is 90s'})
        # empirical timer check: sim seconds actually used vs the objective clock
        sim_used = page.evaluate("() => window.__qa.state.simSeconds ?? null")
        timer = audit.get('timer')
        obj_kind = audit.get('kind')
        journeys = page.evaluate(f"() => (window.__scripts?.['{mission}']?.journeys ?? [])")
        skip_timer = obj_kind in ('survive', 'choice') or (info['idx'] in (journeys or []))
        # empirical backstop at the bumbling ratio: the bot drives at 65% cruise, a bumbling player
        # at ~50% with detours — so the bot's time scales by ~1.6, then 1.8x slack on top
        if timer and sim_used and not skip_timer and sim_used * 1.6 * 1.8 > timer:
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
    else:
        # reward emission (owner: no silent payouts) — every paying mission raises the MISSION PASSED card
        card = page.evaluate("() => Boolean(window.__qa.g.missionPassedView)")
        base = page.evaluate(f"() => window.__qa.g.missions.missions.find(m => m.id === '{mission}')?.reward ?? 0")
        if base > 0 and not card:
            all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail', 'what': 'completion paid a reward but showed no MISSION PASSED card'})
        # TIER FLOORS (owner: The Audition collapsed to ~20m and machine-passed — a tier is a BAND, both
        # edges are law). A mission's longest routed leg must meet its tier floor; ceilings alone let a
        # mission implode below its band. Applies per-mission (the longest leg), not per-objective, so
        # short legs like "escape the perimeter" don't false-fail. Journeys are exempt (already long).
        FLOOR = {'favour': 250, 'standard': 700, 'substantial': 1400, 'journey': 0}
        tier = page.evaluate(f"() => window.__scripts?.['{mission}']?.tier ?? 'standard'")
        journeys = page.evaluate(f"() => window.__scripts?.['{mission}']?.journeys ?? []") or []
        routed = [m['roadDistance'] for m in all_measurements
                  if m['mission'] == mission and m.get('roadDistance') and m['objective'] not in journeys]
        floor = FLOOR.get(tier, 700)
        # The floor is about DRIVES doing real work — exempt missions whose substance is a non-road
        # modality the floor can't see: a tail (follow), a train/plane ride (carrier), a riddle (hidden
        # first objective), a stealth infiltration (undetected — the challenge is not being seen), or a
        # mission that already carries a sanctioned journey leg (a long drive by construction).
        objs = page.evaluate(f"() => (window.__qa.g.missions.missions.find(m => m.id === '{mission}')?.objectives ?? []).map(o => ({{ kind: o.kind, hidden: !!o.hidden, carrier: !!(o.conditions && (o.conditions.onTrain || o.conditions.drivingTrain || o.conditions.inPlane)), stealth: !!(o.conditions && o.conditions.undetected) }}))") or []
        non_drive = bool(journeys) or any(o['kind'] == 'follow' or o['carrier'] or o['stealth'] for o in objs) or (bool(objs) and objs[0]['hidden'])
        if routed and floor and max(routed) < floor and not non_drive:
            all_findings.append({'mission': mission, 'objective': -1, 'severity': 'fail',
                'what': f'tier floor: longest routed leg is {max(routed)}u but the {tier} floor is {floor}u — the mission collapsed below its band (make the drive do real work)'})


def run(port: int, out: Path, missions: list[str]) -> int:
    out.mkdir(parents=True, exist_ok=True)
    all_findings, all_measurements, sheet_rows = [], [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'])
        page = None  # ONE page is reused across missions (prep() via `mission <n>` fully resets state);
        for mission in missions:               # re-boot only on a renderer crash — 24 boots was the slow part
            for attempt in (1, 2):
                try:
                    if page is None:
                        page = boot(browser, port)
                    play_mission(page, mission, out, all_findings, all_measurements, sheet_rows)
                    try:
                        for f in json.loads(page.evaluate("() => JSON.stringify(window.__qa.state.findings.splice(0))")):
                            all_findings.append(f)
                        for line in json.loads(page.evaluate("() => JSON.stringify(window.__qa.state.log.splice(0))")):
                            print('   ', line, flush=True)
                    except Exception:
                        pass
                    break  # keep the page for the next mission
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
