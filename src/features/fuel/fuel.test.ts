import * as THREE from 'three';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFeature } from './fuel';
import {
  LOW_FRACTION, SPUTTER_FRACTION, ensureForecourts, forecourts, fuelHud, litresIn, resetLedger,
  setLitres, tankSize,
} from '../fuel.state';
import { CAN_PRICE, apronPoint, buildStations, shopSpot, stationAt, type Station } from './pump';
import { hash } from '../../world/models/kit';
import { LANDMARKS } from '../../world/mapData';
import type { FeatureGameApi, FeatureMenuView, FeatureSystem } from '../types';
import type { Pedestrian } from '../../entities/Pedestrian';
import type { Vehicle } from '../../entities/Vehicle';
import { VEHICLE_SPECS, type VehicleKind } from '../../config';

function car(kind: VehicleKind = 'compact', x = 0, z = 0, speed = 0): Vehicle {
  return {
    spec: VEHICLE_SPECS[kind], speed, wrecked: false, disabled: false, heading: 0,
    group: { position: new THREE.Vector3(x, 0, z) },
  } as unknown as Vehicle;
}

interface Harness {
  api: FeatureGameApi;
  menus: FeatureMenuView[];
  notes: Array<{ title: string; detail?: string; success?: boolean }>;
  events: Array<{ event: string; value?: number; detail?: string }>;
  fixtures: Set<Pedestrian>;
  balance: number;
  vehicle: Vehicle | undefined;
  hour: number;
  closed: number;
}

function harness(): Harness {
  const scene = new THREE.Scene();
  const state: Harness = {
    api: undefined as unknown as FeatureGameApi,
    menus: [], notes: [], events: [], fixtures: new Set(),
    balance: 5000, vehicle: undefined, hour: 12, closed: 0,
  };
  let serial = 0;
  state.api = {
    scene,
    surfaceHeightAt: () => 0,
    districtAt: () => 'Joburg CBD',
    isPark: () => false,
    nearestRoadPose: (at) => ({ position: at.clone(), heading: 0 }),
    playerPosition: () => state.vehicle?.group.position ?? new THREE.Vector3(),
    playerHeading: () => 0,
    drivenVehicle: () => state.vehicle,
    hour: () => state.hour,
    blackout: () => 0,
    balance: () => state.balance,
    earn: (amount) => { state.balance += amount; },
    spend: (amount) => { if (amount > state.balance) return false; state.balance -= Math.round(amount); return true; },
    notify: (title, detail, success) => { state.notes.push({ title, detail, success }); },
    showMenu: (view) => { state.menus.push(view); },
    closeMenu: () => { state.closed += 1; },
    persist: () => undefined,
    analytics: (event, props) => { state.events.push({ event, ...props }); },
    spawnFixture: (x, z, name) => {
      const ped = { group: { position: new THREE.Vector3(x, 0, z), name }, id: serial++ } as unknown as Pedestrian;
      state.fixtures.add(ped);
      return ped;
    },
    removeFixture: (ped) => { state.fixtures.delete(ped); },
  };
  return state;
}

/** The scattered forecourts exactly as the feature builds them (the harness district is fixed). */
const scattered = (): Station[] => buildStations(forecourts(), hash, () => 'Joburg CBD');

/** Park a car on a real derived forecourt. */
function onForecourt(h: Harness, kind: VehicleKind = 'compact'): Vehicle {
  const site = scattered()[0]!;
  const at = apronPoint(site, 0, site.offZ);
  const vehicle = car(kind, at.x, at.z, 0);
  h.vehicle = vehicle;
  return vehicle;
}

const rows = (view: FeatureMenuView): string[] => view.rows.map((row) => row.id);

// Deriving the forecourts runs the whole map scatter the first time (the browser hydrates it from
// the bake; a node test does not). Warm it ONCE, off the per-test hook budget, or the full suite's
// four workers push the first beforeEach past its 10s timeout and the file goes flaky in CI.
beforeAll(async () => { await ensureForecourts(); }, 180_000);

