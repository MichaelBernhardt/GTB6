# Adding a feature

A **feature** is a self-contained slice of gameplay (golf, petrol, protests, interiors, the street
economy) that costs boot nothing until the player walks into it. Adding one is **a directory plus one
line in an array**. You do not touch `Game.ts`, `types.ts`, `SaveManager.ts`, `UIManager.ts`,
`MenuView.ts`, `HudView.ts`, `Console.ts` or `styles.css`.

## The five-minute version

1. `src/features/golf/golf.ts` — the body. Export `createFeature(api, state)`.
2. One entry in the `FEATURES` array in `src/features/registry.ts`.
3. `npm test && npm run build`. Done.

```ts
// src/features/golf/golf.ts  — lazily loaded; nothing here runs until the player asks for it
import type { FeatureGameApi, FeatureSystem, InteractionDescriptor } from '../types';
import type { GolfState } from '../golf.state'; // import TYPE only — see "Bundle rules"

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
  const saved = state as GolfState | undefined;
  const group = new THREE.Group();
  api.scene.add(group);
  let strokes = saved?.strokes ?? 0;

  const rungs: InteractionDescriptor[] = [{
    id: 'golf:tee', order: 50, context: 'foot',
    test: (ctx) => nearTee(ctx.position) ? { prompt: 'E  Tee off', act: () => tee() } : undefined,
  }];

  return {
    update: (dt) => { /* per sim step; never called while the player is online */ },
    hud: () => [{ id: 'golf:card', label: 'GOLF', value: `+${strokes}` }],
    interactions: () => rungs,
    serialize: () => ({ strokes }),
    restore: (next) => { strokes = (next as GolfState | undefined)?.strokes ?? 0; },
    menu: (actionId) => { /* a row on api.showMenu(...) was clicked */ },
    command: (args) => [`golf: ${args.join(' ')}`],   // `feature golf …` in the console
    qa: (action) => runTheMachinePlaythrough(action), // window.__qa.feature('golf', action)
    dispose: () => { api.scene.remove(group); /* …and every collider, fixture ped and timer */ },
  };
}
```

```ts
// src/features/registry.ts — the ONE eager line
{ id: 'golf', saveKey: 'golf', label: 'Golf', sanitize: sanitizeGolfState, load: () => import('./golf/golf'),
  approach: { context: 'foot', order: 50, prompt: 'E  Enter the pro shop', near: (ctx) => nearClubhouse(ctx.position) } }
```

## What you get for free

| You want | You do |
| --- | --- |
| A key + a HUD prompt + a mobile touch pill | one `InteractionDescriptor` (or the eager `approach`) |
| A menu screen | `api.showMenu({ featureId, eyebrow, title, rows })`, rows come back to `menu(actionId)` |
| A HUD chip / gauge | return `FeatureHudEntry[]` from `hud()` |
| Save state | return it from `serialize()`; it arrives back as the `state` argument |
| Money | `api.balance()`, `api.earn(n)`, `api.spend(n)` (returns false when short) |
| An NPC standing a spot | `api.spawnFixture(x, z, name)` |
| A debug command | `feature <id> …` in the console → your `command(args)` |
| A machine playthrough | `window.__qa.feature('<id>', action)` → your `qa(action, args)` |
| Analytics | `api.analytics('round_banked', { value: 3 })` — your id is bound in for you |

The full surface is `FeatureGameApi` in `src/features/types.ts`. It is flat and **all-callable on
purpose**: every volatile value is a method (`api.playerPosition()`, `api.balance()`), so you cannot
accidentally cache a stale one.

## Bundle rules — these are enforced by CI, not by review

`tools/check-bundle.mjs` enforces a hard **500,000 B per executable chunk**. The `simulation` chunk is
the tight one, and `vite.config.ts` sweeps *everything* under `/src/world/`, `/src/systems/`,
`/src/story/` and `/src/entities/` into it. **A manual-chunk assignment beats a dynamic import**, so a
feature written in `src/systems/` is loaded at boot no matter how you import it. That is the entire
reason `src/features/` exists.

