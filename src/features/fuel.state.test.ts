import { beforeAll, describe, expect, it } from 'vitest';
import {
  BASE_95_CENTS, CAN_LITRES, DEFAULT_FUEL_SAVE, GRADE_93_DISCOUNT_CENTS, IDLE_LPS, LEVY_CENTS,
  LOW_FRACTION, SPUTTER_FRACTION, THIRST, THROTTLE_LPS, TANKS, apronPoint, attendantSpot, burn,
  centsText, fractionIn, gradeCents, hasTank, isMetered, litresFor, litresIn, markRevealed,
  ensureSites, nearestStation, onApron, randFor, resetLedger, sanitizeFuelSave, seedFill, setLitres,
  stationAt, tankSize,
} from './fuel.state';
import type { Vehicle } from '../entities/Vehicle';
import { VEHICLE_SPECS, type VehicleKind } from '../config';

/** A Vehicle stand-in: burn() only reads spec, speed, position and the two damage flags. */
function car(kind: VehicleKind = 'compact', x = 0, z = 0, speed = 0): Vehicle {
  return {
    spec: VEHICLE_SPECS[kind], speed, wrecked: false, disabled: false,
    group: { position: { x, y: 0, z } },
  } as unknown as Vehicle;
}

describe('fuel — the reward test', () => {
  it('anchors a vol-tank on the starter car to one mid-tier mission payout', () => {
    // src/story/missions.ts pays 900 / 1100 / 1500 / 1800 / 2200 / 2600 / 2800 mid-tier.
    const fill = randFor(TANKS.compact, BASE_95_CENTS);
    expect(Math.round(fill)).toBe(1170);
    expect(fill).toBeGreaterThan(900);
    expect(fill).toBeLessThan(1500);
  });

  it('gives every kind of car between eight and thirteen minutes of flat-out driving', () => {
    for (const kind of Object.keys(TANKS) as VehicleKind[]) {
      if (TANKS[kind] === 0) continue;
      const seconds = TANKS[kind] / (IDLE_LPS + THROTTLE_LPS * THIRST[kind]);
      expect(seconds, kind).toBeGreaterThan(400);
      expect(seconds, kind).toBeLessThan(800);
    }
  });

  it('never charges more than a late-game payout for a single fill', () => {
    for (const kind of Object.keys(TANKS) as VehicleKind[]) {
      expect(randFor(TANKS[kind], BASE_95_CENTS), kind).toBeLessThan(2200);
    }
  });

  it('prices 93 below 95, because Johannesburg is inland and 93 is the inland grade', () => {
    expect(gradeCents(BASE_95_CENTS, 93)).toBe(BASE_95_CENTS - GRADE_93_DISCOUNT_CENTS);
    expect(gradeCents(BASE_95_CENTS, 95)).toBe(BASE_95_CENTS);
  });

  it('puts about a quarter of every litre in the state\'s pocket', () => {
    expect(LEVY_CENTS / BASE_95_CENTS).toBeGreaterThan(0.22);
    expect(LEVY_CENTS / BASE_95_CENTS).toBeLessThan(0.3);
  });

  it('turns R200 into a real but modest top-up', () => {
    const litres = litresFor(200, BASE_95_CENTS);
    expect(litres).toBeGreaterThan(7);
    expect(litres / TANKS.compact).toBeLessThan(0.2);
  });
});

describe('fuel — burn', () => {
  it('drains faster under throttle than at idle', () => {
    resetLedger(); markRevealed();
    const idling = car('compact'); const flat = car('compact', 40, 40, VEHICLE_SPECS.compact.maxSpeed);
    setLitres(idling, 40); setLitres(flat, 40);
    burn(idling, 1); burn(flat, 1);
    expect(litresIn(flat)).toBeLessThan(litresIn(idling));
    expect(litresIn(idling)).toBeCloseTo(40 - IDLE_LPS, 5);
  });

  it('never lets a tank go negative and never burns a bicycle', () => {
    resetLedger(); markRevealed();
    const bike = car('bicycle');
    expect(hasTank(bike)).toBe(false);
    expect(tankSize(bike)).toBe(0);
    expect(burn(bike, 100)).toBe(0);
    const golf = car('compact', 10, 10);
    setLitres(golf, 0.2);
    burn(golf, 60);
    expect(litresIn(golf)).toBe(0);
  });

  it('floors at a limp reserve until the player has actually met the mechanic', () => {
    resetLedger();
    const golf = car('compact', 20, 20, VEHICLE_SPECS.compact.maxSpeed);
    setLitres(golf, 20);
    for (let step = 0; step < 4000; step++) burn(golf, 0.1);
    expect(fractionIn(golf)).toBeCloseTo(0.09, 3);
    markRevealed();
    for (let step = 0; step < 4000; step++) burn(golf, 0.1);
    expect(litresIn(golf)).toBe(0);
  });

  it('does not burn a wrecked car', () => {
    resetLedger(); markRevealed();
    const golf = car('compact', 30, 30, 20);
    setLitres(golf, 10);
    (golf as { wrecked: boolean }).wrecked = true;
    burn(golf, 5);
    expect(litresIn(golf)).toBe(10);
  });

  it('warns before it sputters', () => {
    expect(SPUTTER_FRACTION).toBeLessThan(LOW_FRACTION);
  });
});

