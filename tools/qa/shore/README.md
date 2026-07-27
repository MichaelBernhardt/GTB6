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
| `look.py` | **does the dam look like a dam?** Thirteen viewpoints — waterline, roof, air, standing on Grooteiland, the west band, and two CBD controls on the same rig — each rendered and then sampled through a ray lattice, so every reported RGB is attributed to the surface the ray hit. Run it at `QUALITY=low` (flat water) and `QUALITY=medium` (physical) — they are different shaders and they do not fail together. |
| `attribute-frame.py` | renders ONE frame four ways (shipped / shadow map off / Water hidden / fog off) and diffs them. Use it before blaming shading: it is what proved the dark ring around the bays was the drawdown strand's own calibrated colour and not a shadow (shadows off moved 0.1% of pixels). |
| `horizon.py` | **D2 asked properly: is there a level line that is NOT the horizon?** At pitch 0 the true horizon projects to the exact centre row, so it excludes that band and reports the strongest level step anywhere else. Needed because the raw step cannot tell a cap from a horizon — run against the ORIGINAL ocean the owner accepted, the raw step is 150/255. |
| `calibrate.py` | **measure the palette instead of deriving it.** Paints the shipped bed sheet a known albedo and reads the pixel back through the game's own composer, so coast.ts's constants can be inversions of a MEASURED transfer under the CURRENT lighting. `--veld` answers the other half: it reads the sheet patch and the neighbouring ground-mesh patch out of one frame and prints the distance between them, which is how the sheet's inland fade is kept from ending on a colour seam. |

## The control that settles D2

`main`'s map still has the ORIGINAL ocean, the one nobody ever complained about, and it boots on the
same engine. Serve it on its own port and shoot it with the same rig, and the "dead-level water/sky
line" argument resolves itself:

| | strongest level step | strongest level step that is NOT the horizon |
| --- | --- | --- |
| original ocean (`main`, 14 stands) | **147-154** | **151.6** |
| the dam | 23-88 | 47.5 |

A pitch-0 shot of any body of water has a level step at the horizon; that is what a horizon is. The
number to watch is the second column.

## Ground rules for anyone editing these

* Eye height, pitch 0, fog forced to the 0.00025 the owner plays at. A flattering fog is cheating.
* **Look from more than one height.** Everything that broke this round was invisible at pitch 0 and
  obvious from 260 units up, because the ocean haze was keyed to distance and not to angle.
* Throw the first frame away. The atmospheric sky dome snaps to the camera *during* a draw, so the
  first render after a teleport can still have the dome centred on the previous viewpoint.
* Check `eyeY` before you quote a horizon number. Several natural shore stands are **under water** —
  a submerged camera has no horizon and its "step" is the surface seen from below.
* Never edit `src/` while a run is in flight: Vite HMR reloads the page and the run dies mid-way.
