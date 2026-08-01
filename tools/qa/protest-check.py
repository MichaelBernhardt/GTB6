#!/usr/bin/env python3
"""Focused in-engine check for the two protest reports, driven through the real game.

  (1) join a protest and the crowd stays; attack someone and the exemption ends
  (2) lay tyres in a road and watch what a real driver actually does; let them burn out and
      confirm the road flows again

Usage: python3 tools/qa/protest-check.py [--host 127.0.0.1] [--port 5261] [--out /tmp/protest-shots]
"""
import argparse, time
from pathlib import Path
from playwright.sync_api import sync_playwright

PRELUDE = r"""
  const g = window.__game;
  const out = []; const say = (k, v) => out.push(`${k}: ${v}`);
  const step = (n) => { for (let i = 0; i < n; i++) g.update(1 / 30); };
  const qa = (a, args = {}) => g.features.loaded('protest').qa(a, args);
  const cmd = (...args) => g.features.command(args).join(' | ');
  /** The shared RoadClosures singleton, reached through the planner that already holds it. */
  const closures = () => g.population.vehiclePlanner.closures;
  /**
   * The decision itself, on real geometry in the shipped city: place a real Vehicle on the lane a
   * dozen units short of the junk, facing down it, and ask the very function the traffic loop asks.
   * Driving a car AT the line with routeVehicleTo does not work as a probe — the lanes are directed
   * and A* legitimately sends it round the block, which is the routing half doing its job and hides
   * the driver half under test. PopulationSystem.protest.test.ts drives the whole loop end to end.
   */
  const decide = (label, back = 12, across = 0) => {
    const L = window.__lane;
    const V = g.player.group.position.constructor;
    const v = g.population.traffic.find((c) => !c.disabled && !c.playerControlled);
    const x = L.x - L.fx * back + L.ax * across, z = L.z - L.fz * back + L.az * across;
    v.group.position.set(x, g.city.roadHeightAt(x, z), z);
    v.heading = Math.atan2(L.fx, L.fz); v.group.rotation.y = v.heading; v.speed = 12;
    const r = g.population.avoidHazards(v, new V(L.fx, 0, L.fz), 1 / 30);
    const side = r?.dodge ? (r.dodge.x - x) * L.ax + (r.dodge.z - z) * L.az : 0;
    say(label, !r ? 'drives on (nothing in the lane)'
      : r.dodge ? `GOES ROUND: steers ${side.toFixed(2)} units sideways`
      : `STOPS: holds ${r.stopAt.toFixed(1)} units short`);
  };
"""


def boot(browser, host, port):
    page = browser.new_page(viewport={'width': 1024, 'height': 640})
    page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
    page.set_default_timeout(300000)
    page.goto(f'http://{host}:{port}/', timeout=180000)
    for _ in range(60):
        time.sleep(3)
        if page.evaluate("() => !!window.__game"):
            break
    # onStart is what the menu button calls; hideMenu drops the title overlay off the shot.
    page.evaluate("() => { window.__game.ui.onStart(true); window.__game.ui.hideMenu(); return 0; }")
    time.sleep(4)
    return page


