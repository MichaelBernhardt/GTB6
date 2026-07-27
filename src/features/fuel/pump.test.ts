import { beforeAll, describe, expect, it } from 'vitest';
import {
  GRADE_93_DISCOUNT_CENTS, LEVY_CENTS, apronPoint, attendantSpot, buildStation, buildStations,
  centsText, gradeCents, litresFor, nearestStation, onApron, randFor, shopSpot, stationAt,
  type Station,
} from './pump';
import { APPROACH_REACH, BASE_95_CENTS, TANKS, ensureForecourts, forecourtNear, forecourts } from '../fuel.state';
import { hash } from '../../world/models/kit';
import { districtAt } from '../../world/mapData';

describe('petrol — the reward test', () => {
  it('anchors a vol-tank on the starter car to one mid-tier mission payout', () => {
    // src/story/missions.ts pays 900 / 1100 / 1500 / 1800 / 2200 / 2600 / 2800 mid-tier.
    const fill = randFor(TANKS.compact, BASE_95_CENTS);
    expect(Math.round(fill)).toBe(1170);
    expect(fill).toBeGreaterThan(900);
    expect(fill).toBeLessThan(1500);
  });

  it('never charges more than a late-game payout for a single fill', () => {
    for (const kind of Object.keys(TANKS) as Array<keyof typeof TANKS>) {
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

  it('formats rand the way a pump board does', () => {
    expect(centsText(2599)).toBe('R25.99');
    expect(centsText(2561)).toBe('R25.61');
  });
});

describe('petrol — the forecourt, derived from the map', () => {
  let sites: Station[] = [];
  beforeAll(async () => {
    await ensureForecourts();
    sites = buildStations(forecourts(), hash, districtAt);
  }, 180_000);

  it('names each one after the sign above the pumps and the suburb it stands in', () => {
    expect(sites.length).toBeGreaterThanOrEqual(12);
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
      expect(stationAt(sites, site.x, site.z)?.id).toBe(site.id);
      const away = apronPoint(site, 0, site.offZ + site.halfD + 9);
      expect(onApron(site, away.x, away.z)).toBe(false);
      expect(site.halfW).toBeLessThan(15);
      expect(site.halfD).toBeLessThan(12);
    }
  });

  /**
   * The eager circle only exists to fetch the chunk. If it ever reached past the exact apron the
   * press would load the body, re-resolve against the body's rungs, find nothing, and do NOTHING —
   * a prompt that lies. It must stay strictly inside every forecourt on the map.
   */
  it('keeps the eager approach circle strictly inside the real apron', () => {
    for (const site of sites) {
      expect(APPROACH_REACH, site.id).toBeLessThan(Math.min(site.halfW, site.halfD));
      const spot = forecourtNear(site.x + Math.sin(site.heading), site.z + Math.cos(site.heading));
      expect(spot?.id, site.id).toBe(site.id);
      // Anywhere the circle answers, the rectangle must answer too.
      for (const angle of [0, 1, 2, 3, 4, 5]) {
        const probe = apronPoint(site, Math.cos(angle) * APPROACH_REACH, site.offZ + Math.sin(angle) * APPROACH_REACH);
        expect(onApron(site, probe.x, probe.z), `${site.id}@${angle}`).toBe(true);
      }
    }
  });

  it('stands the attendant on the apron beside a pump island', () => {
    for (const site of sites) {
      const spot = attendantSpot(site);
      expect(onApron(site, spot.x, spot.z), site.id).toBe(true);
    }
  });

  it('puts the kiosk door behind the pumps, off the apron, so E still enters your car', () => {
    for (const site of sites) {
      const door = shopSpot(site);
      expect(Math.hypot(door.x - site.x, door.z - site.z), site.id).toBeGreaterThan(3);
    }
  });

  it('answers "where is the nearest garage" from anywhere', () => {
    const near = nearestStation(sites, 0, 0)!;
    expect(near.site).toBeDefined();
    expect(near.distance).toBeLessThan(4000);
  });

  it('builds the same forecourt the world built, from the model seed and nothing else', () => {
    const spot = forecourts()[0]!;
    const a = buildStation(hash, spot, 'Melville');
    const b = buildStation(hash, spot, 'Melville');
    expect(a).toEqual(b);
    expect(a.name).toBe(`${a.brand} Melville`);
  });

  it('gives a forecourt on a named map site the map\'s own name', () => {
    const spot = forecourts()[0]!;
    const named = [{ name: 'Bayshore Marina Petrol Station', x: spot.x + 20, z: spot.z - 10 }];
    const [site] = buildStations([spot], hash, () => 'Vaal Marina', named);
    expect(site!.name).toBe('Bayshore Marina Petrol Station');
    // …and a pin on the other side of town leaves the brand-and-district name alone.
    const far = buildStations([spot], hash, () => 'Vaal Marina', [{ name: 'Somewhere Else', x: spot.x + 4000, z: spot.z }]);
    expect(far[0]!.name).toBe(`${site!.brand} Vaal Marina`);
  });
});
