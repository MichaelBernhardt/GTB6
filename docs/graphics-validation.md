# Graphics validation

Run the game with `npm run dev -- --host 127.0.0.1`, then use a second terminal:

```bash
npm run test:graphics
npm run test:graphics -- --mobile --out gauntlet/evidence/graphics-mobile
npm run test:graphics -- --boot-loss --out gauntlet/evidence/graphics-boot
```

These checks launch Chrome with a temporary profile, use the real WebGL renderer, and close the
browser afterward. `CHROME_PATH` overrides the browser executable. The default is Google Chrome
on macOS with ANGLE/Metal; the shared Gauntlet browser runner records the actual GPU details.
Use `--url` for a different Vite URL. The harness needs the development-only `window.__game` hook.
It does not write to an existing browser profile or use the multiplayer server.

The desktop run covers all five quality tiers, rapid quality changes, a 5K/DPR-2 window, and
repeated resize events. Both runs force two GPU context losses during active simulation, check
that held movement/fire clear, verify that position/health/money stay unchanged while recovery
is pending, and resume using the recovery button and a standard controller. The mobile run uses
a 915×412 CSS viewport at DPR 2 with touch emulation and checks that the recovery controls fit.
The last check injects a simulation error and verifies that the frame loop stops once with a
readable reload action. That intentional error is included in the receipt; any other browser
exception or console error fails the run.

`--boot-loss` additionally interrupts the game's WebGL context during city construction, before
required models are ready. It checks that boot finishes and the recovery action works without a
startup error card.

PNG screenshots and `results.json` are written beneath the selected output directory, which is
ignored by Git. Touch emulation checks layout and browser behavior; a physical phone remains
necessary to measure mobile performance, thermal limits, and real driver behavior.

## Render budgets and resource ownership

`RenderSizing.ts` keeps the canvas at the CSS viewport size and scales the drawing buffer. The
pixel budgets correspond to these 16:9 resolutions; other aspect ratios retain their shape.
The driver's texture and renderbuffer limits can reduce them further.

| Quality | Maximum pixels | Preferred resolution scale |
| --- | --- | --- |
| Skorokoro / potato | 1280×720 | 0.5× CSS |
| Low | 1920×1080 | Native DPR, capped at 1× |
| Medium | 2560×1440 | Native DPR, capped at 1.25× |
| High | 2560×1440 | Native DPR, capped at 1.5× |
| Ultra | 3840×2160 | At least 2× CSS, capped at 3×, within the pixel budget |

The post-processing stack uses at most two MSAA samples. Ultra adds GTAO; High and Medium use
bloom/output. A quality change invalidates older asynchronous setup work. Disposal releases the
composer, its passes, and GTAO/bloom shader materials omitted by Three r178's own disposers. A setup
failure releases the resources already created and falls back to the base renderer. GPU
restoration regenerates the environment map, water targets, shadows and post-processing stack.
Every lake owns its reflection refresh state and releases its target on a quality change;
reflection views cannot recursively render other lake reflections.
NPC despawning releases each cloned skeleton's bone texture while retaining shared model assets.

The pooled-light shader optimization preserves Three's fixed light counts and their uniforms.
Zero-color point/spot slots skip their contribution, and active slots skip BRDF work outside
their influence. The installed Three shader layout is checked by unit tests; an unrecognized
layout falls back to the original shader. Re-run day/night image comparisons after changing
Three or the lighting model.

## Performance comparisons

Use the existing `npm run gauntlet:browser -- profile ...` workflow for performance receipts and
its scene-census validation. Do not weaken its gates when a run is rejected. Keep resolution,
quality, weather/time, camera, world streaming and population equal in comparisons, and avoid
concurrent builds or other GPU work when measuring frame times.

`test:graphics` checks correctness, not FPS. A paused scene with unchanged geometry is useful for
isolating shader cost and comparing pixels, but its frame times do not represent live gameplay.
Report those diagnostics separately from moving, combat, and driving runs.