describe('petrol — the forecourt', () => {
  let h: Harness;
  let fuel: FeatureSystem;

  beforeEach(async () => {
    resetLedger();
    h = harness();
    fuel = await createFeature(h.api, undefined);
  });

  it('raises NO geometry: a garage this feature builds is a garage you can never reach', () => {
    // The dam-shore station used to be built right here, and that made it unreachable. The body only
    // loads when you press E on a forecourt the EAGER list knows about, and the eager list is derived
    // from the world scatter — which did not contain this one. So the labelled gold star on the map
    // had bare veld under it, which is exactly what the owner drove out there and found.
    expect(h.api.scene.getObjectByName('FuelForecourts')).toBeUndefined();
    expect(h.api.scene.children).toHaveLength(0);
  });

  it('takes the map\'s own name for the forecourt standing on the map\'s own fuel landmark', () => {
    const pin = LANDMARKS.find((entry) => entry.kind === 'fuel')!;
    expect(fuel.command!(['stations']).some((line) => line.startsWith(pin.name))).toBe(true);
  });

  it('offers nothing in a car that is nowhere near a garage, so E still exits the vehicle', () => {
    const vehicle = car('compact', 250, 250);
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    for (const rung of fuel.interactions!()) {
      if (rung.context !== 'vehicle') continue;
      expect(rung.test(ctx), rung.id).toBeUndefined();
    }
  });

  it('offers nothing on a bicycle, which has no tank', () => {
    const vehicle = onForecourt(h, 'bicycle');
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    for (const rung of fuel.interactions!()) {
      if (rung.context !== 'vehicle') continue;
      expect(rung.test(ctx), rung.id).toBeUndefined();
    }
  });

  it('prompts with the live price and the live gauge once you roll onto the apron', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, tankSize(vehicle) * 0.34);
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    const offer = fuel.interactions!().find((rung) => rung.id === 'fuel:pump')!.test(ctx)!;
    expect(offer.prompt).toBe('E  Petrol · R25.99/ℓ · 34%');
    expect(offer.prompt.startsWith('E  ')).toBe(true);
  });

  it('will not serve you at speed — you have to actually pull in', () => {
    const vehicle = onForecourt(h);
    vehicle.speed = 30;
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    expect(fuel.interactions!().find((rung) => rung.id === 'fuel:pump')!.test(ctx)).toBeUndefined();
  });

  it('runs the whole attendant transaction: he asks, you pay, he does the windscreen, you tip', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, 5);
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    fuel.interactions!().find((rung) => rung.id === 'fuel:pump')!.test(ctx)!.act();

    const pump = h.menus.at(-1)!;
    expect(pump.title).toBe('Howzit boss. How much?');
    expect(rows(pump)).toEqual(['grade', 'r50', 'r200', 'full', 'can']);
    expect(pump.blurb).toContain('Pump reads 0.00 before he starts');

    const before = h.balance;
    fuel.menu!('r200');
    expect(h.balance).toBe(before - 200);
    expect(litresIn(vehicle)).toBeCloseTo(5 + (200 * 100) / 2599, 4);

    const till = h.menus.at(-1)!;
    expect(till.eyebrow).toContain('CARD MACHINE AT THE WINDOW');
    expect(till.blurb).toContain('fuel levy');
    expect(till.blurb).toContain('RAF');
    expect(rows(till)).toEqual(['tip0', 'tip5', 'tip10', 'tip20']);

    fuel.menu!('tip10');
    expect(h.closed).toBe(1);
    expect(h.notes.at(-1)!.success).toBe(true);
    expect(h.events.map((event) => event.event)).toContain('refuel');
  });

  it('lets you tip nothing without being shamed for it', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, 5);
    fuel.qa!('pump', {});
    fuel.menu!('r50');
    const till = h.menus.at(-1)!;
    expect(till.rows[0]!.detail).toContain('Nobody is owed a tip');
    const cash = h.balance;
    fuel.menu!('tip0');
    expect(h.balance).toBe(cash);
  });

  it('remembers a regular and splashes a little extra over the top, free', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, 2);
    fuel.qa!('pump', {}); fuel.menu!('r50'); fuel.menu!('tip20');
    fuel.qa!('pump', {}); fuel.menu!('r50'); fuel.menu!('tip20');
    expect(h.notes.map((note) => note.title)).toContain('He knows your car now');
    const before = litresIn(vehicle);
    fuel.qa!('pump', {});
    fuel.menu!('r50');
    expect(litresIn(vehicle)).toBeCloseTo(before + (50 * 100) / 2599 + 2, 4);
    expect(h.menus.at(-1)!.title).toBe('He put a bietjie extra for you');
  });

  it('switches grades and charges the cheaper inland one less', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, 2);
    fuel.qa!('pump', {});
    fuel.menu!('grade');
    expect(h.menus.at(-1)!.rows[0]!.label).toBe('Ninety-three');
    const before = litresIn(vehicle);
    fuel.menu!('r200');
    expect(litresIn(vehicle) - before).toBeCloseTo((200 * 100) / (2599 - 38), 4);
  });

  it('offers nothing with a full tank, so E always gets you back out of the car', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, tankSize(vehicle));
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    for (const rung of fuel.interactions!()) {
      if (rung.context !== 'vehicle') continue;
      expect(rung.test(ctx), rung.id).toBeUndefined();
    }
  });

  it('never bills you for litres the tank could not take', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, tankSize(vehicle) - 1); // room for one litre; R200 would buy nearly eight
    const cash = h.balance;
    fuel.qa!('pump', {});
    fuel.menu!('r200');
    expect(litresIn(vehicle)).toBe(tankSize(vehicle));
    expect(cash - h.balance).toBe(Math.round((1 * 2599) / 100)); // charged for the one litre, not R200
  });

  it('refuses politely rather than silently when the money is not there', () => {
    const vehicle = onForecourt(h);
    setLitres(vehicle, 1);
    h.balance = 30;
    fuel.qa!('pump', {});
    const pump = h.menus.at(-1)!;
    expect(pump.rows.find((row) => row.id === 'r50')!.disabled).toBe(true);
    fuel.menu!('r50');
    expect(h.notes.at(-1)!.title).toBe('Card declined');
    expect(h.balance).toBe(30);
  });

  it('puts an attendant at the pumps only while you are on the forecourt', () => {
    const vehicle = onForecourt(h);
    expect(h.fixtures.size).toBe(0);
    fuel.update!(0.016);
    expect(h.fixtures.size).toBe(1);
    expect([...h.fixtures][0]!.group.name).toContain('attendant');
    vehicle.group.position.set(900, 0, 900);
    fuel.update!(0.016);
    expect(h.fixtures.size).toBe(0);
  });
});

