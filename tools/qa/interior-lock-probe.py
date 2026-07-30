#!/usr/bin/env python3
"""Live proof for the locks-and-cheats pass, in-engine on SwiftShader.

Walks the whole arc the pass shipped:
  1. exempt console commands leave the save organic (everCheated stays false);
  2. a locked suburban door offers an honest `E  Try the door` that ACTS (toast with the shop
     pointer) and does not open;
  3. `give lockpick` (a cheat: the sticky flag flips) arms the dial; the REAL rung starts it, the
     sweep runs in live updates, the press lands in the bite, the door opens;
  4. exit is never gated, and the door just left stays open for the grace window;
  5. a shopfront is simply open; a works dock locks at 23:00 and opens again at 12:00;
  6. at night the industrial roof hatch asks the same lock question as the street door, exiting to
     the roof from inside is still free, and the hatch just used grants grace back in;
  7. `opensesame` opens a locked home with no dial (badge: CHEATS ACTIVE); switching it off leaves
     the permanent CHEATS USED badge, which survives save + reload;
  8. `give tyres 2` loads the protest feature and lands the grant (the generic feature-grant route).

The game's own loop keeps running between stages, so page screenshots capture the live HUD
(prompts, the PICK chip, the cheats badge) for a human to LOOK at.

Usage: python3 tools/qa/interior-lock-probe.py [--port 5213]
"""
import argparse, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=5213)
args = ap.parse_args()
OUT = Path('/tmp/claude-1000/-home-sai-ai-gta3js/bd130fd1-ffb2-44ea-b99e-bff4ccaf6e3b/scratchpad')

BOOT_JS = r"""
async () => {
  const g = window.__game;
  window.__probe = {
    g,
    doorsMod: await import('/src/features/interiors/doors.ts'),
    lockMod: await import('/src/features/interiors/lock.ts'),
    coreMod: await import('/src/features/interiors/core.ts'),
    state: {},
  };
  return 'ready';
}
"""

