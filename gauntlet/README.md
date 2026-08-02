# Groot Theft Bakkie Gauntlet Loop

This is a repo-specific version of Matt Shumer's Gauntlet Loop: a lead agent splits an ambitious
goal into independently judgeable pieces, assigns each piece to a builder, and sends the real result
to a separate critic with fresh context. A failed comparison returns the largest observable gap to
the builder, and the cycle continues until the work reaches the bar or a human stops the run.

The important distinction is evidence. Tests, screenshots, recordings, and measurements are judged;
the builder's explanation is not.

## Quality bar

The loop uses two complementary references:

- [Grand Theft Auto V Enhanced](https://www.rockstargames.com/gta-v) and
  [Rockstar's high-resolution PC frames](https://www.rockstargames.com/newswire/article/1748koo9o829a9/screens-from-grand-theft-auto-v-for-pc)
  set the aspirational bar for third-person open-world readability, motion, responsiveness, world
  density, effects, and finish.
- The [City of Johannesburg photo gallery](https://joburg.org.za/play_/Pages/Play%20in%20Joburg/Tourism%20Advice/Links/Photo-Gallery.aspx)
  and [Visit Joburg overview](https://visit.joburg/about-joburg/) set the bar for a place that reads
  unmistakably as Johannesburg rather than a generic American crime-game city.

References are for comparison, not copying. The game's original names, world, code, characters,
missions, dialogue, UI, music, and assets remain an invariant, as do the attribution rules in
`ATTRIBUTIONS.md`.

## Run it

1. Start from a clean branch in an agentic coding harness that can run the game, use a browser,
   inspect images, and create genuinely fresh-context subagents.
2. Paste the contents of [PROMPT.md](PROMPT.md), or tell the agent to run that prompt verbatim.
3. Keep [WORKBENCH.md](WORKBENCH.md) open for progress. Large local screenshots and recordings go in
   `gauntlet/evidence/`, which is intentionally ignored by Git.
4. Stop the run when the result, compute cost, or scope is satisfactory. Review the complete diff and
   the final evidence before committing, pushing, or deploying.

The reproducible native-rAF profile, real-input screenshot routes, sidecar schema, and three-run
regeneration gate are documented in [EVIDENCE.md](EVIDENCE.md).

The loop may run for many hours and consume substantial model usage. It is deliberately authorized to
edit this repository, but the prompt does not authorize pushes, deployments, purchases, or destructive
operations.

## Sources

- [Matt Shumer, “How to Run a Gauntlet Loop”](https://somethingbig.ai/gauntlet-loop)
- [The original Claude of Duty prompt](https://github.com/mshumer/Claude-of-Duty/blob/main/prompt.md)
- [Claude of Duty repository and process notes](https://github.com/mshumer/Claude-of-Duty)
