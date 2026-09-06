#!/usr/bin/env node
/** Real WebGL fault tests against Vite's dev build. Uses a fresh profile and the same Chrome/GPU
 * lifecycle as the Gauntlet harness. This is a correctness check, not an FPS benchmark. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluate, runBrowser, waitForGame, waitFrames } from './gauntlet-browser.mjs';

const args = process.argv.slice(2);
const options = { url: 'http://127.0.0.1:5173/', out: 'gauntlet/evidence/graphics-smoke', width: 1280, height: 720, timeout: 180, mobile: false, bootLoss: false };
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--mobile') { options.mobile = true; options.width = 915; options.height = 412; }
  else if (argument === '--boot-loss') options.bootLoss = true;
  else if (argument === '--url' || argument === '--out') {
    const value = args[++index]; assert.ok(value, `${argument} requires a value`); options[argument.slice(2)] = value;
  } else throw new Error(`Unknown argument ${argument}. Use --url URL --out DIRECTORY [--mobile] [--boot-loss].`);
}
const out = path.resolve(options.out);
await mkdir(out, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await runBrowser(options, async (cdp, browser) => {
  const errors = []; const checks = [];
  cdp.on('Runtime.exceptionThrown', (event) => errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text));
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error') errors.push(event.args.map((item) => item.description ?? item.value).join(' '));
  });
  const shot = async (name) => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(result.data, 'base64'));
  };
  const until = async (expression, label) => {
    const deadline = Date.now() + options.timeout * 1000;
    while (Date.now() < deadline) {
      if (await evaluate(cdp, expression)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const state = () => evaluate(cdp, `(() => {
    const g = window.__game; const c = g.postProcessing?.composer;
    return { graphics: g.graphicsRecovery.state, mode: g.mode, quality: g.settings.quality,
      position: g.player.group.position.toArray(), health: g.player.health, money: g.economy.balance,
      buffer: [g.renderer.domElement.width, g.renderer.domElement.height],
      postBuffer: c ? [Math.floor(c.renderTarget1.width), Math.floor(c.renderTarget1.height)] : null,
      memory: { ...g.renderer.info.memory }, programs: g.renderer.info.programs.length,
      updates: window.__graphicsSmokeUpdates ?? 0, contextLost: g.renderer.getContext().isContextLost() };
  })()`);

  if (options.mobile) {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: options.width, height: options.height, deviceScaleFactor: 2, mobile: true });
  }
  if (options.bootLoss) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const original = HTMLCanvasElement.prototype.getContext; const canvases = new Set();
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        const context = original.call(this, type, ...args);
        if (type === 'webgl2' && context && !canvases.has(this)) {
          canvases.add(this);
          // The first context is main.ts's disposable capability probe; the second is the game.
          if (canvases.size === 2) {
            const loss = context.getExtension('WEBGL_lose_context');
            this.addEventListener('webglcontextlost', () => {
              window.__graphicsSmokeBootLoss = { beforeReady: !window.__game?.requiredAssetsReady };
              setTimeout(() => loss.restoreContext(), 1000);
            }, { once: true });
            setTimeout(() => loss.loseContext(), 0);
          }
        }
        return context;
      };
    })()` });
  }
  await cdp.send('Page.navigate', { url: options.url });
  await waitForGame(cdp, options.timeout * 1000);
  if (options.bootLoss) {
    await until('window.__game.graphicsRecovery.state === "ready"', 'boot context restoration');
    assert.equal(await evaluate(cdp, 'window.__graphicsSmokeBootLoss?.beforeReady'), true);
    assert.equal(await evaluate(cdp, 'Boolean(document.querySelector("#boot-error"))'), false);
    await shot('boot-context-ready');
    await evaluate(cdp, 'document.querySelector("[data-graphics-continue]").click()');
    checks.push({ name: 'context loss during boot', state: await state() });
  }
  await evaluate(cdp, `(() => {
    const g = window.__game; g.startGame(true); g.cheats.invulnerable = true; g.dayNight.timeRate = 0;
    const update = g.update.bind(g); window.__graphicsSmokeUpdates = 0;
    g.update = (...args) => { window.__graphicsSmokeUpdates++; return update(...args); };
    return true;
  })()`);
  await waitFrames(cdp, 30);
  checks.push({ name: 'boot and simulation', state: await state() });
  assert.ok(checks.at(-1).state.updates > 0);

  // Real resize events, DPR changes and all quality tiers must agree with the composer buffers.
  for (const quality of ['potato', 'low', 'medium', 'high', 'ultra', 'high']) {
    await evaluate(cdp, `(() => { const g = window.__game; g.settings.quality = ${JSON.stringify(quality)}; g.applyQuality(); return true; })()`);
    await until(`Boolean(window.__game.postProcessing) === ${!['potato', 'low'].includes(quality)}`, `quality ${quality}`);
    await waitFrames(cdp, 8);
    const receipt = await state(); assert.equal(receipt.graphics, 'running');
    if (receipt.postBuffer) assert.deepEqual(receipt.postBuffer, receipt.buffer);
    checks.push({ name: `quality ${quality}`, state: receipt });
  }
  await evaluate(cdp, `(() => { const g = window.__game; for (const q of ['ultra', 'low', 'medium', 'ultra', 'high']) { g.settings.quality = q; g.applyQuality(); } return true; })()`);
  await until('Boolean(window.__game.postProcessing) && !window.__game.postProcessing.gtao', 'last rapid quality selection');
  await waitFrames(cdp, 12);
  checks.push({ name: 'rapid quality selection', state: await state() });

  if (!options.mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 5120, height: 2880, deviceScaleFactor: 2, mobile: false });
    await until('window.__game.renderer.domElement.width === 2560 && window.__game.renderer.domElement.height === 1440', '5K render budget');
    const large = await state(); assert.deepEqual(large.postBuffer, large.buffer);
    checks.push({ name: '5K display capped at 1440p on High', state: large });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: options.width, height: options.height, deviceScaleFactor: 1, mobile: false });
    await until(`window.__game.renderer.domElement.width === ${options.width}`, 'original viewport');
  }

  const resizeCount = await evaluate(cdp, `(async () => {
    const g = window.__game; const original = g.renderer.setDrawingBufferSize; let changes = 0;
    g.renderer.setDrawingBufferSize = function (...args) { changes++; return original.apply(this, args); };
    for (let index = 0; index < 30; index++) window.dispatchEvent(new Event('resize'));
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
    g.renderer.setDrawingBufferSize = original; return changes;
  })()`);
  assert.equal(resizeCount, 0, 'unchanged resize events reallocated the backbuffer');
  checks.push({ name: 'unchanged resize events', allocations: resizeCount });

  for (let round = 0; round < 2; round++) {
    const before = await state();
    await evaluate(cdp, `(() => {
      const g = window.__game; window.__graphicsSmokeLoss = g.renderer.getContext().getExtension('WEBGL_lose_context');
      if (!window.__graphicsSmokeLoss) throw new Error('WEBGL_lose_context is unavailable');
      g.input.synthKey('KeyW', true); g.input.synthFire(true); window.__graphicsSmokeLoss.loseContext(); return true;
    })()`);
    await until('window.__game.graphicsRecovery.state === "lost"', 'context loss');
    const lost = await state(); await waitFrames(cdp, 10); const waiting = await state();
    assert.equal(lost.contextLost, true); assert.equal(waiting.updates, lost.updates);
    assert.deepEqual(waiting.position, lost.position);
    assert.equal(await evaluate(cdp, 'window.__game.input.firing || window.__game.input.down("KeyW")'), false);
    if (round === 0) await shot('context-lost');
    await evaluate(cdp, 'window.__graphicsSmokeLoss.restoreContext()');
    await until('window.__game.graphicsRecovery.state === "ready"', 'resource restoration');
    const ready = await state(); assert.equal(ready.contextLost, false);
    assert.equal(ready.updates, waiting.updates); assert.deepEqual(ready.position, lost.position);
    assert.equal(ready.health, lost.health); assert.equal(ready.money, lost.money);
    assert.deepEqual(ready.postBuffer, ready.buffer);
    if (round === 0) await shot('context-ready');
    const fits = await evaluate(cdp, `(() => { const r = document.querySelector('.graphics-recovery-card').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
    assert.equal(fits, true, 'recovery controls extend beyond the viewport');
    if (round === 0) await evaluate(cdp, 'document.querySelector("[data-graphics-continue]").click()');
    else {
      // A controller must be able to leave the recovery card while normal gameplay polling is paused.
      await evaluate(cdp, `(() => {
        window.__graphicsSmokeGetPads = navigator.getGamepads;
        navigator.getGamepads = () => [{ connected: true, mapping: 'standard', index: 0, id: 'Graphics smoke controller', axes: [0,0,0,0],
          buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 0, touched: i === 0, value: i === 0 ? 1 : 0 })) }];
        return true;
      })()`);
    }
    await until('window.__game.graphicsRecovery.state === "running"', 'Continue');
    if (round === 1) await evaluate(cdp, 'navigator.getGamepads = window.__graphicsSmokeGetPads; true');
    await waitFrames(cdp, 12); const after = await state(); assert.ok(after.updates > ready.updates);
    checks.push({ name: `context recovery ${round + 1}`, before, lost, ready, after });
  }
  await shot('recovered-game');

  // A failing simulation must stop once with a reload action, even if graphics subsequently restore.
  await evaluate(cdp, 'window.__game.update = () => { throw new Error("IntentionalGraphicsSmokeFrameFault"); }; true');
  await until('window.__game.graphicsRecovery.state === "failed"', 'fatal frame card');
  const fatalCount = errors.filter((error) => error.includes('IntentionalGraphicsSmokeFrameFault')).length;
  await waitFrames(cdp, 12);
  assert.equal(errors.filter((error) => error.includes('IntentionalGraphicsSmokeFrameFault')).length, fatalCount);
  assert.ok(fatalCount > 0); await shot('frame-failure');
  checks.push({ name: 'fatal frame stopped once', diagnostics: fatalCount });
  await evaluate(cdp, 'window.__graphicsSmokeInputFaults = 0; window.__game.input.pollGamepad = () => { window.__graphicsSmokeInputFaults++; throw new Error("IntentionalGraphicsSmokeInputFault"); }; true');
  await waitFrames(cdp, 12);
  assert.equal(await evaluate(cdp, 'window.__graphicsSmokeInputFaults'), 1);
  checks.push({ name: 'recovery survives input failure' });
  const unexpected = errors.filter((error) => !error.includes('IntentionalGraphicsSmokeFrameFault'));
  assert.deepEqual(unexpected, []);
  await writeFile(path.join(out, 'results.json'), `${JSON.stringify({ kind: 'gtb.graphics-smoke/v1', options, browser, checks, errors }, null, 2)}\n`);
  console.log(`Graphics smoke passed: ${checks.length} checks. Evidence: ${out}`);
});
process.exit(process.exitCode ?? 0);
