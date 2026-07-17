# Story & Mission Buildout — Design Doc

Branch `feat/story-missions`. Extends the existing 4-mission vertical slice into a 3-act
arc with ~15 new missions plus side content. Everything below is designed against systems
already on `main` (LoadShedding + DayNight blackout, trains, planes/skydive, taxis,
LivingCity, safehouses, shops), with a marked seam for BlackoutStealth when it lands.

## Synopsis — "Stage Six"

Joburg's blackouts aren't all Eskom's fault. A generator-and-diesel cartel — run by
Solly "the Genny King" Malaka — pays crews to strip substations and trip the grid, then
sells the city its own light back: gennies, diesel, "security". The player, a fresh
arrival grinding gigs for Auntie Portia, Bra Vusi and Candice, starts seeing the pattern
from below: Vusi's "fallen off a substation" copper is cartel salvage, Candice's rank war
is about who moves the diesel, and every blackout makes somebody rich. A night-shift
substation engineer, Sindi Mokoena, catches a sabotage crew red-handed and starts feeding
the player evidence. Act 2 has the player working both sides until they must pick one:
Sindi and the lights, or the Genny King and the money. Act 3 converges on Kelvin Yard,
the cartel's fortified depot, where the ledger that proves everything is kept — behind
floodlights that only ever go out when the grid does. Finale: the cartel tries to blow
the CBD substation for one last, permanent Stage Six; the player stops it (or inherits
the ashes, per branch).

