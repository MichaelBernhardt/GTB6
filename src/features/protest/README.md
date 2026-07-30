# Protests + burning tyres

A service-delivery blockade: a small crowd, a junk barricade with burning tyres laid across a lane,
placards on scrap cardboard, and a black plume you can read from the highway. Caused by the load
shedding the player has personally stood in; it leaves stains on the tar that nobody comes to fix.

The target of the joke is the municipality — state capacity that is available instantly for a camera
crew and never for a plumber. The residents have a real grievance and the player is on their side.

## The whole loop, and there is no menu item in it

There is **no prompt for starting a protest**. You do not press a key to make one exist; one happens,
and you either walk over or you don't. Four beats, about four minutes:

| beat | what he sees |
| --- | --- |
| the lights go out and he stays out in it | a `FED UP` chip appears on the HUD and starts filling. It advances only while the power is off, so the cause is stated without a word of text |
| ~62% of the way | one notification: **"Brixton has had enough"** — fourth week without water, the lights just went again, somebody is talking about closing the road |
| the grievance ripens | a road **85-260 m away** shuts itself. One notification with the district, the distance and the compass bearing; an orange diamond on the map and the minimap; a `PICKET  140 m` chip counting down the walk; and a black plume built with `fog: false` so it is legible from much further than that |
| he walks up to it | `E  Join the picket · keep the smoke up` → `E  Throw a tyre on the fire` → the councillor arrives, he gets paid, and somebody rolls him a spare tyre |

Then, with a tyre in hand: `E  Roll out a tyre and light it` on any road, which shuts that road until it
burns down and leaves a mark that never comes off.

### Why there is no "Follow the smoke"

That prompt shipped, and it was three faults in one line. The owner's report:

> I'm a bit confused by the "Follow the smoke" thing in protests. I don't quite understand the game
> logic. It just seems to spawn a protest where I am or something? More recently, it was saying to
> press E but didn't do anything, and since it was also blocking E it prevented entering vehicles.

- **It ate the E key.** The rung had no proximity test at all — `!barricade && ripe` — so for as long as
  the grievance stayed ripe it offered *from anywhere in the city*, and `Game.updateOnFoot` runs
  `if (this.features.act('foot')) return;` **above** the vehicle-entry branch. Pressing E raised a
  blockade hundreds of metres away with no blip and no bearing, which is indistinguishable from nothing
  happening — and while it was ripe he could not get into a car.
- **It spawned one under his feet.** The eager grievance credit ran off `performance.now()` in a
  `powerGrid.onPowerChange` listener, which carries no position, so `hasAnchor` was false for the whole
  eager phase and the site fell back to the road nearest the player.
- **The prompt was a navigation instruction for smoke that did not exist yet.** There was nothing to
  follow until after the press.

## Seeing one in ten seconds (the review route)

Waiting out the grid is fine when you are playing and useless when you are reviewing. So:

```
~                       open the developer console (backquote)
feature protest now     the first call loads the chunk and says so
feature protest now     the second raises it
```

That shuts the road **nearest your feet** — the one place the ordinary path will never choose — puts
two tyres in your hands, and prints a `tp x z` line to get back to it.

`feature protest ripen` fills the grievance ledger and anchors it where you are standing, then leaves
the ordinary path to raise the protest on its own, at proper distance, so you can review the thing the
player actually experiences.

Every other console verb:

```
feature protest status | where | ripen | raise | clear | tyres <n> | feed | burn | scorch
```

The machine playthrough reaches the same verbs as `window.__qa.feature('protest', '<action>')`, plus
three that exist because of the E-swallowing bug: `offer` (what does the ladder offer right now),
`press` (take whatever it offers, press it, and **fail** if the status line did not move), and `fedup`.

## Four things that are load-bearing

**A rung that offers is a rung that acts.** `FeatureHost.act()` returns true the instant any rung
offers, and `InteractionOffer.act()` has no way to say "I could not". So a verb that offers and then
declines does not fizzle — it *steals the keypress*, and on foot it steals it from `E  Enter vehicle`.
Every rung here therefore resolves its subject in `test()` and hands it to a verb with **no refusal
path**: `feedNow(fire)`, `burnNow(spot)`, `joinNow()`. The guard lives in the predicate, never in the
action. `protest.test.ts` walks the whole feature life pressing whatever is offered and fails on any
press that does not move the status line.

