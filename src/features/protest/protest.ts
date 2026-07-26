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
 * (protest.state.test.ts, protest/protest.test.ts) rather than by a comment.
 */
import * as THREE from 'three';
import { Barricade, ScorchField, TyreFire, radialTexture, type BarricadeSite } from './Barricade';
import {
  BLOCKADE_HOURS, blockadeSize, closureRadius, crowdSize, hourDelta, outageLedger, PICKET_SECONDS,
  picketPayout, sanitizeProtestState, SMOKE_DECAY, SMOKE_PER_TYRE, SOLO_TYRE_SECONDS, TYRE_CARRY_CAP,
  TYRE_FEED_COOLDOWN, tyreCount, assertNotLivingHost, ignitableTargets,
  type BlockadeSize, type ProtestSave,
} from '../protest.state';
import { roadClosures } from '../../systems/NavGraph';
import { powerOn } from '../../world/powerGrid';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { FeatureGameApi, FeatureHudEntry, FeatureSystem, InteractionDescriptor } from '../types';

/** How much of the tar a blockade costs the traffic planner. Finite: see RoadClosures. */
const BLOCKADE_TOLL = 700;
const TYRE_TOLL = 420;
const TYRE_CLOSURE_RADIUS = 12;
/** Interaction reach around the barricade centre. Generous — the junk is spread over ~18 units. */
const BARRICADE_REACH = 12;
/** A solo tyre needs tar under it and elbow room from the last one. */
const TAR_REACH = 7;
const SOLO_SPACING = 22;

type Phase = 'idle' | 'live' | 'picketing' | 'smouldering';

