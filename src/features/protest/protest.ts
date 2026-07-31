/**
 * Protests + burning tyres — the lazily loaded body.
 *
 * Reached ONLY through `load: () => import('./protest/protest')` in src/features/registry.ts. It
 * matches no manualChunk rule, so rollup emits it as its own async chunk that boot never touches.
 *
 * WHAT THIS IS. A service-delivery blockade: a small crowd, a composite junk barricade with burning
 * tyres laid across a lane, placards on scrap cardboard, and a black plume you can see from the
 * highway. It is caused by something the player has personally felt — the load shedding this game
 * already has — and it leaves a stain on the tar that nobody ever comes to fix.
 *
 * WHAT THIS IS NOT, deliberately: not a taxi-association shutdown (no crowd, taxis parked across the
 * lanes, armed operators, a week long, hostile to buses). Conflating the two is the clearest possible
 * tell of no research, so only the first ships here.
 *
 * WHO THE JOKE IS ON. The target is the municipality: state capacity that is available instantly for
 * a camera crew and never for a plumber. The residents have a real grievance and the player is on
 * their side; the payout comes from working the jam like every vendor at every blockade in the
 * country, not from the crowd's pocket. Getting this backwards would read as contempt for people
 * with no water, which is the one thing this feature must never do.
 *
 * THE NECKLACING BLOCK. Burning tyres carry specific historical freight in South Africa. No tyre
 * placement in this feature takes a parent and no ignition takes a target object; both resolve
 * through `assertNotLivingHost` / `ignitableTargets` in ../protest.state, which is enforced by tests
 * (protest.state.test.ts, protest/protest.test.ts) rather than by a comment. The player's throw verb
 * calls `Barricade.addTyre()`, which takes NO ARGUMENTS AT ALL: there is nothing to aim it at.
 *
 * THERE IS NO PROMPT FOR STARTING A PROTEST, AND THAT IS THE POINT.
 *
 * It used to offer `E  Follow the smoke` — from anywhere in the city, with no proximity test at all —
 * and pressing it raised a blockade at your feet. The owner's report is what that costs, and it is
 * three separate failures in one line: "I don't quite understand the game logic. It just seems to
 * spawn a protest where I am or something? More recently, it was saying to press E but didn't do
 * anything, and since it was also blocking E it prevented entering vehicles."
 *
 *  - `Follow the smoke` was a navigation instruction for smoke that did not exist yet.
 *  - The rung sat above `E  Enter vehicle` in Game.updateOnFoot and offered everywhere, so E was eaten
 *    across the whole map for as long as the grievance stayed ripe.
 *  - And a road being closed 300 m away, with no blip and no bearing, is indistinguishable from
 *    nothing happening.
 *
 * So the protest raises ITSELF, out of `update()`, at a road SITE_MIN_METRES away that the player can
 * come across; the plume (built with `fog: false` for exactly this) is the advertisement; a blip and a
 * live distance chip say where; and every rung this feature owns now belongs to a thing standing in
 * front of the player. Every prompt here is an interaction with an object, or it does not exist.
 *
 * HOW TO SEE ONE WITHOUT WAITING FOR THE GRID (documented for review, see also protest/README.md):
 *
 *     ~                      open the developer console
 *     feature protest now    once to load the chunk, again to raise it
 *
 * That shuts the road nearest your feet, hands you two tyres, and prints a `tp x z` line back to it.
 * Nothing else is needed — no cheats, no waiting out three load-shedding cycles.
 */
import * as THREE from 'three';
import { Barricade, ScorchField, TyreFire, radialTexture, type BarricadeSite } from './Barricade';
import {
  bearingName, BLOCKADE_HOURS, blockadeSize, closureRadius, crowdSize, grievanceHud, hourDelta,
  outageLedger, PICKET_SECONDS, picketPayout, pickBlockadeSite, RIPE_OUTAGE_HOURS,
  sanitizeProtestState, SITE_MAX_METRES, SITE_MIN_METRES, SMOKE_DECAY, SMOKE_PER_TYRE,
  SOLO_TYRE_SECONDS, tickGrievance, TYRE_CARRY_CAP, TYRE_FEED_COOLDOWN, tyreCount,
  assertNotLivingHost, ignitableTargets, type BlockadeSize, type ProtestSave, type SiteCandidate,
} from '../protest.state';
import { roadClosures, roadHazards, type RoadHazard } from '../../systems/NavGraph';
import type { FeatureMapIcon, FeatureMapSource } from '../host';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { FeatureGameApi, FeatureHudEntry, FeatureSystem, InteractionDescriptor } from '../types';

/** How much of the tar a blockade costs the traffic planner. Finite: see RoadClosures. */
const BLOCKADE_TOLL = 700;
const TYRE_TOLL = 420;
const TYRE_CLOSURE_RADIUS = 12;
/**
 * WHAT THE SIMULATION IS TOLD, and why there are two of them.
 *
 * A `RoadClosure` is a routing preference: A* pays a toll to plan through the circle, so the city
 * routes AROUND a shutdown instead of queueing into it. That is what this feature already published,
 * and it is why the owner's second report was true — "cars etc just drive through it". A closure
 * reroutes the driver who has not committed to the block yet and says nothing whatsoever to the one
 * already on it, because no driver had ever been told there was a fire in his lane.
 *
 * A `RoadHazard` is the object itself, at the scale a driver sees. Both live in ../../systems/NavGraph
 * (the `navigation` chunk, which imports nothing), so this lazily-loaded body may reach UP into the
 * simulation without the simulation ever reaching down into it. A static edge the other way — a system
 * importing src/features/protest — makes the eager chunk depend on a lazy one, which is the chunk
 * cycle that has taken production down on this project once already.
 */
