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
  BLOCKADE_HOURS, blockadeSize, closureRadius, crowdSize, hourDelta, outageLedger, PICKET_SECONDS,
  picketPayout, RIPE_OUTAGE_HOURS, sanitizeProtestState, SMOKE_DECAY, SMOKE_PER_TYRE,
  SOLO_TYRE_SECONDS, tickOutage, TYRE_CARRY_CAP, TYRE_FEED_COOLDOWN, tyreCount, assertNotLivingHost,
  ignitableTargets, type BlockadeSize, type ProtestSave,
} from '../protest.state';
import { roadClosures } from '../../systems/NavGraph';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { FeatureGameApi, FeatureHudEntry, FeatureSystem, InteractionDescriptor } from '../types';

/** How much of the tar a blockade costs the traffic planner. Finite: see RoadClosures. */
const BLOCKADE_TOLL = 700;
const TYRE_TOLL = 420;
const TYRE_CLOSURE_RADIUS = 12;
/** Interaction reach around the barricade centre. Generous on purpose: a dawn barricade is 18 units
 *  of junk with placards another 5 units down the lane, so a reach measured from the centre has to
 *  clear the whole thing plus the pavement you would naturally walk up on. */
const BARRICADE_REACH = 17;
/** A solo tyre needs tar under it and elbow room from the last one. Measured against the real map,
 *  not guessed: `nearestRoadPose` snaps to a sampled LANE centreline, so a player standing squarely
 *  on the road can still be 7-8 units from the nearest sample. The first in-engine run refused to
 *  light a tyre in the middle of the road with a reach of 7. */
const TAR_REACH = 10;
const SOLO_SPACING = 22;

type Phase = 'idle' | 'live' | 'picketing' | 'smouldering';