**The necklacing block.** Necklacing — a petrol-soaked tyre forced over a person's chest and arms and
lit — was a real 1980s township execution that recurs in present-day vigilantism. No tyre here may
take a person, a ragdoll, a corpse, a bone or a skinned mesh as a host, and no ignition may resolve
onto one. It is enforced as an API SHAPE, not as a rule to remember: `TyreFire` takes world
coordinates, `Barricade.addTyre()` takes **no arguments at all**, and every ignition sweep runs
through `assertNotLivingHost` / `ignitableTargets`. There is an in-engine probe (`qa('necklace')`)
that hands the whole path live pedestrians, real `THREE.Bone`s and wrapped `userData.ped` objects and
passes only if every one is refused.

**Every prop is grounded on the surface under it.** The barricade group sits at one height — the road
pose at the centre — but the junk spreads nine units either side, and the tar rolls with the terrain.
`Barricade.restingY()` asks `api.surfaceHeightAt` at each prop's own position. Skipping that is what
made the owner's first report read "tyres float in the air", and it is why the constructor takes the
height query as a **required** parameter rather than defaulting it.

**The grievance clock is not in an interaction predicate, and not on a wall clock either.** It has been
in both wrong places:

- inside the registry's `approach.near()`, which works only when protest is the only feature
  registered — `resolveInteraction` returns on the first descriptor that offers something, so any
  feature ordered above it silently froze the ledger (3.90 outage-hours measured in the open street
  against 0.00 on a doorstep), and the ledger is this feature's only unlock gate;
- then in a `powerGrid.onPowerChange` listener against `performance.now()`, which fires reliably but
  counted wall-clock seconds while the game was paused and the tab was in the background (hence the
  `MAX_OUTAGE_CREDIT_HOURS` cap that had to exist), and carried no position at all.

It now rides `eager.tick` — the registry's per-**sim**-step hook, the same one petrol burns fuel on.
`FeatureHost.update` calls it for every unloaded feature unconditionally, so no prompt can shadow it,
no frame rate can change it, and a paused game earns nothing. The loaded body calls the very same
`tickGrievance()`, and the host runs exactly one of the two at any moment, so there is no handover to
get wrong. `protest.state.test.ts` and `protest/protest.test.ts` both pin it, the second through a real
`FeatureHost` on the real five-feature registry with a greedy rung winning the ladder every frame.

## Tuning

| constant | value | why |
| --- | --- | --- |
| `RIPE_OUTAGE_HOURS` | 2.4 | one shed is worth 1.28-1.76 game hours, so this always lands on the second — about four minutes |
| `WARN_FRACTION` | 0.62 | the one warning beat, around the end of the first outage |
| `HUD_FROM_FRACTION` | 0.18 | the chip appears here, and the body is fetched here — it has to be running before the protest starts |
| `SITE_MIN_METRES` / `SITE_MAX_METRES` | 85 / 260 | far enough that it happens over there, close enough that it is a walk. Never under his feet |
| `BLOCKADE_HOURS` | 6 (≈150 s) | the walk there plus the 70-second picket. Do not shorten it below that |
| `PICKET_SECONDS` | 70 | short. Two tyres thrown on holds it comfortably |
| `SMOKE_PER_TYRE` / `SMOKE_DECAY` | 26 / 1.35 s⁻¹ | the player is never asked to sprint |
| `TYRE_CARRY_CAP` | 3 | a tyre is a thing you carry awkwardly, not ammo |
| `SCORCH_CAP` | 48 | one instanced draw call for every stain in the city, FIFO |

## The save

Only the durable things: `tyres`, `pickets`, `scorch`. **The grievance is session-scoped on purpose.**
Persisting `hours`/`anchor` is where the worst bug in this feature's history lived — the eager half
counted from zero each session, the body then received the stored slice, and a plain `load()` there
wiped the very grievance that had caused the load. It is also the less legible design: a returning
player who walks straight into a protest cannot possibly know why. Four minutes of play re-earns it,
and re-earning it in front of your own eyes is the part that makes it mean anything. Saves written by
the old build still load; the extra keys are simply not read.