describe('petrol — running dry', () => {
  let h: Harness;
  let fuel: FeatureSystem;

  beforeEach(async () => {
    resetLedger();
    h = harness();
    fuel = await createFeature(h.api, undefined);
  });

  it('warns once when the light comes on, and says where the nearest garage is', () => {
    const vehicle = car('compact', 200, 200, 30);
    h.vehicle = vehicle;
    setLitres(vehicle, tankSize(vehicle) * (LOW_FRACTION + 0.001));
    fuel.update!(2);
    const warning = h.notes.find((note) => note.title === 'Fuel light')!;
    expect(warning).toBeDefined();
    expect(warning.detail).toMatch(/(Engine|Caltexx|Sasoil|Boerepetrol) .+, \d+ m away\./);
    const before = h.notes.length;
    fuel.update!(2);
    expect(h.notes).toHaveLength(before); // one toast, not a nag
  });

  it('stumbles on fumes and coasts when dry, instead of hard-stalling in traffic', () => {
    const vehicle = car('compact', 300, 300, 30);
    h.vehicle = vehicle;
    setLitres(vehicle, tankSize(vehicle) * (SPUTTER_FRACTION * 0.5));
    let cut = 0;
    for (let step = 0; step < 40; step++) {
      vehicle.speed = 30;
      fuel.update!(0.1);
      if (vehicle.speed < 30) cut += 1;
    }
    expect(cut).toBeGreaterThan(3);
    expect(cut).toBeLessThan(40); // it catches again; you are not glued to the road

    setLitres(vehicle, 0);
    vehicle.speed = 30;
    for (let step = 0; step < 20; step++) fuel.update!(0.1);
    expect(vehicle.speed).toBeLessThan(5);
    expect(vehicle.speed).toBeGreaterThan(0); // rolls to a stop, never a physics slam
    expect(h.notes.some((note) => note.title === 'Dry')).toBe(true);
  });

  it('sells a can at the kiosk door but never where it would trap you outside your own car', () => {
    const site = scattered()[0]!;
    const pumps = apronPoint(site, 0, site.offZ);
    const rung = fuel.interactions!().find((entry) => entry.id === 'fuel:shop')!;
    // Standing at the pumps, where you park: E must stay free for "enter the vehicle".
    expect(rung.test({ context: 'foot', position: new THREE.Vector3(pumps.x, 0, pumps.z), vehicle: undefined, hour: 12 })).toBeUndefined();
    const door = shopSpot(site);
    const footCtx = { context: 'foot' as const, position: new THREE.Vector3(door.x, 0, door.z), vehicle: undefined, hour: 12 };
    const shop = rung.test(footCtx)!;
    expect(shop.prompt).toBe(`E  Buy a 5ℓ can · R${CAN_PRICE}`);
    shop.act();
    expect(h.balance).toBe(5000 - CAN_PRICE);

    const vehicle = car('compact', 900, 900, 0);
    h.vehicle = vehicle;
    setLitres(vehicle, 0);
    const ctx = { context: 'vehicle' as const, position: vehicle.group.position, vehicle, hour: 12 };
    const pour = fuel.interactions!().find((rung) => rung.id === 'fuel:pour')!.test(ctx)!;
    expect(pour.prompt).toBe('E  Pour in the can · 5.0 ℓ');
    pour.act();
    expect(litresIn(vehicle)).toBe(5);
    expect(fuel.interactions!().find((rung) => rung.id === 'fuel:pour')!.test(ctx)).toBeUndefined();
  });

  it('shows a gauge only in a car with a tank, and the same chips the eager slice was drawing', () => {
    expect(fuel.hud!()).toEqual([]);
    const vehicle = car('compact', 10, 10);
    h.vehicle = vehicle;
    setLitres(vehicle, tankSize(vehicle) * 0.5);
    expect(fuel.hud!()).toEqual([{ id: 'fuel:tank', label: 'FUEL', value: '50%', fill: 50, warn: false }]);
    setLitres(vehicle, 0);
    // Identical to fuelHud()'s output before the chunk landed: same ids, same builder, no blink.
    expect(fuel.hud!()).toEqual(fuelHud({ context: 'vehicle', position: vehicle.group.position, vehicle, hour: 12 }));
    expect(fuel.hud!()![0]).toMatchObject({ value: 'DRY', warn: true });
    expect(fuel.hud!()![1]).toMatchObject({ id: 'fuel:hint', label: 'GARAGE' });
    h.vehicle = car('bicycle', 10, 10);
    expect(fuel.hud!()).toEqual([]);
  });
});