describe('fuel — the seeded starting tank', () => {
  it('gives the first car of a session a generous fill and later ones a real spread', () => {
    resetLedger();
    const first = seedFill(car('compact', 100, 100));
    expect(first / TANKS.compact).toBeGreaterThanOrEqual(0.62);
    const spread = new Set<number>();
    for (let index = 0; index < 40; index++) {
      spread.add(Math.round((seedFill(car('compact', index * 37, index * 53)) / TANKS.compact) * 100));
    }
    expect(Math.min(...spread)).toBeLessThan(45);
    expect(Math.max(...spread)).toBeGreaterThan(60);
    expect(spread.size).toBeGreaterThan(20); // not every stolen car is full, which is the whole point
  });

  it('is deterministic per parking spot', () => {
    resetLedger();
    seedFill(car('compact', 0, 0)); // burn the generous first-car roll
    expect(seedFill(car('van', 812, -455))).toBe(seedFill(car('van', 812, -455)));
  });

  it('only meters a vehicle once it has been looked at', () => {
    resetLedger();
    const golf = car('compact', 5, 5);
    expect(isMetered(golf)).toBe(false);
    litresIn(golf);
    expect(isMetered(golf)).toBe(true);
  });
});

describe('fuel — forecourts derived from the map', () => {
  let sites: readonly import('./fuel.state').Station[] = [];
  beforeAll(async () => { sites = await ensureSites(); }, 180_000);

  it('finds enough garages, all from data the map already carries', () => {
    expect(sites.length).toBeGreaterThanOrEqual(12);
    expect(sites.filter((site) => site.authored)).toHaveLength(1); // the Vaal shore's Bayshore Marina
  });

  it('names each one after the sign above the pumps and the suburb it stands in', () => {
    for (const site of sites) {
      expect(site.name, site.id).toMatch(/^(Engine|Caltexx|Sasoil|Boerepetrol) .+/);
    }
  });

  it('spreads them across the city rather than stacking them', () => {
    for (let a = 0; a < sites.length; a++) {
      for (let b = a + 1; b < sites.length; b++) {
        const gap = Math.hypot(sites[a]!.x - sites[b]!.x, sites[a]!.z - sites[b]!.z);
        expect(gap, `${sites[a]!.id}/${sites[b]!.id}`).toBeGreaterThan(120);
      }
    }
  });

  it('puts the apron under the pumps and not under the next street', () => {
    for (const site of sites) {
      expect(onApron(site, site.x, site.z)).toBe(true);
      expect(stationAt(site.x, site.z)?.id).toBe(site.id);
      const away = apronPoint(site, 0, site.offZ + site.halfD + 9);
      expect(onApron(site, away.x, away.z)).toBe(false);
      expect(site.halfW).toBeLessThan(15);
      expect(site.halfD).toBeLessThan(12);
    }
  });

  it('stands the attendant on the apron beside a pump island', () => {
    for (const site of sites) {
      const spot = attendantSpot(site);
      expect(onApron(site, spot.x, spot.z), site.id).toBe(true);
    }
  });

  it('answers "where is the nearest garage" from anywhere', () => {
    const near = nearestStation(0, 0)!;
    expect(near.site).toBeDefined();
    expect(near.distance).toBeLessThan(4000);
  });

  it('hides the feature-built forecourt from the eager approach, so no prompt appears at a garage that is not there yet', () => {
    const bayshore = sites.find((site) => site.authored)!;
    expect(stationAt(bayshore.x, bayshore.z, false)).toBeUndefined();
    expect(stationAt(bayshore.x, bayshore.z, true)?.id).toBe('bayshore');
  });
});

describe('fuel — the save slice', () => {
  it('round-trips a real slice', () => {
    const slice = { driving: 21.5, can: 5, tipped: 40, cents: 2712, daysToHike: 1, hikeCents: 84, litresBought: 300 };
    expect(sanitizeFuelSave(slice)).toEqual(slice);
  });

  it('defaults an absent or hostile slice', () => {
    expect(sanitizeFuelSave(undefined)).toEqual(DEFAULT_FUEL_SAVE);
    expect(sanitizeFuelSave('vol-tank')).toEqual(DEFAULT_FUEL_SAVE);
    expect(sanitizeFuelSave({})).toEqual(DEFAULT_FUEL_SAVE);
  });

  it('clamps nonsense instead of trusting it', () => {
    const wild = sanitizeFuelSave({ driving: Number.NaN, can: 900, tipped: -5, cents: 999999, daysToHike: 400, hikeCents: -99999, litresBought: 'lots' });
    expect(wild.driving).toBeNull();
    expect(wild.can).toBe(CAN_LITRES);
    expect(wild.tipped).toBe(0);
    expect(wild.cents).toBe(6000);
    expect(wild.daysToHike).toBe(12);
    expect(wild.hikeCents).toBe(-400);
    expect(wild.litresBought).toBe(0);
  });

  it('formats rand the way a pump board does', () => {
    expect(centsText(2599)).toBe('R25.99');
    expect(centsText(2561)).toBe('R25.61');
  });
});
