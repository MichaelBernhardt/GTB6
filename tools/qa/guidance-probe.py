#!/usr/bin/env python3
"""In-engine probe for the round-4 follow-ups: next-mainline guidance, side-quest
pacing (beam/offer cooldown), and the bounded train-boarding window. Runs the REAL
game headless against a dev server (like mission-harness.py, without the drivers).

Usage: python3 tools/qa/guidance-probe.py [--port 5299]
Exit 1 on any FAIL line.
"""
import argparse, json, sys, time
from playwright.sync_api import sync_playwright

CHECKS = []


def check(name, ok, detail=''):
    CHECKS.append((name, bool(ok), detail))
    print(f'{"PASS" if ok else "FAIL"}  {name}{" — " + str(detail) if detail else ""}', flush=True)


def run(port):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'])
        page = browser.new_page(viewport={'width': 960, 'height': 600})
        page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
        page.set_default_timeout(240000)
        page.goto(f'http://127.0.0.1:{port}/', timeout=120000)
        for _ in range(30):
            time.sleep(4)
            if page.evaluate("() => !!window.__game"):
                break
        page.evaluate("() => { window.__game.startGame(true); return 0; }")
        page.evaluate("() => { const g = window.__game; g.cheats.invulnerable = true; for (let i = 0; i < 30; i++) g.update(1/30); return 0; }")

        # ---- 1. Next-mainline guidance -------------------------------------------------
        state = json.loads(page.evaluate("""() => {
          const g = window.__game;
          g.missions.completed.add('delivery-run'); // mission 1 done, player standing at Portia
          const pl = g.missions.missions.find(m => m.id === 'delivery-run').start.position;
          g.teleportPlayer(pl.x, pl.z, 'probe');
          for (let i = 0; i < 12; i++) g.update(1/30);
          const t = g.markerTarget;
          return JSON.stringify({ label: t?.label ?? null, crumb: Boolean(t?.breadcrumb), color: t?.color ?? null });
        }"""))
        check('breadcrumb tracks the mainline spine after mission 1 (Bra Vusi, not Portia)',
              state['label'] == 'Bra Vusi' and state['crumb'], state)

        # ---- 2. Side-quest pacing at Portia ---------------------------------------------
        side = json.loads(page.evaluate("""() => {
          const g = window.__game;
          g.missions.completed.add('last-coach-home'); // Portia's mainline now exhausted
          for (let i = 0; i < 60; i++) g.update(1/30); // stamp lands + contact cadence runs
          const offerCold = g.contactAction() ?? null; // player still stands at Portia
          const beaconCold = g.sideBeacons.get('padstal-run')?.visible ?? false;
          const mapCold = g.mapMarkers().some(m => (m.label ?? '').startsWith('Side job: Auntie Portia'));
          g.story.tickSideQuests(200, g.missions.missions, g.missions.completed); // 200s of played time pass
          for (let i = 0; i < 60; i++) g.update(1/30); // beacon cadence catches up
          const offerHot = g.contactAction() ?? null;
          const beaconHot = g.sideBeacons.get('padstal-run')?.visible ?? false;
          const mapHot = g.mapMarkers().some(m => (m.label ?? '').startsWith('Side job: Auntie Portia'));
          return JSON.stringify({
            offerCold: offerCold ? offerCold.mission.id : null, beaconCold, mapCold,
            offerHot: offerHot ? offerHot.mission.id : null, beaconHot, mapHot,
            waits: g.story.serializeSideWaits(),
          });
        }"""))
        check('cooling side: no offer, no beam, no map pin at Portia',
              side['offerCold'] is None and not side['beaconCold'] and not side['mapCold'], side)
        check('after the wait: padstal-run offers, purple beam lit, map diamond shown',
              side['offerHot'] == 'padstal-run' and side['beaconHot'] and side['mapHot'], side)
        check('the wait is persisted state (survives into the save)',
              'padstal-run' in side['waits'], side['waits'])

        # ---- 3. Bounded boarding: last-coach-home at Doornfontein ------------------------
        train = json.loads(page.evaluate("""() => {
          const g = window.__game;
          g.missions.completed.delete('last-coach-home');
          g.consoleHost.missionStart(g.missions.missions.findIndex(m => m.id === 'last-coach-home') + 1);
          for (let i = 0; i < 12; i++) g.update(1/30); // runObjectiveBeats fires the arm-time assist
          const target = g.missions.objective?.target?.position;
          const etaAtArm = g.trains.nextArrivalSeconds(target.x, target.z) ?? null;
          g.teleportPlayer(target.x + 4, target.z + 4, 'probe'); // walk up to the platform
          for (let i = 0; i < 45; i++) g.update(1/30); // 1.5s: the 1Hz cadence refreshes the countdown
          const hint = g.platformWaitHint();
          return JSON.stringify({ objText: g.missions.objective?.text ?? null, etaAtArm, hint });
        }"""))
        check('last-coach-home arm-time assist: next train due within 75s at Doornfontein',
              train['etaAtArm'] is not None and train['etaAtArm'] <= 75, train)
        check('platform countdown shows on the objective card',
              train['hint'] and ('Next train:' in train['hint'] or 'boarding NOW' in train['hint']), train)

        # the promise must be kept: a consist actually opens its doors at the platform inside the window
        arrived = page.evaluate("""() => {
          const g = window.__game;
          const target = g.missions.objective?.target?.position;
          for (let t = 0; t < 90; t += 0.5) {
            for (let i = 0; i < 15; i++) g.update(1/30);
            const eta = g.trains.nextArrivalSeconds(target.x, target.z);
            if (eta === 0) return t;
          }
          return -1;
        }""")
        check('a consist really arrives and dwells at Doornfontein inside the window', 0 <= arrived <= 80, f'{arrived}s of sim')

        # ---- 4. the-wrong-train at Booysens ---------------------------------------------
        wrong = json.loads(page.evaluate("""() => {
          const g = window.__game;
          g.consoleHost.missionStart(g.missions.missions.findIndex(m => m.id === 'the-wrong-train') + 1);
          for (let i = 0; i < 12; i++) g.update(1/30);
          const target = g.missions.objective?.target?.position;
          const eta = g.trains.nextArrivalSeconds(target.x, target.z) ?? null;
          return JSON.stringify({ eta, text: g.missions.objective?.text ?? null });
        }"""))
        check('the-wrong-train: the consist to steal is due at Booysens within 75s',
              wrong['eta'] is not None and wrong['eta'] <= 75, wrong)

        browser.close()
    fails = [c for c in CHECKS if not c[1]]
    print(f'\n==== {len(fails)} FAIL / {len(CHECKS)} checks ====')
    return 1 if fails else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=5299)
    sys.exit(run(ap.parse_args().port))
