# Adding a feature

A **feature** is a self-contained slice of gameplay (golf, petrol, protests, interiors, the street
economy) that costs boot nothing until the player walks into it. Adding one is **a directory plus one
line in an array**. You do not touch `Game.ts`, `types.ts`, `SaveManager.ts`, `UIManager.ts`,
`MenuView.ts`, `HudView.ts`, `Console.ts` or `styles.css`.

The one thing lazy loading cannot give you is anything the player is entitled to see or feel *before*
they have found the feature — see "The eager slice" below, and read it as a warning, not a menu.

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

## The eager slice — you probably do not want one

`approach.near` is a **pure predicate**. It runs from the render loop, it is skipped the moment a
lower rung answers first, and it exists only to draw a prompt. Anything that advances state or has to
be on screen unconditionally does **not** belong in it.

For the rare feature that must be true *before* the player opts in, a registry entry may declare an
`eager` slice — a per-**sim**-step tick and/or a HUD chip that both stop the instant the body loads:

```ts
eager: {
  tick: (dt, ctx) => burnFuel(dt, ctx),   // fixed sim sub-step, exactly like every other system
  hud:  (ctx) => fuelGauge(ctx),          // built by the SAME function the body's hud() calls
}
```

Petrol is the case that bought this seam, and the bug is worth remembering: the fuel gauge lived in
`hud()` on the lazy body, the body only loads when you press E at a forecourt, and so a player could
drive for an entire session and never see a gauge at all. The owner did, and reported exactly that.
The burn had the mirror-image problem — it was smuggled into `approach.near`, off a wall clock, once
per *rendered* frame, which made it measurably frame-rate coupled (0.0059 L/s on a slow box against a
design rate of 0.0825).

Rules: keep both hooks in the eager `<id>.state.ts` (whatever they touch is boot payload for every
player, forever), build the chips with the same function the body uses so the strip cannot change
shape at the moment the chunk lands, and add no scene objects — the eager half has no `dispose()`.

## Telling the player where the feature IS

Same trap, one rung further out, and petrol walked into it twice. With the gauge fixed the owner
drove another session and reported *"fuel level now, but I can't find a station"* — because nothing
on the map said where petrol was, and an icon that only appears once the body loads is an icon for a
place you have already found.

Map and minimap blips therefore come out of `src/features/mapIcons.ts`, which is eager
(`gameplay-rules`) and reads only from `<id>.state.ts`. `UIManager.drawMap` / `updateMap` merge them
into the marker list on their way to both surfaces, in the same visual language as
`ShopSystem.mapIcons()`. Two rules: derive the positions from map data at runtime (never a typed
table), and **never** import a feature body from there.

There is a second, later blip path for things that only exist once the body is up — a staffed corner,
a standing barricade. Implement `mapIcons(): FeatureMapIcon[]` on the object `createFeature` returns
(the hook is structural, declared in `host.ts`; a feature that wants no blips changes nothing) and
`FeatureHost.mapIcons()` collects it into `Game.mapMarkers()` beside `this.shops.mapIcons()`. Pick by
what the blip is FOR: a fixed place the player must be able to find before the chunk exists is eager
and belongs in `mapIcons.ts`; a live thing the loaded feature owns and moves belongs on the system.

Walking into `approach.near`'s ring also LOADS the body — `FeatureHost.preloadNearby()` re-tests every
unloaded feature's predicate every 0.4 s and opens each one whose ring the player is standing in, so a
feature that puts people or scenery in the world is already populated by the time the player can see
it. The prompt is then a fallback that only rejoins the ladder if the fetch itself failed. Two
consequences: size the ring for "close enough that loading is worth it", not for "close enough to
press E", and keep `near()` cheap and pure — it now runs whether or not any rung ever draws.

And the world has to hold up its end. If a feature's location is a place — a forecourt, a shopfront —
that place must be built by the **world**, not by the feature body: the fuel feature used to raise
the dam-shore garage itself, which made it a garage nobody could ever reach, because the body only
loads once the player is standing on a forecourt the eager list already knows about. It is a
scattered model now (`ModelScatter.landmarkForecourtPass`), so the city builds it whether the feature
ever loads or not, and the eager list gets it for free.

## What you get for free