Backstory rides collectibles: 12 "Grid Diary" pages (a fired Eskom planner's notes)
scattered at landmarks, each one paragraph of lore; finding all 12 unlocks a side payoff.

## Contact roster (voices)

| Contact | Voice | Role |
|---|---|---|
| Auntie Portia | warm, motherly hustle, "boet", "sharp sharp" | Act 1 anchor, existing |
| Bra Vusi | chancer, "yoh", "vrrr phaa" | Act 1, unknowing cartel supplier |
| Candice from Boksburg | brassy rank politics | Act 1–2, taxi/diesel angle |
| Thandi (Jozi Arms) | terse, transactional | existing; ammo/branch flavour |
| **Sindi Mokoena** (new) | precise engineer dryness, "load factor", "per spec" | whistleblower, Act 2–3 |
| **Solly "Genny King" Malaka** (new) | charming menace, money talk, "my laaitie" | antagonist/employer, Act 2–3 |
| **Skywise Sipho** (new, minor) | bush-pilot bravado | airport missions |
| **Oupa Jakes** (new, minor) | retired Park Station announcer, riddles | puzzle missions |

## Act structure & mission list

Existing 4 missions become the on-ramp (Act 0); completing any 2 raises flag `act1`.

**ACT 1 — "Hustle"** (contacts you know; seeds of the plot)
1. **Last Coach Home** (Portia) — *trains*: her nephew left her rent bag on a train.
   Deduce the right platform at Park Station from his voice-note ("the one that smells
   the sea" → coastal line), board, ride to the named station, grab the bag, ride back.
   New snapshot: `onTrain`, `stationName`.
2. **Copper Wire Blues** (Vusi) — *tail*: follow the buyer's bakkie to its yard without
   spooking it (stay within 45u, don't touch it, don't shoot). Discovers Kelvin Yard —
   establishes the flagship location early, innocently. New kind: `follow`.
3. **Rank Cold War** (Candice) — *escort*: ride shotgun in Candice's taxi; fight off two
   ambushes at rival-rank territory. Fail if the taxi dies. New kind: `survive` +
   `failIf: vehicleDestroyed`.
4. **The Reading of the Signs** (Oupa Jakes) — *puzzle*: riddle chain across the joke
   street names, **no map markers** — the objective text IS the riddle ("Stand where the
   road confesses its condition" → Pothole Street; "…where the lights never stay" →
   Loadshed Lane; "…where the city still sends paper" → Fax Street). New objective flag:
   `hidden: true` (no blip/breadcrumb). Reward + first Grid Diary page.

**ACT 2 — "The Grid"** (flag `act1` → Sindi & Genny King unlock)
5. **Night Shift** (Sindi intro) — reach the CBD substation, catch and beat off a
   sabotage crew mid-cut. Learn the blackouts are induced.
6. **Diesel Run** (Genny King intro) — hijack a parked diesel tanker (van kind, cartel
   colours) and deliver it **gently**: fail if vehicle health drops below 60%. New
   snapshot: `vehicleHealthPct`; new `failIf: vehicleHealthBelow`.
7. **Paper Round** (Sindi, *puzzle*) — her dead-drop location is encoded in a classified
   ad she reads you: "For sale: one-way ticket. Meet where the Halt serves the sky."
   → Lughawe Halt, the airport station ("lughawe" = Afrikaans for airport; the airport is
   right there on the map — solvable by exploring the rail line, no external knowledge).
   `hidden: true` reach.
8. **Stage Fright** (Genny King) — steal the Sandton showroom superbike. His brief carries
   the *teaching hint*: "When the lights die, the cameras die with them, laaitie." Attempt
   with grid up → alarm, 3-star wanted, mission continues (get away with it hot) — attempt
   in a blackout → silent. This teaches the blackout-as-opportunity grammar ONCE, with a
   hint, so the flagship can stay hintless. New snapshot: `blackout` (0..1), `isNight`.
9. **The Wrong Train** (Candice) — *drive a train*: the cartel rails diesel at night; take
   the freight consist and stop it dead at the Crown Station siding (precision stop:
   `reach` + `speedBelow` condition while `drivingTrain`).
10. **Crosswinds** (Skywise Sipho) — fly the plane from O.R. Tambourine through three sky
    checkpoints, then bail and land the chute on the Ponte Tower roof. New snapshot:
    `inPlane`, `altitude`, `parachuted`; new kind reuse: `checkpoints` (sky) + `reach`
    with `landedOnFoot` condition.
11. **Two Fires** (branch, both contacts) — Sindi has enough to go public but needs the
    sabotage crew caught in the act; the Genny King wants her charge sheet burned and her
    name smeared. `choice` objective → flags `sided-sindi` / `sided-solly`, feeds
    LivingCity (new events `grid-defended` / `grid-sold`, CBD standing ±, pressure +).
    Each side gets one exclusive follow-up mission:
    - *sided-sindi*: **Catch Them Cutting** — stake out the substation, defeat the crew,
      photograph (collect) the cutting rig.
    - *sided-solly*: **Paper Fire** — torch Sindi's evidence van before 06:00 (timed,
      wanted heat, escape).

**ACT 3 — "Stage Six"** (branch resolved → `act3`)
12. **FLAGSHIP: Dark House** — see below. Both branches need the Kelvin Yard ledger.
13. Branch tail:
    - *sided-sindi*: **Daylight** — run the ledger to Constitution Hill with cartel
      hit-cars on you the whole way (escort-self, `failIf: vehicleDestroyed`, no wanted-
      laundering allowed: JMPD also want it).
    - *sided-solly*: **Ash Ledger** — deliver the ledger to Solly, then hold Kelvin Yard
      against the rival crew he sold out (survive wave defence).
14. **The Switch** (finale, both branches) — the cartel (or its remnant) rigs the CBD
    substation to blow for a permanent blackout. Timed: reach it, defeat the wreckers,
    then `survive` 90s holding the perimeter until Sindi (or a bought JMPD unit) arrives.
    Epilogue dialogue differs by branch; LivingCity settles final standing.

**SIDE PIECES** (optional, any time after act 1)
- **Ouma se Padstal Run** — scenic long-haul delivery to the padstal over the mountain
  pass; timed generously; pure tourism reward.
- **Grid Diaries** — 12 collectible lore pages (`collect`, hidden, clued by each other);
  all 12 → cash + a "the planner knew" epilogue scrap.
- **Pier Pressure** (Candice) — a fare skipped without paying, big time: chase him down
  the coastal strip to Seepunt Pier by taxi before his boat leaves (timed pursuit).

Count: 15 scripted missions (two branch-exclusive) + 3 side pieces + collectibles = the
12–18 target with verb variety: courier, tail, escort, riddle×2, defend, gentle-drive,
train-ride, train-drive, fly+skydive, stealth-steal, stakeout, arson-timed, infiltration,
convoy, hold-out, pursuit.

## FLAGSHIP: "Dark House" (Kelvin Yard break-in)

**Setup.** Kelvin Yard: a fenced cartel depot in the southern industrial belt (placed via
`bestKerbSpot` like other sites) — floodlight masts on the fence, one gate, a records
office at the back. The mission giver says only: "Get me the black ledger out of the
records office at Kelvin Yard. Their security is… thorough. Figure it out."

**Grid up (day or night): impossible, diegetically.**
- Floodlights blaze at night; by day the yard is simply watched.
- Crossing the perimeter → floodlights snap to the player, klaxon, instant 4-star wanted,
  objective fails with only diegetic copy: *"Floodlights slam on. The whole yard saw you."*
  No mechanic named, no schedule hinted. Restart is one E-press (checkpointed).
- The gate is electrically sealed — mains-powered maglock. It won't open. Ever. (Physical
  blocker + the above detection = hard impossible, not merely hard.)

**Grid down at night (blackout ≥ threshold): possible.**
- Floodlights dead, maglock released (gate sags open a crack), two guards walk torch
  patrols with narrow cones — avoid the cones, torch OFF (your own torch inside the
  fence = detected), no gunfire. Reach office → `collect` ledger → get out past the fence.
- Mid-mission grid return: lights surge back with a *bang* — you have a 5s grace surge-
  flicker to get out of the open, then normal detection resumes. (Cruel but fair; the
  outage window is ~32–44s per LoadSheddingSystem so the run is tight by design — and the
  player can retry on the next outage or force one at a substation? No: no player control,
  the waiting IS the discovery.)

