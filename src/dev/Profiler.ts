/**
 * Dev-only Gauntlet profiler. `main.ts` loads this module only for `?profile=...` on a Vite dev
 * server; the browser driver records that limitation in every evidence sidecar. Fixed-scene runs
 * use the browser's native requestAnimationFrame cadence. `&fastraf` is an explicitly ineligible
 * timer-throughput diagnostic and must never be compared with the frame-time gates.
 *
 * Reproducible fixed run (all state-shaping inputs are mandatory):
 *   ?profile=fixed&x=-430&z=820&seed=424242&world=2000&detail=500&buildings=1100
 *     &peds=28&cars=15&quality=high&hour=13&warmup=180&frames=240
 *
 * Other plans:
 *   ?profile=matrix&... — renderer toggles bracketed by an untoggled phase in the same fixed world
 *   ?profile=traverse&x=..&z=..&x2=..&z2=..&... — moving diagnostic, not fixed-scene evidence
 *   ?profile=probe — one-shot district/water reconnaissance
 */
import { BUILDING_VISIBLE_RANGE, CHUNK_VISIBLE_RANGE, DETAIL_VISIBLE_RANGE } from '../world/ChunkVisibility';

export interface FrameSample {
  frame: number;
  rafTimestamp: number;
  dt: number;
  calls: number;
  tris: number;
  heap: number;
  buckets: Record<string, number>;
}

const BUCKETS = [
  'gameUpdate', 'population', 'lifecycle', 'police', 'bullets', 'cityUpdate', 'visibility',
  'dayNight', 'shadowFocus', 'renderHUD', 'updateCamera', 'render',
] as const;
type Bucket = typeof BUCKETS[number];

interface TimingFrame { started: number; childMs: number; }
interface Readiness {
  ready: boolean;
  requiredAssetsReady: boolean;
  characterReady: boolean;
  mode: string;
  buildings: { complete: boolean; pending: boolean; queue: number; queuedCells: number; cells: number };
  population: { queuesEmpty: boolean; pendingPeds: number; pendingCars: number; expectedPeds: number; expectedCars: number; actualPeds: number; actualCars: number };
}

const query = (): URLSearchParams => new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const raw = query().get(key); const value = Number(raw);
  return raw !== null && Number.isFinite(value) ? value : fallback;
};
const hasFinite = (key: string): boolean => query().has(key) && Number.isFinite(Number(query().get(key)));
const emit = (tag: string, payload: unknown): void => console.log(`[${tag}] ${JSON.stringify(payload)}`);

