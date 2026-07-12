/** Dev-only headless profiling harness. Loaded exclusively via `?profile=<plan>` on a DEV server (main.ts gates on
 *  import.meta.env.DEV, so production builds tree-shake the whole module). It drives the running Game through the
 *  same window.__game handle the console tooling uses, times each subsystem with performance.now() wrappers, reads
 *  renderer.info once per frame, and prints one `[PROFILE] {json}` line per phase for a headless Chrome run to
 *  scrape from stderr. Nothing here mutates game source behavior — every toggle goes through the game's own knobs
 *  and is restored when the phase ends.
 *
 *  Plans (query params):
 *    ?profile=probe                          — log district anchors, spawn, water sites, then exit
 *    ?profile=matrix&x=..&z=..&label=..      — full toggle matrix (baseline/gtao/post/shadows/water/agents/medium) at a spot
 *    ?profile=traverse&x=..&z=..&x2=..&z2=.. — glide the player between two points, logging per-frame spikes
 *  Common: &frames=N (measure length), &warmup=N, &speed=U (traverse u/s),
 *  &only=a,b,c (matrix: keep just the named phases — baseline always runs first for the A/B). */

interface FrameSample { dt: number; calls: number; tris: number; heap: number; buckets: Record<string, number>; }

const BUCKETS = ['gameUpdate', 'population', 'lifecycle', 'police', 'bullets', 'cityUpdate', 'visibility', 'dayNight', 'shadowFocus', 'renderHUD', 'updateCamera', 'render'] as const;

const query = (): URLSearchParams => new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => { const raw = query().get(key); const value = Number(raw); return raw !== null && Number.isFinite(value) ? value : fallback; };

const emit = (tag: string, payload: unknown): void => console.log(`[${tag}] ${JSON.stringify(payload)}`);

const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

function summarize(samples: FrameSample[]): Record<string, unknown> {
  const dts = samples.map((s) => s.dt).sort((a, b) => a - b);
  const median = quantile(dts, 0.5);
  const bucketStats: Record<string, unknown> = {};
  for (const bucket of BUCKETS) {
    const values = samples.map((s) => s.buckets[bucket] ?? 0).sort((a, b) => a - b);
    const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
    if (mean > 0.005) bucketStats[bucket] = { mean: +mean.toFixed(3), p95: +quantile(values, 0.95).toFixed(3), max: +quantile(values, 1).toFixed(3) };
  }
  // Spikes: frames well past the median, attributed to whichever bucket grew most vs its own median.
  const bucketMedians: Record<string, number> = {};
  for (const bucket of BUCKETS) bucketMedians[bucket] = quantile(samples.map((s) => s.buckets[bucket] ?? 0).sort((a, b) => a - b), 0.5);
  const spikes = samples
    .map((s, index) => ({ index, dt: s.dt, over: s.dt - median, culprit: BUCKETS.map((b) => ({ b, excess: (s.buckets[b] ?? 0) - (bucketMedians[b] ?? 0) })).sort((x, y) => y.excess - x.excess)[0], heap: s.heap }))
    .filter((s) => s.dt > Math.max(median * 2, median + 12))
    .sort((a, b) => b.dt - a.dt).slice(0, 12)
    .map((s) => ({ frame: s.index, dt: +s.dt.toFixed(1), culprit: s.culprit?.b, culpritMs: +(s.culprit?.excess ?? 0).toFixed(2) }));
  const heaps = samples.map((s) => s.heap);
  const gcDrops = heaps.filter((h, i) => i > 0 && (heaps[i - 1] ?? 0) - h > 1e6).length;
  return {
    frames: samples.length,
    dtMs: { mean: +(dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length)).toFixed(2), p50: +median.toFixed(2), p95: +quantile(dts, 0.95).toFixed(2), max: +quantile(dts, 1).toFixed(2) },
    calls: { p50: quantile(samples.map((s) => s.calls).sort((a, b) => a - b), 0.5), max: quantile(samples.map((s) => s.calls).sort((a, b) => a - b), 1) },
    tris: { p50: quantile(samples.map((s) => s.tris).sort((a, b) => a - b), 0.5) },
    cpu: bucketStats, spikes, gcDrops,
    heapMB: { start: +((heaps[0] ?? 0) / 1048576).toFixed(1), end: +((heaps[heaps.length - 1] ?? 0) / 1048576).toFixed(1) },
  };
}

