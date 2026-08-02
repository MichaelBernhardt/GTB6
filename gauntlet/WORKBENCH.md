# Gauntlet Workbench

Live status for the Groot Theft Bakkie Gauntlet Loop. The lead agent updates this document while a
run is active; builders and critics do not rewrite their own verdicts.

## Run

- Status: **stopped by human — PR handoff**
- Baseline commit: `48a0d88e86e9878ed00ce977674dc5fab7c77e66`
- Branch: `main` (`0` ahead / `0` behind `origin/main` at launch; Gauntlet changes uncommitted)
- Started: `2026-08-02T11:58+02:00`
- Reference machine/browser: Apple M3 MacBook Air, 16 GB, macOS 26.5.2; Chrome 150.0.7871.187; 1920×1080, DPR 1, high quality
- Current wave: `1 closed after independent critique`
- Current focus: `integration gates and reviewable PR`

## Baseline receipts

| Evidence | Result | Artifact |
| --- | --- | --- |
| Production build | PASS · 217 modules, 31 acyclic chunks, 12.01 s | Baseline gate transcript reported by `baseline_gates` critic |
| Tests | PASS · 197 files / 2,609 tests; one opt-in heavy test skipped, 57.20 s | Baseline gate transcript reported by `baseline_gates` critic |
| Lint | PASS · 5.46 s | Baseline gate transcript reported by `baseline_gates` critic |
| Character/NPC/foliage/vehicle validation | PASS · all four validators | Baseline gate transcript reported by `baseline_gates` critic |
| Representative shot set | PARTIAL · 1080p on-foot day/night, driving and wanted-state frames | `gauntlet/evidence/baseline/spawn-day-clean.png`, `spawn-night.png`, `driving-day.png`, `wanted-day.png` |
| Scripted on-foot/driving/combat route | PARTIAL · deterministic state capture exists; real-input traversal and combat recording still required | `tools/qa/gauntlet-browser.mjs` |
| Frame time p50 / p95 / p99 / worst | **INVALID AS A GATE** · 50.5 / 108.2 / 116.3 / 136.9 ms came from timer-pumped DEV evidence in a changing scene | `gauntlet/evidence/baseline/profile-fixed.json`; harness critic round 1 |

## Reference board

Record the exact comparison frame or footage URL, timestamp, scenario, and relevant dimension before
judging a workstream. Include real Johannesburg references for place-specific work. Do not silently
change a reference after seeing our result.