STAGE_JS = r"""
async (stage) => {
  const { g, doorsMod, lockMod, coreMod, state } = window.__probe;
  const out = { checks: [] };
  const check = (name, ok, detail) => out.checks.push({ name, ok: !!ok, detail: String(detail) });
  const p = g.player.group.position;
  const pump = (x, z) => {
    let guard = 0;
    do { g.city.updateBuildingChunks(x, z); } while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 600);
    g.city.updateVisibility(p, true);
  };
  const settle = (n) => { for (let i = 0; i < n; i++) { g.update(1/60); g.updateCamera(1/60); } };
  const console_ = (text) => { g.ui.onConsoleCommand(text); };
  const toast = () => document.querySelector('#toast')?.textContent || '';
  const offerNow = async () => {
    let offer;
    for (let i = 0; i < 25 && !offer; i++) {
      settle(4);
      offer = g.features.offer('foot');
      if (!offer) await new Promise(r => setTimeout(r, 200));
    }
    return offer;
  };
  const qa = (a, x) => g.features.qa('interiors', a, x || {}); // NOTE: async — always await
  // The badge text is written by renderHUD on the RAF frame, which headless throttles hard — poll.
  const badgeIs = async (want) => {
    for (let i = 0; i < 40; i++) {
      g.renderHUD(); // drive the DOM ourselves — headless throttles the RAF frame that normally does
      const e = document.querySelector('[data-hud="cheats"]');
      if (e && !e.hidden && e.textContent === want) return { ok: true, detail: `${e.textContent}` };
      await new Promise(r => setTimeout(r, 250));
    }
    const e = document.querySelector('[data-hud="cheats"]');
    return { ok: false, detail: e ? `hidden=${e.hidden} ${e.textContent}` : 'no badge' };
  };
  const standAt = (door) => { g.teleportPlayer(door.x, door.z); pump(door.x, door.z); settle(10); };
  const findDoor = (want) => {
    const cand = doorsMod.doorsNear(p.x, p.z, 2500)
      .map(d => ({ d, core: coreMod.buildCore(d.facts) }))
      .filter(e =>
        want === 'locked-home' ? lockMod.lockedClass(e.d.facts) && e.core.family === 'suburban'
        : want === 'shopfront' ? e.d.facts.entrance === 'shopfront'
        : want === 'dock' ? e.d.facts.entrance === 'dock'
        : want === 'tall-dock' ? e.d.facts.entrance === 'dock' && e.core.storeys > 2 && e.d.roof && coreMod.hasRoofAccess(e.core)
        : true)
      .sort((a, b) => Math.hypot(a.d.x - p.x, a.d.z - p.z) - Math.hypot(b.d.x - p.x, b.d.z - p.z));
    return cand.length ? cand[0].d : undefined;
  };

  if (stage === 'organic') {
    for (const cmd of ['help', 'fps', 'fps', 'busy', 'save', 'reload', 'perfchart', 'perfchart']) console_(cmd);
    settle(5);
    check('exempt commands leave everCheated false', g.save.everCheated === false && !g.everCheated, `save=${g.save.everCheated} live=${g.everCheated}`);
    return out;
  }

  if (stage === 'home-try') {
    g.teleportPlayer(-4441, -2193); pump(-4441, -2193); settle(10);
    const door = findDoor('locked-home');
    if (!door) return { error: 'no locked suburban door near -4441,-2193' };
    state.home = door;
    out.door = `${door.id} ${door.name}`;
    standAt(door);
    const offer = await offerNow();
    check('pickless prompt is Try the door', !!offer && offer.prompt.startsWith('E  Try the door'), offer ? offer.prompt : 'none');
    if (offer) { offer.act(); settle(3); }
    check('Try the door ACTS: locked toast with the shop pointer', toast().includes('Locked') && toast().includes('lock pick'), toast());
    const status0 = await qa('status');
    check('still outside', status0 === 'outside', status0);
    return out;
  }

  if (stage === 'home-dial') {
    const door = state.home; standAt(door);
    console_('give lockpick');
    settle(3);
    check('give lockpick is a cheat: everCheated flips', g.everCheated === true, String(g.everCheated));
    check('inventory carries the pick', g.inventory.lockpicks === 1, String(g.inventory.lockpicks));
    const offer = await offerNow();
    check('prompt becomes Pick the lock', !!offer && offer.prompt.startsWith('E  Pick the lock'), offer ? offer.prompt : 'none');
    if (offer) offer.act(); // the dial starts; the live loop keeps it sweeping for the screenshot
    settle(10);
    const hud = g.features.hud();
    check('PICK chip on the HUD strip', !!hud && hud.some(c => c.id === 'interiors:pick'), JSON.stringify(hud));
    return out;
  }

  if (stage === 'home-pick') {
    let pressed = false;
    for (let i = 0; i < 600 && !pressed; i++) {
      settle(1);
      const now = g.features.offer('foot');
      if (now && now.prompt.includes('NOW')) { now.act(); pressed = true; }
    }
    check('the bite came and the press landed', pressed, `pressed=${pressed}`);
    await new Promise(r => setTimeout(r, 700)); // the entry fade timer is real time
    settle(10);
    const status1 = await qa('status');
    check('inside after the pick', String(status1).startsWith('inside|'), status1);
    return out;
  }

  if (stage === 'home-leave') {
    const left = await qa('leave');
    check('leave is never gated', left === 'ok', left);
    settle(5);
    const again = await offerNow();
    check('grace: the door just left offers Go inside, no second dial', !!again && again.prompt.startsWith('E  Go inside'), again ? again.prompt : 'none');
    return out;
  }

  if (stage === 'shopfront') {
    g.teleportPlayer(-840, -1303); pump(-840, -1303); settle(10);
    const door = findDoor('shopfront');
    if (!door) return { error: 'no shopfront near -840,-1303' };
    out.door = `${door.id} ${door.name}`;
    standAt(door);
    const offer = await offerNow();
    check('a shop that is open is open', !!offer && offer.prompt.startsWith('E  Go inside'), offer ? offer.prompt : 'none');
    return out;
  }

  if (stage === 'works-night') {
    g.teleportPlayer(-142, 2502); pump(-142, 2502); settle(10);
    const door = findDoor('dock');
    if (!door) return { error: 'no dock near -142,2502' };
    state.dock = door;
    out.door = `${door.id} ${door.name}`;
    console_('set time 2300'); standAt(door);
    const offer = await offerNow();
    check('a works dock LOCKS at 23:00 (pick in pocket, so the dial offers)', !!offer && offer.prompt.startsWith('E  Pick the lock'), offer ? offer.prompt : 'none');
    return out;
  }

  if (stage === 'works-day') {
    console_('set time 1200'); standAt(state.dock);
    const offer = await offerNow();
    check('and opens again at 12:00', !!offer && offer.prompt.startsWith('E  Go inside'), offer ? offer.prompt : 'none');
    return out;
  }

  if (stage === 'roof-hatch-night') {
    console_('set time 2300');
    g.teleportPlayer(-142, 2502); pump(-142, 2502); settle(10);
    const door = findDoor('tall-dock');
    if (!door) return { error: 'no roof-qualifying dock near -142,2502' };
    state.roofDoor = door;
    out.door = `${door.id} ${door.name}`;
    const stood = await qa('roofstand', {});
    check('standing on the works roof', String(stood).startsWith('ok'), stood);
    pump(p.x, p.z);
    const offer = await offerNow();
    check('night hatch asks for the pick like the street door', !!offer && offer.prompt.startsWith('E  Pick the hatch lock'), offer ? offer.prompt : 'none');
    return out;
  }

  if (stage === 'roof-exit-free') {
    const door = state.roofDoor; standAt(door);
    const entered = await qa('enter');
    check('qa enter (driver path)', entered === 'ok', entered);
    const core = coreMod.buildCore(door.facts);
    const upped = await qa('floor', { n: core.storeys - 1 });
    check('to the top floor', String(upped).startsWith('ok'), upped);
    const roofed = await qa('roof', {});
    check('exit to the roof is ungated at night', String(roofed).startsWith('ok'), roofed);
    settle(5);
    const offer = await offerNow();
    check('the hatch just used grants grace back in', !!offer && offer.prompt.startsWith('E  In through the roof hatch'), offer ? offer.prompt : 'none');
    return out;
  }

  if (stage === 'sesame-on') {
    if (String(await qa('status')).startsWith('inside')) await qa('leave');
    console_('set time 1200');
    g.teleportPlayer(-2417, -1551); pump(-2417, -1551); settle(10);
    const door = findDoor('locked-home');
    if (!door) return { error: 'no locked home near -2417,-1551' };
    out.door = `${door.id} ${door.name}`;
    console_('opensesame');
    standAt(door);
    const offer = await offerNow();
    check('opensesame: a locked home just opens, no dial', !!offer && offer.prompt.startsWith('E  Go inside'), offer ? offer.prompt : 'none');
    const active = await badgeIs('CHEATS ACTIVE');
    check('badge reads CHEATS ACTIVE while it is on', active.ok, active.detail);
    return out;
  }

  if (stage === 'sesame-off') {
    console_('opensesame');
    const used = await badgeIs('CHEATS USED');
    check('badge falls back to the permanent CHEATS USED', used.ok, used.detail);
    console_('save'); settle(3); console_('reload'); settle(10);
    const stored = JSON.parse(localStorage.getItem('groot-theft-bakkie-save-v1'));
    check('everCheated persists in the stored save', stored.everCheated === true, String(stored.everCheated));
    const still = await badgeIs('CHEATS USED');
    check('and survives the reload live', g.everCheated === true && still.ok, `${g.everCheated} ${still.detail}`);
    return out;
  }

  if (stage === 'grant-tyres') {
    const before = g.features.isLoaded('protest');
    console_('give tyres 2');
    check('grant found the protest feature unloaded', !before, `protest loaded before: ${before}`);
    for (let i = 0; i < 50 && !g.features.isLoaded('protest'); i++) await new Promise(r => setTimeout(r, 200));
    check('the protest body loaded for the grant', g.features.isLoaded('protest'), String(g.features.isLoaded('protest')));
    settle(5);
    const status = g.features.command(['protest', 'status']).join(' ');
    check('the tyres landed', status.includes('tyres=2'), status);
    return out;
  }

  return { error: 'unknown stage ' + stage };
}
"""