def shot(page, out: Path, name: str, look=None):
    # The chase camera settles behind the player facing -z after a teleport, so stand south of the
    # subject and it ends up in shot.
    if look:
        page.evaluate("""([lx, lz]) => {
          const g = window.__game;
          // Stand on the tar a little back from the subject and aim the chase camera AT it: a fixed
          // +z offset drops the lens inside a hill on any road that does not happen to run north.
          const pose = g.city.nearestRoadPose(new (g.player.group.position.constructor)(lx, 0, lz));
          const bx = lx - pose.position.x, bz = lz - pose.position.z;
          const back = Math.hypot(bx, bz) > 1 ? { x: bx, z: bz } : { x: Math.sin(pose.heading), z: Math.cos(pose.heading) };
          const len = Math.hypot(back.x, back.z) || 1;
          const px = lx - (back.x / len) * 16, pz = lz - (back.z / len) * 16;
          g.player.group.position.set(px, g.city.surfaceHeightAt(px, pz), pz);
          g.cameraController.yaw = Math.atan2(px - lx, pz - lz); // camera behind the player, looking at the subject
          for (let i = 0; i < 120; i++) g.update(1 / 30);
        }""", look)
    # The usual chunk pump does NOTHING after a teleport when the queue is already empty, so call
    # updateBuildingChunks unconditionally first or you photograph an empty street.
    page.evaluate("""() => {
      const g = window.__game; const p = g.player.group.position;
      for (let i = 0; i < 400; i++) { try { g.city.updateBuildingChunks(p.x, p.z); } catch (e) { /* keep going */ } }
      for (let i = 0; i < 90; i++) g.update(1 / 30);
    }""")
    page.wait_for_timeout(800)
    # The title overlay is a DOM node the harness never clicked away; drop it off the frame.
    page.evaluate("() => { const m = document.getElementById('menu'); if (m) m.style.display = 'none'; }")
    (out / name).write_bytes(page.screenshot(type='jpeg', quality=80))
    print('shot:', out / name, flush=True)


def where(page, key):
    return page.evaluate("(k) => window[k]", key)