| ID | Scenario and dimension | Reference | Local counterpart |
| --- | --- | --- | --- |
| `R1` | Daylight third-person CBD free roam · composition, material response, street density | [Rockstar GTAV PC high-resolution frames](https://www.rockstargames.com/newswire/article/1748koo9o829a9/screens-from-grand-theft-auto-v-for-pc) | `gauntlet/evidence/baseline/spawn-day.png` |
| `R2` | Night CBD free roam · exposure, practical lighting, readable depth | [GTAV Enhanced visual feature bar](https://www.rockstargames.com/gta-v) | `gauntlet/evidence/baseline/spawn-night.png` |
| `R3` | Johannesburg specificity · streetscape, urban forest, public art and lived detail | [City of Johannesburg photo gallery](https://joburg.org.za/play_/Pages/Play%20in%20Joburg/Tourism%20Advice/Links/Photo-Gallery.aspx) | Day/night local shot set plus upcoming district captures |

## Workstreams

One row represents the latest independent verdict. Link actual before/after evidence and preserve
prior rounds in the decision log.

| Workstream | Builder | Fresh critic | Round | Verdict | Largest remaining gap | Evidence | Next action |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| Evidence harness | `harness_builder_r2` | `harness_critic_r2` | 2 | **FAIL — R3 BUILDING** | Full 28-ped/15-car runs never reach quiescence: all three profiles abort on object/mesh drift; empty failed phases incorrectly report raw-sample completeness | `gauntlet/evidence/round2-critic/`; critic transcript | One shared profile/capture quiescence state machine; reject vacuous/tampered evidence; repeat three full native-rAF runs |
| CBD spawn hero corridor | `cbd_corridor_builder_r1` | `cbd_corridor_critic_r1` | 1 | **FAIL — R2 BUILDING** | A flat west-kerb plane consumes ~43% of the fixed view and becomes a night void; authored actors/vehicles/Jozi cues remain hidden or generic | `gauntlet/evidence/cbd-corridor-r1/`; critic transcript | Rebuild only the first 60–80 m as a surface-correct market/taxi-rank frontage, then recapture identical day/night evidence |
| Detail-instance render bounds | Not assigned | `render_cost_critic` baseline | 0 | **READY AFTER CORRIDOR/HARNESS** | Detail instances are batched in 976-unit cells; one intersecting camera/shadow frustum submits every instance in the cell, accounting for ~3.94M submitted tris | One-frame draw-hook census: 7.88M total, 3.94M detail; 759-lamp batch = 446k beauty + shadow | Sweep 488/244/122-unit child batches under unchanged parent cells; require instance/checksum/pixel equivalence and net native-rAF improvement |
| First-drive embodiment | Not assigned | `gameplay_critic` baseline | 0 | **BLOCKED ON CADENCE GATE** | Scalar speed/direct heading has little grip, slip, weight transfer, or recovery feel | `driving-day.png`; `src/entities/Vehicle.ts`; gameplay critic report | After honest cadence baseline, run one fixed 45–60 s Couch Run Citi Golf route through builder/critic loops |

## Invariants and wave gates

- Original Jozi setting and authored identity preserved; licenses and `ATTRIBUTIONS.md` remain valid.
- The critic inspected the actual artifact, not a builder-authored summary.
- No builder acted as its own critic; blind labels were used where feasible.
- Focused tests passed; assertions and coverage were not weakened to manufacture a pass.
- `npm run lint`, `npm test`, and `npm run build` pass at every completed wave.
- Affected asset validators pass.
- No baseline regression in performance, controls, accessibility, saves, or multiplayer.
- Integration critic played the combined result after parallel work landed.

## Decision log

Append brief, falsifiable entries. Never erase failed rounds; they prevent the loop from repeating an
approach that already lost.

| Time | Workstream / round | Evidence-backed verdict | Change or next experiment |
| --- | --- | --- | --- |
| `2026-08-02T12:06+02:00` | Engineering baseline | PASS: lint, 2,609 tests, production build, and four asset validators green | Preserve as Wave 0 functional gate |
| `2026-08-02T12:16+02:00` | Evidence harness / 1 | FAIL: scene census changes between phases; `fastraf` changes the clock; artifacts lack provenance | Send the exact seven-point failure back to a dedicated harness builder |
| `2026-08-02T12:20+02:00` | Gameplay baseline | Largest gap is physical embodiment; first bounded slice is Couch Run's Citi Golf | Do not build until reproducible frame cadence can gate the result |
| `2026-08-02T12:22+02:00` | Visual baseline | FAIL: biggest surface-area gap is the default CBD corridor in both day and night | Assign one bounded deterministic, performance-aware corridor pass; preserve full baseline shot set |
| `2026-08-02T12:28+02:00` | Render-cost baseline | ~50% of submitted triangles are detail instances drawn from coarse 976-unit batches | Queue a pixel-preserving fine-child-batch sweep after overlapping corridor files and corrected cadence harness land |
| `2026-08-02T13:08+02:00` | CBD hero corridor / 1 | FAIL: richer than baseline, but only preference passes; foreground slab/void dominates, visible counts and non-text Jozi identity miss | Return the single first-60–80 m frontage task to the same builder for R2 |
| `2026-08-02T13:10+02:00` | Evidence harness / 2 | FAIL: three canonical native-rAF profiles abort on census drift; capture setup is flaky and zero-phase completeness is vacuous | Build shared full-density quiescence plus strict failure/tamper validation for R3 |
| `2026-08-02T13:10+02:00` | Wave 1 integration build | PASS: 218 modules, 31 acyclic chunks; simulation 495.36 kB remains below the 500 kB cap | Preserve while R2/R3 builders work; defer CPU-heavy full suite until profiling is idle |
| `2026-08-02T13:16+02:00` | Run control | Human stopped the open-ended loop and requested a PR | Preserve the independently failed verdicts; run integration gates and hand off without unverified R2/R3 edits |
| `2026-08-02T13:19+02:00` | PR integration gates | PASS: lint; 200 test files / 2,620 tests with one expected opt-in skip; production build and bundle budgets; character, NPC, foliage, and vehicle validators | Create the review branch and PR with remaining visual/cadence failures disclosed |

## Final assessment

The human stopped the run after Wave 1 and requested a reviewable PR. The branch adds the reusable
Gauntlet prompt/workbench/evidence contract and a first bounded CBD hero-corridor pass. The production
build remained within all chunk budgets after that pass, and the focused corridor, day/night, harness,
lint, and type-check receipts reported above passed before handoff. The final PR tree also passed the
complete lint suite, 200 test files / 2,620 tests (one expected opt-in skip), production build, bundle
budgets, and all four asset validators.

The R1 corridor is clearly preferable to its before frame for visible activity and localized night
light, but the fresh critic still rejects it against the stated target: the untextured far-ground mesh
dominates roughly 43% of the fixed view, activity and vehicle identities are not legible enough, and
non-text Johannesburg identity remains weak. The R2 evidence harness is substantially more truthful
than the original timer-pumped script—native rAF, exact setup, sidecars, raw samples, and real-input
receipts are implemented—but it also correctly exposes that the full-density scene is not quiescent.
All three canonical profiles aborted, so this run establishes **no accepted cadence baseline**.

Deferred largest gaps are: fix the near-camera far-ground surface and stage the first 60–80 m of the
taxi-rank frontage; make full-density profiling/capture wait for deterministic actor/visual quiescence
and reject vacuous failed evidence; then rerun the queued detail-instance batching and first-drive
embodiment loops. No render optimization or vehicle-handling change was included in this stopped run.