interface SoloFire { fire: TyreFire; id: string; x: number; z: number }

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
  const save: ProtestSave = sanitizeProtestState(state);
  outageLedger.load(save);

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
  let disposed = false;

  const scratch = new THREE.Vector3();
  const distanceTo = (x: number, z: number): number => {
    const position = api.playerPosition();
    return Math.hypot(position.x - x, position.z - z);
  };
  const nearBarricade = (reach = BARRICADE_REACH): boolean => Boolean(barricade) && distanceTo(barricade!.site.x, barricade!.site.z) <= reach;

  // ---- the blockade ------------------------------------------------------------------------------

  /** The site is the road nearest to where the player kept standing in the dark. Derived at runtime
   *  from the live road network — no world coordinate is typed anywhere in this feature, because the
   *  map is being reshaped underneath it. */
  function chooseSite(): BarricadeSite {
    const anchorX = outageLedger.hasAnchor ? outageLedger.anchorX : api.playerPosition().x;
    const anchorZ = outageLedger.hasAnchor ? outageLedger.anchorZ : api.playerPosition().z;
    const pose = api.nearestRoadPose(scratch.set(anchorX, 0, anchorZ));
    return { x: pose.position.x, y: pose.position.y, z: pose.position.z, heading: pose.heading };
  }

  function raise(force = false): boolean {
    if (barricade || (!force && !outageLedger.ripe)) return false;
    const site = chooseSite();
    size = blockadeSize(api.hour());
    barricade = new Barricade(api.scene, site, size, tyreCount(size));
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
    api.notify('You took a corner of the road', 'Keep the smoke up. When the smoke goes, the cameras go, and then nobody comes.', true);
    api.analytics('picket_joined', { detail: size });
  }

  function feed(): void {
    if (phase !== 'picketing' || feedCooldown > 0 || !barricade) return;
    feedCooldown = TYRE_FEED_COOLDOWN;
    smoke = Math.min(100, smoke + SMOKE_PER_TYRE);
    // One more tyre onto the pile: the props, never a person. `ignite` filters its candidates.
    barricade.ignite([{ kind: 'tyre' }]);
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
        `Camera crew, two bodyguards, no plumber. You sold cold drinks down the queue all morning: R${payout}. Somebody rolled you a spare tyre.`,
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
    // The grievance clock keeps running now that we own the frame — same ledger the eager approach
    // was ticking before this chunk existed, so nothing is double-counted or lost at the handover.
    outageLedger.tick(hour, position.x, position.z, powerOn());
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
      entries.push({ id: 'protest:smoke', label: 'SMOKE', value: `${Math.round(picketElapsed)}s`, fill: smoke, warn: smoke < 26 });
    } else if (barricade && phase !== 'smouldering') {
      entries.push({ id: 'protest:way', label: 'PICKET', value: `${Math.round(distanceTo(barricade.site.x, barricade.site.z))} m` });
    }
    if (tyres > 0) entries.push({ id: 'protest:tyres', label: 'TYRES', value: `${tyres}` });
    return entries.length ? entries : undefined;
  }

  // ---- interactions -------------------------------------------------------------------------------

  const rungs: InteractionDescriptor[] = [
    {
      id: 'protest:feed', order: 54, context: 'foot',
      test: () => (phase === 'picketing' && nearBarricade() && feedCooldown <= 0
        ? { prompt: 'E  Throw on a tyre', act: feed } : undefined),
    },
    {
      id: 'protest:join', order: 56, context: 'foot',
      test: () => (phase === 'live' && nearBarricade() ? { prompt: 'E  Join the picket', act: join } : undefined),
    },
    {
      id: 'protest:take', order: 58, context: 'foot',
      test: () => (phase === 'smouldering' && nearBarricade() && tyres < TYRE_CARRY_CAP
        ? { prompt: 'E  Take a tyre', act: () => { tyres = Math.min(TYRE_CARRY_CAP, tyres + 1); api.notify('Tyre', 'There is always another tyre.', true); api.persist(); } } : undefined),
    },
    {
      id: 'protest:raise', order: 60, context: 'foot',
      test: () => (!barricade && outageLedger.ripe ? { prompt: 'E  Follow the smoke', act: () => { raise(); } } : undefined),
    },
    {
      id: 'protest:burn', order: 62, context: 'foot',
      test: () => (canBurnHere() ? { prompt: 'E  Burn a tyre', act: () => { burnTyre(); } } : undefined),
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

  function command(args: readonly string[]): string[] {
    const [verb, value] = args;
    switch (verb) {
      case undefined: case 'status': return [status()];
      case 'ripen': outageLedger.hours = 99; outageLedger.hasAnchor = true;
        if (!outageLedger.anchorX && !outageLedger.anchorZ) { const p = api.playerPosition(); outageLedger.anchorX = p.x; outageLedger.anchorZ = p.z; }
        return ['Grievance ripe. Walk outside and follow the smoke.'];
      case 'raise': return [raise(true) ? 'Blockade up.' : 'There is already one standing.'];
      case 'clear': clearBlockade(); return ['Road reopened.'];
      case 'tyres': tyres = Math.max(0, Math.min(TYRE_CARRY_CAP, Number(value) || 1)); return [`Carrying ${tyres}.`];
      case 'burn': return [burnTyre() ? 'Lit.' : 'Needs a tyre, tar underfoot, and room from the last one.'];
      case 'scorch': return [`${scorch.count} marks on the tar.`];
      default: return ['feature protest [status|ripen|raise|clear|tyres <n>|burn|scorch]'];
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
      case 'raise': return raise(true) ? 'ok' : 'failed:already-standing';
      case 'site': return barricade ? `ok:${barricade.site.x.toFixed(1)},${barricade.site.z.toFixed(1)}` : 'stuck:no-blockade';
      case 'crowd': return `ok:${crowd.length}`;
      case 'join':
        if (phase !== 'live') return `stuck:phase-${phase}`;
        if (!nearBarricade()) return `stuck:not-near:${Math.round(distanceTo(barricade!.site.x, barricade!.site.z))}`;
        join(); return 'ok';
      case 'feed':
        if (phase !== 'picketing') return `stuck:phase-${phase}`;
        feedCooldown = 0; feed(); return `ok:${Math.round(smoke)}`;
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
    outageLedger.reset();
  }

  return { update, hud, interactions: () => rungs, serialize, restore, command, qa, dispose };
}