describe('petrol — the regulated price', () => {
  let h: Harness;
  let fuel: FeatureSystem;

  beforeEach(async () => {
    resetLedger();
    h = harness();
    fuel = await createFeature(h.api, undefined);
  });

  /** Walk the clock over a midnight. */
  function midnight(): void {
    h.hour = 23.5; fuel.update!(0.016);
    h.hour = 0.2; fuel.update!(0.016);
  }

  it('announces the change a day out and lands it at midnight, city-wide', () => {
    midnight(); midnight(); // 3 -> 2 -> 1: the announcement
    expect(h.notes.map((note) => note.title).some((title) => title.startsWith('Petrol '))).toBe(true);
    const before = (fuel.serialize!() as { cents: number }).cents;
    midnight();
    const after = fuel.serialize!() as { cents: number; daysToHike: number; hikeCents: number };
    expect(after.cents).not.toBe(before);
    expect(after.hikeCents).toBe(0);
    expect(after.daysToHike).toBe(3);
    expect(h.notes.map((note) => note.title)).toContain('New pump price');
  });

  it('puts a queue and a hand-written thirty litre limit on the forecourt the night before a rise', () => {
    fuel.command!(['hike']);
    h.hour = 23.9; fuel.update!(0.016);
    h.hour = 0.1; fuel.update!(0.016); // the announcement lands
    h.hour = 19;                       // evening, price rises at midnight
    const vehicle = onForecourt(h);
    setLitres(vehicle, 1);
    fuel.update!(0.016);
    const slice = fuel.serialize!() as { hikeCents: number };
    if (slice.hikeCents > 0) {
      expect(h.fixtures.size).toBeGreaterThan(1); // attendant plus the queue
      fuel.qa!('pump', {});
      const pump = h.menus.at(-1)!;
      expect(pump.eyebrow).toContain('QUEUE INTO THE STREET');
      expect(pump.rows.find((row) => row.id === 'full')!.label).toContain('Thirty litres');
      expect(pump.rows.find((row) => row.id === 'full')!.price).toBeLessThan(900);
    }
  });
});