interface SoloFire { fire: TyreFire; id: string; x: number; z: number }

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
  const save: ProtestSave = sanitizeProtestState(state);
  outageLedger.adopt(save); // ADOPT, not load — see OutageLedger.adopt. `load` here wipes the session.
  // From here on THIS is the ledger's clock: update() ticks it every sim step with the real game hour,
  // the real player position and the real grid. The eager power-grid credit stands down while this is
  // set, so an outage that spans the chunk arriving is counted once and not twice.
  outageLedger.driven = true;

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
  let disposed = false;

  const scratch = new THREE.Vector3();
  const distanceTo = (x: number, z: number): number => {
    const position = api.playerPosition();
    return Math.hypot(position.x - x, position.z - z);
  };
  const nearBarricade = (reach = BARRICADE_REACH): boolean => Boolean(barricade) && distanceTo(barricade!.site.x, barricade!.site.z) <= reach;

  // ---- the blockade ------------------------------------------------------------------------------

  /** The site is the road nearest to where the player kept standing in the dark, or — when the QA
   *  route asks for one right here — the road nearest their feet. Derived at runtime from the live
   *  road network: no world coordinate is typed anywhere in this feature, because the map moves. */
  function chooseSite(preferPlayer = false): BarricadeSite {
    const useAnchor = outageLedger.hasAnchor && !preferPlayer;
    const anchorX = useAnchor ? outageLedger.anchorX : api.playerPosition().x;
    const anchorZ = useAnchor ? outageLedger.anchorZ : api.playerPosition().z;
    const pose = api.nearestRoadPose(scratch.set(anchorX, 0, anchorZ));
    return { x: pose.position.x, y: pose.position.y, z: pose.position.z, heading: pose.heading };
  }

  function raise(force = false, preferPlayer = false): boolean {
    if (barricade || (!force && !outageLedger.ripe)) return false;
    const site = chooseSite(preferPlayer);
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
      crowd.push(ped);
    }

    roadClosures.open({ id: 'protest:blockade', x: site.x, z: site.z, radius: closureRadius(size), toll: BLOCKADE_TOLL });

    const district = api.districtAt(site.x, site.z);
    api.notify(`${district} is shut`,
      size === 'dawn'
        ? 'Every entrance, before work, the way it is always done. Fourth week without water; the tanker came once and it was empty.'
        : 'A few neighbours and whatever was in the yard. Fourth week without water; the tanker came once and it was empty.',
      true);
    api.analytics('blockade_raised', { detail: size, value: Math.round(outageLedger.hours * 10) / 10 });
    api.persist();
    return true;
  }

  /** Lay the stains, drop the closure to a smoulder, send the crowd home. */
  function standDown(reason: 'held' | 'faded' | 'scattered'): void {
    if (!barricade) return;
    for (const mark of barricade.scorchPlan) scorch.add(mark.x, mark.z, mark.r);
    barricade.smoulder();
    roadClosures.close('protest:blockade');
    for (const ped of crowd) api.removeFixture(ped);
    crowd = [];
    phase = 'smouldering';
    blockadeHoursLeft = 1.5;
    api.analytics('blockade_cleared', { detail: reason, value: scorch.count });
  }

  function clearBlockade(): void {
    if (barricade) { barricade.dispose(); barricade = undefined; }
    for (const ped of crowd) api.removeFixture(ped);
    crowd = [];
    roadClosures.close('protest:blockade');
    phase = 'idle';
    smoke = 0; picketElapsed = 0;
  }

  // ---- the picket ---------------------------------------------------------------------------------

  function join(): void {
    if (phase !== 'live') return;
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
  function feed(): boolean {
    if (phase !== 'picketing' || !barricade || feedCooldown > 0) return false;
    feedCooldown = TYRE_FEED_COOLDOWN; // a same-frame guard only; the OFFER is never gated on it
    smoke = Math.min(100, smoke + SMOKE_PER_TYRE);
    barricade.addTyre();                  // the visible tyre: no parent, no target, coordinates only
    barricade.ignite([{ kind: 'tyre' }]); // the props, never a person — `ignite` filters its candidates
    if (!taughtFeed) {
      taughtFeed = true;
      api.notify('On the fire it goes', 'Black smoke is the whole point: when the smoke goes the cameras go. Keep pressing E while the bar drains.', true);
    }
    api.analytics('tyre_fed', { value: Math.round(smoke) });
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

  function canBurnHere(): boolean {
    if (tyres <= 0) return false;
    const spot = tarUnderfoot();
    if (!spot) return false;
    return !solo.some((entry) => Math.hypot(entry.x - spot.x, entry.z - spot.z) < SOLO_SPACING);
  }

  /**
   * Roll one tyre out and light it. Takes NO target: a world position is computed from the player's
   * own feet and the fire is built from numbers. There is no overload, no parent argument, and no
   * path from an entity to this call — that is the necklacing block, expressed as a shape.
   */
  function burnTyre(): boolean {
    const spot = tarUnderfoot();
    if (!spot || tyres <= 0) return false;
    tyres -= 1;
    const id = `protest:tyre:${soloSerial++}`;
    const fire = new TyreFire(api.scene, spot.x, spot.y, spot.z, SOLO_TYRE_SECONDS, soloSmoke, soloFlame);
    solo.push({ fire, id, x: spot.x, z: spot.z });
    roadClosures.open({ id, x: spot.x, z: spot.z, radius: TYRE_CLOSURE_RADIUS, toll: TYRE_TOLL });
    api.notify('Tyre out, tyre lit', 'That road is closed until it burns down. The mark stays.', true);
    api.analytics('tyre_burned', { value: solo.length });
    api.persist();
    return true;
  }

  // ---- frame --------------------------------------------------------------------------------------

  function update(dt: number): void {
    if (disposed) return;
    const hour = api.hour();
    const position = api.playerPosition();
    // The accurate half of the grievance clock: real game hours, the real player position, the real
    // grid. `outageLedger.driven` was set at construction, so the eager power-grid credit stands down
    // and an outage spanning the chunk's arrival is counted once rather than twice.
    tickOutage(hour, position.x, position.z);
    const elapsedHours = Math.max(0, Math.min(0.5, hourDelta(lastHour, hour)));
    lastHour = hour;

    feedCooldown = Math.max(0, feedCooldown - dt);

    for (const entry of [...solo]) {
      entry.fire.update(dt);
      if (!entry.fire.spent) continue;
      scorch.add(entry.x, entry.z, 1.9);
      roadClosures.close(entry.id);
      entry.fire.dispose(api.scene);
      solo = solo.filter((other) => other !== entry);
    }

    if (!barricade) return;
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
    }
    if (tyres > 0) entries.push({ id: 'protest:tyres', label: 'TYRES', value: `${tyres}` });
    return entries.length ? entries : undefined;
  }

  // ---- interactions -------------------------------------------------------------------------------

  /**
   * Every prompt here names the key AND what pressing it will do, because the owner's playtest report
   * on the old set was "tyre throwing didn't seem to work but it could be me doing it wrong" — which
   * is a report about the prompt, not about the code. A verb the player cannot tell they performed is
   * a verb that does not exist.
   *
   * The feed rung is also NOT gated on its cooldown any more. It used to be, and the effect was that
   * pressing E made the prompt disappear and come back three seconds later as `E  Burn a tyre` — the
   * band flickering between two different verbs at the one moment the player is looking for feedback.
   */
  const rungs: InteractionDescriptor[] = [
    {
      id: 'protest:feed', order: 54, context: 'foot',
      test: () => (phase === 'picketing' && nearBarricade()
        ? { prompt: 'E  Throw a tyre on the fire', act: () => { feed(); } } : undefined),
    },
    {
      id: 'protest:join', order: 56, context: 'foot',
      test: () => (phase === 'live' && nearBarricade()
        ? { prompt: 'E  Join the picket · keep the smoke up', act: join } : undefined),
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
      id: 'protest:raise', order: 60, context: 'foot',
      test: () => (!barricade && outageLedger.ripe ? { prompt: 'E  Follow the smoke', act: () => { raise(); } } : undefined),
    },
    {
      id: 'protest:burn', order: 62, context: 'foot',
      test: () => (canBurnHere() ? { prompt: 'E  Roll out a tyre and light it', act: () => { burnTyre(); } } : undefined),
    },
  ];

  // ---- save ---------------------------------------------------------------------------------------

  function serialize(): ProtestSave {
    const ledger = outageLedger.store();
    return { hours: ledger.hours, anchor: ledger.anchor, tyres, pickets, scorch: scorch.serialize() };
  }

  function restore(next: unknown): void {
    const loaded = sanitizeProtestState(next);
    outageLedger.load(loaded);
    tyres = loaded.tyres; pickets = loaded.pickets;
    scorch.load(loaded.scorch);
    clearBlockade();
  }

  // ---- console + machine playthrough ---------------------------------------------------------------

  function status(): string {
    return `phase=${phase} hours=${outageLedger.hours.toFixed(2)} ripe=${outageLedger.ripe} tyres=${tyres} pickets=${pickets} `
      + `smoke=${Math.round(smoke)} scorch=${scorch.count} solo=${solo.length} closures=${roadClosures.count}`;
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
        return ['Grievance ripe, anchored where you are standing. Walk out and follow the smoke.'];
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
        join(); return 'ok';
      case 'feed':
        if (phase !== 'picketing') return `stuck:phase-${phase}`;
        feedCooldown = 0;
        if (!feed()) return 'failed:throw-refused';
        return `ok:${Math.round(smoke)}:tyres-on-the-pile-${barricade?.thrownTyres ?? 0}`;
      case 'smoke': return `ok:${Math.round(smoke)}`;
      case 'tyre': tyres = Math.min(TYRE_CARRY_CAP, tyres + (Number(args.n) || 1)); return `ok:${tyres}`;
      case 'burn': return burnTyre() ? `ok:${solo.length}` : 'failed:no-tar-or-no-tyre';
      case 'closures': return `ok:${roadClosures.count}:${roadClosures.ids.join('|')}`;
      case 'scorch': return `ok:${scorch.count}`;
      case 'money': return `ok:${api.balance()}`;
      // The safety probe, run in-engine rather than only in vitest: hand the tyre and ignition paths
      // a live pedestrian, a bare bone and a skinned mesh, and report OK only if every one is refused.
      case 'necklace': return necklaceProbe();
      default: return `stuck:unknown-action:${action}`;
    }
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

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    clearBlockade();
    for (const entry of solo) { roadClosures.close(entry.id); entry.fire.dispose(api.scene); }
    solo = [];
    scorch.dispose();
    soloSmoke.dispose(); soloFlame.dispose();
    // Belt and braces: anything this feature ever closed is reopened, so a stale chunk arrival or a
    // new game can never leave the city routing around a barricade that isn't there.
    for (const id of roadClosures.ids) if (id.startsWith('protest:')) roadClosures.close(id);
    outageLedger.reset(); // also clears `driven`, handing the clock back to the eager power-grid hook
  }

  return { update, hud, interactions: () => rungs, serialize, restore, command, qa, dispose };
}
