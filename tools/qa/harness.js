/* global window, KeyboardEvent */
/**
 * In-page mission QA core (installed by mission-harness.py, driven per-objective from Python).
 *
 * Philosophy: exercise the REAL game paths — real dialogue accept, real vehicle entry, real
 * key events, collider-respecting walking (clampMoveAt) — and teleport-drive along real
 * road routes at 65% of the vehicle's cruise speed. Where the honest path is hours of sim,
 * a documented shortcut still routes through the real state machines:
 *   - lose-wanted: heat asserted present, then WantedSystem.clear() (evasion sim skipped)
 *   - defeat: wave spawn asserted, then the kill counter set (combat sim skipped)
 *   - trains/planes: boarded/entered for real, then the CARRIER is teleported (its state
 *     machines — station detection, altitude, bail-out, canopy — all run for real)
 */
window.__qa = (() => {
  const g = window.__game;
  const STEP = 0.15; // sim step used for fast-forwarding
  const state = { mission: null, log: [], findings: [], shots: [] };

  // SwiftShader dies under the continuous background RAF render of a 3.2M-triangle scene across a
  // long sweep. The harness drives via direct sim steps and doesn't need the live view, so suppress
  // the renderer entirely (restored only for a screenshot). This removes the crash source.
  const realComposerRender = g.composer ? g.composer.render.bind(g.composer) : null;
  const realRendererRender = g.renderer.render.bind(g.renderer);
  let renderSuppressed = false;
  function suppressRender() {
    if (renderSuppressed) return;
    renderSuppressed = true;
    if (g.composer) g.composer.render = () => {};
    g.renderer.render = () => {};
  }
  function withRender(fn) {
    if (g.composer && realComposerRender) g.composer.render = realComposerRender;
    g.renderer.render = realRendererRender;
    const out = fn();
    if (renderSuppressed) { if (g.composer) g.composer.render = () => {}; g.renderer.render = () => {}; }
    return out;
  }

  const finding = (severity, what) => { state.findings.push({ mission: state.mission, objective: objIndex(), severity, what }); };
  const note = (what) => state.log.push(`[${state.mission}:${objIndex()}] ${what}`);
  const objIndex = () => g.missions.active ? g.missions.objectiveIndex : -1;
  const objective = () => g.missions.objective;
  const focus = () => g.activeVehicle?.group.position ?? g.player.group.position;
  const surface = (x, z) => g.city.surfaceHeightAt(x, z);
  const step = (n, dt = STEP) => { for (let i = 0; i < n; i++) g.update(dt); };
  const pump = (x, z) => { let guard = 0; while ((g.city.buildQueue?.length || g.city.pending) && guard++ < 500) g.city.updateBuildingChunks(x, z); };
  const key = (code) => { window.dispatchEvent(new KeyboardEvent('keydown', { code })); g.update(1 / 60); window.dispatchEvent(new KeyboardEvent('keyup', { code })); };
  const planner = () => g.population.vehiclePlanner;
  const roadRoute = (tx, tz) => {
    const p = focus();
    // A sanctioned journey (or any far destination) needs the citywide planner — plan()'s normal
    // expansion cap can't reach across the map, which is fine for clustered reaches but fails a
    // multi-km drive like the padstal run. planFar carries the citywide cap.
    const journeyObj = (window.__scripts?.[g.missions.active?.id]?.journeys ?? []).includes(objIndex());
    if (journeyObj || Math.hypot(tx - p.x, tz - p.z) > 2500) return planner().planFar(p.x, p.z, tx, tz);
    return planner().plan(p.x, p.z, planner().nearest(tx, tz));
  };
  const routeLength = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return d; };
  const cruise = () => (g.activeVehicle?.spec.maxSpeed ?? 34) * 0.65;

  /** Teleport-walk with REAL collision: clampMoveAt must let us through, or the route is blocked. */
  function walkToward(tx, tz, speed, dt) {
    const p = g.player.group.position;
    const dx = tx - p.x, dz = tz - p.z; const d = Math.hypot(dx, dz);
    if (d < 0.3) return true;
    const stepLen = Math.min(d, speed * dt);
    const desired = p.clone(); desired.x += (dx / d) * stepLen; desired.z += (dz / d) * stepLen;
    const clamped = g.city.clampMoveAt(p, desired, 0.5);
    const moved = Math.hypot(clamped.x - p.x, clamped.z - p.z);
    p.x = clamped.x; p.z = clamped.z; p.y = surface(p.x, p.z);
    return moved > stepLen * 0.3 ? false : 'blocked';
  }

  /** Drive the active vehicle (or walk the player) along road route points. Returns steps used or -1 if the objective never advanced. */
  function driveRoute(points, maxSimSeconds) {
    state.simSeconds = 0;
    const startObjective = `${g.missions.active?.id}:${objIndex()}:${g.missions.progress}`;
    const v = g.activeVehicle; const speed = v ? cruise() : 7;
    let i = 0; let sim = 0;
    let px = focus().x, pz = focus().z;
    while (i < points.length && sim < maxSimSeconds) {
      const target = points[i];
      const dx = target.x - px, dz = target.z - pz; const d = Math.hypot(dx, dz);
      if (d < 2) { i++; continue; }
      const stepLen = Math.min(d, speed * STEP);
      px += (dx / d) * stepLen; pz += (dz / d) * stepLen;
      if (v) { v.group.position.set(px, g.city.roadHeightAt(px, pz), pz); v.heading = Math.atan2(dx, dz); v.group.rotation.y = v.heading; v.speed = speed; }
      else { g.player.group.position.set(px, surface(px, pz), pz); }
      g.update(STEP); sim += STEP; state.simSeconds = sim;
      if (`${g.missions.active?.id}:${objIndex()}:${g.missions.progress}` !== startObjective) return sim;
      if (g.missions.state === 'failed') return sim;
    }
    // Route exhausted at the nearest LANE NODE — which can sit outside the objective radius.
    // Final approach: close the remaining gap straight toward the marker itself.
    const marker = g.markerTarget ?? g.missionTargetRaw?.();
    if (marker) {
      let guard = 0;
      while (guard++ < 300 && Math.hypot(marker.position.x - px, marker.position.z - pz) > 1.5) {
        const dx = marker.position.x - px, dz = marker.position.z - pz; const d = Math.hypot(dx, dz);
        const stepLen = Math.min(d, speed * STEP);
        px += (dx / d) * stepLen; pz += (dz / d) * stepLen;
        if (v) { v.group.position.set(px, g.city.roadHeightAt(px, pz), pz); v.speed = speed * 0.5; }
        else g.player.group.position.set(px, surface(px, pz), pz);
        g.update(STEP); sim += STEP;
        if (`${g.missions.active?.id}:${objIndex()}:${g.missions.progress}` !== startObjective) return sim;
        if (g.missions.state === 'failed') return sim;
      }
    }
    for (let k = 0; k < 20; k++) {
      g.update(STEP); sim += STEP;
      if (`${g.missions.active?.id}:${objIndex()}:${g.missions.progress}` !== startObjective) return sim;
      if (g.missions.state === 'failed') return sim;
    }
    return -1;
  }

  /** Static per-objective audit: marker, minimap, surface sanity, route, timer feasibility. */
  function audit() {
    const o = objective(); if (!o) return { kind: 'none' };
    const marker = g.markerTarget;
    const result = { kind: o.kind, text: o.text, hidden: Boolean(o.hidden), marker: marker?.label ?? null, timer: g.missions.remainingTime || null, roadDistance: null };
    const raw = g.missionTargetRaw?.() ?? null;
    if (o.hidden) {
      if (marker && !g.riddleRevealed && raw && Math.hypot(marker.position.x - raw.position.x, marker.position.z - raw.position.z) < 2) finding('fail', `hidden objective leaks its marker: ${marker.label}`);
      const area = g.riddleSearchArea?.();
      if (!area) finding('fail', `riddle "${o.text}" has no search circle (owner: markerless one-liners are hostile)`);
      else if (raw) {
        const off = Math.hypot(area.x - raw.position.x, area.z - raw.position.z);
        if (off > area.radius - 10) finding('fail', `riddle search circle does not safely contain its answer (${Math.round(off)}u vs r=${area.radius})`);
        // Owner: the answer must NOT sit at the bullseye (the circle would give it away), and the
        // circle must hold >=2 notable objects so the clue does the disambiguating, not the ring.
        if (off < 40) finding('fail', `riddle answer sits at the circle centre (${Math.round(off)}u) — offset it so the ring doesn't hand over the answer`);
        const inCircle = (x, z) => Math.hypot(x - area.x, z - area.z) <= area.radius;
        const roads = (window.__roads ?? []).filter((r) => r.name && r.points.some((p) => inCircle(p.x, p.z)));
        const streetNames = new Set(roads.map((r) => r.name));
        const shops = (g.shops?.mapIcons?.() ?? []).filter((s) => inCircle(s.x, s.z)).length;
        const notable = streetNames.size + shops;
        if (notable < 2) finding('fail', `riddle circle holds only ${notable} notable object(s) (${streetNames.size} named streets + ${shops} shops) — needs >=2 so the ring alone can't give it away`);
        else note(`riddle circle: ${streetNames.size} named streets + ${shops} shops inside, answer ${Math.round(off)}u off-centre`);
      }
      const hints = (window.__scripts?.[g.missions.active?.id]?.hints ?? []).filter((h) => h.objective === objIndex());
      if (!hints.length) finding('fail', `riddle "${o.text}" has no progressive hints`);
      else if (!hints.some((h) => h.reveal)) finding('fail', `riddle "${o.text}" hints never escalate to a real blip`);
    } else if (['reach', 'escape', 'collect', 'checkpoints', 'enter-kind', 'follow'].includes(o.kind)) {
      if (!marker) finding(o.conditionsOnly && !o.target ? 'warn' : 'fail', `no world marker for located objective "${o.text}"`);
      if (marker) {
        const onMap = g.mapMarkers().some((m) => Math.abs(m.x - marker.position.x) < 2 && Math.abs(m.z - marker.position.z) < 2);
        if (!onMap) finding('fail', `marker "${marker.label}" missing from minimap`);
        const drop = marker.position.y - surface(marker.position.x, marker.position.z);
        if (Math.abs(drop) > 4 && !['inPlane'].some((c) => o.conditions?.[c])) finding('fail', `marker "${marker.label}" floats/buried ${drop.toFixed(1)}u vs surface`);
      }
    }
    // vehicle-object sanity (the buried-car class): any vehicle the objective needs must sit ON the ground
    if (o.kind === 'enter-kind') {
      const vehicle = g.population.vehicles.find((item) => item.spec.kind === o.vehicleKind && (!o.vehicleColor || item.spec.color === o.vehicleColor));
      if (!vehicle) finding('fail', `required vehicle ${o.vehicleKind}/${o.vehicleColor?.toString(16)} does not exist in the world`);
      else {
        const dy = vehicle.group.position.y - surface(vehicle.group.position.x, vehicle.group.position.z);
        if (dy < -1.2 || dy > 3) finding('fail', `vehicle ${vehicle.spec.name} buried/floating: ${dy.toFixed(2)}u vs surface`);
      }
    }
    // route + timer feasibility for anything with a physical destination
    const destination = marker ?? raw;
    if (destination && !['choice', 'lose-wanted', 'survive', 'defeat'].includes(o.kind) && !o.conditions?.inPlane && !o.conditions?.onTrain && !o.conditions?.drivingTrain) {
      const pts = roadRoute(destination.position.x, destination.position.z);
      if (!pts?.length) finding('fail', `no road route from player to "${destination.label}"`);
      else {
        result.roadDistance = Math.round(routeLength(pts));
        // Distance TIERS (owner: effort must scale with the perceived goal — not one flat cap that
        // makes every job feel like the end of a short street). Per-mission band; a declared journey
        // objective is exempt (the sanctioned long hauls). Numbers are road distance ceilings.
        const script = window.__scripts?.[g.missions.active?.id] ?? {};
        const journeys = script.journeys ?? [];
        const isJourney = journeys.includes(objIndex());
        const tier = script.tier ?? 'standard';
        const CEIL = { favour: 1000, standard: 1800, substantial: 2800, journey: 99999 };
        const ceil = CEIL[tier] ?? 1800;
        if (isJourney || tier === 'journey') { note(`journey objective: ${result.roadDistance}u to "${destination.label}"`); }
        else if (result.roadDistance > ceil) finding('fail', `route to "${destination.label}" is ${result.roadDistance}u — over the ${tier} tier ceiling (${ceil}u); re-anchor or re-tier`);
        result.tier = tier;
        if (o.timeLimit && !isJourney) {
          // Bumbling pace (owner): 50% of cruise, with a 1.25x wrong-turn detour on the route.
          const bumbleSpeed = (g.activeVehicle?.spec.maxSpeed ?? 34) * 0.5;
          const need = (result.roadDistance * 1.25) / bumbleSpeed;
          result.timerNeed = Math.round(need);
          if (o.timeLimit < need * 1.8) finding('fail', `timer ${o.timeLimit}s < 1.8x bumbling ${Math.round(need)}s (route ${result.roadDistance}u, detour 1.25x @ ${bumbleSpeed.toFixed(0)}u/s) — set >= ${Math.ceil(need * 1.8 / 10) * 10}s`);
          // PROMISE ↔ GEOMETRY (owner: padstal promised "over the mountain" with 900s timers but sat a
          // block away — he walked it in a minute). The clean signal is a TRIVIALLY SHORT route wearing
          // a journey-scale timer: the copy sells a trip the geometry doesn't deliver. (A generous timer
          // on a genuinely long route isn't this defect, so key on absolute route length, not a ratio.)
          if (result.roadDistance < 700 && o.timeLimit >= 400) finding('fail', `promise/geometry: "${o.text}" is a ${result.roadDistance}u hop but carries a ${o.timeLimit}s journey-scale timer — the copy promises a trip the geometry doesn't deliver; lengthen the drive (declare journeys[]) or cut the timer`);
        }
        // The other direction: a genuine journey-length drive with no timer and no en-route beat is a
        // long empty haul. Declared journeys should carry a timer or a wave/beat to justify the distance.
        if (isJourney && !o.timeLimit) {
          const beat = (script.waves ?? []).some((w) => w.objective === objIndex()) || (script.quarry?.igniteObjective === objIndex());
          if (!beat) finding('warn', `journey "${o.text}" (${result.roadDistance}u) has no timer and no en-route beat — a long empty drive; add a timer or a beat`);
        }
      }
    }
    return result;
  }

  /** Resolve the current objective using its real driver. Returns a status string. */
  function resolve() {
    const o = objective(); if (!o) return g.missions.state;
    const before = `${objIndex()}:${g.missions.progress}`;
    const marker = g.markerTarget ?? g.missionTargetRaw?.();
    const advanced = () => `${objIndex()}:${g.missions.progress}` !== before || !g.missions.active;

    switch (o.kind) {
      case 'enter-kind': {
        const vehicle = g.population.vehicles.find((item) => item.spec.kind === o.vehicleKind && (!o.vehicleColor || item.spec.color === o.vehicleColor));
        if (!vehicle) return 'stuck:no-vehicle';
        const vp = vehicle.group.position;
        g.player.group.position.set(vp.x + 2, surface(vp.x + 2, vp.z), vp.z);
        step(3, 1 / 30);
        g.beginEnter(vehicle);
        step(30, 1 / 30); // the boarding transition is real
        if (!g.activeVehicle) return 'stuck:enter-failed';
        step(5);
        return advanced() ? 'ok' : 'stuck:entered-but-not-advanced';
      }
      case 'reach': case 'escape': case 'checkpoints': case 'collect': {
        if (g.trains.riding && !o.conditions?.onTrain && !o.conditions?.drivingTrain) {
          let exit = g.trains.dismount();
          for (let tries = 0; !exit && tries < 12 && g.trains.ride; tries++) { g.trains.ride.train.state.s += 6; exit = g.trains.dismount(); } // nudge along the line for clear ground
          if (exit) { g.player.group.position.set(exit.x, exit.y, exit.z); g.player.onGround = true; step(3, 1 / 30); note('stepped off the train for an on-foot objective'); }
          else if (marker) { g.player.group.position.set(marker.position.x, surface(marker.position.x, marker.position.z), marker.position.z); g.player.onGround = true; g.trains.dismount(); step(3, 1 / 30); note('shortcut: placed on foot at the marker (no clear ground beside the siding)'); }
        }
        // A collect is on-foot — you can't grab a pickup from the driver's seat. If we drove here (e.g.
        // the padstal journey leaves us parked at the marker), step out so the walk + E-press path runs.
        if (o.kind === 'collect' && g.activeVehicle) { g.beginExit(g.activeVehicle); step(24, 1 / 30); note('stepped out of the car to collect on foot'); }
        if (o.hidden && !g.riddleRevealed) {
          // Play the riddle the merciful way: walk the hint ladder (clock jumped to each threshold —
          // the hints still fire through the real updateRiddleHints path) until the reveal blip drops.
          const hintTimes = (window.__scripts?.[g.missions.active?.id]?.hints ?? []).filter((h) => h.objective === objIndex()).map((h) => h.afterSeconds).sort((a, b) => a - b);
          for (const at of hintTimes) { g.objectiveElapsed = at + 1; g.update(0.1); }
          if (!g.riddleRevealed) return 'stuck:riddle-never-revealed';
          note(`riddle revealed via hint ladder (${hintTimes.length} hints)`);
        }
        if (o.conditions?.atNight && !(g.dayNight.hour > 19 || g.dayNight.hour < 5)) { g.dayNight.hour = 22; note('shortcut: set hour 22 for atNight'); }
        if (o.conditions?.blackoutAbove && g.dayNight.blackoutFactor < o.conditions.blackoutAbove) return 'needs:blackout';
        // NEGATIVE VERB ASSERTION (owner: the re-anchor once gutted a train mission so it completed
        // without boarding). Before doing the real verb, prove the objective does NOT complete at the
        // target WITHOUT the verb — stand the player on foot on the marker and confirm no advance.
        if ((o.conditions?.onTrain || o.conditions?.drivingTrain || o.conditions?.inPlane) && marker) {
          const before = `${objIndex()}:${g.missions.progress}`;
          g.player.group.position.set(marker.position.x, surface(marker.position.x, marker.position.z), marker.position.z);
          if (g.activeVehicle) g.activeVehicle.speed = 0;
          step(6);
          if (`${objIndex()}:${g.missions.progress}` !== before || !g.missions.active) finding('fail', `verb not enforced: "${o.text}" completed at the target WITHOUT the required ${o.conditions.drivingTrain ? 'drivingTrain' : o.conditions.onTrain ? 'onTrain' : 'inPlane'} verb`);
          else note(`verb enforced: no advance at the target without the ${o.conditions.drivingTrain ? 'drivingTrain' : o.conditions.onTrain ? 'onTrain' : 'inPlane'} verb`);
        }
        if (o.conditions?.drivingTrain || o.conditions?.onTrain) return 'needs:train';
        if (o.conditions?.inPlane) return 'needs:plane';
        if (!marker) return 'stuck:no-target';
        let sim = -1;
        const near = Math.hypot(marker.position.x - focus().x, marker.position.z - focus().z) < 45 && !g.activeVehicle;
        if (near) {
          sim = 0; let blocked = 0;
          while (sim < 60) {
            const r = walkToward(marker.position.x, marker.position.z, 7, STEP);
            g.update(STEP); sim += STEP;
            if (advanced() || g.missions.state === 'failed') break;
            if (r === true) { step(10); break; }
            if (r === 'blocked' && ++blocked > 40) { sim = -1; break; }
          }
          if (!advanced() && g.missions.state !== 'failed' && o.kind !== 'collect' && sim !== -1) sim = -1;
        } else {
          const pts = roadRoute(marker.position.x, marker.position.z);
          if (!pts?.length) return 'stuck:no-route';
          // Sanctioned journeys are genuinely long drives — give the teleport-drive a bigger budget so a
          // multi-km scenic haul (padstal) actually reaches the marker instead of timing out mid-route.
          const journeyObj = (window.__scripts?.[g.missions.active?.id]?.journeys ?? []).includes(objIndex());
          // A journey is a DRIVE — a real player brings a car (the copy literally says "take a radio").
          // Console-armed missions start on foot, so board a nearby vehicle first; otherwise the bot
          // WALKS several km at 7u/s and the (correctly-sized) timer expires.
          if (journeyObj && !g.activeVehicle) {
            const veh = g.population.vehicles.find((v) => !v.wrecked && !v.spec.twoWheeler && v.spec.kind !== 'bicycle');
            if (veh) {
              const p = focus(); veh.restore?.(); veh.group.position.set(p.x + 2, g.city.roadHeightAt(p.x + 2, p.z), p.z);
              step(3, 1 / 30); g.beginEnter(veh); step(24, 1 / 30);
              note('boarded a car for the journey drive');
            }
          }
          sim = driveRoute(pts, journeyObj ? 1400 : 600);
        }
        if (g.missions.state === 'failed') return 'failed:' + state.lastFail;
        if (o.kind === 'collect' && !advanced()) { key('KeyE'); step(3); if (!advanced()) { g.collectedItem = true; step(3); note('shortcut: forced collectedItem after E failed'); finding('warn', `collect E-press did not register at "${o.text}"`); } }
        // Two-wheeler reaches: teleport-driving can trip a knockOff, dropping the rider off the bike
        // mid-route. If the objective needs a vehicle and we lost it, re-mount it at the marker.
        if (!advanced() && o.vehicleKind && !g.activeVehicle) {
          const veh = g.population.vehicles.find((v) => v.spec.kind === o.vehicleKind && (!o.vehicleColor || v.spec.color === o.vehicleColor) && !v.wrecked);
          if (veh) {
            veh.restore?.(); veh.group.position.set(marker.position.x, g.city.roadHeightAt(marker.position.x, marker.position.z), marker.position.z);
            g.player.group.position.set(marker.position.x + 1.5, surface(marker.position.x + 1.5, marker.position.z), marker.position.z);
            step(3, 1 / 30); g.beginEnter(veh); step(24, 1 / 30);
            note(`re-mounted the ${o.vehicleKind} after a mid-route knock-off`);
          }
        }
        if (sim === -1 && o.kind === 'checkpoints') return 'stuck:checkpoint-not-registering';
        // Hold night across our own teleport-drive: driveRoute() advances the game clock at game-rate
        // per sim-step, so a long night run can roll past dawn and defeat the hour we set before driving.
        // A real player covering ~1km never burns whole game-hours; re-assert night at the advance check.
        if (o.conditions?.atNight && !(g.dayNight.hour > 19 || g.dayNight.hour < 5)) { g.dayNight.hour = 22; note('shortcut: re-set hour 22 after drive for atNight'); }
        step(5);
        return advanced() ? 'ok' : 'stuck:arrived-but-not-advanced';
      }
      case 'lose-wanted': {
        const scripted = (window.__scripts?.[g.missions.active?.id]?.wanted ?? null);
        if (g.wanted.level === 0) finding(scripted ? 'fail' : 'warn', `lose-wanted began with zero heat${scripted ? ' although the script forces wanted ' + scripted.level + ' at objective ' + scripted.objective : ''}`);
        g.wanted.clear(); note('shortcut: wanted cleared via API AFTER asserting heat was present (evasion sim skipped)');
        step(10);
        return advanced() ? 'ok' : 'stuck:wanted-cleared-but-not-advanced';
      }
      case 'defeat': {
        // REAL kills (no API crediting): kill the whole crew through the ped's own damage path and
        // assert the counter follows each kill — this is the hole that let uncredited kills ship
        // (owner: Rank Cold War 0/3). One pass kills all of them so a per-kill progress bump doesn't
        // make the outer loop re-enter on a depleted crew.
        const need = o.required ?? 1;
        const capacity = g.population.hostiles.length;
        if (capacity < need) { finding('fail', `defeat needs ${need} hostiles but the wave only holds ${capacity}`); return 'stuck:defeat-short-wave'; }
        const startIdx = g.missions.objectiveIndex; // stop the moment THIS defeat objective advances —
        let guard = 0;                              // a following objective's fresh wave must not get farmed
        let usedVehicleKill = false;
        while (g.population.defeatedHostiles() < need && g.missions.state === 'active' && g.missions.objectiveIndex === startIdx && guard++ < 20) {
          const alive = g.population.hostiles.filter((ped) => ped.state !== 'down');
          if (!alive.length) break;
          const target = alive[0];
          const before = g.population.defeatedHostiles();
          // Kill the FIRST hostile by a REAL vehicle impact (the owner's exact case): drop a car on it
          // at lethal speed so handleVehiclePedestrianImpacts fires — no direct takeDamage, no API credit.
          // Use a throwaway NON-mission vehicle so ramming doesn't wreck a mission-critical van.
          const car = !usedVehicleKill ? g.population.vehicles.find((v) => v !== g.activeVehicle && !v.disabled && !v.wrecked && v.spec.kind !== 'van') : null;
          if (car) {
            usedVehicleKill = true;
            // Re-assert the car on the ped at lethal speed each step until it goes down — the driving
            // update decelerates the car, so a single step can drop it below the kill threshold.
            let vg = 0;
            while (target.state !== 'down' && vg++ < 8) {
              const tp = target.group.position;
              car.group.position.set(tp.x, g.city.roadHeightAt(tp.x, tp.z), tp.z);
              car.speed = 30; // |speed| * 2.8 well over ped health — a kill, not a knockdown
              g.update(STEP);
            }
            step(2);
            if (g.population.defeatedHostiles() <= before) finding('fail', `VEHICLE kill of a mission hostile did not credit (${target.group.name}) — the owner's exact bug`);
            else note('killed a wave member by REAL vehicle impact — credited');
          } else {
            target.takeDamage(1000, g.player.group.position); // rest via the ped's own damage path
            step(3);
            if (g.population.defeatedHostiles() <= before && g.missions.objectiveIndex === startIdx) finding('fail', `killing a mission hostile did not credit the defeat counter (${target.group.name})`);
          }
        }
        step(5);
        if (!advanced() && g.missions.state === 'active') finding('fail', `defeat did not advance after ${g.population.defeatedHostiles()}/${need} real kills`);
        return advanced() ? 'ok' : 'stuck:defeat-not-advancing';
      }
      case 'survive': {
        const need = (g.missions.remainingTime || 30) + 3;
        step(Math.ceil(need / STEP));
        return advanced() ? 'ok' : 'stuck:survive-not-advancing';
      }
      case 'choice': {
        g.tryMissionInteraction(); // opens the modal (pauses)
        const id = o.choices?.[0]?.id;
        g.ui.onMissionChoice?.(id);
        step(5);
        return advanced() ? 'ok' : 'stuck:choice-not-advancing';
      }
      case 'follow': {
        if (!g.quarry) return 'stuck:no-quarry';
        let sim = 0;
        state.simSeconds = 0;
        while (sim < 900 && !advanced() && g.missions.state === 'active') {
          const qp = g.quarry.group.position;
          g.player.group.position.set(qp.x + 12, surface(qp.x + 12, qp.z), qp.z + 6); // shadow the bakkie
          g.update(STEP); sim += STEP; state.simSeconds = sim;
        }
        if (g.missions.state === 'failed') return 'failed:' + state.lastFail;
        return advanced() ? 'ok' : 'stuck:quarry-never-arrived';
      }
      default: return 'stuck:unknown-kind';
    }
  }

  // ---- special carriers ------------------------------------------------------------

  /** Board the train whose line passes nearest `stationName`, then teleport the TRAIN to that station.
   *  Boarding, riding pose, station detection and (optionally) the cab controls are all real. */
  function trainTo(stationName, drive) {
    const trains = g.trains.trains ?? [];
    // the current objective's blip target IS the station point (set by content)
    const target = g.markerTarget ?? g.missionTargetRaw?.();
    if (!target) return 'stuck:no-station-target';
    let best = g.trains.ride?.train ?? null; let bestD = best ? 0 : Infinity;
    if (!best) for (const train of trains) {
      for (let i = 0; i < train.points.length; i += 4) {
        const p = train.points[i];
        const d = Math.hypot(p.x - target.position.x, p.z - target.position.z);
        if (d < bestD) { bestD = d; best = train; }
      }
    }
    if (!best) { finding('fail', `no rail line passes near "${target.label}"`); return 'stuck:no-line'; }
    if (!g.trains.riding) {
      // ride the line that actually serves the target: sanity that a line passes close
      let lineD = Infinity;
      for (let i = 0; i < best.points.length; i += 2) { const p = best.points[i]; lineD = Math.min(lineD, Math.hypot(p.x - target.position.x, p.z - target.position.z)); }
      if (lineD > 60) finding('fail', `nearest rail line misses "${target.label}" by ${Math.round(lineD)}u`);
      // Force the picked consist to a dwell so the speed gate (BOARD_MAX_SPEED) passes deterministically
      // — waiting for a natural station stop is flaky when the line's stations are far apart.
      best.state.speed = 0; best.state.dwell = 40; g.update(STEP);
      // Every vertex within the consist's span is on the track; try boarding from each x a few heights.
      let boarded = false;
      const cumEnd = best.cum[best.cum.length - 1];
      for (let vi = 0; vi < best.points.length && !boarded; vi++) {
        const arc = best.cum[vi];
        if (arc < best.state.s - best.trainLength - 2 || arc > best.state.s + 2) continue; // within the consist span
        const pt = best.points[vi];
        for (const dy of [1.1, 0.6, 1.6, 0.1, 2.1, 2.6]) {
          g.player.group.position.set(pt.x, g.city.terrainHeightAt(pt.x, pt.z) + dy, pt.z);
          if (g.trains.tryBoard(g.player.group.position)) { boarded = true; break; }
        }
      }
      if (!boarded && cumEnd) { // last resort: sweep the whole line finely
        for (let arc = 0; arc < cumEnd && !boarded; arc += 3) {
          const p = arcPoint(best, arc);
          for (const dy of [1.1, 0.6, 1.6]) { g.player.group.position.set(p.x, g.city.terrainHeightAt(p.x, p.z) + dy, p.z); if (g.trains.tryBoard(g.player.group.position)) { boarded = true; break; } }
        }
      }
      if (!boarded) { finding('fail', 'could not board the dwelling train anywhere along its span'); return 'stuck:board-failed'; }
    }
    if (drive && !g.trains.driving) {
      // takeControls needs the rider standing in a cab zone (near the nose): seat them at s≈margin.
      if (g.trains.ride) g.trains.ride.s = 1.0;
      g.trains.takeControls();
      if (!g.trains.driving) { finding('fail', 'takeControls failed at the nose cab'); return 'stuck:no-controls'; }
    }
    // teleport the train's nose arc to the station
    const arc = nearestArc(best, target.position.x, target.position.z);
    best.state.s = arc; best.state.speed = 0; best.state.dwell = drive ? 0 : 8;
    if (drive) { const ride = g.trains.ride; if (ride) ride.v = 0; }
    step(12, 1 / 20);
    note(`train teleported to arc ${Math.round(arc)} near ${target.label} (station reads: ${g.trains.currentStationName ?? 'none'})`);
    return 'ok-carrier';
  }
  function arcPoint(train, s) {
    const cum = train.cum; const pts = train.points;
    let i = 1; while (i < cum.length && cum[i] < s) i++;
    if (i >= pts.length) return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };
    const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
  }
  function nearestArc(train, x, z) {
    let bestS = 0; let bestD = Infinity;
    for (let s = 0; s < train.cum[train.cum.length - 1]; s += 5) {
      const p = arcPoint(train, s); const d = Math.hypot(p.x - x, p.z - z);
      if (d < bestD) { bestD = d; bestS = s; }
    }
    return bestS;
  }

  /** Enter a plane for real, teleport-fly it to the marker at altitude, then bail + canopy for real. */
  function flyTo() {
    const target = g.markerTarget ?? g.missionTargetRaw?.();
    let plane = g.activePlane ?? null;
    if (!plane) {
      plane = g.planes?.find((entry) => !entry.wrecked) ?? null;
      if (!plane) { finding('fail', 'no flyable plane exists'); return 'stuck:no-plane'; }
      const pp = plane.group.position;
      g.player.group.position.set(pp.x + 3, surface(pp.x + 3, pp.z), pp.z);
      step(3, 1 / 30);
      g.enterPlane(plane);
      if (!g.activePlane) { finding('fail', 'enterPlane did not take'); return 'stuck:enter-plane'; }
    }
    if (!target) return 'stuck:no-air-target';
    // teleport-fly: hover the real airframe high over the objective — above the tower line, low
    // momentum so the settle frames don't fly it into Ponte (sweep 2: crashed, bail found no plane)
    plane.state.grounded = false; plane.state.speed = 12;
    plane.group.position.set(target.position.x, surface(target.position.x, target.position.z) + 160, target.position.z);
    step(6, 1 / 30);
    return 'ok-carrier';
  }

  function bailAndLand(tx, tz) {
    if (!g.activePlane && !g.airborne) { flyTo(); step(4, 1 / 30); } // re-establish flight if the airframe was lost
    const plane = g.activePlane;
    if (plane) g.bailOut(plane);
    else if (!g.airborne) return 'stuck:not-flying';
    if (!g.airborne) { finding('fail', 'bailOut did not enter the skydive'); return 'stuck:no-airborne'; }
    key('Space'); // canopy (real deploy path; inventory topped up by boarding)
    let sim = 0;
    while (g.airborne && sim < 700) {
      const p = g.player.group.position;
      const dx = tx - p.x, dz = tz - p.z; const d = Math.hypot(dx, dz);
      if (d > 1) { const stepLen = Math.min(d, 9 * STEP); p.x += (dx / d) * stepLen; p.z += (dz / d) * stepLen; } // glide steering, canopy sink is real
      g.update(STEP); sim += STEP;
    }
    if (g.airborne) return 'stuck:never-landed';
    note(`landed after ${Math.round(sim)}s of canopy`);
    // A canopy landing rarely stops on the exact reach point — walk the rest of the way in on foot.
    let wsim = 0;
    while (wsim < 40 && Math.hypot(tx - g.player.group.position.x, tz - g.player.group.position.z) > 4) {
      walkToward(tx, tz, 7, STEP); g.update(STEP); wsim += STEP;
      if (g.missions.state !== 'active') break;
    }
    step(4);
    return 'ok';
  }

  // ---- flagship: walk the breach for real ------------------------------------------

  function breachYard() {
    // darkness first: night + a forced outage, eased factor must clear the threshold
    g.dayNight.hour = 22;
    if (!g.loadShedding.active) g.applyEskom(g.loadShedding.force());
    let sim = 0; while (g.dayNight.blackoutFactor < 0.75 && sim < 30) { g.update(STEP); sim += STEP; }
    if (g.dayNight.blackoutFactor < 0.75) { finding('fail', `blackout factor stuck at ${g.dayNight.blackoutFactor.toFixed(2)}`); return 'stuck:no-dark'; }
    g.torch.on = false; // own torch inside the fence = spotted
    // the quiet-takedown route: yard guards go down (real damage API), their cones die with them
    for (const guard of g.yardGuards ?? []) if (guard.state !== 'down') guard.takeDamage?.(1000);
    // walk from the gate around the ring to the back and in through the breach — REAL collision
    const office = g.markerTarget ?? g.missionTargetRaw?.();
    if (!office) return 'stuck:no-office-target';
    const gate = g.player.group.position.clone();
    const cx = (gate.x + office.position.x) / 2, cz = (gate.z + office.position.z) / 2; // ~ yard centre
    const ring = Math.hypot(gate.x - cx, gate.z - cz) + 3;
    const gateAngle = Math.atan2(gate.x - cx, gate.z - cz);
    // arc-walk to the far side
    for (let t = 0; t <= 1.001; t += 0.05) {
      const a = gateAngle + Math.PI * t;
      const wx = cx + Math.sin(a) * ring, wz = cz + Math.cos(a) * ring;
      let guard = 0;
      while (walkToward(wx, wz, 7, STEP) === false && guard++ < 300) g.update(STEP);
    }
    // now push inward toward the office through the breach; sidestep along the ring if blocked
    for (let offset = 0; offset <= 12; offset = offset <= 0 ? -offset + 2 : -offset) {
      const a = gateAngle + Math.PI + offset / ring;
      const sx = cx + Math.sin(a) * ring, sz = cz + Math.cos(a) * ring;
      let guard = 0;
      while (walkToward(sx, sz, 7, STEP) === false && guard++ < 200) g.update(STEP);
      let blockedCount = 0; let ok = false; let guard2 = 0;
      while (guard2++ < 400) {
        const r = walkToward(office.position.x, office.position.z, 6, STEP);
        g.update(STEP);
        if (r === true) { ok = true; break; }
        if (r === 'blocked' && ++blockedCount > 30) break;
        if (g.missions.state === 'failed') return 'failed:' + state.lastFail;
        if (`${objIndex()}` !== '1' && g.missions.objectiveIndex > 1) { ok = true; break; }
      }
      if (ok) return 'ok';
    }
    finding('fail', 'no walkable breach into Kelvin Yard (fence sweep found no gap)');
    return 'stuck:no-breach';
  }

  /** Escape Dark House: back out through the breach and around the ring to the gate — real collision. */
  const keepDark = () => { g.dayNight.hour = 22; g.torch.on = false; if (!g.loadShedding.active) g.applyEskom(g.loadShedding.force()); };
  function escapeYard() {
    // During the blackout the maglock gate hangs OPEN (the breach was only the grid-up way in), so the
    // escape is a short straight walk office → gate — well inside one outage window. Keep it dark and
    // brief so no self-ending-outage frame catches the player still inside the fence.
    keepDark();
    let dsim = 0; while (g.dayNight.blackoutFactor < 0.78 && dsim < 30) { g.update(STEP); dsim += STEP; }
    for (const guard of g.yardGuards ?? []) if (guard.state !== 'down') guard.takeDamage?.(1000);
    const gate = g.markerTarget ?? g.missionTargetRaw?.();
    if (!gate) return 'stuck:no-gate-target';
    let guard = 0;
    while (g.missions.state === 'active' && guard++ < 200) {
      keepDark();
      walkToward(gate.position.x, gate.position.z, 8, STEP); g.update(STEP);
      if (!g.missions.active || g.missions.state !== 'active') break;
    }
    step(6);
    return g.missions.state === 'complete' || !g.missions.active ? 'ok' : g.missions.state === 'failed' ? 'failed:' + state.lastFail : 'stuck:escape';
  }

  // ---- orchestration ----------------------------------------------------------------


  function prep(missionId) {
    state.mission = missionId; state.lastFail = null;
    const index = g.missions.missions.findIndex((entry) => entry.id === missionId) + 1;
    if (!index) return 'no-such-mission';
    g.cheats.invulnerable = true; // the harness verifies mission logic, not AFK survival in traffic
    g.wanted.clear();
    if (missionId === 'delivery-run') {
      // The opener keeps the REAL offer path: walk up, talk, accept — the one dialogue-accept flow test.
      g.missions.active = undefined; g.missions.state = 'available';
      g.dialogue.abandon?.(); g.story.abandonOffer?.();
      const s2 = g.missions.missions[index - 1].start.position;
      g.teleportPlayer(s2.x, s2.z, missionId);
      pump(s2.x, s2.z);
      step(6, 1 / 30);
      return 'ready';
    }
    // Everything else arms through the same console command players/testers use: `mission <n>`.
    const said = g.consoleHost.missionStart(index);
    pump(g.player.group.position.x, g.player.group.position.z);
    step(6, 1 / 30);
    if (g.missions.active?.id !== missionId) { note(`missionStart said: ${said}`); return `not-armed:${g.missions.active?.id ?? 'none'}`; }
    return 'armed-direct';
  }

  function accept() {
    const before = state.mission;
    if (!g.tryMissionInteraction()) return 'no-offer';
    let presses = 0;
    while (g.dialogue.active && presses++ < 15) { g.advanceDialogue(); g.update(1 / 60); }
    step(4, 1 / 30);
    if (g.missions.active?.id !== before) return `not-armed:${g.missions.active?.id ?? 'none'}`;
    return 'armed';
  }

  function shot() {
    const p = focus(); pump(p.x, p.z);
    for (let i = 0; i < 8; i++) g.update(1 / 60);
    g.updateCamera(1 / 60);
    return withRender(() => {
      if (g.composer && realComposerRender) realComposerRender(); else realRendererRender(g.scene, g.camera);
      return g.renderer.domElement.toDataURL('image/jpeg', 0.7);
    });
  }

  // capture the last failure reason for reporting
  const origFail = g.missions.fail.bind(g.missions);
  g.missions.fail = (reason) => { state.lastFail = reason; return origFail(reason); };

  suppressRender();
  return { g, state, prep, accept, audit, resolve, trainTo, flyTo, bailAndLand, breachYard, escapeYard, shot, step, note, finding, objIndex };
})();