describe('petrol — save, console, teardown', () => {
  it('round-trips its slice and adopts the saved tank onto the next car', async () => {
    resetLedger();
    const h = harness();
    const fuel = await createFeature(h.api, { driving: 12.5, can: 5, tipped: 40, cents: 2700, daysToHike: 2, hikeCents: 0, litresBought: 88 });
    const vehicle = car('compact', 400, 400);
    h.vehicle = vehicle;
    fuel.update!(0.016);
    expect(litresIn(vehicle)).toBeCloseTo(12.5 - 0.016 * 0.006, 4);
    expect(fuel.serialize!()).toMatchObject({ can: 5, tipped: 40, cents: 2700 });
    fuel.restore!({ ...(fuel.serialize!() as object), can: 0 });
    expect(fuel.serialize!()).toMatchObject({ can: 0 });
  });

  it('answers the console honestly', async () => {
    resetLedger();
    const h = harness();
    const fuel = await createFeature(h.api, undefined);
    expect(fuel.command!(['stations']).length).toBeGreaterThan(10);
    expect(fuel.command!(['price'])[0]).toContain('R25.99/ℓ');
    expect(fuel.command!(['tank'])[0]).toBe('Not in a vehicle with a tank.');
    h.vehicle = car('van', 0, 0);
    expect(fuel.command!(['tank', '40'])[0]).toContain('40.0 ℓ of 80');
    expect(fuel.command!([])[0]).toContain('feature fuel stations');
  });

  it('drives its own machine playthrough end to end', async () => {
    resetLedger();
    const h = harness();
    const fuel = await createFeature(h.api, undefined);
    expect(fuel.qa!('sites', {})).toMatch(/^ok:\d+$/);
    expect(fuel.qa!('run', {})).toBe('stuck:not-driving-a-tanked-vehicle');
    onForecourt(h);
    expect(fuel.qa!('drain', { fraction: 0.02 })).toMatch(/^ok:/);
    expect(fuel.qa!('nearest', {})).toMatch(/^ok:/);
    expect(fuel.qa!('run', {})).toMatch(/^ok:.*tipped-5$/);
    expect(fuel.qa!('receipt', {})).toContain('carbon');
    expect(fuel.qa!('nonsense', {})).toBe('stuck:unknown-action:nonsense');
  });

  it('disposes completely, twice, leaving no fixture and no mesh behind', async () => {
    resetLedger();
    const h = harness();
    const fuel = await createFeature(h.api, undefined);
    const vehicle = onForecourt(h);
    setLitres(vehicle, 10);
    fuel.update!(0.016);
    expect(h.fixtures.size).toBe(1);
    fuel.dispose();
    fuel.dispose();
    expect(h.fixtures.size).toBe(0);
    expect(h.api.scene.children).toHaveLength(0);
  });

  it('pushes no colliders anywhere — a feature cannot take one back', () => {
    // The api has no collider seam at all, which is the point: nothing this feature adds can survive
    // as an invisible wall. Asserted structurally so a future edit has to delete this test on purpose.
    expect(Object.keys(harness().api).some((key) => /collider/i.test(key))).toBe(false);
  });
});

describe('petrol — the map, not the code, decides where garages are', () => {
  it('derives every forecourt from data and never from a typed coordinate', () => {
    const sites = scattered();
    expect(stationAt(sites, sites[0]!.x, sites[0]!.z)?.id).toBe(sites[0]!.id);
    expect(sites.every((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.z))).toBe(true);
  });
});