| You want | You do |
| --- | --- |
| A key + a HUD prompt + a mobile touch pill | one `InteractionDescriptor` (or the eager `approach`) |
| A readout the player sees before they find the feature | `eager: { hud }` in the registry entry |
| A mechanic that runs before the player opts in | `eager: { tick }` — per sim step, never per frame |
| A map + minimap blip the player can navigate to | one line in `src/features/mapIcons.ts` (eager), or `mapIcons()` on the loaded system |
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
- **A feature owns exactly ONE key, and that is a design constraint, not a detail.** `E` is the whole
  input vocabulary: there is no second binding, no `api.onKey`, and the mobile pills are built from
  the prompt string by `parsePromptActions`, so a key the host does not handle is a pill that does
  nothing. If your feature has a mode a player can get *stuck in*, the way out cannot be a second key
  — it has to be a state your rung can see. Golf shipped a round in which every rung was the swing,
  so `E` could only ever be the next click of a swing, and the first playtest reported "no way to
  quit"; the fix was a rung that watches `api.playerPosition()` and turns `E` into the way out the
  moment you step off your ball. **Missing seams, if anyone is extending the foundation:** a second
  key on `InteractionDescriptor`, an `api.openMenu()` a feature can raise on its own, and
  `api.placePlayer(x, z, heading)` — position without facing means a feature can move you somewhere
  and leave the camera pointed at nothing.
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
- **A lazy feature cannot put anything in the world until its body loads.** If your feature is meant
  to be *seen* — a lit doorway, a marker, a fixture — waiting for a key press is a catch-22: nothing
  is visible until somebody presses a key at an invisible ring, and nobody presses a key at an
  invisible ring. `FeatureHost.preloadNearby()` is the answer for both shapes of feature, polled
  every 0.4 s while the body is unloaded:
  - Normally it is just **`approach.near`** — the same predicate that offers your prompt. Street does
    this: walk within `STREET_LOAD_RADIUS` of a corner and the body arrives already staffed, and the
    press that used to be mandatory is now only a fallback for a failed fetch.
  - If your prompt belongs to something **only the loaded body can find**, `near` has nothing to
    test. Declare **`preload(x, z)`** on the approach instead: a coarse, cheap "there is work for me
    around here" test taken from the player's position, which loads the body while offering nothing
    and stealing no press. Interiors does this — its rung belongs to real front doors and an eager
    chunk cannot reach `CityGen` to know where one is — so its `near` is constant `false` and its
    `preload` asks "is there a street within ~110 u". `preload` wins over `near` when both exist.
  Either way the host never auto-retries a failed fetch, and the eager stand-in is kept off the
  ladder while the chunk is in flight so it cannot sit above `E  Enter vehicle` for a block.
  `preload` is deliberately **not on `FeatureApproach`**: one feature needs it, the host duck-types
  it, and `registry.ts` casts. Fold it into the type when a second feature wants it.
- **The camera boom is 9.5 units and you cannot shorten it.** `Game.updateCamera` special-cases the
  plane, the train and a skydive; a feature cannot add a case, and `CameraController` only shortens
  the boom against `City.colliders`, which a feature cannot register. So anything that encloses the
  player has to be built for a camera that will end up outside it: interiors use an inside-out
  (`THREE.BackSide`) shell so the worst case is a cutaway rather than an opaque wall in front of the
  lens, keep every room wider than a boom, and hide interior partitions that fall between the player
  and where the camera is. **If you need the boom itself, say so** — that is a `Game.ts` change.
- **Moving the player far is a trap, not a shortcut.** A teleport re-streams `updateBuildingChunks`,
  and every player-position-keyed system (police/wanted, the `LifecycleSystem` census and its
  `REFRESH_RADIUS` recycling, mission distances, `city.updateVisibility`) sees the player leave the
  city. Interiors avoid it entirely by building over the player's own building — same x, same z,
  above the roof, where `City.clampMoveAt`'s y-aware collider test finds nothing to freeze them on.
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
| The eager slice (pre-load tick + HUD) | `FeatureEagerSlice` in `src/features/types.ts`, run by `FeatureHost.update`/`hud` |
| The eager map + minimap blips | `src/features/mapIcons.ts`, merged by `UIManager.drawMap`/`updateMap` |
| The proximity ring (`approach.near`, or `approach.preload`) | `FeatureHost.preloadNearby` |
| The ordered interaction ladder | `src/features/interactions.ts` |
| The save sanitizer | `src/features/save.ts` |
| The contract | `src/features/types.ts` |
| Game's four interaction branches | `Game.updateOnFoot`, `Game.updateDriving`, `Game.renderHUD` (×2) |
| The lazy-chunk gate | `tools/check-bundle.mjs` |
| The machine-playthrough hook | `tools/qa/harness.js` → `window.__qa.feature(id, action)` |
