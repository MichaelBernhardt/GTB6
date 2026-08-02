# Gauntlet evidence contract

The evidence harness creates fixed-scene browser artifacts that can be inspected without trusting a
builder's summary. It uses a fresh Chrome profile, an explicit world coordinate and population,
native `requestAnimationFrame`, a 1920×1080 CSS viewport at DPR 1, and the game's real renderer.

The profiler is intentionally available only from Vite's development page because `window.__game`
and `src/dev/Profiler.ts` are development instrumentation. This is production-like frame pacing and
real WebGL work, not the minified production bundle. Every sidecar records that limitation and the
actual Chrome GPU/WebGL backend; reviewers should reject a run whose backend is not representative
of the comparison machine.

## Start the page

In one terminal:

```sh
npm run dev -- --host 127.0.0.1 --port 5173
```

Use the generated-map player spawn as the fixed reference coordinate. Both values remain explicit in
every command so a future map rebuild cannot silently move the benchmark:

```text
x = 2242.0107086962958
z = 1996.8564986892688
```

## Deterministic screenshots

The three scenarios share the same setup. The route uses real CDP keyboard events and exact native-rAF
frame counts. On-foot holds sprint/forward; driving positions beside a deterministic car, enters with
real `E`, then accelerates with real `W`; wanted applies an explicit three-star setup and then follows a
real sprint route. Direct state setup is disclosed in the sidecar—it is not described as player input.

```sh
npm run gauntlet:browser -- capture \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/on-foot.png \
  --x 2242.0107086962958 --z 1996.8564986892688 --scenario on-foot

npm run gauntlet:browser -- capture \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/driving.png \
  --x 2242.0107086962958 --z 1996.8564986892688 --scenario driving

npm run gauntlet:browser -- capture \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/wanted.png \
  --x 2242.0107086962958 --z 1996.8564986892688 --scenario wanted
```

Before capture, the harness requires required assets, the player model, the complete fixed building
ring, empty building/population queues, and the requested live census. It then freezes simulation at
an explicit paused-ready state, pauses DOM animation, renders the final HUD/world, waits two compositor
frames, reads layout, and captures. It aborts instead of writing an artifact if the scene census changes
during that flush or the PNG is not exactly 1920×1080.

## Native-rAF fixed profile

Run three separate Chrome processes. Each profile contains every raw measured frame, nearest-rank
p95/p99, exclusive synchronous subsystem timings, start/end readiness, and start/end scene census.

```sh
npm run gauntlet:browser -- profile \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/fixed-1.json \
  --x 2242.0107086962958 --z 1996.8564986892688

npm run gauntlet:browser -- profile \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/fixed-2.json \
  --x 2242.0107086962958 --z 1996.8564986892688

npm run gauntlet:browser -- profile \
  --url http://127.0.0.1:5173/ \
  --out gauntlet/evidence/candidate/fixed-3.json \
  --x 2242.0107086962958 --z 1996.8564986892688

npm run gauntlet:browser -- verify \
  --runs gauntlet/evidence/candidate/fixed-1.json,gauntlet/evidence/candidate/fixed-2.json,gauntlet/evidence/candidate/fixed-3.json
```

`verify` says `eligibleToRegenerateBaseline: true` only when there are exactly three native-rAF fixed
runs with distinct artifact files and hashes, all raw samples are present, each phase remains ready with a stable census, setup and
revision/dirty hashes match, the cross-run scene census is identical, and both p95 and p99 have at most
5% relative spread. This is only a reproducibility gate. An independent critic still decides whether
the measured result satisfies the quality bar.

Do not add `fastraf` to an evidence URL. Timer pumping is available only with the explicit
`--throughput` acknowledgement and produces `frameTimeGateEligible: false`; it is useful for CPU
throughput diagnosis, never for FPS or frame-time claims.

For a renderer toggle experiment, use `--plan matrix --only gtao-off` (or `post-off`, `shadows-off`,
`water-low`). Each variant is bracketed by untoggled phases in the same fixed world. Actor-removal and
quality-tier comparisons require separate fresh fixed runs with explicit settings; the matrix does not
pretend it can restore a destroyed population or rebuilt world in place.

## Artifact and sidecar schema

A PNG `frame.png` is paired with `frame.png.json`. A profile `fixed-1.json` is paired with
`fixed-1.json.meta.json`. The artifact is atomically renamed into place first; the complete JSON
sidecar is then atomically renamed into place. A missing sidecar means the artifact is incomplete.

Every `gtb.gauntlet.evidence/v2` sidecar contains:

| Field | Evidence recorded |
| --- | --- |
| `revision` | Full Git revision, branch, dirty flag, and a SHA-256 over tracked diff plus untracked file contents. |
| `command` | Exact argument vector and working directory. |
| `host` | OS, architecture, CPU model/count, and memory. |
| `browser` | Chrome protocol/version receipt, launch flags, headless truth, `SystemInfo` GPU devices, driver/features, and model. |
| `viewport` | Inner/outer/visual viewport, DPR, canvas CSS size, and actual WebGL drawing buffer. |
| `webgl` | Context/version/shader language plus masked and, when exposed, unmasked vendor/renderer. |
| `settings` | The game's serialized live settings—not inferred renderer claims. |
| `camera` | Position, quaternion, FOV, near plane, and far plane. |
| `world` | Actual player/vehicle pose, district, hour, wanted state, population and scene census, plus requested setup. |
| `readiness` | Asset/character gates, building pending/queue/cell counts, population pending/target/actual counts, and final mode. |
| `setup` | Canonical setup contract and SHA-256, including coordinates, seed, ranges, census, quality, hour, route and custom setup hash. |
| `artifact` | Absolute file, MIME type, byte count, SHA-256, and PNG dimensions where applicable. |

Screenshot sidecars additionally include the full input event/frame sequence and freeze/compositor
receipt. Profile sidecars state pacing eligibility, phase count, raw-sample completeness, and any
profiler error. Draw calls and triangle counts are valid per-frame profiler samples only; screenshot
sidecars do not invent a renderer snapshot from stale `renderer.info` fields.