def run(page, body):
    for line in page.evaluate("() => {" + PRELUDE + body + "\n  return out; }"):
        print(line, flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--port', type=int, default=5261)
    ap.add_argument('--out', default='/tmp/protest-shots')
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        page = boot(browser, args.host, args.port)

        # The first `feature protest now` only starts the fetch; the chunk lands a moment later.
        run(page, "\n          say('load', cmd('protest', 'now'));\n        ")
        page.wait_for_function("() => !!window.__game.features.loaded('protest')", timeout=60000)

        run(page, r"""
          say('raise', cmd('protest', 'now'));
          const site = qa('site'); say('site', site);
          const [sx, sz] = site.slice(3).split(',').map(Number);
          g.player.group.position.set(sx + 3, g.city.surfaceHeightAt(sx + 3, sz + 3), sz + 3);
          step(30);
          say('crowd', qa('crowd'));
          say('solidarity-on-raise', qa('solidarity'));
          say('hazards-on-raise', qa('hazards'));
          say('closures', qa('closures'));
          say('offer', qa('offer'));
          say('join', qa('join'));
          // Ten seconds of walking about inside the crowd, through the REAL bump path.
          for (let i = 0; i < 300; i++) {
            const p = g.player.group.position;
            p.x = sx + Math.sin(i * 0.09) * 2.4; p.z = sz + Math.cos(i * 0.09) * 2.4;
            g.population.bumpPlayer(1 / 30, p, true, false);
            g.update(1 / 30);
          }
          say('fled-after-jostling', qa('fled'));
          say('solidarity-after-jostling', qa('solidarity'));
          // A raised gun is not an attack.
          g.population.broadcastBrandish(g.player.group.position);
          step(45);
          g.population.broadcastBrandish(g.player.group.position);
          step(45);
          say('fled-after-brandish', qa('fled'));
          say('solidarity-after-brandish', qa('solidarity'));
          say('status', qa('status'));
        """)
        shot(page, out, '1-picket-holds.jpg', page.evaluate("() => { const s = window.__game.features.loaded('protest').qa('site', {}).slice(3).split(',').map(Number); return s; }"))

        run(page, r"""
          const victim = g.population.pedestrians.find((p) => p.solidarity);
          say('before-attack', qa('solidarity'));
          g.player.group.position.set(victim.group.position.x + 1.2, victim.group.position.y, victim.group.position.z);
          g.tryMugOrMelee(); // the real melee funnel: takeDamage + reportCrime, which is what revokes
          step(45);
          say('after-attack', qa('solidarity'));
          say('fled-after-attack', qa('fled'));
          say('status', qa('status'));
          // What a driver arriving at the standing barricade decides.
          const site = qa('site').slice(3).split(',').map(Number);
          const pose = g.city.nearestRoadPose(new (g.player.group.position.constructor)(site[0], 0, site[1]));
          window.__lane = { x: site[0], z: site[1], ax: Math.cos(pose.heading), az: -Math.sin(pose.heading), fx: Math.sin(pose.heading), fz: Math.cos(pose.heading) };
          decide('BARRICADE, 14 u out', 14);
          decide('BARRICADE, 26 u out', 26);
        """)
        shot(page, out, '2-attack-breaks-it.jpg', page.evaluate("() => { const s = window.__game.features.loaded('protest').qa('site', {}).slice(3).split(',').map(Number); return s; }"))

        # ---- the player's own tyres, on a road well away from the standing blockade -------------
        # The grievance is still ripe, so clearing the barricade only raises another one. Walk away
        # from it instead (only one stands at a time) and use a different road.
        run(page, r"""
          const site = qa('site').slice(3).split(',').map(Number);
          const V = g.player.group.position.constructor;
          const away = g.city.nearestRoadPose(new V(site[0] + 180, 0, site[1] + 120));
          window.__lane = {
            x: away.position.x, z: away.position.z,
            ax: Math.cos(away.heading), az: -Math.sin(away.heading), // across the carriageway
            fx: Math.sin(away.heading), fz: Math.cos(away.heading),  // along it
          };
          say('lane', `${away.position.x.toFixed(0)},${away.position.z.toFixed(0)}`);
          say('away-from-blockade', Math.hypot(away.position.x - site[0], away.position.z - site[1]).toFixed(0));
          const L = window.__lane;
          qa('tyre', { n: 3 });
          g.player.group.position.set(L.x + L.ax * 1.4, g.city.surfaceHeightAt(L.x + L.ax * 1.4, L.z + L.az * 1.4), L.z + L.az * 1.4);
          say('burn-one', qa('burn'));
          say('hazards-with-one-tyre', qa('hazards'));
          // ISOLATE THE DRIVER FROM THE PLANNER. A tyre also opens a RoadClosure and A* correctly
          // sends traffic down another street — which is right, and hides the thing under test. Drop
          // the closures so the only thing still telling a driver about the tyre is the hazard.
          closures().clear();
          say('closures-after-isolating', closures().count);
          decide('ONE TYRE, 12 u out', 12);
          decide('ONE TYRE, 22 u out', 22);
        """)
        shot(page, out, '3-one-tyre-swerve.jpg', page.evaluate("() => [window.__lane.x, window.__lane.z]"))

        run(page, r"""
          const L = window.__lane;
          // The other two ACROSS the lane. SOLO_SPACING is 4.5, so 5 units apart is legal.
          for (const offset of [-5, 5]) {
            const x = L.x + L.ax * (offset + 1.4), z = L.z + L.az * (offset + 1.4);
            g.player.group.position.set(x, g.city.surfaceHeightAt(x, z), z);
            say(`burn at ${offset}`, qa('burn'));
          }
          say('hazards-with-three-tyres', qa('hazards'));
          closures().clear();
          decide('THREE TYRES ACROSS, 12 u out', 12);
          decide('THREE TYRES ACROSS, 22 u out', 22);
          const moving = () => g.population.traffic.filter((v) => v.occupied && !v.disabled && !v.frozen && Math.abs(v.speed) > 3).length;
          const live = () => g.population.traffic.filter((v) => v.occupied && !v.disabled && !v.frozen).length;
          say('city-moving-while-blocked', `${moving()}/${live()}`);
        """)
        shot(page, out, '4-three-tyres-block.jpg', page.evaluate("() => [window.__lane.x, window.__lane.z]"))

        run(page, r"""
          const moving = () => g.population.traffic.filter((v) => v.occupied && !v.disabled && !v.frozen && Math.abs(v.speed) > 3).length;
          const live = () => g.population.traffic.filter((v) => v.occupied && !v.disabled && !v.frozen).length;
          for (let i = 0; i < 3300; i++) g.update(1 / 30); // let the tyres burn out for real
          say('hazards-after-burnout', qa('hazards'));
          say('city-moving-after-burnout', `${moving()}/${live()}`);
          decide('AFTER BURNOUT', 12);
        """)
        shot(page, out, '5-flow-recovers.jpg', page.evaluate("() => [window.__lane.x, window.__lane.z]"))
        browser.close()


if __name__ == '__main__':
    main()
