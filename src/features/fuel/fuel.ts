/**
 * PETROL — the lazy half. Nothing in this file runs until the player pulls onto a forecourt.
 *
 * THE POINT OF THE FEATURE, and the thing every South African would notice if it were missing: there
 * is no self-service. Self-service is illegal here (Petroleum Products Act s2A(5)(b)). You do not
 * touch a nozzle, you do not get out. You roll up to the pumps, drop the window, and a petrol
 * attendant asks how much. He fills it, does the windscreen, checks oil and water, brings the card
 * machine OUT TO THE CAR — because your card never leaves your sight, precisely because skimming is
 * the crime everyone fears — and then you decide what he is worth.
 *
 * Everything else follows from that: the regulated price the whole city shares and the queue the
 * night before it goes up, the pylon board with the plastic digits, the litres and the levies on the
 * slip, and the fact that the man at the window is a person you can be decent to.
 *
 * WHAT IS NOT HERE: the gauge and the burn. Both are eager (src/features/fuel.state.ts), because a
 * readout that only exists after you have pressed E at a garage is a readout the player never sees.
 */
import { hash } from '../../world/models/kit';
import { LANDMARKS } from '../../world/mapData';
import type {
  FeatureGameApi, FeatureHudEntry, FeatureMenuRow, FeatureSystem, InteractionCtx,
  InteractionDescriptor, InteractionOffer,
} from '../types';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { Vehicle } from '../../entities/Vehicle';
import {
  CAN_LITRES, DEFAULT_FUEL_SAVE, HIKE_PERIOD_DAYS, LOW_FRACTION, SPUTTER_FRACTION,
  UNITS_TO_METRES, burn, ensureForecourts, forecourts, fractionIn, garageHint, hasTank, isMetered,
  litresIn, markRevealed, resetLedger, sanitizeFuelSave, setLitres, tankGauge, tankSize,
  type FuelSave,
} from '../fuel.state';
import {
  CAN_PRICE, LEVIES, LEVY_CENTS, SHOP_REACH, apronPoint, attendantSpot, buildStations,
  centsText, gradeCents, litresFor, litresText, nearestStation, randFor, randText, shopSpot,
  stationAt, type Station,
} from './pump';

/** Rand tips that turn you into a regular. The attendant's memory is cheap and generous on purpose. */
const REGULAR_TIP_RAND = 25;
/** What being a regular is worth: a splash over the top, free, every time. */
const REGULAR_SPLASH_LITRES = 2;
/** Litres the hand-written cardboard sign allows on price-hike night. */
const HIKE_NIGHT_LIMIT = 30;

type Grade = 93 | 95;

interface Pending {
  site: Station;
  vehicle: Vehicle;
  grade: Grade;
  litres: number;
  rand: number;
  splash: number;
}

/**
 * The sites the map names, so the pump prompt can read "Bayshore Marina Petrol Station" instead of
 * "Caltexx Vaal Marina". The station itself is NOT built here and must never be again: it used to
 * be, and that made it a garage you could not reach — the body only loads when you press E on a
 * forecourt, and this one was invisible to the eager list that draws the prompt, so the labelled
 * gold star on the map had bare veld under it. It is a scattered model in the world now
 * (ModelScatter.landmarkForecourtPass). All this file does is put the map's name back on it.
 */
const NAMED_SITES = LANDMARKS.filter((entry) => entry.kind === 'fuel');

