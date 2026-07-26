/**
 * STREET ECONOMY — corners, kerbs, and the Body Corporate.
 *
 * Lazily loaded: this file and its four siblings are reached ONLY through registry.ts's `load()`, so
 * rollup emits them as `street-<hash>.js` and boot never touches a byte of it. See ../README.md.
 *
 * What is here:
 *  - fixtures on derived kerb sites (`scripted`, never `contact`), pooled by proximity
 *  - a dealer trade with district pricing, corner demand, a carry cap, arrear subs and three ranks
 *  - a kerb negotiation in the VEHICLE context with a stated price and a refusal ladder
 *  - a short-time ride that grants nothing physical: what you get is the conversation, and the
 *    conversation is worth more than the fare because she knows which corner is paying tonight
 *  - a bad-date list: hurt anyone here and the whole trade shuts on you, citywide, for hours
 */
import type { FeatureGameApi, FeatureHudEntry, FeatureMenuRow, FeatureSystem, InteractionCtx, InteractionDescriptor, InteractionOffer } from '../types';
import type { Pedestrian } from '../../entities/Pedestrian';
import {
  ASK_AROUND_RADIUS, DEFAULT_STREET_STATE, sanitizeStreetState, STREET_PRODUCTS, streetSites,
  type StreetProduct, type StreetSaveState, type StreetSite,
} from '../street.state';
import { CALM_THRESHOLD } from '../../systems/FearSystem';
import { cycle, dealerFor, FIXER, LEVY_NOTES, PROMOTIONS, RADIO_BLAME, workerFor, type Worker } from './cast';
import {
  AFTER_WORK_SECONDS, BAD_DATE_LEVY, BAD_DATE_SECONDS, banHours, hoursUntilShift, isQuiet, onShift,
  quietHint, refuseWindow, type Refusal, type WindowState,
} from './rules';
import {
  askPrice, bestDemand, bidPrice, buysHere, carryCap, carrying, demandIndex, PRODUCTS, productSpec,
  quoteBuy, quoteSell, recoverDemand, sellsToYou, supplyProduct, tierFor, tierSpec,
} from './trade';

/** How close before a corner is staffed. Comfortably past draw distance, well inside the ped budget. */
const SPAWN_RADIUS = 190;
const DESPAWN_RADIUS = 260;
/** Reach of the on-foot conversation. Matches the game's own mug/melee reach so the two never disagree. */
const TALK_RANGE = 3.4;
/** Reach from a stopped car window. */
const WINDOW_RANGE = 8;
/** A corner restocks its own supply on this clock. */
const RESTOCK_SECONDS = 200;
const SUPPLY_PER_CORNER = 40;
/** After a fixture is killed, the block leaves that corner alone for a while. */
const CORNER_COOLDOWN = 420;

interface Fixture {
  readonly site: StreetSite;
  readonly ped: Pedestrian;
  /** Last seen health, so a single point of damage is enough to trip the bad-date list. */
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

export function createFeature(api: FeatureGameApi, state: unknown): FeatureSystem {
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
  let restockTimer = RESTOCK_SECONDS;
  let radio = 0;
  let sales = 0;
  let ride: Ride | undefined;
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
    fixtures.set(entry.id, { site: entry, ped, health: ped.health, dead: false });
  }

  function despawn(id: string): void {
    const fixture = fixtures.get(id);
    if (!fixture) return;
    api.removeFixture(fixture.ped);
    fixtures.delete(id);
  }

