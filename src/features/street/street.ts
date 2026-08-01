/**
 * STREET ECONOMY — corners, kerbs, and the Body Corporate.
 *
 * Lazily loaded: this file and its four siblings are reached ONLY through registry.ts's `load()`, so
 * rollup emits them as `street-<hash>.js` and boot never touches a byte of it. See ../README.md.
 *
 * What is here:
 *  - fixtures on derived kerb sites (`scripted`, never `contact`), pooled by proximity
 *  - a lit pad and a beam over every worked corner, and a GOLD PILLAR over the one you were sent to
 *  - a blip for every corner on the radar and the city map, and a gold objective pin for the tip
 *  - a dealer trade with district pricing, corner demand, a carry cap, arrear subs and three ranks
 *  - a kerb negotiation in the VEHICLE context with a stated price and a refusal ladder
 *  - a short-time ride that grants nothing physical: what you get is the conversation, and the
 *    conversation is worth more than the fare because she knows which corner is paying tonight
 *  - a bad-date list: hurt anyone here and the whole trade shuts on you, citywide, for hours
 *
 * THE RULE THIS FILE WAS REWRITTEN UNDER, from the owner's playtest: nothing the player needs may
 * exist only in a toast. A toast is four seconds long and then the information is destroyed. Every
 * direction, price, shift and destination in here is re-readable on demand — on the paused menu
 * card, on the map, on the HUD chip, or as a beam of light standing over the place itself — and
 * every character repeats themselves for free, for ever, because "the person stopped telling me" is
 * the worst sentence in that report.
 */
import * as THREE from 'three';
import type { FeatureGameApi, FeatureHudEntry, FeatureMenuRow, FeatureSystem, InteractionCtx, InteractionDescriptor, InteractionOffer } from '../types';
import type { FeatureMapIcon, FeatureMapSource } from '../host';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { Vehicle } from '../../entities/Vehicle';
import { stablePositionRandom } from '../../world/StableRandom';
import {
  DEFAULT_STREET_STATE, sanitizeStreetState, STREET_PRODUCTS, STREET_STAFF_RADIUS,
  STREET_UNSTAFF_RADIUS, streetSites,
  type StreetProduct, type StreetSaveState, type StreetSite,
} from '../street.state';
import { KNOCKDOWN_DAMAGE } from '../../systems/BumpSystem';
import { CALM_THRESHOLD } from '../../systems/FearSystem';
import { cycle, dealerFor, FIXER, LEVY_NOTES, PROMOTIONS, RADIO_BLAME, workerFor, type Worker } from './cast';
import {
  AFTER_WORK_SECONDS, BAD_DATE_LEVY, BAD_DATE_SECONDS, banHours, hoursUntilShift, isQuiet, onShift,
  quietHint, refuseWindow, type Refusal, type WindowState,
} from './rules';
import { bodyRock, SCENE_LENGTH, shortTimeShot } from './scene';
import {
  askPrice, bestDemand, bidPrice, buysHere, carryCap, carrying, demandIndex, PRODUCTS, productSpec,
  quoteBuy, quoteSell, recoverDemand, sellsToYou, supplyProduct, tierFor, tierSpec,
} from './trade';

/** How close before a corner is staffed — and it must not be tighter than the ring that PROMISED you
 *  the corner. Both live in ../street.state.ts so they cannot drift apart; see the note there. The
 *  cost is bounded by the map: no point in the city has more than three corners inside this radius. */
const SPAWN_RADIUS = STREET_STAFF_RADIUS;
const DESPAWN_RADIUS = STREET_UNSTAFF_RADIUS;
/** Reach of the on-foot conversation. Deliberately longer than the melee reach: walking up to a
 *  person you can see and getting no prompt is the failure this whole rewrite is about, so the
 *  generous number wins over the tidy one. */
const TALK_RANGE = 5;

/**
 * THE COLOURS OF THE STREET. Distinct in hue AND in lightness from the teal shop diamonds
 * (#3fd1c4) and the gold objective pin (#f5c542), so the radar stays legible to a colour-blind
 * player: shops are teal diamonds, corners are coloured circles, the place you were SENT is gold.
 */
const DEALER_COLOR = '#f0842a';
const WORKER_COLOR = '#c07bff';
/** The game's own objective gold, taken from Game.buildMarker so a street destination looks exactly
 *  like a mission destination — same pillar, same pin, same behaviour at the edge of the minimap. */
const GOAL_COLOR = '#f5c542';
/** Corner beams are short — a lit doorway you can see down the street. The GOAL pillar is the tall
 *  one, and there is only ever one of those, because "go here" must not have to compete. */
const CORNER_BEAM_HEIGHT = 26;
const GOAL_BEAM_HEIGHT = 130;
/** Reach from a stopped car window. */
const WINDOW_RANGE = 8;
/** A corner restocks its own supply on this clock. */
const RESTOCK_SECONDS = 200;
const SUPPLY_PER_CORNER = 40;
/** After a fixture is killed, the block leaves that corner alone for a while. Four minutes, not
 *  seven: patience is a resource, and an unlucky corner should not read as a broken one. */
const CORNER_COOLDOWN = 240;
/** Damage a fixture shrugs off without calling it violence — the bump system's own knockdown figure,
 *  imported rather than guessed so the two can never drift. Anything above this is a weapon. */
const SHOVE_DAMAGE = KNOCKDOWN_DAMAGE;
/** Health a fixture recovers per second after a survivable knock. Slow enough that gunfire still
 *  kills, fast enough that a taxi clipping the kerb is forgotten by the time you walk over. */
const FIXTURE_REGEN = 12;
/** How far a fixture may drift from its corner before it is put back, player watching or not. */
const STRAY_LIMIT = 8;

interface Fixture {
  readonly site: StreetSite;
  readonly ped: Pedestrian;
  /** Health this person spawned with — the ceiling the corner heals back up to. */
  readonly full: number;
  /** Last seen health, so damage can be told apart from a shrug. */
  health: number;
  dead: boolean;
}

interface Ride {
  readonly site: StreetSite;
  readonly worker: Worker;
  readonly pickupX: number;
  readonly pickupZ: number;
  readonly paid: number;
}

/** A cutscene in flight. It owns nothing the ride does not already own — kill it at any moment and
 *  the ride still resolves onto the same card with the same payoff. */