/** Nearest-rank quantile, including the minimum at q=0 and maximum at q=1. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const rank = q <= 0 ? 0 : Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[rank] ?? 0;
}

export function summarizeFrameSamples(samples: FrameSample[]): Record<string, unknown> {
  const dts = samples.map((sample) => sample.dt).sort((a, b) => a - b);
  const median = quantile(dts, 0.5);
  const bucketStats: Record<string, unknown> = {};
  for (const bucket of BUCKETS) {
    const values = samples.map((sample) => sample.buckets[bucket] ?? 0).sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
    if (mean > 0.005) bucketStats[bucket] = {
      exclusive: true,
      mean: +mean.toFixed(3),
      p95: +quantile(values, 0.95).toFixed(3),
      max: +quantile(values, 1).toFixed(3),
    };
  }
  const bucketMedians: Record<string, number> = {};
  for (const bucket of BUCKETS) bucketMedians[bucket] = quantile(samples.map((sample) => sample.buckets[bucket] ?? 0).sort((a, b) => a - b), 0.5);
  const spikes = samples
    .map((sample) => ({
      frame: sample.frame,
      dt: sample.dt,
      culprit: BUCKETS.map((bucket) => ({ bucket, excess: (sample.buckets[bucket] ?? 0) - (bucketMedians[bucket] ?? 0) })).sort((a, b) => b.excess - a.excess)[0],
    }))
    .filter((sample) => sample.dt > Math.max(median * 2, median + 12))
    .sort((a, b) => b.dt - a.dt)
    .slice(0, 12)
    .map((sample) => ({ frame: sample.frame, dt: +sample.dt.toFixed(1), culprit: sample.culprit?.bucket, culpritMs: +(sample.culprit?.excess ?? 0).toFixed(2) }));
  const heaps = samples.map((sample) => sample.heap);
  const gcDrops = heaps.filter((heap, index) => index > 0 && (heaps[index - 1] ?? 0) - heap > 1e6).length;
  const calls = samples.map((sample) => sample.calls).sort((a, b) => a - b);
  const tris = samples.map((sample) => sample.tris).sort((a, b) => a - b);
  return {
    frames: samples.length,
    dtMs: {
      mean: +(dts.reduce((sum, value) => sum + value, 0) / Math.max(1, dts.length)).toFixed(2),
      p50: +median.toFixed(2),
      p95: +quantile(dts, 0.95).toFixed(2),
      p99: +quantile(dts, 0.99).toFixed(2),
      max: +quantile(dts, 1).toFixed(2),
      over50: dts.filter((value) => value > 50).length,
    },
    calls: { p50: quantile(calls, 0.5), max: quantile(calls, 1) },
    tris: { p50: quantile(tris, 0.5) },
    cpu: { semantics: 'exclusive wall-clock time inside the instrumented synchronous method', buckets: bucketStats },
    spikes,
    gcDrops,
    heapMB: { start: +((heaps[0] ?? 0) / 1048576).toFixed(1), end: +((heaps[heaps.length - 1] ?? 0) / 1048576).toFixed(1) },
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function installProfiler(): void {
  const seed = num('seed', NaN);
  // Install before Game's async boot reaches population construction. Static world generation is
  // already seed-based; this closes the remaining Math.random seams in opening actors and routing.
  if (Number.isInteger(seed)) Math.random = seededRandom(seed);

  const throughput = query().has('fastraf');
  if (throughput) {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0)) as typeof window.requestAnimationFrame;
  }
  emit('PROFILE_MODE', {
    pacing: throughput ? 'timer-throughput' : 'native-rAF',
    frameTimeGateEligible: !throughput,
    warning: throughput ? 'Timer throughput is not display frame time and cannot satisfy performance gates.' : undefined,
  });

  const handle = window.setInterval(() => {
    const game = (window as any).__game;
    if (!game?.requiredAssetsReady || game.player?.characterStatus !== 'ready') return;
    window.clearInterval(handle);
    try { run(game, throughput); } catch (error) { emit('PROFILE_ERROR', error instanceof Error ? error.message : String(error)); }
  }, 100);
}

function requiredFixedInputs(plan: string | null): void {
  if (plan === 'probe') return;
  const required = plan === 'traverse'
    ? ['x', 'z', 'x2', 'z2', 'seed', 'world', 'detail', 'buildings', 'peds', 'cars', 'hour']
    : ['x', 'z', 'seed', 'world', 'detail', 'buildings', 'peds', 'cars', 'hour'];
  const missing = required.filter((key) => !hasFinite(key));
  if (missing.length) throw new Error(`profile ${plan ?? '(missing)'} requires explicit finite ${missing.join(', ')}`);
  if (!query().has('quality')) throw new Error(`profile ${plan} requires an explicit quality tier`);
  if (!Number.isInteger(num('seed', NaN))) throw new Error('profile seed must be an integer');
}

function run(game: any, throughput: boolean): void {
  const plan = query().get('profile');
  requiredFixedInputs(plan);

  const acc: Record<Bucket, number> = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>;
  const timingStack: TimingFrame[] = [];
  let renderDepth = 0;
  const measured = <T>(bucket: Bucket, operation: () => T): T => {
    const frame: TimingFrame = { started: performance.now(), childMs: 0 };
    timingStack.push(frame);
    try { return operation(); } finally {
      const elapsed = performance.now() - frame.started;
      timingStack.pop();
      acc[bucket] += Math.max(0, elapsed - frame.childMs);
      const parent = timingStack[timingStack.length - 1];
      if (parent) parent.childMs += elapsed;
    }
  };
  const patch = (target: any, method: string, bucket: Bucket): void => {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => measured(bucket, () => original(...args));
  };
  const patchRender = (target: any, method: string): void => {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => {
      if (renderDepth > 0) return original(...args);
      renderDepth += 1;
      try { return measured('render', () => original(...args)); } finally { renderDepth -= 1; }
    };
  };

  patch(game, 'update', 'gameUpdate');
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
  if (game.postProcessing?.composer) patchRender(game.postProcessing.composer, 'render');

  game.loggedDrawCalls = true;
  game.renderer.info.autoReset = false;
  game.startGame(true);

  if (plan === 'probe') { probe(game); return; }

  const x = num('x', NaN); const z = num('z', NaN);
  const seed = num('seed', NaN);
  const worldRange = num('world', CHUNK_VISIBLE_RANGE);
  const detailRange = num('detail', DETAIL_VISIBLE_RANGE);
  const buildingRange = num('buildings', BUILDING_VISIBLE_RANGE);
  const expectedPeds = Math.max(0, Math.round(num('peds', NaN)));
  const expectedCars = Math.max(0, Math.round(num('cars', NaN)));
  const quality = query().get('quality');
  if (!['potato', 'low', 'medium', 'high', 'ultra'].includes(quality ?? '')) throw new Error(`invalid profile quality ${quality}`);
  game.settings.quality = quality;
  game.applyQuality();
  // applyQuality rebuilds the composer, so instrument the live replacement rather than only the
  // instance that existed when run() first attached its wrappers.
  if (game.postProcessing?.composer) patchRender(game.postProcessing.composer, 'render');
  // applyQuality owns player-facing tier defaults; the evidence contract owns these exact rings.
  game.city.setStreamRanges(worldRange, detailRange, buildingRange);
  game.dayNight.hour = num('hour', 13);
  game.dayNight.timeRate = 0;
  game.lifecycle.tuning.peds = expectedPeds;
  game.lifecycle.tuning.cars = expectedCars;
  game.teleportPlayer(x, z, 'gauntlet-profile');
  resetAmbientPopulation(game, x, z, seed, expectedPeds, expectedCars);
  const settlement = settleBuildings(game, x, z);
  if (!settlement.complete) throw new Error(`building settlement incomplete: ${JSON.stringify(settlement)}`);
  const initialReadiness = readiness(game, expectedPeds, expectedCars);
  if (!initialReadiness.ready) throw new Error(`fixed scene was not ready: ${JSON.stringify(initialReadiness)}`);

  const frames = Math.max(1, Math.round(num('frames', 240)));
  const warmup = Math.max(1, Math.round(num('warmup', 180)));
  const label = query().get('label') ?? plan ?? 'run';
  type Phase = {
    name: string;
    role: 'fixed' | 'baseline-before' | 'variant' | 'baseline-after' | 'traverse';
    comparison?: string;
    warmup: number;
    frames: number;
    apply?: () => void;
    restore?: () => void;
    move?: (dtMs: number) => void;
  };
  const phases: Phase[] = [];

  if (plan === 'fixed') {
    phases.push({ name: `${label}:fixed`, role: 'fixed', warmup, frames });
  } else if (plan === 'matrix') {
    let stashedPostProcessing: any;
    const variants: Array<Pick<Phase, 'comparison' | 'apply' | 'restore'> & { comparison: string }> = [
      { comparison: 'gtao-off', apply: () => { if (game.postProcessing?.gtao) game.postProcessing.gtao.enabled = false; }, restore: () => { if (game.postProcessing?.gtao) game.postProcessing.gtao.enabled = true; } },
      { comparison: 'post-off', apply: () => { stashedPostProcessing = game.postProcessing; game.postProcessing = undefined; }, restore: () => { game.postProcessing = stashedPostProcessing; } },
      { comparison: 'shadows-off', apply: () => { game.renderer.shadowMap.enabled = false; game.environment.sun.castShadow = false; }, restore: () => { game.renderer.shadowMap.enabled = true; game.environment.sun.castShadow = true; } },
      { comparison: 'water-low', apply: () => game.city.setWaterQuality('low'), restore: () => game.city.setWaterQuality(quality === 'ultra' ? 'high' : quality) },
    ];
    const only = query().get('only');
    const wanted = only ? new Set(only.split(',').map((name) => name.trim()).filter(Boolean)) : undefined;
    for (const variant of variants.filter((candidate) => !wanted || wanted.has(candidate.comparison))) {
      phases.push(
        { name: `${label}:${variant.comparison}:before`, role: 'baseline-before', comparison: variant.comparison, warmup, frames },
        { name: `${label}:${variant.comparison}`, role: 'variant', comparison: variant.comparison, warmup: Math.max(60, Math.round(warmup / 2)), frames, apply: variant.apply, restore: variant.restore },
        { name: `${label}:${variant.comparison}:after`, role: 'baseline-after', comparison: variant.comparison, warmup: Math.max(60, Math.round(warmup / 2)), frames },
      );
    }
    if (!phases.length) throw new Error(`matrix only=${only} selected no known variants`);
  } else if (plan === 'traverse') {
    const x2 = num('x2', NaN); const z2 = num('z2', NaN); const speed = num('speed', 30);
    const distance = Math.hypot(x2 - x, z2 - z) || 1;
    phases.push({
      name: `${label}:traverse`, role: 'traverse', warmup, frames: Math.max(1, Math.round(num('frames', 1200))),
      move: (dtMs) => {
        const position = game.player.group.position;
        position.x += ((x2 - x) / distance) * speed * (dtMs / 1000);
        position.z += ((z2 - z) / distance) * speed * (dtMs / 1000);
      },
    });
  } else {
    throw new Error(`unknown profile plan ${plan}`);
  }

  const setup = {
    plan,
    label,
    pacing: throughput ? 'timer-throughput' : 'native-rAF',
    frameTimeGateEligible: !throughput,
    comparisonDesign: plan === 'matrix' ? 'same-world baseline brackets around every variant' : 'single fixed world',
    coordinates: { x, z },
    seed,
    streamRanges: { world: worldRange, detail: detailRange, buildings: buildingRange },
    populationTargets: { peds: expectedPeds, cars: expectedCars },
    hour: game.dayNight.hour,
    quality,
    warmup,
    frames,
    settlement,
    readiness: initialReadiness,
    sceneCensus: sceneCensus(game),
  };
  emit('PROFILE_SETUP', setup);

  let phaseIndex = -1;
  let framesLeft = 0;
  let warmupLeft = 0;
  let samples: FrameSample[] = [];
  let lastTimestamp: number | undefined;
  let sampledFrame = 0;
  let phaseStartCensus: Record<string, number> | undefined;
  let phaseStartReadiness: Readiness | undefined;

  const advance = (): boolean => {
    phaseIndex += 1;
    const phase = phases[phaseIndex];
    if (!phase) {
      emit('PROFILE_DONE', { plan: label, pacing: setup.pacing, frameTimeGateEligible: !throughput });
      return false;
    }
    phase.apply?.();
    warmupLeft = phase.warmup;
    framesLeft = phase.frames;
    samples = [];
    sampledFrame = 0;
    phaseStartCensus = undefined;
    phaseStartReadiness = undefined;
    return true;
  };
  if (!advance()) return;

  const tick = (rafTimestamp: number): void => {
    try {
      const phase = phases[phaseIndex]; if (!phase) return;
      const dt = lastTimestamp === undefined ? 0 : rafTimestamp - lastTimestamp;
      lastTimestamp = rafTimestamp;
      const info = game.renderer.info.render;
      const sample: FrameSample = {
        frame: sampledFrame,
        rafTimestamp,
        dt,
        calls: info.calls,
        tris: info.triangles,
        heap: (performance as any).memory?.usedJSHeapSize ?? 0,
        buckets: { ...acc },
      };
      game.renderer.info.reset();
      for (const bucket of BUCKETS) acc[bucket] = 0;
      phase.move?.(dt);
      if (warmupLeft > 0) {
        warmupLeft -= 1;
      } else if (framesLeft > 0) {
        if (!phaseStartCensus) {
          phaseStartCensus = sceneCensus(game);
          phaseStartReadiness = readiness(game, expectedPeds, expectedCars);
          if (phase.role !== 'traverse' && !phaseStartReadiness.ready) throw new Error(`${phase.name} began unready: ${JSON.stringify(phaseStartReadiness)}`);
        }
        // The first measured callback always has a prior warm-up callback, so dt is native cadence,
        // never "time since profiler setup".
        sample.frame = sampledFrame++;
        samples.push(sample);
        framesLeft -= 1;
      } else {
        const endCensus = sceneCensus(game);
        const endReadiness = readiness(game, expectedPeds, expectedCars);
        const sceneStable = JSON.stringify(phaseStartCensus) === JSON.stringify(endCensus);
        if (phase.role !== 'traverse' && (!endReadiness.ready || !sceneStable)) {
          throw new Error(`${phase.name} changed fixed-scene truth: ${JSON.stringify({ sceneStable, start: phaseStartCensus, end: endCensus, readiness: endReadiness })}`);
        }
        emit('PROFILE', {
          phase: phase.name,
          role: phase.role,
          comparison: phase.comparison,
          pacing: setup.pacing,
          frameTimeGateEligible: !throughput,
          ...summarizeFrameSamples(samples),
          rawSamples: samples,
          sceneCensus: { start: phaseStartCensus, end: endCensus, stable: sceneStable },
          readiness: { start: phaseStartReadiness, end: endReadiness },
          live: liveCounts(game),
        });
        phase.restore?.();
        if (!advance()) return;
      }
      requestAnimationFrame(tick);
    } catch (error) {
      emit('PROFILE_ERROR', error instanceof Error ? error.message : String(error));
    }
  };
  requestAnimationFrame(tick);
}

function isAmbientPedestrian(ped: any): boolean {
  return !ped.scripted && !ped.contact && !ped.police && !ped.hostile && !ped.carGuard && ped.state !== 'down';
}

function pointScore(point: { x: number; z: number }, seed: number): number {
  let value = (Math.round(point.x * 10) ^ Math.imul(Math.round(point.z * 10), 0x45d9f3b) ^ seed) | 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function fixedPoints(points: ReadonlyArray<{ x: number; z: number }>, x: number, z: number, seed: number, count: number): Array<{ x: number; z: number }> {
  const ranked = points
    .filter((point) => {
      const distance = Math.hypot(point.x - x, point.z - z);
      return distance >= 70 && distance <= 420;
    })
    .sort((a, b) => pointScore(a, seed) - pointScore(b, seed) || a.x - b.x || a.z - b.z);
  if (ranked.length < count) throw new Error(`fixed population requested ${count} points but only ${ranked.length} are available near (${x}, ${z})`);
  return ranked.slice(0, count);
}

/** Replace opening ambient actors with exact, seeded fixed-location census targets. Role-specific cast
 * remains untouched. This makes separate browser processes start with the same actor counts and spots. */