  /**
   * Somebody put hands on a person who works this street. The trade closes, citywide.
   *
   * Attribution is by PRESENCE, not by a damage-source hook the api does not expose: if the player
   * is not on the block, a stray traffic collision does not get blamed on them. Inside the ring it
   * is assumed to be yours, which in practice it always is.
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
      if (live?.dead) continue;
      if (!live && distance < SPAWN_RADIUS && working(entry, hour) && !(ride && ride.site.id === entry.id)) spawn(entry);
      else if (live && (distance > DESPAWN_RADIUS || (!working(entry, hour) && distance > 45))) despawn(entry.id);
    }
  }

  /** Fixtures stand their post. Fear, bumps and gunfire still move them; this walks them back. */
  function tendFixtures(): void {
    const player = api.playerPosition();
    for (const [id, fixture] of fixtures) {
      const ped = fixture.ped;
      if (ped.health < fixture.health) { fixture.health = ped.health; harmed(fixture); }
      if (ped.state === 'down') {
        if (!fixture.dead) { fixture.dead = true; cooldown.set(id, CORNER_COOLDOWN); harmed(fixture); }
        continue;
      }
      // Fear, bumps and gunfire still move a fixture — they are ordinary peds in every respect but
      // the census. Once calm, they go back to standing their corner instead of wandering off it.
      if (ped.state !== 'idle' && ped.fear < CALM_THRESHOLD) { ped.state = 'idle'; ped.idleTime = 999999; ped.setHail(true); }
      if (ped.state !== 'idle') continue;
      if (flat(ped.group.position, fixture.site) > 1.2 && flat(player, fixture.site) > 40) {
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
    if (save.tipSite === entry.id && save.tipProduct === product) { save.tipSite = undefined; save.tipProduct = undefined; }
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
      { id: 'street-status', label: `${worker.name} · ${worker.shift.start}h–${worker.shift.end}h`, detail: worker.tag, note: 'HER TERMS', disabled: true },
    ];
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

  /** The information she sells: a real, checkable corner price, worth several times the fee. */
  function tipLine(): string {
    const heaviest = STREET_PRODUCTS
      .map((product) => ({ product, held: save.stock[product] }))
      .sort((a, b) => b.held - a.held)[0]!;
    const product = heaviest.held > 0 ? heaviest.product : supplyProduct(sites[0]!.id, sites[0]!.cast);
    const target = bestDemand(sites, product);
    if (!target) return 'Nothing worth selling you tonight, and I am not going to invent something.';
    save.tipSite = target; save.tipProduct = product; dirty = true;
    const spec = productSpec(product);
    return `${district(target)} is short of ${spec.name.toLowerCase()} — they are paying about R${bidPrice(product, target, demandOf(target, product))} a ${spec.unit} there. Not the busy corner. The quiet one.`;
  }

  function buyInfo(entry: StreetSite): void {
    const worker = workerFor(entry.cast);
    const reason = refuseWindow(windowState(entry, worker));
    if (reason) { api.notify(worker.name, refusal(worker, reason), false); return; }
    if (!api.spend(worker.infoPrice)) { api.notify(worker.name, worker.refuse.broke, false); return; }
    const seen = visits.get(entry.id) ?? 0;
    api.notify(worker.name, `${cycle(worker.info, seen)} ${tipLine()}`, true);
    api.analytics('info', { value: worker.infoPrice });
    api.closeMenu();
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
    api.showMenu({
      featureId: 'street',
      eyebrow: 'LATER · ROUND THE CORNER',
      title: worker.name,
      blurb: `${worker.after} ${cycle(worker.info, save.rides)} ${tipLine()}`,
      rows: [{ id: 'ride-done', label: 'Drive on', detail: 'She is back on her corner before you have found first gear.' }],
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
        if (!ride) return undefined;
        return isQuiet(rideSpot()) ? { prompt: 'E  Kill the lights', act: () => finishRide() } : undefined;
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
    {
      // The block itself, so a corner is findable before you can see anybody on it. Same ring the
      // eager registry approach uses, so the prompt does not change when the chunk lands.
      //
      // ONE PRESS PER BLOCK, then it goes quiet for good. The on-foot feature rung sits above
      // `E Enter vehicle`, so a rung that kept offering inside a 46 m ring would quietly stop the
      // player getting into cars for a whole city block. Its only job is the gap before the chunk
      // loads and before anybody is standing there.
      id: 'street:ask', order: 58, context: 'foot',
      test: (ctx) => {
        const near = nearestSite(ctx.position.x, ctx.position.z);
        if (!near || near.distance > ASK_AROUND_RADIUS) return undefined;
        if (save.met.includes(near.site.id) || fixtures.has(near.site.id)) return undefined;
        return { prompt: `E  Ask around · ${near.site.district}`, act: () => askAround(near.site) };
      },
    },
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

  function askAround(entry: StreetSite): void {
    const player = api.playerPosition();
    const hour = api.hour();
    const partner = sites.find((other) => other.district === entry.district && other.kind !== entry.kind);
    const dealerSite = entry.kind === 'dealer' ? entry : partner;
    const workerSite = entry.kind === 'worker' ? entry : partner;
    const lines: string[] = [];
    if (dealerSite) lines.push(`${dealerFor(dealerSite.cast).name} works the corner about ${Math.round(flat(player, dealerSite))} m ${bearing(player, dealerSite)}.`);
    if (workerSite) {
      const worker = workerFor(workerSite.cast);
      lines.push(onShift(hour, worker.shift)
        ? `${worker.name} is on the kerb ${Math.round(flat(player, workerSite))} m ${bearing(player, workerSite)}.`
        : `${worker.name} works this block from ${worker.shift.start}h.`);
    }
    api.notify(entry.district, lines.join(' ') || 'Nobody is working this block right now.', true);
    // The whole block counts as asked, so the rung stands down for both corners on it.
    for (const other of sites) if (other.district === entry.district && !save.met.includes(other.id)) save.met.push(other.id);
    dirty = true;
    api.analytics('ask_around', { detail: entry.district });
  }

  // ---- frame ------------------------------------------------------------------------------------

  let reconcileTimer = 0;

  function update(dt: number): void {
    if (disposed) return;
    const hour = api.hour();
    reconcileTimer -= dt;
    if (reconcileTimer <= 0) { reconcileTimer = 0.5; reconcile(hour); }
    tendFixtures();
    drainToasts(dt);

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
    else if (save.tipSite) entries.push({ id: 'street:tip', label: 'TIP', value: district(save.tipSite).slice(0, 12) });
    return entries.length > 0 ? entries.slice(0, 3) : undefined;
  }

  function menu(actionId: string): void {
    const entry = openSite;
    if (!entry) return;
    if (actionId === 'levy') { payLevy(entry); return; }
    if (actionId === 'fixer') { showFixer(entry); return; }
    if (actionId === 'fixer-done' || actionId === 'ride-done') { api.closeMenu(); return; }
    if (actionId === 'ride') { beginRide(entry); return; }
    if (actionId === 'info') { buyInfo(entry); return; }
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
    return ['feature street [status|sites|here|give <product> <n>|clear]'];
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
    interactions: () => rungs,
    serialize: () => ({ ...save, stock: { ...save.stock }, met: [...save.met] }),
    restore: (next) => {
      const fresh = sanitizeStreetState(next);
      Object.assign(save, fresh, { stock: { ...fresh.stock }, met: [...fresh.met] });
      ride = undefined;
    },
    menu,
    command,
    qa,
    dispose: () => {
      disposed = true;
      for (const id of [...fixtures.keys()]) despawn(id);
      fixtures.clear(); cooldown.clear(); busy.clear(); demand.clear(); supply.clear(); visits.clear();
      ride = undefined; openSite = undefined;
    },
  };
}