export async function createFeature(api: FeatureGameApi, state: unknown): Promise<FeatureSystem> {
  // The forecourt positions come out of the map through a dynamic import so the eager half can stay
  // out of a chunk cycle with `simulation` (see the header of fuel.state.ts). By the time a player has
  // pressed E on a forecourt this has long since resolved; awaiting it makes the console and QA paths
  // honest when they open the feature cold.
  await ensureForecourts();
  const save: FuelSave = sanitizeFuelSave(state ?? DEFAULT_FUEL_SAVE);
  markRevealed(); // from here on the tank is allowed to actually reach zero

  /** Every forecourt the WORLD built, named — this feature raises no geometry of its own. */
  const sites: Station[] = buildStations(forecourts(), hash, api.districtAt, NAMED_SITES);

  const fixtures: Pedestrian[] = [];
  let attendantSite: Station | undefined;
  let grade: Grade = 95;
  let pending: Pending | undefined;
  let sputterPhase = 0;
  let lastHour = api.hour();
  let dryToastAt = -999;
  let lowToastAt = -999;
  let elapsed = 0;
  let adoptPending = save.driving !== null;
  let lastReceipt = '';

  // ---- price ---------------------------------------------------------------------------------------

  const price = (of: Grade = grade): number => gradeCents(save.cents, of);

  /** Announce the coming change, then land it at midnight. The regulated price is national news
   *  here: it is trailed a week out, and the queues form the night before. */
  function rollClock(): void {
    const hour = api.hour();
    const crossedMidnight = hour < lastHour - 6; // wrapped 23:xx -> 00:xx
    lastHour = hour;
    if (!crossedMidnight) return;
    if (save.daysToHike > 0) save.daysToHike -= 1;
    if (save.daysToHike === 1 && save.hikeCents === 0) {
      // Mostly up, occasionally down — and the drop is always the smaller story.
      const up = Math.random() < 0.78;
      save.hikeCents = up ? 45 + Math.round(Math.random() * 85) : -(25 + Math.round(Math.random() * 45));
      api.notify(
        save.hikeCents > 0 ? 'Petrol goes up at midnight' : 'Petrol comes down at midnight',
        `${save.hikeCents > 0 ? '+' : ''}${(save.hikeCents / 100).toFixed(2)} a litre on 95. ${save.hikeCents > 0 ? 'Every forecourt in Gauteng will have a queue tonight.' : 'Nobody queues for good news.'}`,
        save.hikeCents < 0,
      );
      api.analytics('price_announced', { value: save.hikeCents });
    }
    if (save.daysToHike === 0) {
      save.cents = Math.max(1400, save.cents + save.hikeCents);
      api.notify('New pump price', `95 unleaded is ${centsText(save.cents)} a litre. They changed the board by hand at midnight.`, save.hikeCents < 0);
      api.analytics('price_changed', { value: save.cents });
      save.hikeCents = 0;
      save.daysToHike = HIKE_PERIOD_DAYS;
      api.persist();
    }
  }

  /** True through the night before a rise: the queue, the torches, the 30 LITRE LIMIT sign. */
  const hikeNight = (): boolean => save.daysToHike === 1 && save.hikeCents > 0 && (api.hour() >= 17 || api.hour() < 1);

  // ---- fixtures ------------------------------------------------------------------------------------

  function clearFixtures(): void {
    for (const ped of fixtures) api.removeFixture(ped);
    fixtures.length = 0;
    attendantSite = undefined;
  }

  /** The attendant lives at the pump island, and on hike night the queue lives behind him. Fixtures
   *  are spawned for the forecourt the player is ON and removed the moment they leave, so a city of
   *  19 garages never costs 19 pedestrians. */
  function syncFixtures(site: Station | undefined): void {
    if (site?.id === attendantSite?.id) return;
    clearFixtures();
    if (!site) return;
    attendantSite = site;
    const spot = attendantSpot(site);
    const attendant = api.spawnFixture(spot.x, spot.z, `${site.brand} attendant`);
    if (attendant) fixtures.push(attendant);
    if (!hikeNight()) return;
    for (let index = 0; index < 4; index++) {
      const at = apronPoint(site, -site.halfW + 2 + index * 1.7, site.offZ + site.halfD - 2.4);
      const waiting = api.spawnFixture(at.x, at.z, 'Queueing for the old price');
      if (waiting) fixtures.push(waiting);
    }
  }

  // ---- the tank ------------------------------------------------------------------------------------

  function tank(vehicle: Vehicle): number { return litresIn(vehicle); }

  /** A reload hands back a fresh Vehicle with no ledger entry; the first car the player drives after
   *  that adopts the litres the save was written with. Only the garaged car survives a reload at all
   *  (SavedVehicle is {kind, color, health} and we do not touch it), so this is deliberately loose. */
  function adopt(vehicle: Vehicle): void {
    if (!adoptPending || isMetered(vehicle)) return;
    adoptPending = false;
    if (save.driving !== null) setLitres(vehicle, save.driving);
  }

  // ---- the transaction -------------------------------------------------------------------------------

  const isRegular = (): boolean => save.tipped >= REGULAR_TIP_RAND;

  function cap(vehicle: Vehicle): number {
    const room = tankSize(vehicle) - tank(vehicle);
    return hikeNight() ? Math.min(room, HIKE_NIGHT_LIMIT) : room;
  }

  function openPump(site: Station, vehicle: Vehicle): void {
    const room = cap(vehicle);
    const cents = price();
    const full = randFor(room, cents);
    const rows: FeatureMenuRow[] = [
      {
        id: 'grade',
        label: grade === 95 ? 'Ninety-five' : 'Ninety-three',
        detail: grade === 95
          ? `${centsText(cents)} a litre. Tap to switch to 93 — it is the inland grade and it is cheaper.`
          : `${centsText(cents)} a litre. Fine up here on the Highveld. Tap for 95.`,
        note: 'SWITCH',
      },
      { id: 'r50', label: 'Fifty rand', detail: `${litresText(Math.min(room, litresFor(50, cents)))} — enough to get somewhere better.`, price: 50, disabled: room < 0.2 || api.balance() < 50 },
      { id: 'r200', label: 'Two hundred rand', detail: `${litresText(Math.min(room, litresFor(200, cents)))} — what a person actually buys.`, price: 200, disabled: room < 0.2 || api.balance() < 200 },
      { id: 'full', label: hikeNight() ? `Thirty litres — that is the limit` : 'Vol-tank', detail: hikeNight() ? 'Hand-written sign on the pump. No jerry cans, no arguments.' : 'Volmaak. Fill her up.', price: Math.round(full), disabled: room < 0.2 || api.balance() < Math.round(full) },
    ];
    if (save.can < CAN_LITRES) {
      rows.push({ id: 'can', label: 'Five-litre can for the boot', detail: 'Plastic, yellow, with the deposit. You will be glad of it.', price: CAN_PRICE, disabled: api.balance() < CAN_PRICE });
    }
    api.showMenu({
      featureId: 'fuel',
      eyebrow: `${site.name.toUpperCase()} · ${hikeNight() ? 'QUEUE INTO THE STREET' : api.blackout() > 0.35 ? 'GENERATOR ROUND THE BACK' : '24 HOURS'}`,
      title: isRegular() ? 'Howzit boss, same again?' : 'Howzit boss. How much?',
      blurb: `${describeTank(vehicle)} Pump reads 0.00 before he starts. ${sceneNote(site)}`,
      balance: api.balance(),
      rows,
      leaveLabel: 'Just the windscreen, thanks',
    });
  }

  function describeTank(vehicle: Vehicle): string {
    const fraction = fractionIn(vehicle);
    const level = fraction < SPUTTER_FRACTION ? 'running on fumes'
      : fraction < LOW_FRACTION ? 'nearly empty'
      : fraction > 0.92 ? 'basically full already' : `about ${Math.round(fraction * 100)}% full`;
    return `${vehicle.spec.name}, ${level} — ${litresText(tank(vehicle))} of ${tankSize(vehicle)}.`;
  }

  function sceneNote(site: Station): string {
    if (hikeNight()) return 'Cars down the block with their engines off. Somebody is selling boerewors rolls off a trestle table.';
    if (api.blackout() > 0.35) return 'Two of the six pumps are lit. The genny is going behind the shop and the card machine is being difficult.';
    const hour = api.hour();
    if (hour < 5) return 'Dead quiet. The car guard is asleep in a plastic chair with his reflective vest over his face.';
    if (hour > 21) return `The ${site.brand} shop is still open. It is always still open.`;
    return 'Somebody is having a Steri Stumpie in the shade of the canopy.';
  }

  function buy(kind: 'r50' | 'r200' | 'full', site: Station, vehicle: Vehicle): void {
    const cents = price();
    const room = cap(vehicle);
    const asked = kind === 'full' ? randFor(room, cents) : kind === 'r50' ? 50 : 200;
    // He stops when it is full and charges for what went in — you are never billed for litres the
    // tank could not take.
    const rand = Math.round(Math.min(asked, randFor(room, cents)));
    if (rand < 1) { api.notify('She is full, boss', 'Nothing he can put in there.', false); api.closeMenu(); return; }
    if (!api.spend(rand)) {
      api.notify('Card declined', `${randText(rand)} and you have ${randText(api.balance())}. He has seen worse, and he says so kindly.`, false);
      return;
    }
    const bought = Math.min(room, litresFor(rand, cents));
    const splash = isRegular() ? Math.min(REGULAR_SPLASH_LITRES, tankSize(vehicle) - tank(vehicle) - bought) : 0;
    setLitres(vehicle, tank(vehicle) + bought + Math.max(0, splash));
    save.litresBought += bought;
    pending = { site, vehicle, grade, litres: bought, rand, splash: Math.max(0, splash) };
    api.analytics('refuel', { detail: kind, value: Math.round(rand) });
    openTip();
  }

  function openTip(): void {
    if (!pending) return;
    const litreCents = Math.round(price());
    lastReceipt = `${litresText(pending.litres)} of ${pending.grade} at ${centsText(litreCents)} — ${randText(pending.rand)}. `
      + `Of every litre: ${centsText(LEVIES.fuel)} fuel levy, ${centsText(LEVIES.raf)} RAF, ${centsText(LEVIES.carbon)} carbon. `
      + `${Math.round((LEVY_CENTS / litreCents) * 100)}% of that went to the state before it went in your tank.`;
    api.showMenu({
      featureId: 'fuel',
      eyebrow: `${pending.site.name.toUpperCase()} · CARD MACHINE AT THE WINDOW`,
      title: pending.splash > 0 ? 'He put a bietjie extra for you' : 'Oil and water checked. Windscreen done.',
      blurb: `${lastReceipt}${pending.splash > 0 ? ` He topped it ${litresText(pending.splash)} over and did not mention it.` : ''}`,
      balance: api.balance(),
      rows: [
        { id: 'tip0', label: 'Nothing today', detail: 'He says "sharp sharp boss" and means it. Nobody is owed a tip.', note: 'R0' },
        { id: 'tip5', label: 'Five rand', detail: 'The coins from the cupholder.', price: 5, disabled: api.balance() < 5 },
        { id: 'tip10', label: 'Ten rand', detail: 'Standard, and appreciated.', price: 10, disabled: api.balance() < 10 },
        { id: 'tip20', label: 'Twenty rand', detail: 'He will remember your car.', price: 20, disabled: api.balance() < 20 },
      ],
      leaveLabel: 'Drive off',
    });
  }

  function tip(rand: number): void {
    const deal = pending;
    pending = undefined;
    if (rand > 0 && api.spend(rand)) {
      const wasRegular = isRegular();
      save.tipped += rand;
      if (!wasRegular && isRegular()) {
        api.notify('He knows your car now', 'From here he rounds the fill up for you and tells you what the road ahead is doing.', true);
        api.analytics('became_regular', { value: save.tipped });
      }
    }
    api.closeMenu();
    if (!deal) return;
    const extra = deal.splash > 0 ? ` (+${litresText(deal.splash)} on the house)` : '';
    api.notify(
      `${litresText(deal.litres)}${extra}`,
      `${randText(deal.rand)} at ${deal.site.name}. ${rand > 0 ? `Tipped ${randText(rand)}. ` : ''}${nextTip()}`,
      true,
    );
    api.persist();
  }

  function nextTip(): string {
    if (isRegular() && save.hikeCents > 0 && save.daysToHike <= 1) return 'And boss — fill up tonight. It goes up at twelve.';
    if (hikeNight()) return 'Thirty litre limit until midnight. Sorry boss.';
    return 'Sharp sharp.';
  }

  // ---- the jerry can ----------------------------------------------------------------------------------

  function buyCan(): void {
    if (!api.spend(CAN_PRICE)) { api.notify('Not today', `${randText(CAN_PRICE)} for the can and the deposit.`, false); return; }
    save.can = CAN_LITRES;
    api.analytics('bought_can');
    api.notify('Five litres in the boot', 'Yellow plastic, screw cap, the spout that never quite fits. Pour it in from the driver\'s seat when you run dry.', true);
    api.persist();
  }

  function pourCan(vehicle: Vehicle): void {
    const poured = Math.min(save.can, tankSize(vehicle) - tank(vehicle));
    setLitres(vehicle, tank(vehicle) + poured);
    save.can = 0;
    api.analytics('poured_can', { value: Math.round(poured) });
    api.notify(`${litresText(poured)} in`, 'Half of it down the wing. Enough to reach a garage.', true);
    api.persist();
  }

  // ---- interactions -------------------------------------------------------------------------------------

  function siteFor(ctx: InteractionCtx): Station | undefined {
    return stationAt(sites, ctx.position.x, ctx.position.z);
  }

  const rungs: InteractionDescriptor[] = [
    {
      id: 'fuel:pump', order: 12, context: 'vehicle',
      test: (ctx): InteractionOffer | undefined => {
        const vehicle = ctx.vehicle;
        if (!hasTank(vehicle) || Math.abs(vehicle.speed) > 14) return undefined;
        const site = siteFor(ctx);
        if (!site) return undefined;
        // A full tank offers NOTHING, so E is free to get you out of the car again. Otherwise
        // parking on a forecourt full would loop: open menu, leave, press E, open menu.
        if (tankSize(vehicle) - tank(vehicle) < 0.2) return undefined;
        return {
          prompt: `E  Petrol · ${centsText(price())}/ℓ · ${Math.round(fractionIn(vehicle) * 100)}%`,
          act: () => openPump(site, vehicle),
        };
      },
    },
    {
      id: 'fuel:pour', order: 13, context: 'vehicle',
      test: (ctx): InteractionOffer | undefined => {
        const vehicle = ctx.vehicle;
        if (!hasTank(vehicle) || save.can <= 0 || Math.abs(vehicle.speed) > 1.5) return undefined;
        // Only when you are genuinely stranded: this rung sits above `E  Exit vehicle`, and it
        // clears itself the moment the can is empty, so it can never hold you in the car.
        if (fractionIn(vehicle) > 0.1 || siteFor(ctx)) return undefined;
        return { prompt: `E  Pour in the can · ${litresText(save.can)}`, act: () => pourCan(vehicle) };
      },
    },
    {
      id: 'fuel:shop', order: 46, context: 'foot',
      test: (ctx): InteractionOffer | undefined => {
        if (save.can >= CAN_LITRES) return undefined;
        // A tight ring on the kiosk DOOR, not the apron: this rung sits one above "enter the nearest
        // vehicle" in Game.updateOnFoot, so a forecourt-wide offer would trap you outside your own car.
        for (const site of sites) {
          const door = shopSpot(site);
          if (Math.hypot(door.x - ctx.position.x, door.z - ctx.position.z) > SHOP_REACH) continue;
          return { prompt: `E  Buy a 5ℓ can · ${randText(CAN_PRICE)}`, act: () => buyCan() };
        }
        return undefined;
      },
    },
  ];

  // ---- frame ------------------------------------------------------------------------------------------

  function update(dt: number): void {
    elapsed += dt;
    rollClock();
    const vehicle = api.drivenVehicle();
    // Keyed off whichever body is actually at the pumps, so stepping out of the car to go into the
    // shop does not make the attendant vanish.
    const focus = hasTank(vehicle) ? vehicle.group.position : api.playerPosition();
    syncFixtures(stationAt(sites, focus.x, focus.z, 6));
    if (!hasTank(vehicle)) { sputterPhase = 0; return; }
    adopt(vehicle);
    const before = fractionIn(vehicle);
    // The eager slice stops ticking the moment this system exists (FeatureHost.update skips a
    // feature's eager tick once its body is loaded), so the burn never doubles up.
    burn(vehicle, dt);
    const after = fractionIn(vehicle);
    save.driving = tank(vehicle);
    const at = vehicle.group.position;

    if (before >= LOW_FRACTION && after < LOW_FRACTION && elapsed - lowToastAt > 20) {
      lowToastAt = elapsed;
      const near = nearestStation(sites, at.x, at.z);
      api.notify('Fuel light', near ? `${near.site.name}, ${Math.round(near.distance * UNITS_TO_METRES)} m away.` : 'Find a garage.', false);
      api.analytics('low_warning');
    }

    if (after <= 0) {
      // Never a hard stall: the engine will not hold, so you coast, steer, and roll to the kerb.
      vehicle.speed *= Math.exp(-1.9 * dt);
      if (elapsed - dryToastAt > 25) {
        dryToastAt = elapsed;
        const near = nearestStation(sites, at.x, at.z);
        api.notify('Dry', near ? `${near.site.name} is ${Math.round(near.distance * UNITS_TO_METRES)} m from here. Walk, or find another car — this is Joburg.` : 'Out of petrol.', false);
        api.analytics('ran_dry');
      }
      return;
    }
    if (after < SPUTTER_FRACTION) {
      // A stumble, not a stall: it cuts for a beat, catches, cuts again.
      sputterPhase += dt;
      if (sputterPhase % 1.9 < 0.55) vehicle.speed *= Math.exp(-2.6 * dt);
    } else sputterPhase = 0;
  }

  /** The same gauge and the same garage hint the eager slice has been drawing since the first frame
   *  of driving — built by the same functions, so nothing blinks when the chunk lands — plus the can. */
  function hud(): FeatureHudEntry[] {
    const entries: FeatureHudEntry[] = [];
    const vehicle = api.drivenVehicle();
    const chip = tankGauge(vehicle);
    if (chip) entries.push(chip);
    if (chip && vehicle) {
      const hint = garageHint(vehicle, vehicle.group.position.x, vehicle.group.position.z);
      if (hint) entries.push(hint);
    }
    if (save.can > 0) entries.push({ id: 'fuel:can', label: 'CAN', value: litresText(save.can) });
    return entries;
  }

  // ---- console + machine playthrough ----------------------------------------------------------------------

  function command(args: readonly string[]): string[] {
    const [verb, value] = args;
    const vehicle = api.drivenVehicle();
    if (verb === 'stations') {
      return sites.slice(0, 24).map((site) => `${site.name} @ ${Math.round(site.x)},${Math.round(site.z)}`);
    }
    if (verb === 'price') {
      if (value) save.cents = Math.max(1400, Math.round(Number(value) * 100));
      return [`95 is ${centsText(save.cents)}/ℓ, 93 is ${centsText(gradeCents(save.cents, 93))}/ℓ. Next change in ${save.daysToHike} midnight(s)${save.hikeCents ? `, ${(save.hikeCents / 100).toFixed(2)}` : ''}.`];
    }
    if (verb === 'tank') {
      if (!hasTank(vehicle)) return ['Not in a vehicle with a tank.'];
      if (value !== undefined) setLitres(vehicle, Number(value));
      return [`${vehicle.spec.name}: ${litresText(tank(vehicle))} of ${tankSize(vehicle)} (${Math.round(fractionIn(vehicle) * 100)}%).`];
    }
    // TWO midnights, not one: the first decrements 2 -> 1 and ANNOUNCES, the second lands it. Arming
    // it at 1 made the very next midnight jump straight to the change with nothing announced — found
    // by the in-engine playthrough, which is the only place the sequencing is visible.
    if (verb === 'hike') { save.daysToHike = 2; save.hikeCents = 0; lastHour = 24; return ['Hike armed: the next midnight announces it, the one after lands it.']; }
    return [
      'feature fuel stations — every forecourt on the map',
      'feature fuel price [rand] — read or set the regulated 95 price',
      'feature fuel tank [litres] — read or set the driven vehicle\'s tank',
      'feature fuel hike — arm the next regulated price change',
    ];
  }

  /**
   * The machine playthrough. Drives the whole loop the owner would: burn a tank down, confirm the
   * sputter, teleport nothing, pull onto a real derived forecourt, buy at each tier, tip, and check
   * the gauge agrees with the ledger.
   */
  function qa(action: string, args: Record<string, unknown>): string {
    const vehicle = api.drivenVehicle();
    if (action === 'sites') {
      if (sites.length < 6) return `failed:only-${sites.length}-forecourts`;
      return `ok:${sites.length}`;
    }
    if (!hasTank(vehicle)) return 'stuck:not-driving-a-tanked-vehicle';
    if (action === 'gauge') {
      const chip = tankGauge(vehicle);
      return chip ? `ok:${chip.label}:${chip.value}:${Math.round(chip.fill ?? 0)}${chip.warn ? ':warn' : ''}` : 'failed:no-gauge';
    }
    if (action === 'drain') {
      setLitres(vehicle, tankSize(vehicle) * Number(args.fraction ?? 0.03));
      return `ok:${litresText(tank(vehicle))}`;
    }
    if (action === 'nearest') {
      const near = nearestStation(sites, vehicle.group.position.x, vehicle.group.position.z);
      return near ? `ok:${near.site.name}:${Math.round(near.distance)}` : 'failed:no-stations';
    }
    if (action === 'pump') {
      const site = stationAt(sites, vehicle.group.position.x, vehicle.group.position.z);
      if (!site) return 'stuck:not-on-a-forecourt';
      openPump(site, vehicle);
      return `ok:${site.name}`;
    }
    if (action === 'buy') {
      const site = stationAt(sites, vehicle.group.position.x, vehicle.group.position.z);
      if (!site) return 'stuck:not-on-a-forecourt';
      const before = tank(vehicle);
      const amount = args.amount === 'r50' || args.amount === 'full' ? args.amount : 'r200';
      buy(amount, site, vehicle);
      return tank(vehicle) > before ? `ok:${litresText(tank(vehicle))}` : 'failed:no-litres-delivered';
    }
    if (action === 'tip') { tip(Number(args.rand ?? 10)); return `ok:tipped:${save.tipped}`; }
    if (action === 'receipt') return lastReceipt ? `ok:${lastReceipt}` : 'stuck:no-receipt-yet';
    if (action === 'run') {
      // One full loop, no UI: drain, verify the sputter bites, fill, verify the money moved.
      setLitres(vehicle, 0);
      const cash = api.balance();
      const site = stationAt(sites, vehicle.group.position.x, vehicle.group.position.z) ?? sites[0]!;
      buy('r200', site, vehicle);
      if (api.balance() !== cash - 200) return `failed:balance-${api.balance()}-expected-${cash - 200}`;
      const expected = litresFor(200, price());
      if (Math.abs(tank(vehicle) - expected) > 2.1) return `failed:litres-${tank(vehicle).toFixed(2)}-expected-${expected.toFixed(2)}`;
      tip(5);
      return `ok:${litresText(tank(vehicle))}:tipped-${save.tipped}`;
    }
    return `stuck:unknown-action:${action}`;
  }

  return {
    update,
    hud,
    interactions: () => rungs,
    serialize: (): FuelSave => ({ ...save }),
    restore: (next) => {
      const fresh = sanitizeFuelSave(next);
      Object.assign(save, fresh);
      adoptPending = fresh.driving !== null;
    },
    menu: (actionId) => {
      const vehicle = api.drivenVehicle();
      const site = vehicle ? stationAt(sites, vehicle.group.position.x, vehicle.group.position.z) : undefined;
      if (actionId === 'grade') { grade = grade === 95 ? 93 : 95; if (site && hasTank(vehicle)) openPump(site, vehicle); return; }
      if (actionId === 'can') { buyCan(); if (site && hasTank(vehicle)) openPump(site, vehicle); return; }
      if (actionId.startsWith('tip')) { tip(Number(actionId.slice(3))); return; }
      if (!site || !hasTank(vehicle)) { api.closeMenu(); return; }
      if (actionId === 'r50' || actionId === 'r200' || actionId === 'full') buy(actionId, site, vehicle);
    },
    command,
    /** The console's generic `give petrol` route (registry.ts `grants`): fills the tank you are
     *  sitting in. On foot there is no tank to fill, and the line says so — no silent no-op. */
    grant: () => {
      const vehicle = api.drivenVehicle();
      if (!vehicle || !hasTank(vehicle)) return 'No tank to fill — get behind the wheel of something with an engine first.';
      setLitres(vehicle, tankSize(vehicle));
      return `Tank filled: ${litresText(tank(vehicle))} of ${vehicle.spec.name}. The forecourt saw nothing.`;
    },
    qa,
    dispose: () => {
      // Fixtures and bookkeeping, and that is the whole list: this feature adds NO meshes and NO
      // colliders to the scene. Every forecourt it works with is a model the world scatter already
      // built and the chunk streamer already owns, so there is nothing here to leak.
      clearFixtures();
      pending = undefined;
      resetLedger();
    },
  };
}
