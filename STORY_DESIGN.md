# Story & Mission Buildout — Design Doc (rev 2, owner-corrected)

Branch `feat/story-missions`. Extends the existing 4-mission vertical slice into a 3-act
arc with ~15 new missions plus side content. BlackoutStealth (PR #77) is merged into this
branch; DepotSecurity routes giveaways through its shared concealment model.

**Owner steers (binding, from design review):**
- Protagonist is a BAD GUY — a criminal opportunist who joins the cartel early and does
  its dirty work from inside. Never civic virtue. The irony of the arc: the player causes
  the blackouts that later become their stealth cover.
- Flagship break-in is impossible outside load shedding and the game NEVER tells the
  player how — no instructional text anywhere. Teaching is experiential only.
- Riddle missions: every referent exists in shipped map data; the contact re-states the
  riddle on demand (E at the contact while the mission is active).

## Synopsis — "Stage Six"

Joburg's blackouts aren't all Eskom's fault. A generator-and-diesel cartel — run by Solly
"the Genny King" Malaka — trips the grid on purpose and sells the city its own light
back: gennies, diesel, "security subscriptions". The player claws up from gig work (the
existing four missions), gets noticed moving hot copper, and is recruited onto Solly's
payroll: tanker hijacks, substation sabotage, collections, arson. The player personally
throws the breakers that black out the city. Sindi Mokoena, a night-shift substation
engineer, reads the fault logs and knows the trips are manual — she's a threat, then an
asset. The branch: stay loyal and rise to take Solly's throne, or feed Sindi the evidence
and pick over the cartel's carcass for money. Both criminal, both paid. Either way the
road runs through Kelvin Yard's records office — sealed behind mains floodlights that
only ever die when the grid does — and ends at the CBD substation, where Solly's people
rig one last, permanent Stage Six.

Backstory rides 12 collectible "Grid Diary" pages: a fired Eskom planner's notes — the
man who first sold Solly the idea. All 12 unlock a cash stash + epilogue scrap.

## Contact roster (voices; models reuse existing NPC GLBs)

| Contact | Voice | Role |
|---|---|---|
| Auntie Portia | warm, motherly hustle, "boet", "sharp sharp" | Act 1 anchor, existing |
| Bra Vusi | chancer, "yoh", "vrrr phaa" | Act 1; the cartel's copper fence, vouches you in |
| Candice from Boksburg | brassy rank politics | Act 1; diesel moves through her rank |
| Thandi (Jozi Arms) | terse, transactional | existing |
| **Solly "Genny King" Malaka** (new) | charming menace, "my laaitie" | employer, Act 2–3 antagonist |
| **Sindi Mokoena** (new) | precise engineer dryness | threat → asset, Act 2–3 |
| **Skywise Sipho** (new, minor) | bush-pilot bravado | airport mission |
| **Oupa Jakes** (new, minor) | retired Park Station announcer | riddle missions |

## Act structure & mission list

Existing 4 missions are the on-ramp. `hot-property` (Vusi's copper) is the thread the
cartel pulls.

**ACT 1 — "Hustle"** (grind; the city teaches you its systems)
1. **Last Coach Home** (Portia; *trains*) — her nephew abandoned her rent bag on the
   Sandton line. Board at any station, ride to Sandton Station, grab the bag off the
   platform, bring it back. Conditions: `onTrain` + `stationName`.
2. **Copper Wire Blues** (Vusi; *tail*) — follow the cable buyer's bakkie across town
   without losing it (`follow` + `strayed` failIf). It parks at Kelvin Yard — the player
   sees the fence, the floodlight masts, the gate. First sight of the flagship location,
   innocently.
3. **Rank Cold War** (Candice; *escort*) — drive Candice's taxi through two rival-rank
   ambushes; the taxi must survive (`vehicle-health-below` failIf, hostile waves).
4. **The Reading of the Signs** (Oupa Jakes; *riddle*, no markers) — riddle chain over
   real map streets: Pothole Street → Loadshed Lane → Fax Street. Objective text IS the
   riddle (`hidden: true`); Oupa re-states it on demand. Pays a Grid Diary page.

Act gate: completing 2 of the original 4 **plus** Copper Wire Blues raises `act2`
(recruitment — Vusi vouches for you; Solly sends word).

**ACT 2 — "The Payroll"** (inside the cartel, working for Solly)
5. **The Audition** (Solly intro; *gentle-drive*) — hijack a diesel tanker and bring it
   to Kelvin Yard without denting it (`vehicleHealthPct` failIf). The crew waves you in
   the gate by day: you see the yard from inside; the records office stays locked — Solly
   trusts nobody with the books.
6. **Pull the Plug** (Solly; *sabotage*) — night job: reach the CBD feeder substation,
   throw the breaker (collect), watch the grid die around you (the script forces a
   load-shedding start), then get clear of the JMPD response. **Experiential teaching #1:
   your hand on the breaker → the lights die.** No commentary.
7. **Stage Fright** (Solly; *stealth-steal*) — "the Sandton superbike. Tonight." The
   showroom forecourt is floodlit with a mains maglock gate — the same furniture as
   Kelvin Yard. Grid up: alarm screams, 3 stars, ride it out hot (mission continues).
   Grid down: silent. Unlocks immediately after Pull the Plug completes — a player who
   moves fast does the steal inside their own blackout and feels the connection. Nobody
   says it. **Experiential teaching #2.**
8. **The Genny Round** (Solly; *collections*) — three businesses behind on "generator
   subscriptions": visit each (checkpoints), lean on the one holdout (defeat 1), get the
   money to Solly. LivingCity standing cost baked in (assault events).
9. **Paper Round** (Sindi approaches YOU; *riddle*) — "I read the fault logs. That trip
   was manual. Let's talk — if you can read." Her dead-drop is a classified ad: "For
   sale: one-way ticket. Collect where the Halt serves the sky." → Lughawe Halt (the
   airport station; solvable by riding the line). `hidden: true`. You take her dossier —
   what you do with it comes later.
10. **The Wrong Train** (Solly; *drive a train*) — the cartel rails diesel at night; take
    the consist and stop it dead at the Crown Station siding (`drivingTrain` +
    `speedBelow` at the target).
11. **Crosswinds** (Skywise Sipho; *fly + skydive*) — run "spare parts" through three sky
    checkpoints out of O.R. Tambourine, then bail and put the chute down on the Ponte
    Tower roof (`inPlane`/`altitude`/`parachuted` conditions).
12. **Two Fires** (branch `choice`) — Solly's order: Sindi's evidence van burns tonight.
    - **Loyal** (`choice:two-fires:solly`) → **Paper Fire**: torch the van before 06:00,
      lose the heat. You're made — Solly's right hand.
    - **Feed Sindi** (`choice:two-fires:sindi`) → **Catch Them Cutting**: help her
      photograph your own crew mid-cut at the substation (stakeout, defeat, collect the
      rig photo). Still a criminal play: she pays, and the carcass will be yours to pick.

**ACT 3 — "Stage Six"** (gate: branch resolved)
13. **FLAGSHIP: Dark House** — both branches need Solly's black ledger. Throne: leverage
    to turn his lieutenants. Sindi: the page her case (and your payday) hangs on. The
    records office at Kelvin Yard is sealed to everyone — including you. See flagship
    spec below. Zero hints, diegetic failure only.
14. Branch tails:
    - *Loyal/throne*: **Long Live the King** — the ledger turns the lieutenants; hold
      Kelvin Yard against Solly's loyalists (survive wave defence). The yard is yours.
    - *Sindi*: **Carcass** — run the ledger to the Constitution Hill handover with
      cartel hit-cars on you; then sweep three cartel stashes for cash before the seals
      go on (timed checkpoints).
15. **The Switch** (finale, both branches) — Solly (or his bitter remnant) rigs the CBD
    substation to blow: a permanent Stage Six. You stop it — throne branch because it's
    your grid to milk now, Sindi branch because your money dies with the city. Timed
    reach → defeat the wreckers → survive 90s holding the perimeter. Epilogue dialogue
    per branch; LivingCity settles final standing (grid-defended/grid-sold).

**SIDE PIECES** (optional)
- **Ouma se Padstal Run** — scenic long-haul to the padstal; generous timer; tourism pay.
- **Pier Pressure** (Candice) — a skipped fare, big time: run him down before his boat
  leaves Seepunt Pier (timed pursuit).
- **Grid Diaries** — 12 hidden lore pages, clued by each other; all 12 → stash + scrap.

Verb variety: courier, tail, escort, riddle×2, sabotage, stealth-steal, collections,
train-ride, train-drive, fly+skydive, timed arson, stakeout, infiltration, convoy,
hold-out, pursuit, loot-sweep.

## FLAGSHIP: "Dark House" (Kelvin Yard break-in)

Mission giver (either branch): "The black ledger sleeps in the records office at Kelvin
Yard. Security answers to nobody — not even me. Figure it out." Nothing else, ever.

**Grid up (day or night): impossible.** Mains floodlights; crossing the fence →
floodlights snap on, klaxon, instant 4-star, objective fails with diegetic copy only
(*"Floodlights slam on. The whole yard saw you."*). The office gate maglock is mains-fed
and physically sealed. Hard impossible, not merely hard.

**Grid down at night (`blackout ≥ 0.7`): possible.** Floodlights dead, maglock sags
open, two guards on torch patrols (narrow cones). Own torch inside the fence, muzzle
flash, or a live headlight cone = spotted (shared BlackoutStealth model). Reach office →
collect ledger → get back out. Grid returning mid-run: 5s surge-flicker grace, then
normal watch resumes.

**Discovery is experiential:** the player has thrown the breaker themselves (mission 6),
has robbed a floodlit-maglock forecourt that fell silent in a blackout (mission 7), and
has seen Kelvin Yard's floodlight masts from both sides (missions 2 and 5). Optional
oblique flavour only: a guard grumbling the backup genny has no diesel; a newspaper scrap
about billed-but-undelivered diesel. No objective text, no character line states the
mechanic. The failure copy mentions floodlights every time; every blackout the player has
ever seen kills floodlights citywide.

Implementation: pure `DepotSecurity` (done, tested) — `update(dt, snapshot)` verdict +
surge grace + `gateOpen()`; giveaways via BlackoutStealth's `visibleInBlackout`.

## Engine (done, committed)

New kinds `follow`/`survive`; `conditions[]` (onTrain, drivingTrain, inPlane, onFoot,
parachuted, speedBelow, altitudeAbove, blackoutAbove, undetected, torchOff, stationName);
`failIf[]` (vehicle-health-below, detected, wanted-above, escort-down, strayed) with
per-rule diegetic reasons; `hidden` (no blip); `checkpoint` (restart resumes there);
`prerequisites`/`setFlags`/`act`; `missionUnlocked()`. GameSnapshot enriched (optional
fields). DialogueSystem (pure), StoryDirector (flags/unlocks/offer handshake/diary),
DepotSecurity, save v3 (storyFlags+diaryPages), LivingCity grid events. All sim-tested.

## Dialogue layer

`DialogueScript { id, lines[{speaker, text}] }`, non-pausing HUD card (shipped), E
advances, walking >12u away abandons the offer. Intros are 3–6 line exchanges
(`story/dialogues.ts`); mid-mission beats use the radio-tone toast. Riddle contacts
re-state the active riddle when spoken to again.

## Verification plan

Pure Vitest sims (owner's rule): a scripted walkthrough per mission (completion + every
failure mode), DepotSecurity matrix, dialogue/director/save/gating tests (shipped), and
the flagship discovery loop simulated end-to-end (grid-up fail → blackout success →
mid-run power return). Gate: lint + tsc -b + full vitest green.
