# Protests + burning tyres

A service-delivery blockade: a small crowd, a junk barricade with burning tyres laid across a lane,
placards on scrap cardboard, and a black plume you can read from the highway. Caused by the load
shedding the player has personally stood in; it leaves stains on the tar that nobody comes to fix.

The target of the joke is the municipality — state capacity that is available instantly for a camera
crew and never for a plumber. The residents have a real grievance and the player is on their side.

## Seeing one in ten seconds (the review route)

Waiting out the grid is fine when you are playing and useless when you are reviewing. So:

```
~                       open the developer console (backquote)
feature protest now     the first call loads the chunk and says so
feature protest now     the second raises it
```

That shuts the road **nearest your feet**, puts two tyres in your hands, and prints a `tp x z` line
that gets you back to it if you wander off. From there:

| you | see |
| --- | --- |
| walk into the barricade | `E  Join the picket · keep the smoke up` |
| press E | the SMOKE and HOLD chips appear; hold SMOKE up for 70 s |
| press E again, at the fire | `E  Throw a tyre on the fire` — a tyre lands on the pile and the plume flares |
| hold it out | the councillor arrives, you get paid, and somebody rolls you a spare tyre |
| stand on the remains | `E  Take a tyre · n/3 carried` |
| stand on any road with a tyre | `E  Roll out a tyre and light it` — that road shuts until it burns down |

Every other console verb:

```
feature protest status | where | ripen | raise | clear | tyres <n> | feed | burn | scorch
```

`ripen` fills the grievance ledger and anchors it where you are standing, if you would rather walk to
one yourself. The machine playthrough reaches the same verbs as
`window.__qa.feature('protest', '<action>')` — see `qa()` in `protest.ts`.

## Three things that are load-bearing

**The necklacing block.** Necklacing — a petrol-soaked tyre forced over a person's chest and arms and
lit — was a real 1980s township execution that recurs in present-day vigilantism. No tyre here may
take a person, a ragdoll, a corpse, a bone or a skinned mesh as a host, and no ignition may resolve
onto one. It is enforced as an API SHAPE, not as a rule to remember: `TyreFire` takes world
coordinates, `Barricade.addTyre()` takes **no arguments at all**, and every ignition sweep runs
through `assertNotLivingHost` / `ignitableTargets`. There is an in-engine probe
(`qa('necklace')`) that hands the whole path live pedestrians, real `THREE.Bone`s and wrapped
`userData.ped` objects and passes only if every one is refused.

**Every prop is grounded on the surface under it.** The barricade group sits at one height — the road
pose at the centre — but the junk spreads nine units either side, and the tar rolls with the terrain.
`Barricade.restingY()` asks `api.surfaceHeightAt` at each prop's own position. Skipping that is what
made the owner's first report read "tyres float in the air", and it is why the constructor takes the
height query as a **required** parameter rather than defaulting it.

**The grievance clock is not in an interaction predicate.** It ticks off `powerGrid.onPowerChange`,
which fires from `Game.applyEskom` — the same call that turns the street lights off. It used to tick
inside the registry's `approach.near()`, which works only when protest is the only feature registered:
`resolveInteraction` returns on the first descriptor that offers something, so any feature ordered
above it silently froze the ledger (3.90 outage-hours measured in the open street against 0.00 on a
doorstep). The ledger is this feature's only unlock gate, so that would have shipped a feature that
never triggers. `protest.state.test.ts` and `protest/protest.test.ts` both pin it.

## Tuning

| constant | value | why |
| --- | --- | --- |
| `RIPE_OUTAGE_HOURS` | 2.4 | one shed is worth 1.28-1.76 game hours, so this always lands on the second — about four minutes |
| `PICKET_SECONDS` | 70 | short. Two tyres thrown on holds it comfortably |
| `SMOKE_PER_TYRE` / `SMOKE_DECAY` | 26 / 1.35 s⁻¹ | the player is never asked to sprint |
| `TYRE_CARRY_CAP` | 3 | a tyre is a thing you carry awkwardly, not ammo |
| `SCORCH_CAP` | 48 | one instanced draw call for every stain in the city, FIFO |
