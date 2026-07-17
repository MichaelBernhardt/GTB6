/* eslint-env browser */
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
  const roadRoute = (tx, tz) => { const p = focus(); return planner().plan(p.x, p.z, planner().nearest(tx, tz)); };
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
      g.update(STEP); sim += STEP;
      if (`${g.missions.active?.id}:${objIndex()}:${g.missions.progress}` !== startObjective) return sim;
      if (g.missions.state === 'failed') return sim;
    }
    // route exhausted: settle a few steps at the destination
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
      if (marker && raw && Math.hypot(marker.position.x - raw.position.x, marker.position.z - raw.position.z) < 2) finding('fail', `hidden objective leaks its marker: ${marker.label}`);
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
        if (o.timeLimit) {
          const need = result.roadDistance / cruise();
          result.timerNeed = Math.round(need);
          if (o.timeLimit < need * 1.8) finding('fail', `timer ${o.timeLimit}s < 1.8x measured ${Math.round(need)}s (route ${result.roadDistance}u @ ${cruise().toFixed(0)}u/s) — set >= ${Math.ceil(need * 1.8 / 10) * 10}s`);
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
        if (o.conditions?.atNight && !(g.dayNight.hour > 19 || g.dayNight.hour < 5)) { g.dayNight.hour = 22; note('shortcut: set hour 22 for atNight'); }
        if (o.conditions?.blackoutAbove && g.dayNight.blackoutFactor < o.conditions.blackoutAbove) return 'needs:blackout';
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
          sim = driveRoute(pts, 600);
        }
        if (g.missions.state === 'failed') return 'failed:' + state.lastFail;
        if (sim === -1 && o.kind === 'collect') { key('KeyE'); step(3); if (!advanced()) { g.collectedItem = true; step(3); note('shortcut: forced collectedItem after E failed'); finding('warn', `collect E-press did not register at "${o.text}"`); } }
        if (sim === -1 && o.kind === 'checkpoints') return 'stuck:checkpoint-not-registering';
        step(5);
        return advanced() ? 'ok' : 'stuck:arrived-but-not-advanced';
      }
      case 'lose-wanted': {
        if (g.wanted.level === 0) { note('no heat to lose (script may not have forced it)'); finding('warn', 'lose-wanted objective began with zero heat'); }
        g.wanted.clear(); note('shortcut: wanted cleared via API (evasion sim skipped)');
        step(10);
        return advanced() ? 'ok' : 'stuck:wanted-cleared-but-not-advanced';
      }
      case 'defeat': {
        const alive = g.population.hostiles.filter((ped) => ped.state !== 'down').length;
        if (alive < (o.required ?? 1)) finding('fail', `defeat needs ${o.required ?? 1} hostiles but only ${alive} spawned`);
        g.hostileDefeated = o.required ?? 1; note('shortcut: kill counter set (combat sim skipped)');
        step(5);
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
        while (sim < 900 && !advanced() && g.missions.state === 'active') {
          const qp = g.quarry.group.position;
          g.player.group.position.set(qp.x + 12, surface(qp.x + 12, qp.z), qp.z + 6); // shadow the bakkie
          g.update(STEP); sim += STEP;
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
      // wait for a dwell, then board at the nose for real
      let sim = 0;
      while (best.state.speed > 0.4 && sim < 60) { g.update(STEP); sim += STEP; }
      const noseAt = noseWorld(best);
      g.player.group.position.set(noseAt.x, surface(noseAt.x, noseAt.z) + 1.2, noseAt.z);
      if (!g.trains.tryBoard(g.player.group.position)) { finding('fail', 'could not board the dwelling train at its nose'); return 'stuck:board-failed'; }
    }
    if (drive && !g.trains.driving) { g.trains.takeControls(); if (!g.trains.driving) { finding('fail', 'takeControls failed at the nose cab'); return 'stuck:no-controls'; } }
    // teleport the train's nose arc to the station
    const arc = nearestArc(best, target.position.x, target.position.z);
    best.state.s = arc; best.state.speed = 0; best.state.dwell = drive ? 0 : 8;
    if (drive) { const ride = g.trains.ride; if (ride) ride.v = 0; }
    step(12, 1 / 20);
    note(`train teleported to arc ${Math.round(arc)} near ${target.label} (station reads: ${g.trains.currentStationName ?? 'none'})`);
    return 'ok-carrier';
  }
  function noseWorld(train) { const s = train.state.s; return arcPoint(train, s); }
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
    // teleport-fly: climb the real airframe to the objective point
    plane.state.grounded = false; plane.state.speed = 40;
    plane.group.position.set(target.position.x, surface(target.position.x, target.position.z) + 220, target.position.z);
    step(20, 1 / 20);
    return 'ok-carrier';
  }

  function bailAndLand(tx, tz) {
    const plane = g.activePlane; if (!plane) return 'stuck:not-flying';
    g.bailOut(plane);
    if (!g.airborne) { finding('fail', 'bailOut did not enter the skydive'); return 'stuck:no-airborne'; }
    key('Space'); // canopy (real deploy path; inventory topped up by boarding)
    let sim = 0;
    while (g.airborne && sim < 120) {
      const p = g.player.group.position;
      const dx = tx - p.x, dz = tz - p.z; const d = Math.hypot(dx, dz);
      if (d > 1) { const stepLen = Math.min(d, 9 * STEP); p.x += (dx / d) * stepLen; p.z += (dz / d) * stepLen; } // glide steering, canopy sink is real
      g.update(STEP); sim += STEP;
    }
    if (g.airborne) return 'stuck:never-landed';
    note(`landed after ${Math.round(sim)}s of canopy`);
    return 'ok';
  }

  // ---- flagship: walk the breach for real ------------------------------------------

  function breachYard() {
    // darkness first: night + a forced outage, eased factor must clear the threshold
    g.dayNight.hour = 22;
    if (!g.loadShedding.active) g.applyEskom(g.loadShedding.force());
    let sim = 0; while (g.dayNight.blackoutFactor < 0.75 && sim < 30) { g.update(STEP); sim += STEP; }
    if (g.dayNight.blackoutFactor < 0.75) { finding('fail', `blackout factor stuck at ${g.dayNight.blackoutFactor.toFixed(2)}`); return 'stuck:no-dark'; }
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
  function escapeYard() {
    const gate = g.markerTarget ?? g.missionTargetRaw?.();
    if (!gate) return 'stuck:no-gate-target';
    const office = g.player.group.position.clone();
    const cx = (gate.position.x + office.x) / 2, cz = (gate.position.z + office.z) / 2;
    const ring = Math.hypot(gate.position.x - cx, gate.position.z - cz) + 3;
    const gateAngle = Math.atan2(gate.position.x - cx, gate.position.z - cz);
    const breachAngle = gateAngle + Math.PI;
    // out through the breach (sidestep search like the way in)
    for (let offset = 0; offset <= 12; offset = offset <= 0 ? -offset + 2 : -offset) {
      const a = breachAngle + offset / ring;
      const bx = cx + Math.sin(a) * ring, bz = cz + Math.cos(a) * ring;
      let blocked = 0; let out = false; let guard = 0;
      while (guard++ < 300) {
        const r = walkToward(bx, bz, 7, STEP); g.update(STEP);
        if (r === true) { out = true; break; }
        if (r === 'blocked' && ++blocked > 30) break;
        if (g.missions.state === 'failed') return 'failed:' + state.lastFail;
      }
      if (out) break;
    }
    // around the outside to the gate kerb
    for (let t = 1; t >= -0.001; t -= 0.05) {
      const a = gateAngle + Math.PI * t;
      const wx = cx + Math.sin(a) * ring, wz = cz + Math.cos(a) * ring;
      let guard = 0;
      while (walkToward(wx, wz, 7, STEP) === false && guard++ < 200) { g.update(STEP); if (g.missions.state !== 'active') break; }
      if (g.missions.state !== 'active') break;
    }
    let guard = 0;
    while (g.missions.state === 'active' && guard++ < 300) { const r = walkToward(gate.position.x, gate.position.z, 7, STEP); g.update(STEP); if (r === 'blocked' && guard > 60) break; }
    step(10);
    return g.missions.state === 'complete' || !g.missions.active ? 'ok' : g.missions.state === 'failed' ? 'failed:' + state.lastFail : 'stuck:escape';
  }

  // ---- orchestration ----------------------------------------------------------------

  const PREREQ_FLAGS = { 'paper-fire': ['choice:two-fires:solly'], 'long-live-the-king': ['choice:two-fires:solly'], 'catch-them-cutting': ['choice:two-fires:sindi'], 'carcass': ['choice:two-fires:sindi'], 'dark-house': ['act3'], 'the-switch': ['endgame'] };

  function prep(missionId) {
    state.mission = missionId; state.lastFail = null;
    const mission = g.missions.missions.find((entry) => entry.id === missionId);
    if (!mission) return 'no-such-mission';
    // synthesize the prerequisite closure
    const need = [...(mission.prerequisites?.missions ?? [])];
    while (need.length) {
      const id = need.pop(); if (g.missions.completed.has(id)) continue;
      g.missions.completed.add(id);
      const m2 = g.missions.missions.find((entry) => entry.id === id);
      for (const flag of m2?.setFlags ?? []) g.story.raise(flag);
      need.push(...(m2?.prerequisites?.missions ?? []));
    }
    for (const flag of mission.prerequisites?.flags ?? []) g.story.raise(flag);
    for (const flag of PREREQ_FLAGS[missionId] ?? []) g.story.raise(flag);
    // clean slate for the run itself
    g.missions.active = undefined; g.missions.state = 'available';
    g.dialogue.abandon?.(); g.story.abandonOffer?.();
    g.wanted.clear();
    const s = mission.start.position;
    g.teleportPlayer(s.x, s.z, missionId);
    pump(s.x, s.z);
    step(6, 1 / 30);
    return 'ready';
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
    if (g.composer) g.composer.render(); else g.renderer.render(g.scene, g.camera);
    return g.renderer.domElement.toDataURL('image/jpeg', 0.7);
  }

  // capture the last failure reason for reporting
  const origFail = g.missions.fail.bind(g.missions);
  g.missions.fail = (reason) => { state.lastFail = reason; return origFail(reason); };

  return { g, state, prep, accept, audit, resolve, trainTo, flyTo, bailAndLand, breachYard, escapeYard, shot, step, note, finding, objIndex };
})();