const HAZARD_OWNER = 'protest';
/** One burning tyre, physically: the rubber plus the bit of fire and heat nobody drives a bakkie
 *  through. Sized so a car CAN thread past a single one — `HAZARD_SWERVE_MAX` is 3.4 and this asks for
 *  1.6 + half a car + clearance ≈ 3.05 — because one tyre by the kerb should be a metre of steering. */
const TYRE_HAZARD_RADIUS = 1.6;
/** The barricade is published as a ROW of circles laid across its own lane, not one big one. Three
 *  reasons: a car on the cross street then meets only the part of it actually in front of him; the
 *  arithmetic that decides "can I get round this" is the same arithmetic used for the player's own
 *  tyres, so there is one rule and not two; and the row is genuinely unthreadable, which is what makes
 *  a blockade a blockade. */
const BARRICADE_HAZARD_RADIUS = 2.4;
const BARRICADE_HAZARD_STEP = 3.4;
/** Once the crowd has gone home the road is declared open again (the closure lifts), but the junk is
 *  still lying there. One smaller circle at the centre, threadable on purpose: traffic weaves round
 *  the remains rather than stopping at a road nothing says is shut. */
const SMOULDER_HAZARD_RADIUS = 1.8;
/** Interaction reach around the barricade centre. Generous on purpose: a dawn barricade is 18 units
 *  of junk with placards another 5 units down the lane, so a reach measured from the centre has to
 *  clear the whole thing plus the pavement you would naturally walk up on. */
const BARRICADE_REACH = 17;
/** A solo tyre needs tar under it and elbow room from the last one. Measured against the real map,
 *  not guessed: `nearestRoadPose` snaps to a sampled LANE centreline, so a player standing squarely
 *  on the road can still be 7-8 units from the nearest sample. The first in-engine run refused to
 *  light a tyre in the middle of the road with a reach of 7. */
const TAR_REACH = 10;
/**
 * Elbow room between one player-lit tyre and the next.
 *
 * It was 22 — wider than any road in the city — which meant the player could never put two tyres on
 * the same carriageway and so could never build anything. That is half of the owner's second report:
 * he threw a tyre expecting to block a road, and one tyre by itself is a thing a driver steers round,
 * correctly. At 4.5 a carried set of three lays a real line across a lane and shuts it, while a single
 * one still just gets swerved past — which is the whole design: what the traffic does is decided by how
 * much of the carriageway you actually covered, not by a flag on the tyre.
 */
const SOLO_SPACING = 4.5;
/** Bearings and radii probed around the player to find a road worth closing. Fixed, so the same
 *  grievance in the same place always shuts the same road; eight by two is 16 `nearestRoadPose`
 *  snaps plus 17 `districtAt` calls, ONCE, on the frame a protest starts — measured in-engine at
 *  6.6 ms, against the barricade's own 33 props and 10 fixture peds on the same frame. Never per
 *  frame: `raise()` sets `barricade` on its first success, so `update()` stops asking. */
const SITE_BEARINGS = 8;
const SITE_RADII = [SITE_MIN_METRES + 35, (SITE_MIN_METRES + SITE_MAX_METRES) / 2 + 30] as const;
/** The blip colour. Tyre-smoke orange, which is also what the plume reads as from a distance. */
const BLIP_COLOR = '#ff7a2f';

type Phase = 'idle' | 'live' | 'picketing' | 'smouldering';

