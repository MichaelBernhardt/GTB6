# Runnable prompt

Paste the block below into Codex or another agentic coding harness from the repository root.

```text
Run a Gauntlet Loop to turn the existing Groot Theft Bakkie repository into the most convincing,
cohesive, commercially polished browser-native open-world action game set unmistakably in
Johannesburg. Preserve its original Jozi identity, humour, map, characters, missions, and web-first
accessibility; improve the real game rather than replacing it with a disconnected demo.

Use like-for-like GTA V Enhanced free-roam screenshots and gameplay footage as the aspirational bar
for third-person presentation, movement and driving feel, animation, world density, lighting,
materials, effects, audio-visual feedback, UI readability, and moment-to-moment finish. Use real
Johannesburg street and neighbourhood imagery as a second bar: ours must read more specifically as
Jozi. References are comparison targets only. Do not copy protected assets, code, layouts, names,
characters, dialogue, logos, UI, music, or other expression; keep everything original or properly
licensed under this repository's attribution rules.

First inspect the repository, run and play the current build, record the baseline commit, tests,
performance, and a reproducible set of representative 1920x1080 frames and short interaction
captures. If the general capture/playtest/profile harness needed for honest comparisons is missing,
build it. Maintain gauntlet/WORKBENCH.md and put large local evidence in gauntlet/evidence/ so I can
watch the work without interrupting you.

Act as the lead agent and choose the smallest important pieces that can be improved and judged
independently. For every piece, fan out a specialist builder and a separate ruthless critic with
fresh context. Never let a builder grade its own work. Give the critic the goal, relevant quality
bar, invariants, and actual artifact, but none of the builder's reasoning. The critic must inspect
the running game, real pixels, interaction recording, tests, or measurements as appropriate and use
a blind A/B comparison when possible. If ours loses, it must identify the single largest observable
gap and return that gap to the builder. Build, judge, and repeat without an arbitrary round limit
until ours wins the relevant comparison or I stop the run.

After each major wave, use a fresh integration critic to play the complete game and smooth conflicts
between individually improved pieces. Do not accept screenshots that hide regressions, static beauty
that harms play, summaries in place of artifacts, flaky tests, weakened assertions, or quality gains
that merely move a defect elsewhere.

Every accepted round must preserve or improve the baseline functional and performance evidence.
Run relevant focused tests during construction and, at each wave boundary, run npm run lint, npm test,
npm run build, and all affected character, NPC, foliage, and vehicle validators. On the same reference
machine and scripted route, target 60 fps at 1080p after warm-up, p95 frame time no worse than 20 ms,
p99 no worse than 33 ms, no avoidable hitch over 50 ms, and no regression from the recorded baseline.
Keep keyboard/mouse, controller, and touch flows working. Treat a test, performance, accessibility,
save-compatibility, multiplayer, or originality regression as an automatic critic failure.

Keep going while meaningful gaps remain. Pause only for a genuine external blocker, a decision that
would expand authority, or my stop instruction. Do not push, deploy, spend money, or perform destructive
operations. Leave a reviewable working tree, reproducible receipts, and an honest final assessment of
what still loses against the bar.
```
