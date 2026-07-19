# City bake

`npm run bake` pre-derives the expensive deterministic boot passes and writes them to
`public/baked/` (committed, shipped with the site):

- `city-manifest.json` — counts, string tables, map-data hash, format version
- `city.bin` — packed structure-of-arrays payload (parcels, scatter, vehicle-nav edge topology)

At boot the game fetches these, validates them against its own map data and format version, and
hydrates the derivation memos directly (`src/world/bake/loader.ts`) — skipping the citywide parcel
layout, model scatter and vehicle nav-graph builds that dominate slow-device load times. Any
validation failure falls back to live derivation, so a missing or stale bake can slow a boot down
but never break one.

The generator imports the SAME modules the game boots with (`CityGen`, `ModelScatter`, the
`City` nav builders) — there is no forked derivation logic to drift.

## When to re-bake

Re-run `npm run bake` and commit the changed `public/baked/` files whenever you touch:

- the map (`npm run map:build` / `src/world/generated/joburg-map.json`)
- any derivation input or logic: `CityGen.ts`, `ModelScatter.ts`, `mapData.ts`, `placements.ts`,
  `data/zoning.ts` / `zoneGrid.ts` / `manicured.ts`, model catalog footprints/spacing/variants,
  `NavGraph.ts`, the nav/lane constants in `City.ts`, or the bake format itself

CI enforces this: `src/world/bake/bake.test.ts` live-derives everything and compares CONTENT
against the committed artifacts — a stale bake fails the suite with a "run `npm run bake`"
message. The same comparison is the determinism proof that a hydrated boot builds the identical
world (same buildings, scatter and nav topology, exact doubles).

A re-bake with unchanged inputs is byte-identical (no timestamps or randomness) and leaves git
clean.

## Format notes

See `src/world/bake/format.ts` for the layout. Bump `BAKE_FORMAT_VERSION` when changing the
packed layout or hydration contract — old artifacts are then rejected at boot (live fallback)
and by the gate test until re-baked. Nav node positions and the ped nav graph are deliberately
NOT baked: they rebuild live in ~10²ms; the artifact carries only what is expensive to derive.