interface SoloFire { fire: TyreFire; id: string; x: number; z: number }

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem & FeatureMapSource {
  const save: ProtestSave = sanitizeProtestState(state);
  // NOTHING is adopted from the save into the ledger, and that is deliberate — see ProtestSave. The
  // grievance is session-scoped, the registry's eager tick has been counting it since boot, and from
  // this line on `update()` continues the very same count on the very same object.

  const scorch = new ScorchField(api.scene, (x, z) => api.surfaceHeightAt(x, z));
  scorch.load(save.scorch);

  // One shared pair of sprite maps for every player-lit tyre, built once and disposed once.
  const soloSmoke = radialTexture('rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  const soloFlame = radialTexture('rgba(255,236,190,1)', 'rgba(255,120,0,0)');

  let phase: Phase = 'idle';
  let barricade: Barricade | undefined;
  let crowd: Pedestrian[] = [];
  let size: BlockadeSize = 'daytime';
  let blockadeHoursLeft = 0;
  let lastHour = api.hour();
  let smoke = 0;
  let picketElapsed = 0;
  let feedCooldown = 0;
  let tyres = save.tyres;
  let pickets = save.pickets;
  let solo: SoloFire[] = [];
  let soloSerial = 0;
  let taughtFeed = false;
  let warned = false;
  let disposed = false;
  /** False while the shared simulation does not know about this feature's road works — see syncRoad. */
  let published = false;

  const scratch = new THREE.Vector3();
  const distanceTo = (x: number, z: number): number => {
    const position = api.playerPosition();
    return Math.hypot(position.x - x, position.z - z);
  };
  const nearBarricade = (reach = BARRICADE_REACH): boolean => Boolean(barricade) && distanceTo(barricade!.site.x, barricade!.site.z) <= reach;

  // ---- what the simulation is told ----------------------------------------------------------------

  /** Every circle this feature currently has lying on a road, derived from live state and never
   *  stored — so it cannot drift out of step with what is actually in the scene. */
  function hazardList(): RoadHazard[] {
    const list: RoadHazard[] = [];
    if (barricade) {
      const site = barricade.site;
      if (phase === 'smouldering') list.push({ x: site.x, z: site.z, r: SMOULDER_HAZARD_RADIUS });
      else {
        // The same `across` and `span` the junk itself was laid out on — see Barricade's constructor.
        const acrossX = Math.cos(site.heading); const acrossZ = -Math.sin(site.heading);
        const span = size === 'dawn' ? 9 : 6.5;
        const steps = Math.max(1, Math.round((span * 2) / BARRICADE_HAZARD_STEP));
        for (let index = 0; index <= steps; index++) {
          const offset = -span + (index / steps) * span * 2;
          list.push({ x: site.x + acrossX * offset, z: site.z + acrossZ * offset, r: BARRICADE_HAZARD_RADIUS });
        }
      }
    }
    for (const entry of solo) list.push({ x: entry.x, z: entry.z, r: TYRE_HAZARD_RADIUS });
    return list;
  }

  /**
   * Restate everything this feature publishes into the shared simulation, out of its own live state.
   *
   * Idempotent — closures replace by id, hazards replace by owner — so it is both the "something
   * changed" call and the "we were suspended and the registry has forgotten about us" call. That is
   * why `published` exists: `suspend()` retracts and clears it, and `update()` puts it all back on the
   * first frame after the player leaves PvP, with no resume hook needed anywhere.
   */
  function syncRoad(): void {
    if (barricade && phase !== 'smouldering') {
      roadClosures.open({ id: 'protest:blockade', x: barricade.site.x, z: barricade.site.z, radius: closureRadius(size), toll: BLOCKADE_TOLL });
    }
    for (const entry of solo) roadClosures.open({ id: entry.id, x: entry.x, z: entry.z, radius: TYRE_CLOSURE_RADIUS, toll: TYRE_TOLL });
    roadHazards.publish(HAZARD_OWNER, hazardList());
    published = true;
  }

  /** Everything back off the road, and the flag that makes `update()` put it back. Called on the PvP
   *  suspend edge and from dispose(). */
  function retractRoad(): void {
    roadHazards.retract(HAZARD_OWNER);
    for (const id of roadClosures.ids) if (id.startsWith('protest:')) roadClosures.close(id);
    published = false;
  }

  // ---- the blockade ------------------------------------------------------------------------------

  /**
   * The road that gets closed.
   *
   * THIS IS THE OWNER'S SECOND REPORT — "it just seems to spawn a protest where I am or something" —
   * and it was literally true: the old version snapped to the road nearest a single point and that
   * point was, on the eager path, always the player's own feet (the wall-clock credit carried no
   * position, so there was never an anchor to prefer).
   *
   * Now: sixteen road poses are snapped out of the live network on fixed bearings around the player,
   * and `pickBlockadeSite` chooses among them — never within SITE_MIN_METRES of him, preferably inside
   * SITE_MAX_METRES, preferably in the district that is aggrieved, and of those the one nearest to
   * where he actually kept standing in the dark. Derived at runtime from the road network every time:
   * no world coordinate is typed anywhere in this feature, because the map moves under it.
   *
   * `atMyFeet` is the console/QA review route only (`feature protest now`), which exists so a protest
   * can be looked at without waiting out the grid.
   */
  function chooseSite(atMyFeet = false): BarricadeSite {
    const player = api.playerPosition();
    if (atMyFeet) {
      const here = api.nearestRoadPose(scratch.set(player.x, 0, player.z));
      return { x: here.position.x, y: here.position.y, z: here.position.z, heading: here.heading };
    }
    const anchor = outageLedger.hasAnchor
      ? { x: outageLedger.anchorX, z: outageLedger.anchorZ }
      : { x: player.x, z: player.z };
    const candidates: SiteCandidate[] = [];
    for (const radius of SITE_RADII) {
      for (let index = 0; index < SITE_BEARINGS; index++) {
        const angle = (index / SITE_BEARINGS) * Math.PI * 2;
        const pose = api.nearestRoadPose(scratch.set(player.x + Math.cos(angle) * radius, 0, player.z + Math.sin(angle) * radius));
        candidates.push({
          x: pose.position.x, y: pose.position.y, z: pose.position.z, heading: pose.heading,
          district: api.districtAt(pose.position.x, pose.position.z),
        });
      }
    }
    const chosen = pickBlockadeSite(candidates, player, anchor, api.districtAt(anchor.x, anchor.z));
    if (chosen) return { x: chosen.x, y: chosen.y, z: chosen.z, heading: chosen.heading };
    // The whole probe found no road at all (deep veld, or the dam). Fall back to the one under our
    // feet rather than refusing: a rung nobody can see cannot be "swallowing" anything, and a protest
    // in an odd place still beats a feature that silently never happens.
    const here = api.nearestRoadPose(scratch.set(player.x, 0, player.z));
    return { x: here.position.x, y: here.position.y, z: here.position.z, heading: here.heading };
  }

  function raise(force = false, atMyFeet = false): boolean {
    if (barricade || (!force && !outageLedger.ripe)) return false;
    const site = chooseSite(atMyFeet);
    size = blockadeSize(api.hour());
    // Every prop is grounded on the surface under IT, not on the site's single height — see Barricade.
    barricade = new Barricade(api.scene, site, size, tyreCount(size), (x, z) => api.surfaceHeightAt(x, z));
    barricade.strength = 0.85;
    barricade.ignite(barricade.scorchPlan); // props only; the sweep filters people out by construction
    blockadeHoursLeft = BLOCKADE_HOURS;
    phase = 'live';

    // Standing on the tar is what actually stops the traffic: PopulationSystem already eases every
    // driver to a halt for a pedestrian in its lane corridor. The nav closure is what makes the rest
    // of the city route AROUND the shutdown instead of queueing into it forever.
    const across = new THREE.Vector3(Math.cos(site.heading), 0, -Math.sin(site.heading));
    const along = new THREE.Vector3(Math.sin(site.heading), 0, Math.cos(site.heading));
    const count = crowdSize(size);
    for (let index = 0; index < count; index++) {
      const lateral = ((index % 5) / 4 - 0.5) * (size === 'dawn' ? 11 : 7.5);
      const rank = Math.floor(index / 5);
      const x = site.x + across.x * lateral + along.x * (1.6 + rank * 2.1);
      const z = site.z + across.z * lateral + along.z * (1.6 + rank * 2.1);
      const ped = api.spawnFixture(x, z, 'Resident');
      if (!ped) continue;
      ped.setHail(true); // the existing raised-arm additive pose, reused as a raised fist — scripted peds never hail a taxi
      // SOLIDARITY, and the owner's first report: "everyone gets scared of me and runs away, which
      // means it's not much of a protest." It is granted here rather than on `E  Join the picket`,
      // because a crowd that scatters as you walk up is a picket there is nothing left to join. It
      // lasts exactly as long as the barricade stands, and hurting anybody in sight ends it — see
      // SOLIDARITY_FEAR_CAP in FearSystem and PopulationSystem.breakSolidarity.
      ped.solidarity = true;
      crowd.push(ped);
    }

    syncRoad();

    // WHERE, IN WORDS. A district name is not a direction and a map is not what somebody reads while
    // walking, so the notification carries the bearing and the distance, the HUD carries the live
    // distance, the map and minimap carry a blip, and the plume carries itself.
    const district = api.districtAt(site.x, site.z);
    const player = api.playerPosition();
    const away = `${Math.round(distanceTo(site.x, site.z))} m ${bearingName(site.x - player.x, site.z - player.z)}`;
    api.notify(`${district} has shut its road`,
      size === 'dawn'
        ? `Every entrance, before work, the way it is always done. Black smoke ${away} — you stood in the dark here too. Fourth week without water; the tanker came once and it was empty.`
        : `A few neighbours and whatever was in the yard. Black smoke ${away} — you stood in the dark here too. Fourth week without water; the tanker came once and it was empty.`,
      true);
    api.analytics('blockade_raised', { detail: size, value: Math.round(distanceTo(site.x, site.z)) });
    api.persist();
    return true;
  }

  /** Lay the stains, drop the closure to a smoulder, send the crowd home. */
  function standDown(reason: 'held' | 'faded' | 'scattered'): void {
    if (!barricade) return;
    for (const mark of barricade.scorchPlan) scorch.add(mark.x, mark.z, mark.r);
    barricade.smoulder();
    roadClosures.close('protest:blockade');
    for (const ped of crowd) { ped.solidarity = false; api.removeFixture(ped); }
    crowd = [];
    phase = 'smouldering';
    blockadeHoursLeft = 1.5;
    syncRoad(); // the row across the lane becomes one smouldering heap traffic weaves round
    // The grievance is knocked back on EVERY stand-down, not only on a paid picket. Without this a
    // blockade the player never reached faded with the ledger still ripe, and `update()` raised the
    // next one on the same frame — a permanent protest treadmill somewhere behind him.
    outageLedger.spend();
    warned = false;
    api.analytics('blockade_cleared', { detail: reason, value: scorch.count });
  }

  function clearBlockade(): void {
    if (barricade) { barricade.dispose(); barricade = undefined; }
    for (const ped of crowd) { ped.solidarity = false; api.removeFixture(ped); }
    crowd = [];
    roadClosures.close('protest:blockade');
    phase = 'idle';
    smoke = 0; picketElapsed = 0;
    syncRoad(); // the junk is gone from the scene, so it goes from the drivers' world too
  }

  // ---- the picket ---------------------------------------------------------------------------------

  /**
   * NO REFUSAL PATH, ON PURPOSE — and the same is true of `feedNow` and `burnNow` below.
   *
   * The foundation's ladder returns on the first rung that offers something and `act()` has no way to
   * say "I could not do it, ask the next rung", so a verb that offers and then declines does not merely
   * fizzle: it EATS THE KEY, and on foot the rung it eats it from is `E  Enter vehicle`. That is the
   * owner's third report, and the fix has to be structural rather than careful.
   *
   * So every rung in this feature computes its precondition in `test()` and hands the already-validated
   * subject to the verb. These functions take what they need as an argument and cannot fail. If you add
   * a verb here, add it the same way: the guard belongs in the predicate, never in the action.
   */
  function joinNow(): void {
    phase = 'picketing';
    smoke = 58; picketElapsed = 0; feedCooldown = 0;
    api.notify('You took a corner of the road', `Hold it for ${PICKET_SECONDS} seconds. Press E at the fire to throw a tyre on whenever the SMOKE bar drops.`, true);
    api.analytics('picket_joined', { detail: size });
  }

  /**
   * Throw a tyre on the fire.
   *
   * THE OWNER REPORTED THIS AS "didn't seem to work but it could be me doing it wrong", and he was
   * right on both counts. The old body moved a number and called `ignite([{kind:'tyre'}])`, which
   * sets a boolean — no tyre appeared, the plume did not change, nothing was said, and the prompt
   * then vanished for three and a half seconds and came back as a DIFFERENT verb. Pressing the key
   * did something invisible, which is indistinguishable from doing nothing.
   *
   * So: a real tyre lands on the pile, the column flares, the bar jumps, and the first throw says
   * what the loop is. `addTyre()` takes no arguments at all, so no part of this makes it possible to
   * throw a tyre AT anything — it is placed on the barricade by world coordinate, exactly like every
   * other prop, and the necklacing block is untouched.
   */
  /** No cooldown check, and none is needed: `InputManager.consume('KeyE')` is edge-triggered and
   *  cleared on read, so one keypress reaches this once however many sim sub-steps a frame runs. The
   *  cooldown below exists only for the console/QA door, which has no edge to consume. */
  function feedNow(fire: Barricade): void {
    feedCooldown = TYRE_FEED_COOLDOWN;
    smoke = Math.min(100, smoke + SMOKE_PER_TYRE);
    fire.addTyre();                  // the visible tyre: no parent, no target, coordinates only
    fire.ignite([{ kind: 'tyre' }]); // the props, never a person — `ignite` filters its candidates
    if (!taughtFeed) {
      taughtFeed = true;
      api.notify('On the fire it goes', 'Black smoke is the whole point: when the smoke goes the cameras go. Keep pressing E while the bar drains.', true);
    }
    api.analytics('tyre_fed', { value: Math.round(smoke) });
  }

  /** The console/QA door onto the same verb, which DOES have to answer "could you?" — the predicate is
   *  the rung's job and a command line has no rung. */
  function feed(): boolean {
    if (phase !== 'picketing' || !barricade || feedCooldown > 0) return false;
    feedNow(barricade);
    return true;
  }

  function resolvePicket(success: boolean, reason: 'held' | 'faded' | 'scattered'): void {
    if (!barricade) return;
    const held = Math.min(picketElapsed, PICKET_SECONDS);
    if (success) {
      const payout = picketPayout(held, size);
      api.earn(payout);
      tyres = Math.min(TYRE_CARRY_CAP, tyres + 1);
      pickets += 1;
      outageLedger.spend();
      api.notify('The councillor came',
        `Camera crew, two bodyguards, no plumber. You sold cold drinks down the queue all morning: R${payout}. Somebody rolled you a spare tyre — stand on any road and press E to roll it out and light it.`,
        true);
      api.analytics('picket_held', { value: payout });
    } else if (reason === 'scattered') {
      api.notify('They scattered', 'You have the road to yourself now. Nobody is coming to look at it.', false);
      api.analytics('picket_scattered');
    } else {
      api.notify('The smoke went out', 'People drifted off to find a taxi. The road is open and the taps are still dry.', false);
      api.analytics('picket_faded', { value: Math.round(held) });
    }
    standDown(reason);
    api.persist();
  }

  // ---- the player's own tyre ----------------------------------------------------------------------

  // City.nearestRoadPose is a linear scan over every traffic-route point in the city, and this
  // question is asked from a prompt resolver that runs once per rendered frame. Cache it against the
  // player's own movement: two units of walking is nothing, and a road does not move.
  let tarCacheX = Number.NaN; let tarCacheZ = Number.NaN; let tarCacheGap = Infinity;
  function tarUnderfoot(): { x: number; y: number; z: number } | undefined {
    const position = api.playerPosition();
    if (!(Math.abs(position.x - tarCacheX) < 2.5 && Math.abs(position.z - tarCacheZ) < 2.5)) {
      const pose = api.nearestRoadPose(scratch.set(position.x, 0, position.z));
      tarCacheX = position.x; tarCacheZ = position.z;
      tarCacheGap = Math.hypot(pose.position.x - position.x, pose.position.z - position.z);
    }
    if (tarCacheGap > TAR_REACH) return undefined;
    return { x: position.x, y: api.surfaceHeightAt(position.x, position.z), z: position.z };
  }

  /** The validated spot, or nothing — this is the rung's predicate, and what it returns is what the
   *  verb is handed, so the two can never disagree about whether there was tar. */
  function burnableSpot(): { x: number; y: number; z: number } | undefined {
    if (tyres <= 0) return undefined;
    const spot = tarUnderfoot();
    if (!spot) return undefined;
    return solo.some((entry) => Math.hypot(entry.x - spot.x, entry.z - spot.z) < SOLO_SPACING) ? undefined : spot;
  }

  /**
   * Roll one tyre out and light it. Takes NO target: it is handed a world position computed from the
   * player's own feet and the fire is built from numbers. There is no overload, no parent argument,
   * and no path from an entity to this call — that is the necklacing block, expressed as a shape.
   */
  function burnNow(spot: { x: number; y: number; z: number }): void {
    tyres -= 1;
    const id = `protest:tyre:${soloSerial++}`;
    const fire = new TyreFire(api.scene, spot.x, spot.y, spot.z, SOLO_TYRE_SECONDS, soloSmoke, soloFlame);
    solo.push({ fire, id, x: spot.x, z: spot.z });
    syncRoad();
    api.notify('Tyre out, tyre lit',
      solo.length > 1
        ? 'Drivers go round one tyre. Lay them across the lane and there is nowhere left to go.'
        : 'That road is closed until it burns down, and drivers will steer round it. The mark stays.',
      true);
    api.analytics('tyre_burned', { value: solo.length });
    api.persist();
  }

  /** The console/QA door onto the same verb. */
  function burnTyre(): boolean {
    const spot = burnableSpot();
    if (!spot) return false;
    burnNow(spot);
    return true;
  }

  // ---- frame --------------------------------------------------------------------------------------

  function update(dt: number): void {
    if (disposed) return;
    const hour = api.hour();
    const position = api.playerPosition();
    // The grievance clock, continuing the very count the registry's eager tick was running before this
    // chunk arrived — same object, same call, same rate. `FeatureHost.update` runs the eager hook only
    // while the body is unloaded, so exactly one of the two is live at any moment.
    tickGrievance({ hour, position });
    const elapsedHours = Math.max(0, Math.min(0.5, hourDelta(lastHour, hour)));
    lastHour = hour;

    feedCooldown = Math.max(0, feedCooldown - dt);

    // The simulation forgets a suspended feature's road works (see suspend()); this puts them back on
    // the first frame after PvP, and is a no-op on every other frame of the game.
    if (!published) syncRoad();

    for (const entry of [...solo]) {
      entry.fire.update(dt);
      if (!entry.fire.spent) continue;
      scorch.add(entry.x, entry.z, 1.9);
      roadClosures.close(entry.id);
      entry.fire.dispose(api.scene);
      solo = solo.filter((other) => other !== entry);
      syncRoad(); // burnt out: off the drivers' map as well as out of the planner's
    }

    if (!barricade) {
      // THE WARNING BEAT. One line, before anything happens, naming the place the chip has been
      // filling for — so the road closing later is the second half of a sentence and not a surprise.
      if (!warned && outageLedger.warning) {
        warned = true;
        const at = outageLedger.hasAnchor ? { x: outageLedger.anchorX, z: outageLedger.anchorZ } : position;
        api.notify(`${api.districtAt(at.x, at.z)} has had enough`,
          'Fourth week without water and the lights just went again while you were standing in it. Somebody is talking about closing the road.', false);
        api.analytics('grievance_warned', { value: Math.round(outageLedger.hours * 10) / 10 });
      }
      // AND THE PROTEST RAISES ITSELF. No prompt, no key, nothing to press from across the city: the
      // grievance ripens and a road closes somewhere the player can walk to and see the smoke from.
      if (outageLedger.ripe) raise();
      return;
    }
    barricade.update(dt);
    blockadeHoursLeft -= elapsedHours;

    if (phase === 'picketing') {
      // Hurting the people whose road this is ends it. No payout, no lecture, no wanted-level
      // special case — they simply stop trusting you with their road, which is the whole cost.
      if (crowd.some((ped) => ped.state === 'down')) { resolvePicket(false, 'scattered'); return; }
      picketElapsed += dt;
      smoke = Math.max(0, smoke - SMOKE_DECAY * dt);
      barricade.strength = 0.12 + (smoke / 100) * 0.88;
      if (picketElapsed >= PICKET_SECONDS) { resolvePicket(true, 'held'); return; }
      if (smoke <= 0) { resolvePicket(false, 'faded'); return; }
      return;
    }

    if (phase === 'live') {
      if (crowd.some((ped) => ped.state === 'down')) { standDown('scattered'); return; }
      if (blockadeHoursLeft <= 0) standDown('faded');
      return;
    }

    if (phase === 'smouldering' && blockadeHoursLeft <= 0) clearBlockade();
  }

  // ---- HUD ----------------------------------------------------------------------------------------

  function hud(): FeatureHudEntry[] | undefined {
    const entries: FeatureHudEntry[] = [];
    if (phase === 'picketing') {
      // The bar IS the smoke, so the number beside it has to be the smoke too. It used to read the
      // elapsed seconds under a SMOKE label, which is two different quantities in one chip.
      entries.push({ id: 'protest:smoke', label: 'SMOKE', value: `${Math.round(smoke)}%`, fill: smoke, warn: smoke < 26 });
      entries.push({ id: 'protest:hold', label: 'HOLD', value: `${Math.max(0, Math.ceil(PICKET_SECONDS - picketElapsed))}s` });
    } else if (barricade && phase !== 'smouldering') {
      entries.push({ id: 'protest:way', label: 'PICKET', value: `${Math.round(distanceTo(barricade.site.x, barricade.site.z))} m` });
    } else {
      // The SAME function the registry's eager slice calls, so the strip cannot change shape at the
      // moment this chunk lands — the README's rule, and the reason petrol's gauge is built this way.
      entries.push(...grievanceHud());
    }
    if (tyres > 0) entries.push({ id: 'protest:tyres', label: 'TYRES', value: `${tyres}` });
    return entries.length ? entries : undefined;
  }

  /** The blip. A standing blockade is a live thing this feature owns and moves, so it belongs here and
   *  not in the eager mapIcons.ts — and it is what turns "a road somewhere is shut" into somewhere the
   *  player can steer. Not an `objective` pin: nobody sent him, he is allowed to ignore it. */
  function mapIcons(): FeatureMapIcon[] {
    if (!barricade || phase === 'smouldering') return [];
    return [{ x: barricade.site.x, z: barricade.site.z, color: BLIP_COLOR, shape: 'diamond' }];
  }

  // ---- interactions -------------------------------------------------------------------------------

  /**
   * EVERY RUNG HERE BELONGS TO SOMETHING STANDING IN FRONT OF THE PLAYER, and every one of them offers
   * only when its verb is certain to run. Both halves of that are load-bearing:
   *
   *  - There is no rung for starting a protest. `E  Follow the smoke` used to sit at order 60 with no
   *    proximity test whatsoever, so for as long as the grievance stayed ripe it offered across the
   *    entire map — above `E  Enter vehicle` in Game.updateOnFoot — and the owner could not get into a
   *    car. The protest now raises itself in `update()`; the smoke is the invitation.
   *  - Each `test()` resolves the subject (the fire, the barricade, the spot of tar) and hands it to a
   *    verb with no refusal path. The ladder returns on the first rung that offers and `act()` cannot
   *    report failure, so "offers but declines" is not a fizzle, it is a stolen keypress.
   */
  const rungs: InteractionDescriptor[] = [
    {
      id: 'protest:feed', order: 54, context: 'foot',
      test: () => {
        const fire = phase === 'picketing' && nearBarricade() ? barricade : undefined;
        return fire ? { prompt: 'E  Throw a tyre on the fire', act: () => feedNow(fire) } : undefined;
      },
    },
    {
      id: 'protest:join', order: 56, context: 'foot',
      test: () => (phase === 'live' && nearBarricade()
        ? { prompt: 'E  Join the picket · keep the smoke up', act: joinNow } : undefined),
    },
    {
      id: 'protest:take', order: 58, context: 'foot',
      test: () => (phase === 'smouldering' && nearBarricade() && tyres < TYRE_CARRY_CAP
        // Teaches the verb on pickup, because this rung sits ABOVE the burn rung while you are
        // standing in the remains: you stock up here, then go and close a road somewhere else.
        ? {
          prompt: `E  Take a tyre · ${tyres}/${TYRE_CARRY_CAP} carried`,
          act: () => {
            tyres = Math.min(TYRE_CARRY_CAP, tyres + 1);
            api.notify(`Tyre ${tyres} of ${TYRE_CARRY_CAP}`, 'Stand anywhere on a road and press E to roll it out and light it. That road shuts until it burns down, and the mark never comes off.', true);
            api.persist();
          },
        } : undefined),
    },
    {
      id: 'protest:burn', order: 62, context: 'foot',
      test: () => {
        const spot = burnableSpot();
        return spot ? { prompt: 'E  Roll out a tyre and light it', act: () => burnNow(spot) } : undefined;
      },
    },
  ];

  // ---- save ---------------------------------------------------------------------------------------

  function serialize(): ProtestSave {
    return { tyres, pickets, scorch: scorch.serialize() };
  }

  function restore(next: unknown): void {
    const loaded = sanitizeProtestState(next);
    tyres = loaded.tyres; pickets = loaded.pickets;
    scorch.load(loaded.scorch);
    clearBlockade();
    // A checkpoint reload does not un-live the outages the player stood in, so the grievance stays —
    // but the blockade that WAS standing has just been torn down, so the ledger is knocked back rather
    // than left ripe, or `update()` raises a replacement on the very next frame.
    outageLedger.spend();
    warned = false;
  }

  // ---- console + machine playthrough ---------------------------------------------------------------

  function status(): string {
    return `phase=${phase} hours=${outageLedger.hours.toFixed(2)} fedup=${Math.round(outageLedger.fraction * 100)}% ripe=${outageLedger.ripe} `
      + `tyres=${tyres} pickets=${pickets} smoke=${Math.round(smoke)} scorch=${scorch.count} solo=${solo.length} closures=${roadClosures.count} hazards=${roadHazards.count} solidarity=${crowd.filter((ped) => ped.solidarity).length}/${crowd.length}`;
  }

  /** Where the standing blockade is, and the console line that gets you back to it. */
  function where(): string[] {
    if (!barricade) return ['Nothing standing. Run "feature protest now".'];
    const { x, z } = barricade.site;
    return [
      `${api.districtAt(x, z)} — ${size} blockade, ${Math.round(distanceTo(x, z))} m away, phase ${phase}.`,
      `tp ${x.toFixed(0)} ${z.toFixed(0)}`,
    ];
  }

  function command(args: readonly string[]): string[] {
    const [verb, value] = args;
    switch (verb) {
      case undefined: case 'status': return [status()];
      case 'ripen': {
        outageLedger.hours = Math.max(outageLedger.hours, RIPE_OUTAGE_HOURS + 1);
        const p = api.playerPosition();
        outageLedger.anchorX = p.x; outageLedger.anchorZ = p.z; outageLedger.hasAnchor = true;
        return [`Grievance ripe, anchored where you are standing. A road ${SITE_MIN_METRES}-${SITE_MAX_METRES} m away shuts itself on the next frame — look for the smoke and the blip.`];
      }
      // THE REVIEW ROUTE. One line, from a cold start, standing anywhere: no waiting out three
      // load-shedding cycles to look at the thing. The owner could not reach a protest by hand, and a
      // feature nobody can reach is a feature nobody can judge.
      case 'now': {
        if (barricade) return ['One is already standing.', ...where()];
        outageLedger.hours = Math.max(outageLedger.hours, RIPE_OUTAGE_HOURS + 1);
        if (!raise(true, true)) return ['Could not find a road near you to shut. Drive into town and try again.'];
        tyres = Math.max(tyres, 2);
        return [
          'Blockade up on the road nearest your feet, and you are carrying 2 tyres.',
          `Walk into it: E joins the picket, then E throws a tyre on the fire — hold the SMOKE bar for ${PICKET_SECONDS} s.`,
          ...where(),
        ];
      }
      case 'where': return where();
      case 'raise': return [raise(true) ? 'Blockade up.' : 'There is already one standing.'];
      case 'clear': clearBlockade(); return ['Road reopened.'];
      case 'tyres': tyres = Math.max(0, Math.min(TYRE_CARRY_CAP, Number(value) || 1)); return [`Carrying ${tyres}.`];
      case 'feed': return [feed() ? `Tyre on. Smoke ${Math.round(smoke)}%.` : 'Only while you are picketing at the barricade.'];
      case 'burn': return [burnTyre() ? 'Lit.' : 'Needs a tyre, tar underfoot, and room from the last one.'];
      case 'scorch': return [`${scorch.count} marks on the tar.`];
      default: return ['feature protest [now|where|status|ripen|raise|clear|tyres <n>|feed|burn|scorch]',
        'now — raise one at your feet and hand you tyres, for review without waiting out the grid.'];
    }
  }

  /**
   * Machine playthrough driver (window.__qa.feature('protest', action)). Each action is one atomic
   * verb; the harness owns the clock and steps the real game loop between them, because the owner's
   * gate is an in-engine playthrough and not a unit test pretending to be one.
   */
  function qa(action: string, args: Record<string, unknown>): string {
    switch (action) {
      case 'status': case 'run': return `ok:${status()}`;
      case 'ripen': command(['ripen']); return 'ok';
      case 'now': {
        if (barricade) return 'failed:already-standing';
        command(['now']);
        return barricade ? `ok:${status()}` : 'failed:no-road-nearby';
      }
      case 'where': return `ok:${where().join(' | ')}`;
      case 'raise': return raise(true) ? 'ok' : 'failed:already-standing';
      case 'site': return barricade ? `ok:${barricade.site.x.toFixed(1)},${barricade.site.z.toFixed(1)}` : 'stuck:no-blockade';
      case 'crowd': return `ok:${crowd.length}`;
      case 'join':
        if (phase !== 'live') return `stuck:phase-${phase}`;
        if (!nearBarricade()) return `stuck:not-near:${Math.round(distanceTo(barricade!.site.x, barricade!.site.z))}`;
        joinNow(); return 'ok';
      // The two questions the E-swallowing bug was about, answerable from the harness: what does the
      // ladder offer right now, and does pressing it actually do something. See qa('press').
      case 'offer': {
        const offer = resolveRung();
        return offer ? `ok:${offer.prompt}` : 'ok:(nothing — E belongs to the rest of the ladder)';
      }
      case 'press': {
        const offer = resolveRung();
        if (!offer) return 'ok:no-offer';
        const before = status();
        offer.act();
        return before === status() ? `failed:offer-did-nothing:${offer.prompt}` : `ok:${offer.prompt}`;
      }
      case 'fedup': return `ok:${Math.round(outageLedger.fraction * 100)}`;
      case 'blips': return `ok:${mapIcons().length}`;
      case 'feed':
        if (phase !== 'picketing') return `stuck:phase-${phase}`;
        feedCooldown = 0;
        if (!feed()) return 'failed:throw-refused';
        return `ok:${Math.round(smoke)}:tyres-on-the-pile-${barricade?.thrownTyres ?? 0}`;
      case 'smoke': return `ok:${Math.round(smoke)}`;
      case 'tyre': tyres = Math.min(TYRE_CARRY_CAP, tyres + (Number(args.n) || 1)); return `ok:${tyres}`;
      case 'burn': return burnTyre() ? `ok:${solo.length}` : 'failed:no-tar-or-no-tyre';
      case 'closures': return `ok:${roadClosures.count}:${roadClosures.ids.join('|')}`;
      // The two questions the traffic half of this feature is judged on: is there anything in the
      // road as far as a DRIVER is concerned, and is the crowd still standing there.
      case 'hazards': return `ok:${roadHazards.count}`;
      case 'solidarity': return `ok:${crowd.filter((ped) => ped.solidarity).length}/${crowd.length}`;
      case 'fled': return `ok:${crowd.filter((ped) => ped.state === 'flee' || ped.state === 'cower').length}/${crowd.length}`;
      case 'suspend': suspend(); return `ok:${roadHazards.count}:${roadClosures.count}`;
      case 'scorch': return `ok:${scorch.count}`;
      case 'money': return `ok:${api.balance()}`;
      // The safety probe, run in-engine rather than only in vitest: hand the tyre and ignition paths
      // a live pedestrian, a bare bone and a skinned mesh, and report OK only if every one is refused.
      case 'necklace': return necklaceProbe();
      default: return `stuck:unknown-action:${action}`;
    }
  }

  /** Whatever THIS feature's rungs would offer on foot right now, resolved exactly as the host does:
   *  lowest order first, first offer wins. */
  function resolveRung(): { prompt: string; act(): void } | undefined {
    const at = api.playerPosition();
    const ctx = { context: 'foot' as const, position: at, vehicle: api.drivenVehicle(), hour: api.hour() };
    for (const rung of [...rungs].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))) {
      const offer = rung.test(ctx);
      if (offer) return offer;
    }
    return undefined;
  }

  function necklaceProbe(): string {
    const victim = crowd[0] as unknown;
    const bone = new THREE.Bone();
    const limb = new THREE.Object3D(); bone.add(limb);
    const wrapped = { userData: { ped: victim ?? {} } };
    const candidates: unknown[] = [victim, bone, limb, wrapped].filter((entry) => entry !== undefined);
    if (!candidates.length) return 'stuck:no-candidates';
    let refused = 0;
    for (const candidate of candidates) {
      try { assertNotLivingHost(candidate, 'qa'); }
      catch { refused += 1; }
    }
    if (refused !== candidates.length) return `failed:accepted-${candidates.length - refused}-living-hosts`;
    if (ignitableTargets(candidates).length !== 0) return 'failed:ignition-filter-leaked-a-body';
    if (barricade) {
      try { barricade.ignite(candidates); return 'failed:barricade-ignited-a-body'; }
      catch { /* expected: the barricade refuses too */ }
    }
    return `ok:refused-${refused}`;
  }

  // ---- teardown -----------------------------------------------------------------------------------

  /** PvP: this feature's clock has stopped, so nothing it published may keep steering the city. Its
   *  tyres would never burn down and its road would stay shut for as long as the player stayed online.
   *  `update()` restates the lot on the first frame back — nothing needs a resume hook. */
  function suspend(): void { retractRoad(); }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearBlockade();
    for (const entry of solo) { roadClosures.close(entry.id); entry.fire.dispose(api.scene); }
    solo = [];
    scorch.dispose();
    soloSmoke.dispose(); soloFlame.dispose();
    // Belt and braces: anything this feature ever put on a road is taken off it, so a stale chunk
    // arrival or a new game can never leave the city routing around — or braking for — a barricade
    // that isn't there.
    retractRoad();
    outageLedger.reset(); // a new game re-earns the grievance; the registry's eager tick takes it back
  }

  return { update, hud, mapIcons, interactions: () => rungs, serialize, restore, command, qa, suspend, dispose };
}