function resetAmbientPopulation(game: any, x: number, z: number, seed: number, peds: number, cars: number): void {
  for (const ped of [...game.population.pedestrians]) if (isAmbientPedestrian(ped)) game.population.removePedestrian(ped);
  for (const vehicle of [...game.population.traffic]) game.population.removeVehicle(vehicle);
  game.lifecycle.pendingPedSpawns.length = 0;
  game.lifecycle.pendingCarSpawns.length = 0;
  game.lifecycle.currentZone = undefined;
  game.lifecycle.timer = 3;
  const pedPoints = fixedPoints(game.city.sidewalkPoints, x, z, seed ^ 0x51a7, peds);
  const carPoints = fixedPoints(game.city.vehicleNav.nodes, x, z, seed ^ 0xca45, cars);
  for (const point of pedPoints) game.population.spawnAmbientPedestrian(point.x, point.z);
  for (const point of carPoints) game.population.spawnTrafficVehicle(point.x, point.z);
  game.population.primeVisualLods(game.player.group.position);
}

/** Complete the fixed-location building ring synchronously and return a hard readiness receipt. */
function settleBuildings(game: any, x: number, z: number): Record<string, unknown> & { complete: boolean } {
  const started = performance.now();
  const maxMs = Math.max(1000, num('settleMs', 20000));
  let passes = 0;
  do {
    game.city.updateBuildingChunks(x, z, 24);
    passes += 1;
  } while ((game.city.pending || game.city.buildQueue.length > 0 || game.city.queuedCells.size > 0) && performance.now() - started < maxMs);
  const complete = !game.city.pending && game.city.buildQueue.length === 0 && game.city.queuedCells.size === 0;
  const receipt = {
    complete,
    passes,
    ms: +(performance.now() - started).toFixed(1),
    cells: game.city.buildingCells.size,
    pending: Boolean(game.city.pending),
    queue: game.city.buildQueue.length,
    queuedCells: game.city.queuedCells.size,
    range: num('buildings', BUILDING_VISIBLE_RANGE),
  };
  emit('PROFILE_SETTLE', receipt);
  return receipt;
}