**Discovery breadcrumbs (all oblique, all optional).**
- Gate guard ambient bark (approach while casing): "Third month the genny's got no
  diesel. Eskom hiccups and this whole yard goes blind — but do they listen?"
- Newspaper scrap collectible at the fence: *"TENDER WATCH: security firm bills Kelvin
  Yard for backup diesel never delivered."*
- Stage Fright (mission 8) already taught blackout = dead cameras, with Solly's one hint.
- The failure copy mentions floodlights every time; floodlights are visibly mains-fed
  (they go dark citywide in every blackout the player has ever seen).

**Detection implementation** — mission-owned, pure module `DepotSecurity.ts`:
`assess({ playerInsideFence, blackout, isNight, torchOn, firedRecently, guardCones })` →
`'clear' | 'spotted'`. Grid-up spotting is unconditional inside the fence. Fully sim-
testable. **Seam:** when BlackoutStealth merges to main, its concealment check replaces
the cone math behind the same `assess` signature (marked `TODO(blackout-stealth)`).

## Engine extensions (EXTEND, no rewrite)

**New ObjectiveKinds** (3 only): `follow`, `survive`, plus everything else expressed via
existing kinds + two new orthogonal objective fields:
- `conditions?: ObjectiveCondition[]` — extra predicates ANDed into `done` (e.g.
  `{ onTrain: true }`, `{ speedBelow: 0.5 }`, `{ blackoutAbove: 0.7 }`, `{ undetected: true }`).
- `failIf?: FailCondition[]` — per-objective failure triggers (`vehicleHealthBelow`,
  `vehicleDestroyed` (exists ad-hoc, generalise), `detected`, `wantedAbove`, `leftRadius`).
- `hidden?: true` — no blip, no breadcrumb (riddle missions).
- `checkpoint?: true` — `restart()` resumes from the most recent checkpointed objective
  index instead of 0 (long-mission mercy; engine change ~10 lines, fully tested).

**GameSnapshot additions** (all optional, fed by thin Game.ts wiring): `hour`, `blackout`,
`isNight`, `onTrain`, `drivingTrain`, `trainSpeed`, `stationName`, `inPlane`, `altitude`,
`parachuted`, `vehicleHealthPct`, `playerSpeed`, `followDistance`, `escortAlive`,
`detected`, `district`, `torchOn`.

**MissionDefinition additions**: `prerequisites?: { missions?: string[]; flags?: string[] }`,
`setFlags?: string[]` (on complete), `giver` dialogue script id, `act` label. Contact
markers only appear when prerequisites pass.

**New modules** (Game.ts stays thin wiring):
- `src/systems/StoryDirector.ts` — story flags, unlock evaluation, per-mission scripted
  beats (hostile spawns, guard patrols, ambushes, timers), dialogue triggering,
  Grid Diary registry. Pure core + small wiring surface.
- `src/systems/DialogueSystem.ts` — pure sequential-line state machine (speaker, text,
  advance, abandon-if-player-leaves). UI: one new HUD card in HudView (existing style),
  E/click to advance, non-pausing.
- `src/systems/DepotSecurity.ts` — flagship detection (above).
- `src/world/placements.ts` — new anchors via the existing `walkSpot`/`bestKerbSpot`
  helpers (Kelvin Yard, substation, dead-drops, diary pages, contact spots). No hand
  coordinates.

**Save schema v3**: `version: 3`, add `storyFlags: string[]` (sanitized to known-flag
whitelist), `diaryPages: number[]`. Follow the existing deserialize spread + per-field
sanitizer pattern; accept versions 1|2|3; migration test v2→v3.

**LivingCity**: two new CityEvents `grid-defended` / `grid-sold` + `gridResolution` field
mirroring the `joziArmsResolution` pattern (sanitizer + save round-trip).

## Dialogue layer sketch

`DialogueScript { id, lines: { speaker, text }[] }` — plays non-pausing above the HUD
objective card; E advances (E is already the interact key; dialogue card visible =
E routes to dialogue first); walking >12u from the contact abandons intro dialogue and
cancels the mission offer (accepting = finishing the dialogue). Mission intros convert
from single toasts to 3–6 line exchanges; mid-mission beats are 1–2 line radio-style
(reuse `notify` radio tone for those, full dialogue only face-to-face).

## Verification plan

Pure Vitest sims only (owner's rule): walkthrough sim per mission (completion path +
every failure mode), DialogueSystem tests, DepotSecurity matrix (grid-up night/day,
blackout, torch, gunfire, grace window), unlock gating, story-flag persistence + v2→v3
migration, checkpoint-restart, `follow`/`survive` kind unit tests. Gate: lint + tsc -b +
full vitest green (LifecycleSystem/AiIntentions re-run isolated if flaky under load).