interface Scene {
  readonly ride: Ride;
  /** The car the scene is filming. If `drivenVehicle()` ever stops being THIS one, she is gone. */
  readonly car: Vehicle;
  /** Stable 0..1 from the pickup kerb and the ride count: the camera's side and the springs' phase. */
  readonly phase: number;
  /** Bodywork when the cameras rolled. A hit during the scene ends it. */
  readonly health: number;
  t: number;
}

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem & FeatureMapSource {
  const save: StreetSaveState = sanitizeStreetState(state ?? DEFAULT_STREET_STATE);
  // A COPY of the memoized derivation: the QA driver restages a site in front of the player, and
  // mutating the module-level cache would leave that stage behind for the next session.
  const sites: StreetSite[] = streetSites().slice();
  const fixtures = new Map<string, Fixture>();
  /** siteId → seconds before that corner is worked again (someone was killed on it). */
  const cooldown = new Map<string, number>();
  /** siteId → seconds of her own after-work pause. */
  const busy = new Map<string, number>();
  /** `${siteId}:${product}` → 0.62..1 demand, walked down by dumping and recovered over minutes. */
  const demand = new Map<string, number>();
  /** siteId → units the corner still has of the thing it is long. */
  const supply = new Map<string, number>();
  const visits = new Map<string, number>();
  /** siteId → the lit pad standing over a worked corner. Built and torn down with the fixture. */
  const beacons = new Map<string, THREE.Group>();
  const beacon = new THREE.Group();
  beacon.name = 'StreetCorners';
  api.scene.add(beacon);
  /** The single gold pillar over wherever the player was last SENT. One at a time, always. */
  let goal: THREE.Group | undefined;
  let beaconPhase = 0;
  let restockTimer = RESTOCK_SECONDS;
  let radio = 0;
  let sales = 0;
  let ride: Ride | undefined;
  let scene: Scene | undefined;
  let openSite: StreetSite | undefined;
  let disposed = false;
  let dirty = false;

  const site = (id: string | undefined): StreetSite | undefined => sites.find((entry) => entry.id === id);
  const district = (id: string | undefined): string => site(id)?.district ?? 'somewhere';
  const demandOf = (siteId: string, product: StreetProduct): number => demand.get(`${siteId}:${product}`) ?? 1;
  const supplyOf = (siteId: string): number => supply.get(siteId) ?? SUPPLY_PER_CORNER;
  const flat = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);
  const shiftOf = (entry: StreetSite): Worker['shift'] => workerFor(entry.cast).shift;
  const working = (entry: StreetSite, hour: number): boolean =>
    (cooldown.get(entry.id) ?? 0) <= 0 && (entry.kind === 'dealer' || onShift(hour, shiftOf(entry)));

  // ---- fixtures ---------------------------------------------------------------------------------

  function spawn(entry: StreetSite): void {
    const name = entry.kind === 'dealer' ? dealerFor(entry.cast).name : workerFor(entry.cast).name;
    const ped = api.spawnFixture(entry.x, entry.z, name);
    if (!ped) return;
    // `scripted` is set for us by spawnFixture. These three are ours, and each one is load-bearing:
    //  - aggressive: one ambient ped in nine squares up and attacks anyone who walks close. A dealer
    //    who swings at his own customer is not a dealer.
    //  - wallet: nothing here is recoverable by force. Mugging a fixture pays exactly R0.
    //  - hailing: the existing raised-arm idle pose, reused as the beckon. No new animation, and no
    //    whistle — there is no whistle clip in this build and we do not promise sounds we do not have.
    ped.aggressive = false;
    ped.wallet = 0;
    ped.setHail(true);
    ped.group.rotation.y = entry.heading;
    fixtures.set(entry.id, { site: entry, ped, full: ped.health, health: ped.health, dead: false });
  }

  function despawn(id: string): void {
    const fixture = fixtures.get(id);
    if (!fixture) return;
    api.removeFixture(fixture.ped);
    fixtures.delete(id);
  }

  // ---- markers ----------------------------------------------------------------------------------

  /**
   * A lit pad under a worked corner, and a short beam over it.
   *
   * This is the ShopSystem entry-pad idiom (disc + torus + pulse) with a beam added, because a shop
   * is a building you can see and a corner is a person you cannot — a pavement pad alone is invisible
   * from the far side of a junction. `depthWrite: false` and MeshBasicMaterial keep it free: no
   * lights, no shadows, no sorting cost worth measuring, and it reads through load shedding.
   */
  function buildBeacon(entry: StreetSite): THREE.Group {
    const colour = new THREE.Color(entry.kind === 'dealer' ? DEALER_COLOR : WORKER_COLOR);
    const group = new THREE.Group();
    group.position.set(entry.x, api.surfaceHeightAt(entry.x, entry.z), entry.z);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 0.06, 24),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    disc.position.y = 0.3;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.08, 0.09, 8, 26), new THREE.MeshBasicMaterial({ color: colour }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.32;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 1.5, CORNER_BEAM_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false }),
    );
    beam.position.y = CORNER_BEAM_HEIGHT / 2;
    group.add(disc, ring, beam);
    return group;
  }

  /** The owner asked for this by name: "perhaps a goal indicator (gold pillar of light) should appear
   *  for it". Same geometry, same gold and same 130-unit height as Game.buildMarker, so a place the
   *  street sent you to is indistinguishable from a place a mission sent you to. */
  function buildGoal(): THREE.Group {
    const group = new THREE.Group();
    const gold = new THREE.Color(GOAL_COLOR);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.16, 8, 28), new THREE.MeshBasicMaterial({ color: gold }));
    ring.rotation.x = Math.PI / 2;
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.9, GOAL_BEAM_HEIGHT, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false }),
    );
    core.position.y = GOAL_BEAM_HEIGHT / 2;
    const flare = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2.8, GOAL_BEAM_HEIGHT, 18, 1, true),
      new THREE.MeshBasicMaterial({ color: gold, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    );
    flare.position.y = GOAL_BEAM_HEIGHT / 2;
    group.add(ring, core, flare);
    return group;
  }

  function dropBeacon(id: string): void {
    const group = beacons.get(id);
    if (!group) return;
    beacon.remove(group);
    disposeTree(group);
    beacons.delete(id);
  }

  function disposeTree(root: THREE.Object3D): void {
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) for (const entry of material) entry.dispose();
      else material.dispose();
    });
  }

  /** The gold pillar follows the tip and NOTHING else, so it always means one thing: go there. It is
   *  built the first time a destination exists and then simply moved — it never needs rebuilding. */
  function syncGoal(): void {
    const target = site(save.tipSite);
    if (!target) { if (goal) goal.visible = false; return; }
    if (!goal) { goal = buildGoal(); beacon.add(goal); }
    goal.visible = true;
    goal.position.set(target.x, api.surfaceHeightAt(target.x, target.z) + 0.25, target.z);
  }

  /**
   * Somebody put hands on a person who works this street. The trade closes, citywide.
   *
   * Attribution is by PRESENCE, not by a damage-source hook the api does not expose: if the player
   * is not on the block, a stray traffic collision does not get blamed on them. Inside the ring it
   * is assumed to be yours, which in practice it always is.
   *
   * IT TAKES A DEATH, NOT A SCRATCH. This used to fire on any health drop at all, and the machine
   * playthrough shows exactly what that costs: the player stood at Chidi's kerb, an ambient car
   * clipped him, and the citywide trade shut on a player who had done nothing but walk up and buy a
   * bankie of zol — R250 of security levy and five minutes of "the corner is closed to you" for
   * somebody else's driving. A punishment you can incur by standing still is not a punishment, it is
   * a trap. Deliberate violence still ends the trade, because that part of the design is right, and
   * anyone who means it will finish the job.
   */
  const BLAME_RADIUS = 60;

  function harmed(fixture: Fixture): void {
    if (flat(api.playerPosition(), fixture.ped.group.position) > BLAME_RADIUS) return;
    if (save.banned > 0) { save.banned = Math.max(save.banned, BAD_DATE_SECONDS); return; }
    save.banned = BAD_DATE_SECONDS;
    save.levy += BAD_DATE_LEVY;
    dirty = true;
    api.notify('Word goes down the road',
      `Every corner on this side of town has your car. Nobody trades with you for about ${banHours(BAD_DATE_SECONDS)} hours, and the trustees have added a R${BAD_DATE_LEVY} security levy.`, false);
    api.analytics('bad_date', { detail: fixture.site.kind, value: BAD_DATE_SECONDS });
  }

  function reconcile(hour: number): void {
    const player = api.playerPosition();
    for (const entry of sites) {
      const distance = flat(entry, player);
      const live = fixtures.get(entry.id);
      // A LIT PAD MEANS SOMEBODY WORKS THIS CORNER. The light tracks `working()` — the same
      // predicate the fixture does — so an off-shift kerb is dark in the world while staying on the
      // map, where the card can say when she is back. Marking an empty kerb would recreate the
      // original bug with better lighting. The light reaches further than the fixture on purpose:
      // you see it from across the junction, and she has spawned by the time you are close enough
      // to tell there is nobody there.
      const worked = working(entry, hour) && !live?.dead;
      if (worked && distance < DESPAWN_RADIUS) { if (!beacons.has(entry.id)) { const built = buildBeacon(entry); beacons.set(entry.id, built); beacon.add(built); } }
      else dropBeacon(entry.id);
      if (live?.dead) continue;
      if (!live && distance < SPAWN_RADIUS && working(entry, hour) && !(ride && ride.site.id === entry.id)) spawn(entry);
      else if (live && (distance > DESPAWN_RADIUS || (!working(entry, hour) && distance > 45))) despawn(entry.id);
    }
    syncGoal();
  }

  /** Fixtures stand their post. Fear, bumps and gunfire still move them; this walks them back. */
  function tendFixtures(dt: number): void {
    const player = api.playerPosition();
    for (const [id, fixture] of fixtures) {
      const ped = fixture.ped;
      // A SHOVE IS NOT AN ASSAULT, and being knocked over is not being killed. Both of those were
      // wrong, and both turned "walk up to the person you can see" into a trap: a sprint-bump on
      // arrival took 12 health, tripped the bad-date list, shut the entire citywide trade on the
      // player, and — because any `down` state was read as a corpse — retired the corner for seven
      // minutes. She now dusts herself off, remembers you as clumsy, and carries on working.
      const lost = fixture.health - ped.health;
      if (lost > 0 && lost <= SHOVE_DAMAGE && ped.health > 0) ped.health = fixture.health;
      else if (lost > 0) fixture.health = ped.health; // wounded, and the road will judge that on the outcome
      // …and a survivable knock heals off over a few seconds. Both fixtures came out of the machine
      // playthrough on 60 health from passing traffic, and a corner that is permanently two shots
      // from a citywide ban is a corner the player is quietly walking a tightrope beside. Sustained
      // gunfire still outruns this by a wide margin, so a real attack still kills.
      if (ped.state !== 'down' && ped.health > 0 && ped.health < fixture.full) {
        ped.health = Math.min(fixture.full, ped.health + FIXTURE_REGEN * dt);
        fixture.health = ped.health;
      }
      if (ped.state === 'down') {
        if (ped.health > 0) continue; // knocked over, not killed: Pedestrian stands her back up on its own clock
        if (!fixture.dead) { fixture.dead = true; cooldown.set(id, CORNER_COOLDOWN); harmed(fixture); }
        continue;
      }
      // A FIXTURE NEVER FIGHTS AND NEVER LEAVES THE KERB. An ordinary ped clipped by a car goes to
      // FEAR_MAX and can roll "fight" (Pedestrian.applyFear), and an enraged ped pursues the player
      // for as long as the fear lasts. The machine playthrough found Chidi Nwosu 72 m off his own
      // corner, hostile, standing where Gugu should have been — so E offered HIS card at HER kerb.
      if (ped.enraged || ped.state === 'hostile') { ped.enraged = false; ped.fear = 0; ped.state = 'idle'; ped.idleTime = 999_999; ped.setHail(true); }
      // Fear, bumps and gunfire still move a fixture — they are ordinary peds in every respect but
      // the census. Once calm, they go back to standing their corner instead of wandering off it.
      if (ped.state !== 'idle' && ped.fear < CALM_THRESHOLD) { ped.state = 'idle'; ped.idleTime = 999_999; ped.setHail(true); }
      if (ped.state !== 'idle') continue;
      // Home if they have strayed far, whatever the player is doing: a fixture eight metres off its
      // pitch is already wrong, and hiding the correction behind "only when nobody is looking" is
      // what let one of them end up answering for somebody else's corner.
      const strayed = flat(ped.group.position, fixture.site);
      if (strayed > STRAY_LIMIT || (strayed > 1.2 && flat(player, fixture.site) > 40)) {
        ped.group.position.set(fixture.site.x, api.surfaceHeightAt(fixture.site.x, fixture.site.z), fixture.site.z);
      }
      // Face whoever is talking to them, otherwise face the road like everyone waiting on a kerb.
      ped.group.rotation.y = flat(player, ped.group.position) < 14
        ? Math.atan2(player.x - ped.group.position.x, player.z - ped.group.position.z)
        : fixture.site.heading;
    }
  }

  // ---- money ------------------------------------------------------------------------------------

  /** One toast at a time: the HUD has a single slot, so a promotion must not eat the sale it came
   *  from and the radio quip must not eat either. Beats land in order, 4.4s apart (TOAST_MS is 4s). */
  const queued: { title: string; detail: string; success: boolean }[] = [];
  let toastTimer = 0;

  function say(title: string, detail: string, success = true): void {
    if (toastTimer <= 0 && queued.length === 0) { api.notify(title, detail, success); toastTimer = 4.4; return; }
    if (queued.length < 3) queued.push({ title, detail, success });
  }

  function drainToasts(dt: number): void {
    toastTimer = Math.max(0, toastTimer - dt);
    if (toastTimer > 0 || queued.length === 0) return;
    const next = queued.shift()!;
    api.notify(next.title, next.detail, next.success);
    toastTimer = 4.4;
  }

  function promote(): void {
    const rank = tierFor(save.turnover, save.tier);
    if (rank === save.tier) return;
    save.tier = rank;
    const beat = PROMOTIONS[Math.min(PROMOTIONS.length - 1, rank)]!;
    say(beat.title, beat.line, true);
    api.analytics('tier_up', { detail: tierSpec(rank).name, value: rank });
    dirty = true;
  }

  /** The Blame Ticker: every third sale, the drive show explains your crime to the province and gets
   *  it wrong in the same direction every time. The joke is always on the host. */
  function blame(): void {
    say('On the radio', cycle(RADIO_BLAME, radio++), true);
  }

  function buy(entry: StreetSite, product: StreetProduct, want: number): void {
    const dealer = dealerFor(entry.cast);
    if (save.banned > 0) { api.notify(dealer.name, dealer.banned, false); return; }
    // Only the corner's own line, whatever a forged menu action asks for: a corner that is short of
    // something must never also stock it, or buy-low-sell-high collapses onto one kerb.
    if (product !== supplyProduct(entry.id, entry.cast)) { api.notify(dealer.name, 'That is not what this corner has. Ask the block that does.', false); return; }
    const context = { siteId: entry.id, tier: save.tier, levy: save.levy, blackout: api.blackout() };
    const quote = quoteBuy(product, context, {
      want, held: carrying(save.stock), cap: carryCap(save.tier), balance: api.balance(), supply: supplyOf(entry.id),
    });
    if (quote.units <= 0) {
      const reason = quote.limit === 'tier' ? dealer.locked
        : quote.limit === 'money' ? dealer.broke
          : quote.limit === 'carry' ? `You are carrying ${carrying(save.stock)}. That is everything your hands and your nerve can manage at ${tierSpec(save.tier).name}.`
            : 'The corner is out. Come back when the bakkie has been round.';
      api.notify(dealer.name, reason, false);
      return;
    }
    if (!api.spend(quote.total)) { api.notify(dealer.name, dealer.broke, false); return; }
    save.stock[product] += quote.units;
    supply.set(entry.id, Math.max(0, supplyOf(entry.id) - quote.units));
    dirty = true;
    const spec = productSpec(product);
    say(`${quote.units} ${quote.units === 1 ? spec.unit : spec.plural} · R${quote.total}`, dealer.bought, true);
    api.analytics('buy', { detail: product, value: quote.total });
    showDealer(entry);
  }

  function sell(entry: StreetSite, product: StreetProduct, want: number): void {
    const dealer = dealerFor(entry.cast);
    if (save.banned > 0) { api.notify(dealer.name, dealer.banned, false); return; }
    // A corner never buys back its own line. Checked here and not only when the row is drawn, so a
    // forged menu action cannot buy at the ask and sell at the bid on one kerb.
    if (!buysHere(entry.id, entry.cast, product)) { api.notify(dealer.name, 'This corner has its own. Take it somewhere that does not.', false); return; }
    const quote = quoteSell(product, entry.id, save.stock[product], want, demandOf(entry.id, product));
    if (quote.units <= 0) { api.notify(dealer.name, 'You are not carrying any. This is a corner, not a conversation.', false); return; }
    save.stock[product] -= quote.units;
    save.turnover += quote.total;
    save.levy += quote.levy;
    demand.set(`${entry.id}:${product}`, quote.demandAfter);
    api.earn(quote.total);
    dirty = true;
    const spec = productSpec(product);
    say(`Sold ${quote.units} ${quote.units === 1 ? spec.unit : spec.plural} · R${quote.total}`,
      `${dealer.sold} Service charge R${quote.levy}.`, true);
    api.analytics('sell', { detail: product, value: quote.total });
    if (save.tipSite === entry.id && save.tipProduct === product) {
      // The errand she sent you on, delivered. Clear the destination, take the pillar down in this
      // frame rather than on the next reconcile, and SAY SO: an arrival that passes in silence is a
      // reward the player never collects.
      save.tipSite = undefined; save.tipProduct = undefined;
      syncGoal();
      say('That was the run she sent you on', 'Straight there, straight sold. Ask any of them where the next one is — they will tell you, and they will keep telling you.', true);
    }
    sales += 1;
    promote();
    if (sales % 3 === 1) blame();
    showDealer(entry);
  }

  function payLevy(entry: StreetSite): void {
    const dealer = dealerFor(entry.cast);
    if (save.levy <= 0) return;
    const owed = save.levy;
    if (!api.spend(owed)) { api.notify(dealer.name, `R${owed} is what the book says. The book is not open to discussion.`, false); return; }
    save.levy = 0;
    dirty = true;
    api.notify(`Levy paid · R${owed}`, dealer.levyPaid, true);
    api.analytics('levy_paid', { value: owed });
    showDealer(entry);
  }

  // ---- menus ------------------------------------------------------------------------------------

  function visit(id: string): number {
    const seen = (visits.get(id) ?? 0);
    visits.set(id, seen + 1);
    if (!save.met.includes(id)) { save.met.push(id); dirty = true; }
    return seen;
  }

  function showDealer(entry: StreetSite): void {
    openSite = entry;
    const dealer = dealerFor(entry.cast);
    const blackout = api.blackout();
    const context = { siteId: entry.id, tier: save.tier, levy: save.levy, blackout };
    const rows: FeatureMenuRow[] = [];

    // On the bad-date list the card still opens — you get to hear exactly what you cost yourself,
    // and how long for — but there is no row to poke. The trade is closed, not merely refusing.
    if (save.banned > 0) {
      rows.push({ id: 'banned', label: `The corner is closed to you`, detail: `Every block on this side of town has your car. About ${banHours(save.banned)} hours left.`, note: 'CLOSED', disabled: true });
      if (save.levy > 0) rows.push({ id: 'levy', label: 'Pay the arrear subs', detail: 'The security levy is not optional and the trustees are not sympathetic.', price: save.levy });
      // Being barred is a closed door, not a blindfold. The road stays readable while you wait it out.
      rows.push({ id: 'block', label: 'Where is everyone else working', detail: 'Shut to you today is not the same as hidden from you. The whole road, with distances.', note: 'FREE' });
      api.showMenu({
        featureId: 'street', eyebrow: `THE BODY CORPORATE · ${entry.district.toUpperCase()}`,
        title: `${dealer.name} — ${dealer.tag}`, blurb: dealer.banned, balance: api.balance(), rows, leaveLabel: 'Walk on',
      });
      visit(entry.id);
      return;
    }

    // A corner stocks EXACTLY its own line and nothing else. Above your rank it says so and sells you
    // nothing — but it is not a dead end, because it still buys what you are carrying, and that is
    // the half of the trade that pays.
    const long = supplyProduct(entry.id, entry.cast);
    const spec = productSpec(long);
    const ask = askPrice(long, context);
    const left = supplyOf(entry.id);
    const room = Math.max(0, carryCap(save.tier) - carrying(save.stock));
    const bulk = Math.min(room, left, Math.floor(api.balance() / ask));
    if (!sellsToYou(entry.id, entry.cast, save.tier)) {
      rows.push({ id: `locked:${long}`, label: `${spec.name} — not at your rank`, detail: dealer.locked, note: tierSpec(spec.tier).name.toUpperCase(), disabled: true });
    } else if (left <= 0) {
      rows.push({ id: `out:${long}`, label: `${spec.name} — sold out`, detail: 'The bakkie comes twice a week and never to the same corner twice running.', note: 'OUT', disabled: true });
    } else {
      rows.push({ id: `buy1:${long}`, label: `One ${spec.unit} of ${spec.name.toLowerCase()}`, detail: spec.note, price: ask });
      if (bulk > 1) rows.push({ id: `buymax:${long}`, label: `Take ${bulk} ${spec.plural}`, detail: `Everything you can carry and afford at ${tierSpec(save.tier).name} rank.`, price: bulk * ask });
    }

    for (const product of PRODUCTS) {
      if (!buysHere(entry.id, entry.cast, product.id)) continue; // a corner never buys back its own line: that is the whole map
      const held = save.stock[product.id];
      if (held <= 0) continue;
      const quote = quoteSell(product.id, entry.id, held, held, demandOf(entry.id, product.id));
      const hot = demandIndex(entry.id, product.id) >= 1.32 ? ' · this block is short' : '';
      rows.push({ id: `sell:${product.id}`, label: `Sell ${held} ${held === 1 ? product.unit : product.plural}`, detail: `R${Math.round(quote.total / Math.max(1, quote.units))} each${hot}`, price: quote.total });
    }

    if (save.levy > 0) rows.push({ id: 'levy', label: 'Pay the arrear subs', detail: cycle(LEVY_NOTES, visits.get(entry.id) ?? 0), price: save.levy });
    // The standing destination and the whole road, from any corner, free, every time. A dealer who
    // will not tell you where the other corners are is a dead end with a shopfront.
    const standing = tipRow();
    if (standing) rows.push(standing);
    rows.push({ id: 'block', label: 'Where is everyone else working', detail: 'The road, with distances from this kerb. He will draw you the whole map if you ask.', note: 'FREE' });
    if (save.tier >= 2) rows.push({ id: 'fixer', label: 'Ask where the wholesale actually comes from', detail: FIXER.tag, note: 'FREE' });

    const next = nextRank(save.tier, save.turnover);
    rows.push({ id: 'status', label: `${tierSpec(save.tier).name} · turnover R${save.turnover}`, detail: next ?? tierSpec(save.tier).blurb, note: `${carrying(save.stock)}/${carryCap(save.tier)}`, disabled: true });

    const seen = visit(entry.id);
    api.showMenu({
      featureId: 'street',
      eyebrow: `THE BODY CORPORATE · ${entry.district.toUpperCase()}`,
      title: `${dealer.name} — ${dealer.tag}`,
      blurb: cycle(dealer.greet, seen),
      balance: api.balance(),
      rows,
      leaveLabel: 'Walk on',
    });
  }

  function nextRank(rank: number, turnover: number): string | undefined {
    if (rank >= 2) return undefined;
    const next = tierSpec(rank + 1);
    return `R${Math.max(0, next.turnover - turnover)} more through the books and you are a ${next.name}.`;
  }

  function showFixer(entry: StreetSite): void {
    openSite = entry;
    api.showMenu({
      featureId: 'street',
      eyebrow: `${FIXER.name.toUpperCase()} · DISPENSARY`,
      title: FIXER.tag,
      blurb: `${cycle(FIXER.greet, visits.get(entry.id) ?? 0)} ${FIXER.reveal}`,
      rows: [{ id: 'fixer-done', label: 'Take the paperwork', detail: FIXER.farewell }],
      leaveLabel: 'Leave the dispensary',
    });
    api.analytics('fixer');
  }

  function windowState(entry: StreetSite, worker: Worker): WindowState {
    const vehicle = api.drivenVehicle();
    return {
      hour: api.hour(), shift: worker.shift, banned: save.banned, balance: api.balance(), price: worker.price,
      busy: busy.get(entry.id) ?? 0,
      vehicle: vehicle ? { speed: vehicle.speed, health: vehicle.health, maxHealth: vehicle.maxHealth, onFire: vehicle.onFire, police: vehicle.police } : undefined,
    };
  }

  /** Every refusal names its cause AND its fix. "No" with a number attached is playable; "no" is not. */
  function refusal(worker: Worker, reason: Refusal): string {
    if (reason === 'off-shift') return `${worker.refuse['off-shift']} (About ${hoursUntilShift(api.hour(), worker.shift)} hours.)`;
    if (reason === 'banned') return `${worker.refuse.banned} (About ${banHours(save.banned)} hours left.)`;
    return worker.refuse[reason];
  }

  /** The same refusal, compressed into the HUD prompt, so E never promises a deal it will decline. */
  function refusalTag(worker: Worker, reason: Refusal): string {
    if (reason === 'off-shift') return `back at ${worker.shift.start}h`;
    if (reason === 'banned') return `you are on the list · ${banHours(save.banned)}h`;
    if (reason === 'police-car') return 'not in a JMPD car';
    if (reason === 'wreck') return 'not in that car';
    if (reason === 'broke') return `R${worker.price} · you are short`;
    if (reason === 'busy') return 'give her a minute';
    return 'stop the car';
  }

  function showWorker(entry: StreetSite): void {
    const worker = workerFor(entry.cast);
    const reason = refuseWindow(windowState(entry, worker));
    if (reason) { api.notify(worker.name, refusal(worker, reason), reason === 'banned'); api.analytics('refused', { detail: reason }); return; }
    openSite = entry;
    const seen = visit(entry.id);
    const onFoot = !api.drivenVehicle();
    const rows: FeatureMenuRow[] = [
      onFoot
        ? { id: 'ride-onfoot', label: 'Short time — not on foot', detail: 'Round the corner means a car. Come back with one and she is still here.', price: worker.price, disabled: true }
        : { id: 'ride', label: 'Short time — she sets the price', detail: 'Round the corner, ten minutes, and she keeps the money whatever happens.', price: worker.price },
      { id: 'info', label: 'Ask what is happening on this block', detail: 'She has stood here every night for years. It shows.', price: worker.infoPrice },
    ];
    // FREE, PERMANENT, AND SHE NEVER GETS BORED OF IT. The owner lost a destination because an NPC
    // told him once, in a toast, and then refused to say it again. Every person in this feature will
    // now repeat the last thing they told you, from any corner, at no charge, for as long as it holds.
    if (save.tipSite) rows.push({ id: 'tip-again', label: 'Say that again — where is it paying?', detail: `You were sent to ${district(save.tipSite)}. She will happily go through it again.`, note: 'FREE' });
    rows.push({ id: 'block', label: 'Who else is working, and where', detail: 'Every corner on the road, with distances. She knows all of them.', note: 'FREE' });
    rows.push({ id: 'street-status', label: `${worker.name} · ${worker.shift.start}h–${worker.shift.end}h`, detail: worker.tag, note: 'HER TERMS', disabled: true });
    api.showMenu({
      featureId: 'street',
      eyebrow: `${entry.district.toUpperCase()} · ${api.hour() >= 18 || api.hour() < 5 ? 'NIGHT SHIFT' : 'DAY SHIFT'}`,
      title: worker.name,
      blurb: cycle(worker.greet, seen),
      balance: api.balance(),
      rows,
      leaveLabel: 'Drive on',
    });
  }

  /**
   * The information she sells: a real, checkable corner price, worth several times the fee.
   *
   * DEALER CORNERS ONLY. This was a straight bug and it is the likeliest reason the owner called the
   * description impossible to follow: `bestDemand` was handed every site, so she could name the
   * district of a WORKER's kerb, quoting a bid price that no dealer in that district honours. You
   * drove across town on a real-sounding number, found a woman on a corner who does not buy zol, and
   * the tip never cleared because clearing it needs a sale at that exact site id.
   */
  function chooseTip(): string | undefined {
    const heaviest = STREET_PRODUCTS
      .map((product) => ({ product, held: save.stock[product] }))
      .sort((a, b) => b.held - a.held)[0]!;
    const product = heaviest.held > 0 ? heaviest.product : supplyProduct(sites[0]!.id, sites[0]!.cast);
    const target = bestDemand(sites.filter((entry) => entry.kind === 'dealer'), product);
    if (!target) return undefined;
    save.tipSite = target; save.tipProduct = product; dirty = true;
    syncGoal(); // the gold pillar goes up the instant she says it, not on the next reconcile tick
    const spec = productSpec(product);
    return `${district(target)} is short of ${spec.name.toLowerCase()} — they are paying about R${bidPrice(product, target, demandOf(target, product))} a ${spec.unit} there. Not the busy corner. The quiet one.`;
  }

  /** The standing directions to the current destination, in the game's own voice rather than hers,
   *  so her line stays a line and the navigation stays navigation. */
  function tipRow(): FeatureMenuRow | undefined {
    const target = site(save.tipSite);
    if (!target || !save.tipProduct) return undefined;
    const spec = productSpec(save.tipProduct);
    return {
      id: 'dir:tip',
      label: `MARKED — ${target.district}, ${Math.round(flat(api.playerPosition(), target))} m ${bearing(api.playerPosition(), target)}`,
      detail: `A gold pillar of light is standing over it, and a gold pin is on your map. Both stay up until you have sold ${spec.name.toLowerCase()} there.`,
      note: 'ON MAP', disabled: true,
    };
  }

  /**
   * What she knows, on a card you can sit and read — not a toast that outruns you.
   *
   * Reached two ways: paid for once (`info`), and then repeated free for ever (`tip-again`). The
   * repeat is the whole point. Nothing in this feature is ever said once.
   */
  function showTipCard(entry: StreetSite, paid: boolean): void {
    openSite = entry;
    const worker = workerFor(entry.cast);
    const seen = visits.get(entry.id) ?? 0;
    const line = paid || !save.tipSite ? chooseTip() : undefined;
    const standing = tipRow();
    const rows: FeatureMenuRow[] = [];
    if (standing) rows.push(standing);
    else rows.push({ id: 'dir:none', label: 'Nothing worth a drive tonight', detail: 'She will not invent a corner to keep you happy. Come back when you are carrying something.', note: '—', disabled: true });
    rows.push({ id: 'block', label: 'And the rest of the road?', detail: 'Every corner she knows, with distances from here.', note: 'FREE' });
    rows.push({ id: 'tip-done', label: 'Right. Thanks.', detail: 'The light will still be there. So will she.' });
    api.showMenu({
      featureId: 'street', eyebrow: `${worker.name.toUpperCase()} · WHAT SHE KNOWS`,
      title: save.tipSite ? `${district(save.tipSite)} is paying` : 'Nothing tonight',
      blurb: `${cycle(worker.info, seen)} ${line ?? standingLine()}`.trim(),
      balance: api.balance(), rows, leaveLabel: 'Walk on',
    });
  }

  /** Her own words for a tip she has already given, so the free repeat is a repeat, not a shrug. */
  function standingLine(): string {
    const target = site(save.tipSite);
    if (!target || !save.tipProduct) return 'Nothing worth selling you tonight, and I am not going to invent something.';
    const spec = productSpec(save.tipProduct);
    return `Same as I said: ${target.district}, short of ${spec.name.toLowerCase()}, about R${bidPrice(save.tipProduct, target.id, demandOf(target.id, save.tipProduct))} a ${spec.unit}. I am not going to get bored of telling you.`;
  }

  function buyInfo(entry: StreetSite): void {
    const worker = workerFor(entry.cast);
    const reason = refuseWindow(windowState(entry, worker));
    if (reason) { api.notify(worker.name, refusal(worker, reason), false); return; }
    if (!api.spend(worker.infoPrice)) { api.notify(worker.name, worker.refuse.broke, false); return; }
    showTipCard(entry, true);
    api.analytics('info', { value: worker.infoPrice });
    dirty = true;
  }

  function beginRide(entry: StreetSite): void {
    const worker = workerFor(entry.cast);
    const reason = refuseWindow(windowState(entry, worker));
    if (reason) { api.notify(worker.name, refusal(worker, reason), false); api.analytics('refused', { detail: reason }); return; }
    const vehicle = api.drivenVehicle();
    // Car-only, and the row is disabled on foot rather than failing here — but the guard stays,
    // because a ride with no car would be abandoned by the very next frame of update().
    if (!vehicle) { api.notify(worker.name, 'Round the corner means a car. Come back with one.', false); return; }
    if (!api.spend(worker.price)) { api.notify(worker.name, worker.refuse.broke, false); return; }
    const at = vehicle.group.position;
    ride = { site: entry, worker, pickupX: at.x, pickupZ: at.z, paid: worker.price };
    despawn(entry.id);
    api.closeMenu();
    api.notify(worker.name, worker.agree, true);
    api.analytics('ride_start', { detail: entry.district, value: worker.price });
    dirty = true;
  }

  function rideSpot(): { speed: number; distanceFromPickup: number } {
    const vehicle = api.drivenVehicle();
    const at = vehicle ? vehicle.group.position : api.playerPosition();
    return {
      speed: vehicle ? vehicle.speed : 0,
      distanceFromPickup: ride ? Math.hypot(at.x - ride.pickupX, at.z - ride.pickupZ) : 0,
    };
  }

  // ---- the cut scene ----------------------------------------------------------------------------

  /**
   * THE SHORT TIME, AS A CUT SCENE. Camera outside the car, black bars, the springs do the acting,
   * job done. Nothing explicit exists in this build, reachable or otherwise; the entire joke is in
   * the framing, which is exactly how the genre has always told it.
   *
   * It is PRESENTATION IN FRONT OF THE CARD, never a replacement for it. Every exit from here — the
   * full seven seconds, a skip, a bullet through the windscreen — lands on the same `finishRide()`,
   * so `save.rides`, her after-work cooldown, the tip she gives you and the analytics are identical
   * whichever way you leave. If the payoff could be lost by skipping, the skip would be a punishment
   * and the scene would be a tax.
   *
   * The seam is OPTIONAL by design (`api.cinema`), and a host without it is not a broken host: it
   * goes straight to the card, which is the feature. See FeatureGameApi.cinema.
   */
  function beginScene(): void {
    const current = ride;
    const car = api.drivenVehicle();
    if (!current || !car || !api.cinema) { finishRide(); return; }
    scene = {
      ride: current, car, health: car.health, t: 0,
      // Stable, from the kerb she was picked up at and how many rides deep the player is: the same
      // pickup replays the same shot, and nothing here can desync a save or a headless capture.
      phase: stablePositionRandom(current.pickupX, current.pickupZ, save.rides + 1),
    };
  }

  /** Puts the body back, hands the camera over, and forgets the scene — WITHOUT resolving the ride.
   *  The one path that must never show a card: a checkpoint reload or a dispose mid-scene. */
  function dropScene(): void {
    if (!scene) return;
    scene.car.setBodySway(0, 0, 0);
    scene = undefined;
    api.cinema?.(undefined);
  }

  function endScene(how: 'played' | 'skipped' | 'cut'): void {
    const played = scene?.t ?? 0;
    dropScene();
    api.analytics('scene', { detail: how, value: Math.round(played * 10) / 10 });
    // Bars down and camera released BEFORE the card, because showMenu pauses the world and a paused
    // world runs no sim step — anything still on this feature's clock would freeze exactly there.
    finishRide();
  }

  function advanceScene(dt: number): void {
    const current = scene;
    if (!current) return;
    current.t += dt;
    const car = api.drivenVehicle();
    // SHE IS GONE THE MOMENT THE SCENE IS. Dragged out of the car, shot at, or set alight: cut to
    // the card on the spot. A cutscene that keeps rolling over a firefight is not a joke, it is a
    // freeze, and the player will report it as one.
    if (!car || car !== current.car || car.onFire || car.health < current.health - 1) { endScene('cut'); return; }
    const at = car.group.position;
    const shot = shortTimeShot(at, car.heading, current.phase, api.surfaceHeightAt(at.x, at.z));
    if (api.cinema?.({ ...shot, hint: 'E  Skip' })) { endScene('skipped'); return; }
    // The VISUAL body only. The collider, the nav graph, traffic, police and the camera focus all go
    // on seeing a parked car — see Vehicle.setBodySway.
    const rock = bodyRock(current.t, current.phase);
    car.setBodySway(rock.pitch, rock.roll, rock.lift);
    if (current.t >= SCENE_LENGTH) endScene('played');
  }

  /**
   * The interlude. A card of conversation on a paused screen — nothing sexual exists in this build,
   * reachable or otherwise — and it grants NO health, no armour and no money back. GTA III's mistake
   * was making a person a health pickup. What you actually get is what she knows.
   */
  function finishRide(): void {
    const current = ride;
    if (!current) return;
    const worker = current.worker;
    save.rides += 1;
    busy.set(current.site.id, AFTER_WORK_SECONDS);
    ride = undefined;
    dirty = true;
    openSite = current.site;
    const line = chooseTip();
    const standing = tipRow();
    api.showMenu({
      featureId: 'street',
      eyebrow: 'LATER · ROUND THE CORNER',
      title: worker.name,
      blurb: `${worker.after} ${cycle(worker.info, save.rides)} ${line ?? standingLine()}`,
      rows: [
        ...(standing ? [standing] : []),
        { id: 'block', label: 'Who else is working, and where', detail: 'Every corner she knows, with distances from here.', note: 'FREE' },
        { id: 'ride-done', label: 'Drive on', detail: 'She is back on her corner before you have found first gear.' },
      ],
      leaveLabel: 'Drive on',
    });
    api.analytics('ride_end', { detail: current.site.district, value: current.paid });
  }

  function abandonRide(): void {
    const current = ride;
    if (!current) return;
    ride = undefined;
    busy.set(current.site.id, AFTER_WORK_SECONDS / 2);
    api.notify(current.worker.name, 'She gets out where you stopped, keeps the money, and is back on her corner in four minutes. That was the deal.', true);
    api.analytics('ride_abandoned', { detail: current.site.district });
    dirty = true;
  }

  // ---- interactions -----------------------------------------------------------------------------

  function nearestFixture(ctx: InteractionCtx, kind: StreetSite['kind'], range: number): Fixture | undefined {
    let best: Fixture | undefined; let bestDistance = range;
    for (const fixture of fixtures.values()) {
      if (fixture.dead || fixture.site.kind !== kind) continue;
      const distance = flat(fixture.ped.group.position, ctx.position);
      if (distance <= bestDistance) { bestDistance = distance; best = fixture; }
    }
    return best;
  }

  function dealerOffer(fixture: Fixture, prefix: string): InteractionOffer {
    const dealer = dealerFor(fixture.site.cast);
    const first = dealer.name.split(' ')[0];
    const product = supplyProduct(fixture.site.id, fixture.site.cast);
    const spec = productSpec(product);
    // The prompt quotes what the card will quote, resolved through the same calls, so the HUD line
    // and the row can never disagree — including when the corner is above your rank and is only
    // good for selling into.
    const tail = save.banned > 0 ? 'the corner is closed to you'
      : !sellsToYou(fixture.site.id, fixture.site.cast, save.tier) ? `${spec.name} at ${tierSpec(spec.tier).name}`
        : `${spec.name} R${askPrice(product, { siteId: fixture.site.id, tier: save.tier, levy: save.levy, blackout: api.blackout() })}`;
    return { prompt: `E  ${prefix} ${first} · ${tail}`, act: () => showDealer(fixture.site) };
  }

  function workerOffer(fixture: Fixture, prefix: string): InteractionOffer {
    const worker = workerFor(fixture.site.cast);
    // The prompt carries her answer BEFORE the press, resolved through the same refusal ladder the
    // press will run. E never promises a deal she is about to decline.
    const reason = refuseWindow(windowState(fixture.site, worker));
    const first = worker.name.split(' ')[0];
    return {
      prompt: reason ? `E  ${first} · ${refusalTag(worker, reason)}` : `E  ${prefix} ${first} · R${worker.price}`,
      act: () => showWorker(fixture.site),
    };
  }

  const rungs: InteractionDescriptor[] = [
    {
      // Above the trade rungs on purpose: while she is in the car, E belongs to the ride.
      id: 'street:ride', order: 46, context: 'vehicle',
      test: () => {
        // While the scene is rolling E belongs to the SKIP, which Game reads directly — a rung that
        // still offered here would put a second prompt on a screen that has no HUD.
        if (!ride || scene) return undefined;
        return isQuiet(rideSpot()) ? { prompt: 'E  Kill the lights', act: () => beginScene() } : undefined;
      },
    },
    {
      id: 'street:deal', order: 50, context: 'foot',
      test: (ctx) => { const fixture = nearestFixture(ctx, 'dealer', TALK_RANGE); return fixture ? dealerOffer(fixture, 'Talk to') : undefined; },
    },
    {
      id: 'street:worker', order: 51, context: 'foot',
      test: (ctx) => { const fixture = nearestFixture(ctx, 'worker', TALK_RANGE); return fixture ? workerOffer(fixture, 'Talk to') : undefined; },
    },
    {
      // A rung that always offers something in the vehicle context traps the player in the car, so
      // both of these demand a nearly stopped vehicle inside a short reach and return undefined
      // everywhere else. E stays "Exit vehicle" for the other 99.9% of the map.
      id: 'street:deal-window', order: 52, context: 'vehicle',
      test: (ctx) => {
        if (ride || !ctx.vehicle || Math.abs(ctx.vehicle.speed) > 4) return undefined;
        const fixture = nearestFixture(ctx, 'dealer', WINDOW_RANGE);
        return fixture ? dealerOffer(fixture, 'Kerb deal ·') : undefined;
      },
    },
    {
      id: 'street:worker-window', order: 53, context: 'vehicle',
      test: (ctx) => {
        if (ride || !ctx.vehicle || Math.abs(ctx.vehicle.speed) > 4) return undefined;
        const fixture = nearestFixture(ctx, 'worker', WINDOW_RANGE);
        return fixture ? workerOffer(fixture, 'Wind the window down ·') : undefined;
      },
    },
    // THERE IS DELIBERATELY NO "ASK AROUND" RUNG HERE ANY MORE.
    //
    // It used to sit at order 58 over a block-wide ring, and it was the only door into the feature:
    // press E on a vague prompt, receive a bearing in a four-second toast, then find a corner from
    // memory. The owner's report is what that costs — "a lot of work to find a clue", "the
    // instructions toasted too quickly to follow", "then the person stopped telling me". Every one of
    // those failures is a property of a treasure hunt whose only clue expires.
    //
    // What replaced it: the host loads this feature on proximity, the corner is staffed, lit and
    // blipped before you can see it, and you walk up to a PERSON. Directions are a re-readable page
    // on the menu card (`showDirectory`), not a toast. As a bonus the on-foot ladder is clear again,
    // so `E  Enter vehicle` works everywhere except within arm's reach of somebody.
  ];

  function nearestSite(x: number, z: number): { site: StreetSite; distance: number } | undefined {
    let best: StreetSite | undefined; let bestDistance = Infinity;
    for (const entry of sites) {
      const distance = Math.hypot(entry.x - x, entry.z - z);
      if (distance < bestDistance) { bestDistance = distance; best = entry; }
    }
    return best ? { site: best, distance: bestDistance } : undefined;
  }

  function bearing(from: { x: number; z: number }, to: { x: number; z: number }): string {
    const angle = Math.atan2(to.x - from.x, to.z - from.z);
    const points = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return points[Math.round(((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2)) * 8) % 8]!;
  }

  /** One line of the directory: who, where, how far, which way, and what they will do with you. */
  function directoryRow(entry: StreetSite, hour: number): FeatureMenuRow {
    const player = api.playerPosition();
    const away = `${Math.round(flat(player, entry))} m ${bearing(player, entry)}`;
    if (entry.kind === 'dealer') {
      const dealer = dealerFor(entry.cast);
      const long = supplyProduct(entry.id, entry.cast);
      const spec = productSpec(long);
      const wants = PRODUCTS.filter((product) => buysHere(entry.id, entry.cast, product.id)).map((product) => product.name.toLowerCase()).join(' and ');
      return {
        id: `dir:${entry.id}`, label: `${entry.district} — ${dealer.name}`,
        detail: `${away}. Sells ${spec.name.toLowerCase()}, buys ${wants}.`,
        note: sellsToYou(entry.id, entry.cast, save.tier) ? `R${askPrice(long, { siteId: entry.id, tier: save.tier, levy: save.levy, blackout: api.blackout() })}` : tierSpec(spec.tier).name.toUpperCase(),
        disabled: true,
      };
    }
    const worker = workerFor(entry.cast);
    const open = onShift(hour, worker.shift);
    return {
      id: `dir:${entry.id}`, label: `${entry.district} — ${worker.name}`,
      // The shift is ALWAYS printed, open or shut. A closed corner with the hours on it is a plan;
      // a closed corner with nothing on it is the empty pavement the owner walked to.
      detail: `${away}. ${worker.shift.start}h–${worker.shift.end}h${open ? ', on the kerb now' : `, back at ${worker.shift.start}h`}.`,
      note: open ? `R${worker.price}` : 'LATER',
      disabled: true,
    };
  }

  /**
   * THE PAGE THAT REPLACED THE TOAST.
   *
   * Every corner the road will admit to: name, district, metres, compass point, what it sells, what
   * it buys, and what hours she works. It is on a PAUSED card, it can be reopened from any corner
   * for free, for ever, and it costs nothing. This is the direct answer to "then the person stopped
   * telling me, so I can't find it" — nobody in this feature ever stops telling you.
   */
  /** Re-open whoever the player is standing in front of. The one place that knows which card. */
  function reopen(entry: StreetSite): void {
    if (entry.kind === 'dealer') showDealer(entry); else showWorker(entry);
  }

  function showDirectory(from: StreetSite): void {
    openSite = from;
    const hour = api.hour();
    const player = api.playerPosition();
    const ordered = [...sites].sort((a, b) => flat(player, a) - flat(player, b));
    const standing = tipRow();
    const rows: FeatureMenuRow[] = standing ? [standing] : [];
    // UIManager.back() RESUMES PLAY on a feature card — there is no card stack — so a page whose only
    // exit is "Back" would drop the player out of the conversation they opened it from.
    if (fixtures.has(from.id)) {
      const who = from.kind === 'dealer' ? dealerFor(from.cast).name : workerFor(from.cast).name;
      rows.push({ id: 'back-to-corner', label: `Back to ${who}`, detail: 'You are still standing in front of them.' });
    }
    rows.push(...ordered.map((entry) => directoryRow(entry, hour)));
    api.showMenu({
      featureId: 'street', eyebrow: 'THE ROAD · WHO IS WHERE',
      title: 'Every corner, and how far',
      blurb: 'Nobody here minds being asked twice. Orange lights are corners, purple lights are kerbs, and the gold one is wherever you were last sent.',
      rows, leaveLabel: 'Put it away and walk on',
    });
    api.analytics('directory', { detail: from.district });
  }

  // ---- frame ------------------------------------------------------------------------------------

  let reconcileTimer = 0;

  function update(dt: number): void {
    if (disposed) return;
    const hour = api.hour();
    advanceScene(dt); // first: a scene that ends this step must resolve before anything reads `ride`
    reconcileTimer -= dt;
    if (reconcileTimer <= 0) { reconcileTimer = 0.5; reconcile(hour); }
    tendFixtures(dt);
    drainToasts(dt);
    // The same pulse ShopSystem gives its entry pads, so a corner reads as the same kind of thing.
    beaconPhase += dt;
    const pulse = 0.42 + Math.sin(beaconPhase * 2.6) * 0.16;
    for (const group of beacons.values()) {
      const disc = group.children[0] as THREE.Mesh | undefined;
      if (disc) (disc.material as THREE.MeshBasicMaterial).opacity = pulse;
      group.rotation.y += dt * 0.9;
    }
    if (goal?.visible) { goal.rotation.y += dt * 0.7; }

    if (save.banned > 0) {
      const before = save.banned;
      save.banned = Math.max(0, save.banned - dt);
      if (before > 0 && save.banned === 0) {
        api.notify('Off the list', 'The road has decided you have paid for it. Do not make them decide again.', true);
        dirty = true;
      }
    }
    // When a corner's cooldown runs out the body goes with it: the fixture slot frees up, the corpse
    // stops being this feature's problem, and the block gets somebody new the next time you drive past.
    for (const [id, left] of cooldown) {
      const next = left - dt;
      if (next > 0) { cooldown.set(id, next); continue; }
      cooldown.delete(id);
      if (fixtures.get(id)?.dead) despawn(id);
    }
    for (const [id, left] of busy) { const next = left - dt; if (next <= 0) busy.delete(id); else busy.set(id, next); }
    for (const [key, value] of demand) { const next = recoverDemand(value, dt); if (next >= 1) demand.delete(key); else demand.set(key, next); }

    restockTimer -= dt;
    if (restockTimer <= 0) { restockTimer = RESTOCK_SECONDS; supply.clear(); }

    if (ride && !api.drivenVehicle()) abandonRide();

    if (dirty) { dirty = false; api.persist(); }
  }

  function hud(): FeatureHudEntry[] | undefined {
    const entries: FeatureHudEntry[] = [];
    if (ride) entries.push({ id: 'street:ride', label: ride.worker.name.split(' ')[0]!.toUpperCase(), value: quietHint(rideSpot()) });
    for (const product of PRODUCTS) {
      const held = save.stock[product.id];
      if (held > 0) entries.push({ id: `street:${product.id}`, label: product.name.toUpperCase(), value: `${held}` });
    }
    if (save.banned > 0) entries.push({ id: 'street:banned', label: 'ON THE LIST', value: `${banHours(save.banned)}h`, warn: true });
    else if (save.tipSite) {
      // The destination is on the HUD as well as the map and the world, and it carries the LIVE
      // distance. Three places, none of them a toast, so it cannot be lost by looking away.
      const target = site(save.tipSite);
      entries.push({ id: 'street:tip', label: district(save.tipSite).slice(0, 12).toUpperCase(), value: target ? `${Math.round(flat(api.playerPosition(), target))} m` : 'SELL' });
    }
    return entries.length > 0 ? entries.slice(0, 3) : undefined;
  }

  /**
   * Blips. Every corner, always, from the moment the feature loads — because a map that hides the
   * shops is not a map, and the owner's whole report is about a thing he could not find. Plus one
   * gold objective pin over the destination, which the minimap pins to its own edge with an arrow
   * when it is out of range, so it is impossible to lose no matter how far you drive.
   */
  function mapIcons(): FeatureMapIcon[] {
    const icons: FeatureMapIcon[] = sites.map((entry) => ({
      x: entry.x, z: entry.z, color: entry.kind === 'dealer' ? DEALER_COLOR : WORKER_COLOR,
    }));
    const target = site(save.tipSite);
    if (target) icons.push({ x: target.x, z: target.z, color: GOAL_COLOR, objective: true });
    return icons;
  }

  function menu(actionId: string): void {
    const entry = openSite;
    if (!entry) return;
    if (actionId === 'levy') { payLevy(entry); return; }
    if (actionId === 'fixer') { showFixer(entry); return; }
    if (actionId === 'block') { showDirectory(entry); return; }
    if (actionId === 'back-to-corner') { reopen(entry); return; }
    if (actionId === 'tip-again') { showTipCard(entry, false); return; }
    if (actionId === 'fixer-done' || actionId === 'ride-done' || actionId === 'tip-done') { api.closeMenu(); return; }
    if (actionId === 'ride') { beginRide(entry); return; }
    if (actionId === 'info') { buyInfo(entry); return; }
    if (actionId.startsWith('dir:')) return; // directory lines are reading matter, not buttons
    const [verb, product] = actionId.split(':') as [string, StreetProduct];
    if (!STREET_PRODUCTS.includes(product)) return;
    if (verb === 'buy1') buy(entry, product, 1);
    else if (verb === 'buymax') buy(entry, product, carryCap(save.tier));
    else if (verb === 'sell') sell(entry, product, save.stock[product]);
  }

  // ---- console + QA -----------------------------------------------------------------------------

  function command(args: readonly string[]): string[] {
    const [verb, ...rest] = args;
    const player = api.playerPosition();
    if (!verb || verb === 'status') {
      return [
        `rank ${tierSpec(save.tier).name} · turnover R${save.turnover} · levy R${save.levy}`,
        `holding ${carrying(save.stock)}/${carryCap(save.tier)} — ${STREET_PRODUCTS.map((product) => `${product} ${save.stock[product]}`).join(', ')}`,
        `bad-date list ${save.banned > 0 ? `${Math.round(save.banned)}s` : 'clear'} · rides ${save.rides} · fixtures live ${fixtures.size}`,
        save.tipSite ? `tip: ${district(save.tipSite)} pays for ${save.tipProduct}` : 'no tip in hand',
      ];
    }
    if (verb === 'sites') {
      return sites.map((entry) => `${entry.id.padEnd(26)} ${entry.kind.padEnd(6)} ${String(Math.round(flat(player, entry))).padStart(5)}m  tp ${Math.round(entry.x)} ${Math.round(entry.z)}  long:${supplyProduct(entry.id, entry.cast)}`);
    }
    if (verb === 'here') {
      const near = nearestSite(player.x, player.z);
      if (!near) return ['no sites'];
      const long = supplyProduct(near.site.id, near.site.cast);
      return [
        `${near.site.id} · ${near.site.district} · ${Math.round(near.distance)}m`,
        `long ${long} ask R${askPrice(long, { siteId: near.site.id, tier: save.tier, levy: save.levy, blackout: api.blackout() })}`,
        ...PRODUCTS.filter((product) => product.id !== long).map((product) => `bids ${product.id} R${Math.round(product.base * demandIndex(near.site.id, product.id) * demandOf(near.site.id, product.id))}`),
      ];
    }
    if (verb === 'give') {
      const product = STREET_PRODUCTS.find((entry) => entry === rest[0]);
      if (!product) return [`usage: feature street give <${STREET_PRODUCTS.join('|')}> <units>`];
      save.stock[product] += Math.max(1, Number(rest[1]) || 1);
      dirty = true;
      return [`holding ${carrying(save.stock)}`];
    }
    if (verb === 'clear') { save.banned = 0; save.levy = 0; dirty = true; return ['bad-date list cleared, subs written off']; }
    // Rolls the cut scene on the car you are sitting in, without the drive, the fare or the corner.
    // It goes through the REAL beginScene, so what you are looking at is what a player would get.
    if (verb === 'scene') {
      const car = api.drivenVehicle();
      if (!car) return ['get in a car first — the scene is shot around one'];
      const entry = sites.find((candidate) => candidate.kind === 'worker');
      if (!entry) return ['no worker corner on this map'];
      const at = car.group.position;
      ride = { site: entry, worker: workerFor(entry.cast), pickupX: at.x, pickupZ: at.z, paid: 0 };
      beginScene();
      return [scene ? 'rolling — E or SPACE to skip' : 'no cinema seam on this host; card only'];
    }
    return ['feature street [status|sites|here|give <product> <n>|scene|clear]'];
  }

  /**
   * Machine playthrough driver. The harness reaches this as `window.__qa.feature('street', action)`.
   * `stage` is the important one: it puts a real fixture in front of the player through the real
   * spawn path so the driver can then walk the REAL interaction ladder and the REAL menu DOM.
   */
  function qa(action: string, args: Record<string, unknown>): string {
    const player = api.playerPosition();
    if (action === 'sites') return `ok:${sites.length}`;
    if (action === 'status') return `ok:tier=${save.tier};turnover=${save.turnover};holding=${carrying(save.stock)};banned=${Math.round(save.banned)};rides=${save.rides};fixtures=${fixtures.size}`;
    if (action === 'stage') {
      const kind = args.kind === 'worker' ? 'worker' : 'dealer';
      const entry = sites.find((candidate) => candidate.kind === kind);
      if (!entry) return `failed:no-${kind}-site`;
      despawn(entry.id);
      cooldown.delete(entry.id);
      const heading = api.playerHeading();
      const staged: StreetSite = {
        ...entry,
        x: player.x + Math.sin(heading) * 2.4,
        z: player.z + Math.cos(heading) * 2.4,
        heading: heading + Math.PI,
      };
      const index = sites.indexOf(entry);
      sites.splice(index, 1, staged);
      spawn(staged);
      return fixtures.has(staged.id) ? `ok:${staged.id}` : `failed:spawn-refused`;
    }
    if (action === 'give') {
      const product = STREET_PRODUCTS.find((entry) => entry === args.product) ?? 'zol';
      save.stock[product] += Math.max(1, Number(args.units) || 1);
      return `ok:${carrying(save.stock)}`;
    }
    if (action === 'harm') {
      const fixture = [...fixtures.values()].find((candidate) => !candidate.dead);
      if (!fixture) return 'stuck:no-fixture';
      fixture.ped.takeDamage(12, api.playerPosition());
      return `ok:banned=${Math.round(save.banned)}`;
    }
    if (action === 'clear') { save.banned = 0; save.levy = 0; return 'ok'; }
    return `stuck:unknown-action:${action}`;
  }

  // ---- lifecycle --------------------------------------------------------------------------------

  return {
    update,
    hud,
    mapIcons,
    interactions: () => rungs,
    serialize: () => ({ ...save, stock: { ...save.stock }, met: [...save.met] }),
    restore: (next) => {
      const fresh = sanitizeStreetState(next);
      Object.assign(save, fresh, { stock: { ...fresh.stock }, met: [...fresh.met] });
      dropScene(); // a checkpoint landing mid-scene gets its camera and its bodywork back, and no card
      ride = undefined;
    },
    menu,
    command,
    /** The console's generic `give zol 5` route (registry.ts `grants`). Adds carried stock; the
     *  street-name aliases land on their product. Deliberately ignores the carry cap — it is a
     *  testing grant, and the sell path already handles any held amount. */
    grant: (item, count) => {
      const product: StreetProduct = item === 'bankie' || item === 'bankies' ? 'zol'
        : item === 'button' ? 'buttons'
          : item === 'straw' || item === 'straws' || item === 'whoonga' ? 'nyaope'
            : (STREET_PRODUCTS.find((entry) => entry === item) ?? 'zol');
      save.stock[product] += Math.max(1, count);
      dirty = true;
      const spec = productSpec(product);
      return `Holding ${save.stock[product]} ${save.stock[product] === 1 ? spec.unit : spec.plural} of ${spec.name} (${carrying(save.stock)} total).`;
    },
    qa,
    dispose: () => {
      disposed = true;
      dropScene(); // the bars and the borrowed camera are scene objects too, and dispose owns all of them
      for (const id of [...fixtures.keys()]) despawn(id);
      // Beacons are meshes we made, so we own their geometry and materials too — a scene removal
      // alone would leak both on every checkpoint reload. Idempotent: the maps are emptied.
      for (const id of [...beacons.keys()]) dropBeacon(id);
      if (goal) { beacon.remove(goal); disposeTree(goal); goal = undefined; }
      api.scene.remove(beacon);
      fixtures.clear(); cooldown.clear(); busy.clear(); demand.clear(); supply.clear(); visits.clear();
      ride = undefined; openSite = undefined;
    },
  };
}