function readiness(game: any, expectedPeds: number, expectedCars: number): Readiness {
  const actualPeds = game.population.pedestrians.filter(isAmbientPedestrian).length;
  const actualCars = game.population.traffic.filter((vehicle: any) => !vehicle.disabled && !vehicle.wrecked).length;
  const pendingPeds = game.lifecycle.pendingPedSpawns.length;
  const pendingCars = game.lifecycle.pendingCarSpawns.length;
  const buildings = {
    complete: !game.city.pending && game.city.buildQueue.length === 0 && game.city.queuedCells.size === 0,
    pending: Boolean(game.city.pending),
    queue: game.city.buildQueue.length,
    queuedCells: game.city.queuedCells.size,
    cells: game.city.buildingCells.size,
  };
  const population = {
    queuesEmpty: pendingPeds === 0 && pendingCars === 0,
    pendingPeds,
    pendingCars,
    expectedPeds,
    expectedCars,
    actualPeds,
    actualCars,
  };
  const requiredAssetsReady = Boolean(game.requiredAssetsReady);
  const characterReady = game.player?.characterStatus === 'ready';
  return {
    ready: requiredAssetsReady && characterReady && game.mode === 'playing' && buildings.complete && population.queuesEmpty && actualPeds === expectedPeds && actualCars === expectedCars,
    requiredAssetsReady,
    characterReady,
    mode: String(game.mode),
    buildings,
    population,
  };
}