# stage -> screenshot taken AFTER it returns (the live loop keeps the state on screen)
STAGES = [
    ('organic', None),
    ('home-try', 'lock1-try-the-door-toast'),
    ('home-dial', 'lock2-dial-midsweep'),
    ('home-pick', 'lock3-inside-after-pick'),
    ('home-leave', 'lock4-grace-go-inside'),
    ('shopfront', 'lock5-shopfront-open'),
    ('works-night', 'lock6-dock-locked-at-night'),
    ('works-day', None),
    ('roof-hatch-night', 'lock7-roof-hatch-night'),
    ('roof-exit-free', 'lock8-on-works-roof-night'),
    ('sesame-on', 'lock9-opensesame-active'),
    ('sesame-off', 'lock10-cheats-used-badge'),
    ('grant-tyres', None),
]

with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True, args=[
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage', '--no-sandbox'])
    page = browser.new_page(viewport={'width': 1100, 'height': 680})
    page.add_init_script("localStorage.clear(); localStorage.setItem('groot-theft-bakkie-save-v1', JSON.stringify({version: 2, settings: {quality: 'low', masterVolume: 0}}))")
    page.set_default_timeout(600000)
    page.goto(f'http://127.0.0.1:{args.port}/', timeout=120000)
    # Wait for the WHOLE boot (prepareAssets ends at mode 'menu') — starting the game mid-boot
    # leaves the loading card up and renderHUD never running, so the DOM shows default markup.
    for _ in range(120):
        time.sleep(2)
        if page.evaluate("() => !!window.__game && window.__game.mode === 'menu'"):
            break
    page.evaluate("() => { window.__game.startGame(true); return 0; }")
    time.sleep(2)
    # startGame() called directly leaves the DOM main-menu card up (the real flow hides it via the
    # menu button callback); hide it so page screenshots show the game, not the menu.
    page.evaluate("() => { window.__game.ui.hideMenu(); return 0; }")
    page.evaluate(BOOT_JS)
    failures = 0
    for stage, shot in STAGES:
        result = page.evaluate(STAGE_JS, stage)
        if 'error' in result:
            print(stage, 'ERROR', result['error'])
            failures += 1
            continue
        print(stage, result.get('door', ''))
        for c in result['checks']:
            print('  ', 'PASS' if c['ok'] else 'FAIL', c['name'], '->', c['detail'])
            if not c['ok']:
                failures += 1
        if shot:
            # Drive one real frame ourselves — headless RAF is throttled, so both the canvas and
            # the DOM HUD would otherwise be stale at screenshot time.
            page.evaluate("() => { const g = window.__game; g.update(1/60); g.updateCamera(1/60); g.renderHUD(); if (g.postProcessing) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera); return 0; }")
            time.sleep(0.3)
            page.screenshot(path=str(OUT / f'{shot}.png'))
    print('RESULT:', 'GREEN' if failures == 0 else f'{failures} FAILURES')
    browser.close()