1. **Name the entry after the feature.** `src/features/golf/golf.ts`, not `index.ts` — the chunk is
   named after the file, and `index-<hash>.js` is unmatchable. `check-bundle.mjs` fails the build if a
   feature directory emits no `<id>-<hash>.js` chunk.
2. **Never import `src/features/<id>/` statically from anywhere.** The only reference is `load()` in
   `registry.ts`. `check-bundle.mjs` fails the build if a feature chunk appears in `index.html`'s
   preload set.
3. **Never add a `manualChunk` rule for `src/features/<id>/`.** Unassigned is the goal.
4. **Eager code goes in a top-level file.** `src/features/<id>.state.ts` (one path segment under
   `src/features/`) is swept into the `gameplay-rules` chunk, which has hundreds of kB spare. Put your
   defaults and `sanitize` there and import it from the body with `import type` only. A state module
   *inside* `src/features/<id>/` that is imported by BOTH `registry.ts` and the lazy body becomes its
   own extra eager chunk — the exact trap the bundling review found.
5. **Nothing optional in `prepareAssets()` or `City.buildStages()`.** Build your geometry on first
   entry and dispose it on exit.

Boot cost of a lazy feature is the ~280 B loader stub. That is the whole point.

## Rules that will bite you

- **Never set `ped.contact` on a feature NPC.** It makes the ped invulnerable AND
  `Game.updateContactPresence` sets `visible = false` every 1.5 s for any contact ped that is not a
  live mission giver. Use `api.spawnFixture()`, which sets `scripted` — the flag that excludes a ped
  from the ambient census, from despawn recycling and from taxi hailing, and nothing else.
- **`dispose()` must be complete and idempotent.** It is called on a new game, on a checkpoint reload
  and on a stale lazy arrival. Colliders you pushed survive a scene removal as invisible walls; a
  fixture ped you forgot leaks its mesh. Keep your own roster and `api.removeFixture()` each one.
- **Return `undefined` from `test()` when there is nothing to do.** In the `vehicle` context your rung
  sits *above* `E  Exit vehicle`, so a rung that always offers something traps the player in the car.
- **`test()` and `approach.near()` must be PURE.** `resolveInteraction` returns on the FIRST rung that
  offers something, so anything you do as a side effect inside a predicate stops the moment another
  feature ordered above you offers first — and the ladder is a merged array, so "above you" is a
  property of a build you cannot see from your branch. Protest ticked its grievance clock in
  `approach.near()`; on its own branch it ran, and the cross-feature verifier measured 3.90
  outage-hours in the open street against **0.00** on a shop doorstep. It was that feature's only
  unlock gate. If you need a per-frame hook before your body loads, find a real one (protest uses
  `powerGrid.onPowerChange`) or ask for a seam — do not hide it in a predicate.
- **Prompts must read `KEY<two spaces>Label`**, segments joined by ` · ` — that grammar is what
  `parsePromptActions` turns into the mobile context pill, and `interactions.test.ts` asserts every
  registered approach prompt produces one.
- **Features are suspended while the player is online.** No ticks, no prompts, no loading. Do not try
  to work around it: protest crowds and street fixtures must never appear in someone else's PvP.
- **Do not touch anything derived into `public/baked/`** — `src/world/placements.ts`,
  `src/world/data/manicured.ts`, `tools/mapgen/`. Derive your sites from map data at runtime; never
  type absolute world coordinates, which the map rework invalidates.
- **`serialize()` is merged per key.** Returning `undefined` leaves the stored slice alone; returning
  a value replaces only your key. Other features' slices are never at risk.

## Where the seams live

| Seam | File |
| --- | --- |
| The registry (the one eager module) | `src/features/registry.ts` |
| The host: loading, generations, save merge, suspension | `src/features/host.ts` |
| The ordered interaction ladder | `src/features/interactions.ts` |
| The save sanitizer | `src/features/save.ts` |
| The contract | `src/features/types.ts` |
| Game's four interaction branches | `Game.updateOnFoot`, `Game.updateDriving`, `Game.renderHUD` (×2) |
| The lazy-chunk gate | `tools/check-bundle.mjs` |
| The machine-playthrough hook | `tools/qa/harness.js` → `window.__qa.feature(id, action)` |
