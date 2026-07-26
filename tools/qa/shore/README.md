# Shore QA — in-engine evidence for D2 / D3 / D4

Three defects on the Vaalpunt shore have each been declared fixed on evidence that could not possibly
show them: a **top-down 2D map crop**. A map crop cannot contain a horizon line, and it cannot contain
the colour of a surface as the player's own composer resolves it. This directory exists so nobody has
to do that again.

Everything here drives the **real game**, headless, through **its own renderer and composer**, from
**player eye height with pitch 0** — so any horizontal line in a frame is a real one — and reads the
pixels back out of `renderer.domElement`. No orthographic camera, no mapgen preview, no 2D crop.

## Running it

```bash
npm run dev -- --port 5411                      # the game, as the game
PORT=5411 python3 tools/qa/shore/eye.py out/ all   # ~40 frames, cap / sand / dark viewsets
python3 tools/qa/shore/measure.py out/ AFTER       # the numbers
```

Needs `playwright` + `pillow` + `numpy`, and Chromium with SwiftShader
(`--use-angle=swiftshader`, already in the scripts). A boot takes about four minutes.

## What each script answers

| script | question |
| --- | --- |
| `eye.py` | the frames themselves. Viewpoints are derived from the SHIPPED `joburg-map.json` (widest water, narrowest water, dry corners, both resort beaches, the west band, night). Records the ray fan down the centre column and what the player is standing on, so a measured tone can be attributed to a surface rather than guessed at. |
| `measure.py` | D2 the largest LEVEL luminance step over any 1..14 px window; D3 patch RGB / hue / HSV saturation on the natural strand and on the resort beaches; D4 ground darkness in the lower half of the frame, with matched open-veld controls east of the city. |
| `sweep-haze.py` | picks the ocean-haze constants. Teleports once per viewpoint, then renders every candidate from that standpoint through `city.waterHandle.setHaze(density, skyMix, grazePower)` — a debug hook that exists for exactly this — and scores each on the step metric plus how far the far water still sits from the sky and from the strand. |
| `attribute.py` | **what is the dark row on the horizon?** Renders the same frame four ways (shipped / Water hidden / sky dome hidden / far chunks hidden) and casts rays through the *centre* of each half-row. This is how the residual line at the v5 placement was identified as the dam's own far bank rather than shading: hiding the far chunks lifts that row from 138 to 186, hiding the water leaves it at 138 exactly. |
| `facades.py` | counts City's facade materials at boot and after a tour, and how many carry a night glow. It is what found D4: the map is **empty** at boot, so DayNight's one-time snapshot of it was a zero-length array and no building window in the world had ever lit up. |

## Ground rules for anyone editing these

* Eye height, pitch 0, fog forced to the 0.00025 the owner plays at. A flattering fog is cheating.
* Throw the first frame away. The atmospheric sky dome snaps to the camera *during* a draw, so the
  first render after a teleport can still have the dome centred on the previous viewpoint.
* Check `eyeY` before you quote a horizon number. Several natural shore stands are **under water** —
  a submerged camera has no horizon and its "step" is the surface seen from below.
* Never edit `src/` while a run is in flight: Vite HMR reloads the page and the run dies mid-way.
