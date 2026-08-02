#!/usr/bin/env node
/**
 * Dependency-free Chrome DevTools driver for reproducible Gauntlet evidence.
 *
 * The game still runs from an externally started Vite server. This process owns a fresh Chrome
 * profile, fixed viewport, deterministic world setup, native-rAF input route, screenshot/profile
 * artifact, and an atomic evidence sidecar. See gauntlet/EVIDENCE.md for the contract and commands.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EVIDENCE_SCHEMA = 'gtb.gauntlet.evidence/v2';
const SETUP_PROTOCOL = 'fixed-scene-v2';
const DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  timeout: 300,
  hour: 13,
  quality: 'high',
  scenario: 'on-foot',
  seed: 424242,
  world: 2000,
  detail: 500,
  buildings: 1100,
  peds: 28,
  cars: 15,
  warmup: 180,
  frames: 240,
  heading: 0,
  'settle-ms': 20000,
});
const BOOLEAN_OPTIONS = new Set(['throughput']);
const NUMERIC_OPTIONS = new Set([
  'width', 'height', 'timeout', 'hour', 'seed', 'world', 'detail', 'buildings', 'peds', 'cars',
  'warmup', 'frames', 'heading', 'x', 'z', 'x2', 'z2', 'speed', 'settle-ms',
]);

function usage(message) {
  if (message) console.error(message);
  console.error(`Usage:
  gauntlet-browser.mjs capture --url URL --out FRAME.png --x X --z Z [--scenario on-foot|driving|wanted]
  gauntlet-browser.mjs profile --url URL --out RUN.json --x X --z Z [--plan fixed|matrix|traverse] [--throughput]
  gauntlet-browser.mjs verify --runs RUN1.json,RUN2.json,RUN3.json

Fixed defaults: 1920x1080 DPR 1, high, hour 13, seed 424242, ranges 2000/500/1100,
28 pedestrians, 15 traffic vehicles, 180 warm-up frames and 240 measured frames.`);
  process.exitCode = 2;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { command, ...DEFAULTS };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  for (const key of NUMERIC_OPTIONS) {
    if (options[key] === undefined) continue;
    options[key] = Number(options[key]);
    if (!Number.isFinite(options[key])) throw new Error(`--${key} must be a finite number`);
  }
  if (!['potato', 'low', 'medium', 'high', 'ultra'].includes(options.quality)) throw new Error('--quality must be potato, low, medium, high, or ultra');
  if (!['on-foot', 'driving', 'wanted'].includes(options.scenario)) throw new Error('--scenario must be on-foot, driving, or wanted');
  if (options.plan && !['fixed', 'matrix', 'traverse', 'probe'].includes(options.plan)) throw new Error('--plan must be fixed, matrix, traverse, or probe');
  for (const key of ['width', 'height', 'timeout', 'warmup', 'frames', 'settle-ms']) {
    if (!(options[key] > 0)) throw new Error(`--${key} must be greater than zero`);
  }
  for (const key of ['peds', 'cars', 'world', 'detail', 'buildings']) {
    if (options[key] < 0) throw new Error(`--${key} cannot be negative`);
  }
  if (!Number.isInteger(options.seed)) throw new Error('--seed must be an integer');
  return options;
}

function validateOptions(options) {
  if (!['capture', 'profile', 'verify'].includes(options.command)) throw new Error(`Unknown command: ${options.command ?? '(missing)'}`);
  if (options.command === 'verify') {
    if (!options.runs) throw new Error('verify requires --runs RUN1,RUN2,RUN3');
    return;
  }
  if (!options.url || !options.out) throw new Error(`${options.command} requires --url and --out`);
  if (!Number.isFinite(options.x) || !Number.isFinite(options.z)) throw new Error(`${options.command} requires explicit --x and --z coordinates`);
  if (options.command === 'profile' && options.plan === 'traverse' && (!Number.isFinite(options.x2) || !Number.isFinite(options.z2))) {
    throw new Error('traverse profiles require explicit --x2 and --z2 coordinates');
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const canonicalJson = (value) => JSON.stringify(canonical(value));

async function atomicWrite(file, data) {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data);
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function sidecarPath(artifact) {
  const absolute = path.resolve(artifact);
  return absolute.endsWith('.json') ? `${absolute}.meta.json` : `${absolute}.json`;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('Could not reserve a Chrome debugging port');
  return port;
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Chrome debugging endpoint did not open: ${lastError ?? 'timeout'}`);
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Chrome DevTools websocket failed to open')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { method, resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return result;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text;
    throw new Error(`Browser evaluation failed: ${detail}`);
  }
  return response.result?.value;
}

async function waitForGame(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    last = await evaluate(cdp, `(() => ({
      game: Boolean(window.__game),
      ready: Boolean(window.__game?.requiredAssetsReady),
      mode: window.__game?.mode,
      character: window.__game?.player?.characterStatus,
      bootError: document.querySelector('#boot-error')?.textContent?.replace(/\\s+/g, ' ').trim(),
      timeline: window.__bootTimeline,
    }))()`);
    if (last.bootError) throw new Error(`Game boot failed: ${last.bootError}`);
    if (last.game && last.ready && last.mode === 'menu' && last.character === 'ready') return last;
    await delay(250);
  }
  throw new Error(`Game was not ready after ${Math.round(timeoutMs / 1000)}s: ${JSON.stringify(last)}`);
}

async function waitFrames(cdp, count) {
  return evaluate(cdp, `(async () => {
    const count = ${JSON.stringify(Math.max(0, Math.round(count)))};
    const stamps = [];
    for (let index = 0; index < count; index += 1) {
      stamps.push(await new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    return { count, first: stamps[0] ?? null, last: stamps[stamps.length - 1] ?? null };
  })()`);
}

function pointHelpersSource() {
  return `
    const isAmbient = (ped) => !ped.scripted && !ped.contact && !ped.police && !ped.hostile && !ped.carGuard && ped.state !== 'down';
    const pointScore = (point, salt) => {
      let value = (Math.round(point.x * 10) ^ Math.imul(Math.round(point.z * 10), 0x45d9f3b) ^ salt) | 0;
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      return (value ^ (value >>> 16)) >>> 0;
    };
    const fixedPoints = (points, px, pz, salt, count) => {
      const ranked = points.filter((point) => {
        const distance = Math.hypot(point.x - px, point.z - pz);
        return distance >= 70 && distance <= 420;
      }).sort((a, b) => pointScore(a, salt) - pointScore(b, salt) || a.x - b.x || a.z - b.z);
      if (ranked.length < count) throw new Error('fixed population has ' + ranked.length + ' candidate points for requested ' + count);
      return ranked.slice(0, count);
    };
    const census = () => {
      const result = {
        objects: 0, visibleObjects: 0, groups: 0, meshes: 0, visibleMeshes: 0,
        instancedMeshes: 0, skinnedMeshes: 0, lights: 0, lines: 0, points: 0,
        buildingCells: g.city.buildingCells.size,
        ambientPeds: g.population.pedestrians.filter(isAmbient).length,
        allPeds: g.population.pedestrians.length,
        traffic: g.population.traffic.length,
        allVehicles: g.population.vehicles.length,
        policeVehicles: g.police.vehicles.length,
      };
      g.scene.traverse((object) => {
        result.objects += 1; if (object.visible) result.visibleObjects += 1;
        if (object.isGroup) result.groups += 1;
        if (object.isMesh) { result.meshes += 1; if (object.visible) result.visibleMeshes += 1; }
        if (object.isInstancedMesh) result.instancedMeshes += 1;
        if (object.isSkinnedMesh) result.skinnedMeshes += 1;
        if (object.isLight) result.lights += 1;
        if (object.isLine) result.lines += 1;
        if (object.isPoints) result.points += 1;
      });
      return result;
    };
    const readiness = (allowedModes = ['playing']) => {
      const actualPeds = g.population.pedestrians.filter(isAmbient).length;
      const actualCars = g.population.traffic.filter((vehicle) => !vehicle.disabled && !vehicle.wrecked).length;
      const pendingPeds = g.lifecycle.pendingPedSpawns.length;
      const pendingCars = g.lifecycle.pendingCarSpawns.length;
      const buildings = {
        complete: !g.city.pending && g.city.buildQueue.length === 0 && g.city.queuedCells.size === 0,
        pending: Boolean(g.city.pending), queue: g.city.buildQueue.length,
        queuedCells: g.city.queuedCells.size, cells: g.city.buildingCells.size,
      };
      const population = {
        queuesEmpty: pendingPeds === 0 && pendingCars === 0,
        pendingPeds, pendingCars,
        expectedPeds: ${JSON.stringify(DEFAULTS.peds)}, expectedCars: ${JSON.stringify(DEFAULTS.cars)},
        actualPeds, actualCars,
      };
      population.expectedPeds = window.__gauntletExpectedPeds;
      population.expectedCars = window.__gauntletExpectedCars;
      const requiredAssetsReady = Boolean(g.requiredAssetsReady);
      const characterReady = g.player?.characterStatus === 'ready';
      return {
        ready: requiredAssetsReady && characterReady && allowedModes.includes(g.mode) && buildings.complete
          && population.queuesEmpty && actualPeds === population.expectedPeds && actualCars === population.expectedCars,
        requiredAssetsReady, characterReady, mode: String(g.mode), buildings, population,
      };
    };
    const settleBuildings = (focusX, focusZ, maxMs) => {
      const started = performance.now(); let passes = 0;
      do { g.city.updateBuildingChunks(focusX, focusZ, 24); passes += 1; }
      while ((g.city.pending || g.city.buildQueue.length > 0 || g.city.queuedCells.size > 0) && performance.now() - started < maxMs);
      return {
        complete: !g.city.pending && g.city.buildQueue.length === 0 && g.city.queuedCells.size === 0,
        passes, ms: +(performance.now() - started).toFixed(1), cells: g.city.buildingCells.size,
        pending: Boolean(g.city.pending), queue: g.city.buildQueue.length, queuedCells: g.city.queuedCells.size,
      };
    };
  `;
}

function fixedSetupSource(options, customSetup) {
  return `(async () => {
    const g = window.__game;
    if (!g?.requiredAssetsReady || g.player?.characterStatus !== 'ready') throw new Error('fixed setup started before required assets');
    window.__gauntletExpectedPeds = ${JSON.stringify(Math.round(options.peds))};
    window.__gauntletExpectedCars = ${JSON.stringify(Math.round(options.cars))};
    ${pointHelpersSource()}
    let randomState = ${JSON.stringify(options.seed)} >>> 0;
    Math.random = () => {
      randomState = (randomState + 0x6d2b79f5) >>> 0;
      let value = randomState;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    g.startGame(true);
    g.ui.hideMenu();
    g.settings.quality = ${JSON.stringify(options.quality)};
    g.applyQuality();
    g.city.setStreamRanges(${JSON.stringify(options.world)}, ${JSON.stringify(options.detail)}, ${JSON.stringify(options.buildings)});
    g.dayNight.hour = ${JSON.stringify(options.hour)};
    g.dayNight.timeRate = 0;
    g.lifecycle.tuning.peds = window.__gauntletExpectedPeds;
    g.lifecycle.tuning.cars = window.__gauntletExpectedCars;
    g.teleportPlayer(${JSON.stringify(options.x)}, ${JSON.stringify(options.z)}, 'gauntlet-capture');
    g.player.setHeading(${JSON.stringify(options.heading)});
    for (const ped of [...g.population.pedestrians]) if (isAmbient(ped)) g.population.removePedestrian(ped);
    for (const vehicle of [...g.population.traffic]) g.population.removeVehicle(vehicle);
    g.lifecycle.pendingPedSpawns.length = 0;
    g.lifecycle.pendingCarSpawns.length = 0;
    g.lifecycle.currentZone = undefined;
    g.lifecycle.timer = 3;
    for (const point of fixedPoints(g.city.sidewalkPoints, ${JSON.stringify(options.x)}, ${JSON.stringify(options.z)}, ${JSON.stringify(options.seed ^ 0x51a7)}, window.__gauntletExpectedPeds)) {
      g.population.spawnAmbientPedestrian(point.x, point.z);
    }
    for (const point of fixedPoints(g.city.vehicleNav.nodes, ${JSON.stringify(options.x)}, ${JSON.stringify(options.z)}, ${JSON.stringify(options.seed ^ 0xca45)}, window.__gauntletExpectedCars)) {
      g.population.spawnTrafficVehicle(point.x, point.z);
    }
    g.population.primeVisualLods(g.player.group.position);
    const customSetup = ${JSON.stringify(customSetup)};
    if (customSetup) eval(customSetup);
    const settlement = settleBuildings(${JSON.stringify(options.x)}, ${JSON.stringify(options.z)}, ${JSON.stringify(options['settle-ms'])});
    if (!settlement.complete) throw new Error('building settlement incomplete: ' + JSON.stringify(settlement));
    const ready = readiness();
    if (!ready.ready) throw new Error('fixed setup unready: ' + JSON.stringify(ready));
    const fixedBuildingKeys = [...g.city.buildingCells.keys()].sort();
    window.__gauntletHarness = { census, readiness, settleBuildings, fixedBuildingKeys };
    return { settlement, readiness: ready, census: census() };
  })()`;
}

const KEY_DEFINITIONS = Object.freeze({
  KeyW: { key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 },
  KeyE: { key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 },
  Digit2: { key: '2', code: 'Digit2', windowsVirtualKeyCode: 50 },
  ShiftLeft: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
});

async function dispatchKey(cdp, type, code, modifiers) {
  const definition = KEY_DEFINITIONS[code];
  if (!definition) throw new Error(`No CDP key definition for ${code}`);
  await cdp.send('Input.dispatchKeyEvent', { type, ...definition, modifiers });
}

async function runInputRoute(cdp, scenario) {
  const events = [];
  let frame = 0;
  let modifiers = 0;
  let captureAnchor = null;
  const hold = async (codes, frames) => {
    for (const code of codes) {
      if (code === 'ShiftLeft') modifiers |= 8;
      await dispatchKey(cdp, 'rawKeyDown', code, modifiers);
      events.push({ frame, type: 'keyDown', code, modifiers });
    }
    const observedHeld = await evaluate(cdp, `[...window.__game.input.held].sort()`);
    for (const code of codes) if (!observedHeld.includes(code)) throw new Error(`CDP ${code} did not reach InputManager; observed ${observedHeld.join(', ')}`);
    const timing = await waitFrames(cdp, frames);
    frame += frames;
    for (const code of [...codes].reverse()) {
      if (code === 'ShiftLeft') modifiers &= ~8;
      await dispatchKey(cdp, 'keyUp', code, modifiers);
      events.push({ frame, type: 'keyUp', code, modifiers });
    }
    return timing;
  };
  const tap = async (code, frames = 2) => hold([code], frames);

  await cdp.send('Page.bringToFront');
  await evaluate(cdp, `(() => { window.focus(); document.querySelector('canvas')?.focus?.(); window.__game.input.reset(); return true; })()`);
  if (scenario === 'driving') {
    const prep = await evaluate(cdp, `(() => {
      const g = window.__game;
      const vehicle = [...g.population.vehicles]
        .filter((candidate) => !candidate.disabled && !candidate.wrecked && !candidate.spec.twoWheeler)
        .sort((a, b) => a.group.position.distanceToSquared(g.player.group.position) - b.group.position.distanceToSquared(g.player.group.position)
          || a.group.position.x - b.group.position.x || a.group.position.z - b.group.position.z)[0];
      if (!vehicle) throw new Error('driving route found no usable vehicle');
      vehicle.occupied = false;
      const sideX = Math.cos(vehicle.heading) * 1.8; const sideZ = -Math.sin(vehicle.heading) * 1.8;
      g.player.group.position.set(vehicle.group.position.x + sideX, g.city.surfaceHeightAt(vehicle.group.position.x + sideX, vehicle.group.position.z + sideZ), vehicle.group.position.z + sideZ);
      g.player.setHeading(vehicle.heading);
      g.cameraController.snapBehind(g.player.group.position);
      return { vehicle: vehicle.spec.kind, x: vehicle.group.position.x, z: vehicle.group.position.z, heading: vehicle.heading };
    })()`);
    captureAnchor = prep;
    events.push({ frame, type: 'deterministic-preposition', ...prep });
    await waitFrames(cdp, 2); frame += 2;
    await tap('KeyE', 2); frame += 0;
    await waitFrames(cdp, 42); frame += 42;
    const entered = await evaluate(cdp, `Boolean(window.__game.activeVehicle)`);
    if (!entered) throw new Error('real KeyE route did not enter the prepared vehicle');
    await hold(['KeyW'], 60);
  } else if (scenario === 'wanted') {
    const wanted = await evaluate(cdp, `(() => { window.__game.forceWanted(3); return window.__game.wanted.level; })()`);
    events.push({ frame, type: 'deterministic-state-setup', wanted });
    await tap('Digit2', 2);
    await hold(['ShiftLeft', 'KeyW'], 36);
  } else {
    await hold(['ShiftLeft', 'KeyW'], 36);
  }
  const flush = await waitFrames(cdp, 12);
  frame += 12;
  const finalInputState = await evaluate(cdp, `(() => ({ held: [...window.__game.input.held].sort(), position: {
    x: window.__game.player.group.position.x, y: window.__game.player.group.position.y, z: window.__game.player.group.position.z
  }, activeVehicle: window.__game.activeVehicle?.spec.kind ?? null, wantedLevel: window.__game.wanted.level }))()`);
  if (finalInputState.held.length) throw new Error(`CDP route left keys held: ${finalInputState.held.join(', ')}`);
  return { protocol: 'cdp-real-input-v1', scenario, totalFrames: frame, events, finalFlush: flush, captureAnchor, finalInputState };
}

function finaliseCaptureSource(options, route) {
  return `(async () => {
    const g = window.__game; const harness = window.__gauntletHarness;
    if (!harness) throw new Error('capture harness state is missing');
    g.input.reset();
    g.dayNight.timeRate = 0;
    const route = ${JSON.stringify(route)};
    if (${JSON.stringify(options.scenario)} === 'driving') {
      const vehicle = g.activeVehicle;
      if (!vehicle || !route.captureAnchor) throw new Error('driving capture lost its active vehicle or anchor');
      vehicle.heading = route.captureAnchor.heading; vehicle.steeringVisual = 0; vehicle.speed = 0;
      vehicle.group.position.set(route.captureAnchor.x, g.city.roadHeightAt(route.captureAnchor.x, route.captureAnchor.z) + 0.02, route.captureAnchor.z);
      vehicle.group.rotation.set(0, route.captureAnchor.heading, 0);
      for (const wheel of vehicle.wheels ?? []) wheel.rotation.set(0, 0, 0);
      vehicle.updatePresentation(0, false);
      g.player.group.position.copy(vehicle.group.position); g.player.setHeading(route.captureAnchor.heading);
    } else {
      g.player.group.position.set(${JSON.stringify(options.x)}, g.city.surfaceHeightAt(${JSON.stringify(options.x)}, ${JSON.stringify(options.z)}), ${JSON.stringify(options.z)});
      g.player.setHeading(${JSON.stringify(options.heading)});
      g.player.velocityY = 0; g.player.onGround = true; g.player.moving = false; g.player.sprinting = false;
      Object.assign(g.player.visualState, { locomotionSpeed: 0, aiming: false, firing: false, moveSide: 0, moveForward: 0, onGround: true, velocityY: 0, landing: false });
      const visual = g.player.riggedVisual;
      visual.transitionTo?.('idle', 0); visual.mixer?.setTime(0); g.player.updateVisual(0);
      g.cameraController.snapBehind(g.player.group.position);
    }
    const focus = g.activeVehicle?.group.position ?? g.player.group.position;
    const settlement = harness.settleBuildings(focus.x, focus.z, ${JSON.stringify(options['settle-ms'])});
    if (!settlement.complete) throw new Error('post-route building settlement incomplete: ' + JSON.stringify(settlement));
    for (const key of [...g.city.buildingCells.keys()]) if (!harness.fixedBuildingKeys.includes(key)) g.city.disposeBuildingCell(key);
    // The route can advance staggered culling cursors and attach a neighbouring group. Walk every
    // culler repeatedly at the capture anchor so identical setup—not route timing—owns the frame.
    for (let pass = 0; pass < 32; pass += 1) g.city.updateVisibility(focus, true);
    const anchoredSettlement = harness.settleBuildings(focus.x, focus.z, ${JSON.stringify(options['settle-ms'])});
    if (!anchoredSettlement.complete) throw new Error('capture-anchor settlement incomplete: ' + JSON.stringify(anchoredSettlement));
    const beforeFreeze = harness.readiness();
    if (!beforeFreeze.ready) throw new Error('post-route state unready: ' + JSON.stringify(beforeFreeze));
    const beforeCensus = harness.census();
    g.mode = 'paused';
    g.ui.hideMenu();
    g.clock.stop();
    g.clock.getDelta = () => 0;
    document.getAnimations().forEach((animation) => animation.pause());
    const style = document.createElement('style');
    style.dataset.gauntletFreeze = 'true';
    style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
    document.head.append(style);
    g.updateCamera(0); g.renderHUD();
    if (g.postProcessing?.composer) g.postProcessing.composer.render(); else g.renderer.render(g.scene, g.camera);
    window.__gauntletCaptureReady = { protocol: ${JSON.stringify(SETUP_PROTOCOL)}, frozen: true, beforeCensus };
    return { settlement, anchoredSettlement, fixedBuildingKeys: harness.fixedBuildingKeys, beforeFreeze, beforeCensus, mode: g.mode };
  })()`;
}

function pageStateSource() {
  return `(() => {
    const g = window.__game;
    const isAmbient = (ped) => !ped.scripted && !ped.contact && !ped.police && !ped.hostile && !ped.carGuard && ped.state !== 'down';
    const sceneCensus = () => {
      if (!g) return null;
      const result = {
        objects: 0, visibleObjects: 0, groups: 0, meshes: 0, visibleMeshes: 0,
        instancedMeshes: 0, skinnedMeshes: 0, lights: 0, lines: 0, points: 0,
        buildingCells: g.city.buildingCells.size,
        ambientPeds: g.population.pedestrians.filter(isAmbient).length,
        allPeds: g.population.pedestrians.length, traffic: g.population.traffic.length,
        allVehicles: g.population.vehicles.length, policeVehicles: g.police.vehicles.length,
      };
      g.scene.traverse((object) => {
        result.objects += 1; if (object.visible) result.visibleObjects += 1;
        if (object.isGroup) result.groups += 1;
        if (object.isMesh) { result.meshes += 1; if (object.visible) result.visibleMeshes += 1; }
        if (object.isInstancedMesh) result.instancedMeshes += 1;
        if (object.isSkinnedMesh) result.skinnedMeshes += 1;
        if (object.isLight) result.lights += 1;
        if (object.isLine) result.lines += 1;
        if (object.isPoints) result.points += 1;
      });
      return result;
    };
    const gl = g?.renderer?.getContext?.();
    const debug = gl?.getExtension?.('WEBGL_debug_renderer_info');
    const webgl = gl ? {
      context: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    } : null;
    const camera = g?.camera ? {
      position: { x: g.camera.position.x, y: g.camera.position.y, z: g.camera.position.z },
      quaternion: { x: g.camera.quaternion.x, y: g.camera.quaternion.y, z: g.camera.quaternion.z, w: g.camera.quaternion.w },
      fov: g.camera.fov, near: g.camera.near, far: g.camera.far,
    } : null;
    const position = g?.activeVehicle?.group.position ?? g?.player?.group.position;
    const params = new URLSearchParams(location.search);
    const expectedPeds = Number(params.get('peds'));
    const expectedCars = Number(params.get('cars'));
    const genericReadiness = g ? (() => {
      const pendingPeds = g.lifecycle.pendingPedSpawns.length; const pendingCars = g.lifecycle.pendingCarSpawns.length;
      const actualPeds = g.population.pedestrians.filter(isAmbient).length;
      const actualCars = g.population.traffic.filter((vehicle) => !vehicle.disabled && !vehicle.wrecked).length;
      const buildings = {
        complete: !g.city.pending && g.city.buildQueue.length === 0 && g.city.queuedCells.size === 0,
        pending: Boolean(g.city.pending), queue: g.city.buildQueue.length,
        queuedCells: g.city.queuedCells.size, cells: g.city.buildingCells.size,
      };
      const population = { queuesEmpty: pendingPeds === 0 && pendingCars === 0, pendingPeds, pendingCars, expectedPeds, expectedCars, actualPeds, actualCars };
      return {
        ready: Boolean(g.requiredAssetsReady && g.player?.characterStatus === 'ready' && ['playing', 'paused'].includes(g.mode)
          && buildings.complete && population.queuesEmpty
          && (!Number.isFinite(expectedPeds) || actualPeds === expectedPeds)
          && (!Number.isFinite(expectedCars) || actualCars === expectedCars)),
        requiredAssetsReady: Boolean(g.requiredAssetsReady), characterReady: g.player?.characterStatus === 'ready', mode: g.mode,
        buildings, population,
      };
    })() : { ready: false, requiredAssetsReady: false, characterReady: false, mode: null };
    const readiness = window.__gauntletHarness?.readiness?.(['playing', 'paused']) ?? genericReadiness;
    return {
      viewport: {
        innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
        visualViewport: window.visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale } : null,
        canvasCss: g?.renderer?.domElement ? { width: g.renderer.domElement.clientWidth, height: g.renderer.domElement.clientHeight } : null,
        drawingBuffer: gl ? { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } : null,
      },
      settings: g?.settings ? JSON.parse(JSON.stringify(g.settings)) : null,
      camera,
      world: g ? {
        mode: g.mode,
        position: position ? { x: position.x, y: position.y, z: position.z } : null,
        playerPosition: { x: g.player.group.position.x, y: g.player.group.position.y, z: g.player.group.position.z },
        playerHeading: g.player.heading,
        activeVehicle: g.activeVehicle ? { kind: g.activeVehicle.spec.kind, speed: g.activeVehicle.speed, heading: g.activeVehicle.heading } : null,
        wantedLevel: g.wanted.level,
        district: position ? g.city.districtAt(position.x, position.z) : null,
        hour: g.dayNight.hour,
        population: { pedestrians: g.population.pedestrians.length, ambientTraffic: g.population.traffic.length, allVehicles: g.population.vehicles.length, police: g.police.vehicles.length },
        sceneCensus: window.__gauntletHarness?.census?.() ?? sceneCensus(),
      } : null,
      readiness,
      captureReady: window.__gauntletCaptureReady ?? null,
      webgl,
      userAgent: navigator.userAgent,
      url: location.href,
    };
  })()`;
}

async function collectPageState(cdp) {
  return evaluate(cdp, pageStateSource());
}

async function collectBrowserState(browserCdp) {
  const [version, system] = await Promise.all([
    browserCdp.send('Browser.getVersion'),
    browserCdp.send('SystemInfo.getInfo'),
  ]);
  return {
    chrome: version,
    gpu: system.gpu ?? null,
    model: { name: system.modelName ?? null, version: system.modelVersion ?? null },
  };
}

async function gitMetadata(startDirectory) {
  let root;
  try {
    root = (await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: startDirectory, encoding: 'utf8' })).stdout.trim();
  } catch {
    return { root: null, revision: null, branch: null, dirty: null, dirtyHash: null };
  }
  const [revisionResult, branchResult, statusResult, diffResult, untrackedResult] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }),
    execFileAsync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }),
    execFileAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['diff', '--binary', 'HEAD', '--'], { cwd: root, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }),
    execFileAsync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }),
  ]);
  const status = Buffer.from(statusResult.stdout);
  const dirtyHasher = createHash('sha256').update(status).update(Buffer.from(diffResult.stdout));
  const untracked = Buffer.from(untrackedResult.stdout).toString('utf8').split('\0').filter(Boolean).sort();
  for (const relative of untracked) {
    dirtyHasher.update(relative).update('\0');
    try { dirtyHasher.update(await readFile(path.join(root, relative))); } catch { dirtyHasher.update('<unreadable>'); }
  }
  const dirty = status.length > 0;
  return {
    root,
    revision: revisionResult.stdout.trim(),
    branch: branchResult.stdout.trim() || null,
    dirty,
    dirtyHash: dirtyHasher.digest('hex'),
  };
}

function setupContract(options, customSetupHash = null) {
  return {
    protocol: SETUP_PROTOCOL,
    coordinates: { x: options.x, z: options.z },
    heading: options.heading,
    hour: options.hour,
    quality: options.quality,
    seed: options.seed,
    streamRanges: { world: options.world, detail: options.detail, buildings: options.buildings },
    populationTargets: { peds: Math.round(options.peds), cars: Math.round(options.cars) },
    scenario: options.scenario,
    profile: { plan: options.plan ?? null, warmup: Math.round(options.warmup), frames: Math.round(options.frames), throughput: Boolean(options.throughput) },
    customSetupHash,
  };
}

async function baseSidecar({ browserState, pageState, chromeArguments, setup, artifact, kind }) {
  const revision = await gitMetadata(process.cwd());
  return {
    schema: EVIDENCE_SCHEMA,
    kind,
    createdAt: new Date().toISOString(),
    revision,
    command: { cwd: process.cwd(), argv: [process.execPath, ...process.argv.slice(1)] },
    host: {
      platform: platform(), release: release(), arch: arch(),
      cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, memoryBytes: totalmem(),
    },
    browser: { ...browserState, launchArguments: chromeArguments, headless: true },
    viewport: pageState.viewport,
    webgl: pageState.webgl,
    settings: pageState.settings,
    camera: pageState.camera,
    world: { ...pageState.world, requested: setup },
    readiness: pageState.readiness,
    setup: { contract: setup, sha256: sha256(canonicalJson(setup)) },
    artifact,
    limitations: [
      'The instrumentation/debug handle is available only from a Vite DEV page; native rAF and the real WebGL renderer are used, but this is not the minified production bundle.',
      'Headless Chrome compositor/GPU behavior is recorded above and must not be assumed equivalent to a headed browser when the reported GPU backend differs.',
    ],
  };
}

function pngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a' || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('Chrome returned an invalid PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function capture(cdp, browserState, chromeArguments, options) {
  console.error('[gauntlet] capture: navigating');
  await cdp.send('Page.navigate', { url: options.url });
  await waitForGame(cdp, options.timeout * 1000);
  console.error('[gauntlet] capture: boot ready; applying fixed setup');
  const customSetup = options['setup-file'] ? await readFile(path.resolve(options['setup-file']), 'utf8') : '';
  const setup = setupContract(options, customSetup ? sha256(customSetup) : null);
  const initial = await evaluate(cdp, fixedSetupSource(options, customSetup));
  console.error(`[gauntlet] capture: fixed setup ready; warming ${options.warmup} native frames`);
  await waitFrames(cdp, options.warmup);
  const warmed = await collectPageState(cdp);
  if (!warmed.readiness?.ready) throw new Error(`capture warm-up ended unready: ${JSON.stringify(warmed.readiness)}`);
  console.error(`[gauntlet] capture: running ${options.scenario} CDP input route`);
  const route = await runInputRoute(cdp, options.scenario);
  console.error('[gauntlet] capture: route complete; freezing world and UI');
  const frozen = await evaluate(cdp, finaliseCaptureSource(options, route));

  // Two native compositor opportunities after the explicit simulation/DOM freeze, followed by a
  // layout read. Chrome also launches with --run-all-compositor-stages-before-draw.
  await waitFrames(cdp, 2);
  await cdp.send('Page.getLayoutMetrics');
  console.error('[gauntlet] capture: compositor flush complete; validating state');
  const pageState = await collectPageState(cdp);
  if (!pageState.captureReady?.frozen || pageState.world?.mode !== 'paused') throw new Error('capture did not reach the explicit frozen ready state');
  if (canonicalJson(frozen.beforeCensus) !== canonicalJson(pageState.world.sceneCensus)) {
    throw new Error(`scene census changed during compositor flush: ${JSON.stringify({ before: frozen.beforeCensus, after: pageState.world.sceneCensus })}`);
  }
  if (pageState.viewport?.innerWidth !== options.width || pageState.viewport?.innerHeight !== options.height || pageState.viewport?.devicePixelRatio !== 1) {
    throw new Error(`viewport contract mismatch: ${JSON.stringify(pageState.viewport)}`);
  }
  if (!(pageState.viewport?.drawingBuffer?.width > 0) || !(pageState.viewport?.drawingBuffer?.height > 0)) throw new Error('drawing buffer dimensions are unavailable');

  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  console.error('[gauntlet] capture: PNG received; writing artifact and sidecar');
  const bytes = Buffer.from(screenshot.data, 'base64');
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== options.width || dimensions.height !== options.height) throw new Error(`PNG is ${dimensions.width}x${dimensions.height}, expected ${options.width}x${options.height}`);
  const absolute = path.resolve(options.out);
  await atomicWrite(absolute, bytes);
  const artifact = { file: absolute, mimeType: 'image/png', bytes: bytes.length, sha256: sha256(bytes), ...dimensions };
  const sidecar = await baseSidecar({ browserState, pageState, chromeArguments, setup, artifact, kind: 'screenshot' });
  sidecar.capture = { initial, warmed: warmed.readiness, route, frozen, compositorFlushFrames: 2 };
  await atomicWrite(sidecarPath(absolute), `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(JSON.stringify({ kind: 'capture', file: absolute, sidecar: sidecarPath(absolute), artifactSha256: artifact.sha256, sceneCensus: pageState.world.sceneCensus }, null, 2));
}

function remoteText(argument) {
  if (Object.hasOwn(argument, 'value')) return String(argument.value);
  return argument.description ?? argument.type ?? '';
}

function parseReceipt(line) {
  const match = /^\[([A-Z_]+)\]\s+(.+)$/.exec(line);
  if (!match) return { tag: 'UNKNOWN', payload: line, raw: line };
  try { return { tag: match[1], payload: JSON.parse(match[2]), raw: line }; }
  catch { return { tag: match[1], payload: match[2], raw: line }; }
}

export function profileUrl(options) {
  const url = new URL(options.url);
  const plan = options.plan ?? url.searchParams.get('profile') ?? 'fixed';
  if (url.searchParams.has('fastraf') && !options.throughput) {
    throw new Error('URL requests fastraf; repeat with --throughput to acknowledge that it is not frame-time evidence');
  }
  const values = {
    profile: plan,
    x: options.x,
    z: options.z,
    seed: options.seed,
    world: options.world,
    detail: options.detail,
    buildings: options.buildings,
    peds: Math.round(options.peds),
    cars: Math.round(options.cars),
    quality: options.quality,
    hour: options.hour,
    warmup: Math.round(options.warmup),
    frames: Math.round(options.frames),
    settleMs: Math.round(options['settle-ms']),
  };
  if (options.label) values.label = options.label;
  if (options.only) values.only = options.only;
  if (plan === 'traverse') Object.assign(values, { x2: options.x2, z2: options.z2, speed: options.speed ?? 30 });
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  if (options.throughput) url.searchParams.set('fastraf', ''); else url.searchParams.delete('fastraf');
  return url.href;
}

async function profile(cdp, browserState, chromeArguments, options) {
  const receipts = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const readConsole = ({ args = [] }) => {
    const line = args.map(remoteText).join(' ');
    if (!line.startsWith('[PROFILE')) return;
    const receipt = parseReceipt(line);
    receipts.push(receipt);
    if (receipt.tag === 'PROFILE_DONE' || receipt.tag === 'PROFILE_ERROR') finish(receipt);
  };
  const remove = cdp.on('Runtime.consoleAPICalled', readConsole);
  const url = profileUrl(options);
  await cdp.send('Page.navigate', { url });
  const timeout = delay(options.timeout * 1000).then(() => { throw new Error(`Profiler did not finish after ${options.timeout}s`); });
  await Promise.race([finished, timeout]);
  remove();
  await waitFrames(cdp, 1);
  const pageState = await collectPageState(cdp);
  const setup = setupContract({ ...options, plan: new URL(url).searchParams.get('profile') });
  const payload = {
    schema: 'gtb.gauntlet.profile/v2',
    kind: 'profile',
    url,
    pacing: receipts.find((receipt) => receipt.tag === 'PROFILE_MODE')?.payload ?? null,
    setup: receipts.find((receipt) => receipt.tag === 'PROFILE_SETUP')?.payload ?? null,
    profiles: receipts.filter((receipt) => receipt.tag === 'PROFILE').map((receipt) => receipt.payload),
    settlement: receipts.find((receipt) => receipt.tag === 'PROFILE_SETTLE')?.payload ?? null,
    completion: receipts.find((receipt) => receipt.tag === 'PROFILE_DONE')?.payload ?? null,
    error: receipts.find((receipt) => receipt.tag === 'PROFILE_ERROR')?.payload ?? null,
    receipts,
  };
  const absolute = path.resolve(options.out);
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`);
  await atomicWrite(absolute, bytes);
  const artifact = { file: absolute, mimeType: 'application/json', bytes: bytes.length, sha256: sha256(bytes) };
  const sidecar = await baseSidecar({ browserState, pageState, chromeArguments, setup, artifact, kind: 'profile' });
  sidecar.profile = {
    pacing: payload.pacing,
    phaseCount: payload.profiles.length,
    rawPerFrameSamples: payload.profiles.every((phase) => Array.isArray(phase.rawSamples) && phase.rawSamples.length === phase.frames),
    error: payload.error,
  };
  await atomicWrite(sidecarPath(absolute), `${JSON.stringify(sidecar, null, 2)}\n`);
  console.log(JSON.stringify({ kind: 'profile', file: absolute, sidecar: sidecarPath(absolute), artifactSha256: artifact.sha256, pacing: payload.pacing, phases: payload.profiles.map((phase) => ({ phase: phase.phase, p95: phase.dtMs?.p95, p99: phase.dtMs?.p99, stable: phase.sceneCensus?.stable })) }, null, 2));
  if (payload.error) process.exitCode = 1;
}

function relativeSpread(values) {
  const minimum = Math.min(...values); const maximum = Math.max(...values);
  if (minimum === 0) return maximum === 0 ? 0 : Infinity;
  return (maximum - minimum) / minimum;
}

export function assessFixedRuns(runs) {
  const reasons = [];
  if (runs.length !== 3) reasons.push(`expected exactly 3 runs, received ${runs.length}`);
  const files = runs.map((run) => run.file);
  if (files.some((file) => !file) || new Set(files).size !== runs.length) reasons.push('runs must be three distinct artifact files');
  const artifactHashes = runs.map((run) => run.sidecar?.artifact?.sha256);
  if (artifactHashes.some((hash) => !hash) || new Set(artifactHashes).size !== runs.length) reasons.push('runs must have three distinct artifact hashes');
  const phases = runs.map((run) => run.payload?.profiles?.find((phase) => phase.role === 'fixed'));
  phases.forEach((phase, index) => {
    if (!phase) reasons.push(`run ${index + 1} has no fixed phase`);
    else {
      if (phase.pacing !== 'native-rAF' || phase.frameTimeGateEligible !== true) reasons.push(`run ${index + 1} is not native-rAF gate evidence`);
      if (!phase.sceneCensus?.stable) reasons.push(`run ${index + 1} changed its scene census`);
      if (!phase.readiness?.start?.ready || !phase.readiness?.end?.ready) reasons.push(`run ${index + 1} was not ready for its whole phase`);
      if (!Array.isArray(phase.rawSamples) || phase.rawSamples.length !== phase.frames) reasons.push(`run ${index + 1} lacks complete raw per-frame samples`);
    }
  });
  const setups = runs.map((run) => run.sidecar?.setup?.sha256);
  if (setups.some((value) => !value) || new Set(setups).size !== 1) reasons.push('setup hashes are missing or differ');
  const revisions = runs.map((run) => `${run.sidecar?.revision?.revision ?? ''}:${run.sidecar?.revision?.dirtyHash ?? ''}`);
  if (revisions.some((value) => value === ':') || new Set(revisions).size !== 1) reasons.push('revision/dirty hashes are missing or differ');
  const census = phases.map((phase) => phase ? canonicalJson(phase.sceneCensus?.start) : null);
  if (census.some((value) => !value) || new Set(census).size !== 1) reasons.push('fixed scene census differs across runs');
  const p95 = phases.flatMap((phase) => Number.isFinite(phase?.dtMs?.p95) ? [phase.dtMs.p95] : []);
  const p99 = phases.flatMap((phase) => Number.isFinite(phase?.dtMs?.p99) ? [phase.dtMs.p99] : []);
  if (p95.length !== 3 || relativeSpread(p95) > 0.05) reasons.push(`p95 spread exceeds 5% or is missing (${p95.join(', ')})`);
  if (p99.length !== 3 || relativeSpread(p99) > 0.05) reasons.push(`p99 spread exceeds 5% or is missing (${p99.join(', ')})`);
  return {
    eligibleToRegenerateBaseline: reasons.length === 0,
    criteria: { runCount: 3, distinctArtifacts: true, identicalSetupHash: true, identicalRevisionAndDirtyHash: true, identicalSceneCensus: true, nativeRaf: true, p95AndP99RelativeSpreadAtMost: 0.05 },
    observations: { p95, p99, p95RelativeSpread: p95.length === 3 ? relativeSpread(p95) : null, p99RelativeSpread: p99.length === 3 ? relativeSpread(p99) : null, files, artifactHashes, setupHashes: setups, revisionDirtyHashes: revisions },
    reasons,
  };
}

async function verify(options) {
  const files = String(options.runs).split(',').map((file) => path.resolve(file.trim())).filter(Boolean);
  const runs = await Promise.all(files.map(async (file) => ({
    file,
    payload: JSON.parse(await readFile(file, 'utf8')),
    sidecar: JSON.parse(await readFile(sidecarPath(file), 'utf8')),
  })));
  const result = assessFixedRuns(runs);
  console.log(JSON.stringify({ kind: 'fixed-run-verification', files, ...result }, null, 2));
  if (!result.eligibleToRegenerateBaseline) process.exitCode = 1;
}

async function runBrowser(options) {
  const port = await freePort();
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'gtb-gauntlet-chrome-'));
  const chrome = process.env.CHROME_PATH ?? DEFAULT_CHROME;
  const chromeArguments = [
    '--headless=new', '--enable-gpu', '--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--run-all-compositor-stages-before-draw', '--enable-precise-memory-info',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDirectory}`,
    `--window-size=${options.width},${options.height}`, '--force-device-scale-factor=1', 'about:blank',
  ];
  const child = spawn(chrome, chromeArguments, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { chromeError = `${chromeError}${chunk}`.slice(-8000); });

  let cdp;
  let browserCdp;
  try {
    const [targets, versionTarget] = await Promise.all([
      waitForJson(`http://127.0.0.1:${port}/json/list`, 15000),
      waitForJson(`http://127.0.0.1:${port}/json/version`, 15000),
    ]);
    const page = targets.find((target) => target.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('Chrome opened without a debuggable page');
    if (!versionTarget.webSocketDebuggerUrl) throw new Error('Chrome opened without a browser debugging endpoint');
    cdp = new Cdp(page.webSocketDebuggerUrl);
    browserCdp = new Cdp(versionTarget.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Log.enable'),
      cdp.send('Emulation.setDeviceMetricsOverride', { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false }),
      browserCdp.ready,
    ]);
    const browserState = await collectBrowserState(browserCdp);
    if (options.command === 'capture') await capture(cdp, browserState, chromeArguments, options);
    else await profile(cdp, browserState, chromeArguments, options);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    if (chromeError) console.error(`Chrome stderr tail:\n${chromeError}`);
    process.exitCode = 1;
  } finally {
    cdp?.close();
    browserCdp?.close();
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)]);
    child.stderr.destroy();
    child.unref();
    await rm(profileDirectory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
    validateOptions(options);
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error));
    return;
  }
  if (options.command === 'verify') await verify(options);
  else await runBrowser(options);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
  // Node's built-in WebSocket can retain a closing handshake after Chrome has been reaped. This is
  // a one-shot CLI and all evidence writes/cleanup above are awaited.
  process.exit(process.exitCode ?? 0);
}