function sceneCensus(game: any): Record<string, number> {
  const census: Record<string, number> = {
    objects: 0,
    visibleObjects: 0,
    groups: 0,
    meshes: 0,
    visibleMeshes: 0,
    instancedMeshes: 0,
    skinnedMeshes: 0,
    lights: 0,
    lines: 0,
    points: 0,
    buildingCells: game.city.buildingCells.size,
    ambientPeds: game.population.pedestrians.filter(isAmbientPedestrian).length,
    allPeds: game.population.pedestrians.length,
    traffic: game.population.traffic.length,
    allVehicles: game.population.vehicles.length,
    policeVehicles: game.police.vehicles.length,
  };
  game.scene.traverse((object: any) => {
    census.objects += 1;
    if (object.visible) census.visibleObjects += 1;
    if (object.isGroup) census.groups += 1;
    if (object.isMesh) {
      census.meshes += 1;
      if (object.visible) census.visibleMeshes += 1;
    }
    if (object.isInstancedMesh) census.instancedMeshes += 1;
    if (object.isSkinnedMesh) census.skinnedMeshes += 1;
    if (object.isLight) census.lights += 1;
    if (object.isLine) census.lines += 1;
    if (object.isPoints) census.points += 1;
  });
  return census;
}

function liveCounts(game: any): Record<string, number> {
  const peds = game.population.pedestrians;
  return {
    peds: peds.length,
    ambientPeds: peds.filter(isAmbientPedestrian).length,
    renderedPeds: peds.filter((ped: any) => ped.isRenderVisible).length,
    detailedPeds: peds.filter((ped: any) => ped.visualLod === 'detail').length,
    proxyPeds: peds.filter((ped: any) => ped.visualLod === 'proxy').length,
    frozenPeds: peds.filter((ped: any) => ped.frozen).length,
    cars: game.population.traffic.length,
    parked: game.population.vehicles.length - game.population.traffic.length,
    police: game.police.vehicles.length,
  };
}

function probe(game: any): void {
  const districts = (game.districtTargets ?? []).map((target: any) => ({ name: target.name, x: Math.round(target.x), z: Math.round(target.z) }));
  const water: { x: number; z: number; kind: string }[] = [];
  game.scene.traverse((object: any) => {
    if (typeof object.getRenderTarget === 'function' && object.isMesh) water.push({ x: Math.round(object.position.x), z: Math.round(object.position.z), kind: 'reflector' });
  });
  emit('PROFILE_PROBE', { spawn: game.save.spawn, districts, water });
  emit('PROFILE_DONE', { plan: 'probe' });
}