export function installProfiler(): void {
  // Headless Chrome throttles requestAnimationFrame to a crawl; `&fastraf` swaps in a timer pump. The game
  // loop re-registers itself every frame, so the patch takes effect on the very next frame. CPU timings,
  // draw calls and allocation behavior are unaffected — only vsync pacing is lost, which headless lacks anyway.
  if (query().has('fastraf')) window.requestAnimationFrame = ((callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
  const handle = setInterval(() => {
    const game = (window as any).__game;
    if (!game) return;
    clearInterval(handle);
    try { run(game); } catch (error) { emit('PROFILE_ERROR', String(error)); }
  }, 100);
}

function run(game: any): void {
  const acc: Record<string, number> = {}; for (const bucket of BUCKETS) acc[bucket] = 0;
  let renderDepth = 0; // Reflector re-entries and composer-internal renderer.render calls must not double-count

  const patch = (target: any, method: string, bucket: string): void => {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => { const start = performance.now(); const result = original(...args); acc[bucket] = (acc[bucket] ?? 0) + (performance.now() - start); return result; };
  };
  const patchRender = (target: any, method: string): void => {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      if (renderDepth > 0) return original(...args);
      renderDepth += 1; const start = performance.now();
      try { return original(...args); } finally { acc.render = (acc.render ?? 0) + (performance.now() - start); renderDepth -= 1; }
    };
  };

  patch(game, 'update', 'gameUpdate'); // accumulates across sim sub-steps
  patch(game.population, 'update', 'population');
  patch(game.lifecycle, 'update', 'lifecycle');
  patch(game.police, 'update', 'police');
  patch(game.bullets, 'update', 'bullets');
  patch(game.city, 'update', 'cityUpdate');
  patch(game.city, 'updateVisibility', 'visibility');
  patch(game.dayNight, 'update', 'dayNight');
  patch(game.environment, 'updateShadowFocus', 'shadowFocus');
  patch(game, 'renderHUD', 'renderHUD');
  patch(game, 'updateCamera', 'updateCamera');
  patchRender(game.renderer, 'render');
  if (game.composer) patchRender(game.composer, 'render');

  game.loggedDrawCalls = true; // disarm the game's own one-shot renderer.info measurement
  game.renderer.info.autoReset = false;

  game.startGame(true); // fresh deterministic save, straight into 'playing'
  game.dayNight.hour = 12; game.dayNight.timeRate = 0; // freeze lighting so phases are comparable

  const plan = query().get('profile');
  const x = num('x', NaN); const z = num('z', NaN);
  if (Number.isFinite(x) && Number.isFinite(z)) game.teleportPlayer(x, z, 'profile');

  if (plan === 'probe') { probe(game); return; }

  const frames = num('frames', 240); const warmup = num('warmup', 150);
  type Phase = { name: string; warmup: number; frames: number; apply?: () => void; restore?: () => void; move?: (dtMs: number) => void };
  const phases: Phase[] = [];
  const label = query().get('label') ?? plan ?? 'run';

  if (plan === 'matrix') {
    let stashedComposer: any;
    phases.push(
      { name: `${label}:baseline-high`, warmup, frames },
      { name: `${label}:gtao-off`, warmup: 30, frames, apply: () => { if (game.gtao) game.gtao.enabled = false; }, restore: () => { if (game.gtao) game.gtao.enabled = true; } },
      { name: `${label}:post-off`, warmup: 30, frames, apply: () => { stashedComposer = game.composer; game.composer = undefined; }, restore: () => { game.composer = stashedComposer; } },
      { name: `${label}:shadows-off`, warmup: 30, frames, apply: () => { game.renderer.shadowMap.enabled = false; game.environment.sun.castShadow = false; }, restore: () => { game.renderer.shadowMap.enabled = true; game.environment.sun.castShadow = true; } },
      { name: `${label}:water-low`, warmup: 30, frames, apply: () => game.city.setWaterQuality('low'), restore: () => game.city.setWaterQuality('high') },
      { name: `${label}:agents-off`, warmup: 60, frames, apply: () => { game.lifecycle.tuning.peds = 0; game.lifecycle.tuning.cars = 0; despawnAgents(game); }, restore: () => { game.lifecycle.tuning.peds = undefined; game.lifecycle.tuning.cars = undefined; } },
      { name: `${label}:medium`, warmup: 60, frames, apply: () => { game.settings.quality = 'medium'; game.applyQuality(); }, restore: () => { game.settings.quality = 'high'; game.applyQuality(); } },
    );
    const only = query().get('only');
    if (only) {
      const wanted = new Set(only.split(',').map((name) => name.trim()));
      const kept = phases.filter((phase, index) => index === 0 || wanted.has(phase.name.slice(label.length + 1)));
      phases.length = 0; phases.push(...kept);
    }
  } else if (plan === 'traverse') {
    const x2 = num('x2', x); const z2 = num('z2', z); const speed = num('speed', 30);
    const dir = Math.hypot(x2 - x, z2 - z) || 1;
    const step = (dtMs: number): void => {
      const position = game.player.group.position;
      position.x += ((x2 - x) / dir) * speed * (dtMs / 1000); position.z += ((z2 - z) / dir) * speed * (dtMs / 1000);
    };
    phases.push({ name: `${label}:traverse`, warmup, frames: num('frames', 1200), move: step });
  } else { emit('PROFILE_ERROR', `unknown plan ${plan}`); return; }

  let phaseIndex = -1; let framesLeft = 0; let warmupLeft = 0; let samples: FrameSample[] = []; let last = performance.now(); let ticks = 0;
  const advance = (): boolean => {
    phaseIndex += 1;
    const phase = phases[phaseIndex];
    if (!phase) { emit('PROFILE_DONE', { plan: label }); return false; }
    phase.apply?.(); warmupLeft = phase.warmup; framesLeft = phase.frames; samples = [];
    return true;
  };
  if (!advance()) return;

  const tick = (): void => {
    const phase = phases[phaseIndex]; if (!phase) return;
    const now = performance.now(); const dt = now - last; last = now;
    ticks += 1; if (ticks % 100 === 0) emit('PROFILE_TICK', { ticks, phase: phase.name, dtMs: +dt.toFixed(1) });
    const info = game.renderer.info.render;
    const sample: FrameSample = { dt, calls: info.calls, tris: info.triangles, heap: (performance as any).memory?.usedJSHeapSize ?? 0, buckets: { ...acc } };
    game.renderer.info.reset(); for (const bucket of BUCKETS) acc[bucket] = 0;
    phase.move?.(dt);
    if (warmupLeft > 0) warmupLeft -= 1;
    else if (framesLeft > 0) { samples.push(sample); framesLeft -= 1; }
    else {
      emit('PROFILE', { phase: phase.name, ...summarize(samples), live: liveCounts(game) });
      phase.restore?.();
      if (!advance()) return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Instant despawn for the agents-off phase: the census only trims out-of-sight agents on a 3s beat, far too slow
 *  and view-dependent for an A/B measurement, so the phase clears the ambient pools directly. */
function despawnAgents(game: any): void {
  for (const ped of [...game.population.pedestrians]) { game.scene.remove(ped.group); }
  game.population.pedestrians.length = 0;
  for (const vehicle of [...game.population.traffic]) {
    game.scene.remove(vehicle.group);
    const index = game.population.vehicles.indexOf(vehicle); if (index >= 0) game.population.vehicles.splice(index, 1);
  }
  game.population.traffic.length = 0;
}

function liveCounts(game: any): Record<string, number> {
  return { peds: game.population.pedestrians.length, cars: game.population.traffic.length, parked: game.population.vehicles.length - game.population.traffic.length, police: game.police.vehicles.length };
}

/** One-shot reconnaissance: where can the matrix runs teleport to? */
function probe(game: any): void {
  const districts = (game.districtTargets ?? []).map((t: any) => ({ name: t.name, x: Math.round(t.x), z: Math.round(t.z) }));
  const water: { x: number; z: number; kind: string }[] = [];
  game.scene.traverse((object: any) => { if (typeof object.getRenderTarget === 'function' && object.isMesh) water.push({ x: Math.round(object.position.x), z: Math.round(object.position.z), kind: 'reflector' }); });
  emit('PROFILE_PROBE', { spawn: game.save.spawn, districts, water });
  emit('PROFILE_DONE', { plan: 'probe' });
}
