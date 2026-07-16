/**
 * Headless verification of the beachfront: the pure layout logic (venue plans, pier plan, the
 * placement data derived from the coastline/harbour/districts) and the pier builder's geometry.
 * The venue/boat models themselves are swept by models.test via the catalog.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BEACHFRONT,
  coastXAt,
  computeBeachfront,
  CREST_INLAND,
  pierPlan,
  seawardHeading,
  venuePlan,
  VENUE_KINDS,
} from './beachfront';
import { BEACH_INLAND, BEACH_TOP_Y } from './City';
import { distanceToRoadEdge, HARBOUR_POINT, districtCenter } from './mapData';
import { MODEL_INDEX } from './models/catalog';
import { buildPleasurePier } from './models/pier';

describe('venuePlan', () => {
  it('is deterministic and covers every kind', () => {
    for (const kind of VENUE_KINDS) {
      const a = venuePlan(1337, kind); const b = venuePlan(1337, kind);
      expect(b).toEqual(a);
      expect(a.signText.length).toBeGreaterThan(3);
      expect(a.tables.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every table on the terrace deck with breathing room between tables', () => {
    for (const seed of [1, 7, 42, 1337, 9001]) {
      for (const kind of VENUE_KINDS) {
        const plan = venuePlan(seed, kind);
        for (const table of plan.tables) {
          expect(Math.abs(table.x)).toBeLessThanOrEqual(plan.terraceW / 2 - 1);
          expect(table.z).toBeGreaterThan(0.5); expect(table.z).toBeLessThan(plan.terraceD - 1.4);
          expect(table.chairs.length).toBeGreaterThanOrEqual(2);
        }
        for (let i = 0; i < plan.tables.length; i++) for (let j = i + 1; j < plan.tables.length; j++) {
          const a = plan.tables[i]!; const b = plan.tables[j]!;
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(1.99);
        }
      }
    }
  });

  it('scales the footprint by kind: restaurant > bar > cafe', () => {
    const r = venuePlan(7, 'restaurant'); const b = venuePlan(7, 'bar'); const c = venuePlan(7, 'cafe');
    expect(r.hallW).toBeGreaterThan(b.hallW); expect(b.hallW).toBeGreaterThan(c.hallW);
  });
});

describe('pierPlan', () => {
  it('covers the full length with bays and keeps every station on the deck', () => {
    const plan = pierPlan(120, 8.5);
    expect(plan.bays[0]!.z0).toBeCloseTo(0, 9);
    expect(plan.bays[plan.bays.length - 1]!.z1).toBe(-120);
    for (let i = 1; i < plan.bays.length; i++) expect(plan.bays[i]!.z0).toBeCloseTo(plan.bays[i - 1]!.z1, 6);
    for (const pz of plan.pylons) { expect(pz).toBeLessThan(0); expect(pz).toBeGreaterThanOrEqual(-120); }
    for (const post of plan.posts) { expect(post).toBeLessThanOrEqual(0); expect(post).toBeGreaterThanOrEqual(-120); }
    expect(plan.lamps.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < plan.lamps.length; i++) expect(plan.lamps[i]!.side).not.toBe(plan.lamps[i - 1]!.side); // alternating
    expect(plan.pavilion.z).toBeLessThan(-120); // pavilion apron beyond the deck's sea end
    expect(plan.deckY).toBeGreaterThan(1); // deck well clear of the waterline
  });

  it('adapts to odd lengths without dropping deck coverage', () => {
    const plan = pierPlan(97, 7);
    expect(plan.bays[plan.bays.length - 1]!.z1).toBe(-97);
  });
});

describe('beachfront placement plan', () => {
  const plan = BEACHFRONT;

  it('is deterministic and stays aligned with the terrain profile constant', () => {
    expect(computeBeachfront()).toEqual(plan);
    expect(CREST_INLAND).toBe(BEACH_INLAND); // venues sit relative to the same sand crest City drapes
  });

  it('plants the pier root on the sand crest at the Kaapstad Quay harbour', () => {
    expect(plan.pier).toBeDefined();
    expect(plan.pier!.z).toBeCloseTo(HARBOUR_POINT!.z, 6);
    expect(plan.pier!.x).toBeCloseTo(coastXAt(plan.pier!.z) + CREST_INLAND, 6);
    expect(plan.pier!.length).toBeGreaterThan(60); // a real pleasure pier, not a jetty
  });

  it('lays venue strips at both Kaapstad Quay and Bantry Bay, off every road, above the waterline', () => {
    const quayZ = HARBOUR_POINT!.z; const bayZ = districtCenter('Bantry Bay')!.z;
    const nearQuay = plan.venues.filter((v) => Math.abs(v.z - quayZ) < 120);
    const nearBay = plan.venues.filter((v) => Math.abs(v.z - bayZ) < 160);
    expect(nearQuay.length).toBeGreaterThanOrEqual(3);
    expect(nearBay.length).toBeGreaterThanOrEqual(4);
    expect(nearQuay.length + nearBay.length).toBe(plan.venues.length);
    const kinds = new Set(plan.venues.map((v) => v.name));
    expect(kinds).toContain('seafront-restaurant'); expect(kinds).toContain('seafront-bar'); expect(kinds).toContain('seafront-cafe');
    for (const venue of plan.venues) {
      expect(MODEL_INDEX.has(venue.name), venue.name).toBe(true);
      expect(distanceToRoadEdge(venue.x, venue.z)).toBeGreaterThan(10); // clear of the carriageway by a footprint
      expect(venue.x).toBeGreaterThan(coastXAt(venue.z) + CREST_INLAND); // landward of the sand crest — never in the sea
      const seaward = seawardHeading(venue.z);
      expect(Math.abs(Math.atan2(Math.sin(venue.heading - seaward), Math.cos(venue.heading - seaward)))).toBeLessThan(0.01); // faces the sea
    }
  });

  it('keeps clutter on the dry sand and boats in the water', () => {
    expect(plan.clutter.length).toBeGreaterThanOrEqual(5);
    for (const spot of plan.clutter) {
      expect(MODEL_INDEX.has(spot.name), spot.name).toBe(true);
      const crest = coastXAt(spot.z) + CREST_INLAND;
      expect(spot.x).toBeLessThan(crest); // seaward of the crest…
      expect(spot.x).toBeGreaterThan(crest - 26); // …but on the dry-sand band, not in the surf
    }
    expect(plan.boats.length).toBeGreaterThanOrEqual(2);
    for (const boat of plan.boats) expect(boat.x).toBeLessThan(coastXAt(boat.z)); // afloat, west of the waterline
    expect(plan.towels.length).toBeGreaterThanOrEqual(8);
    expect(BEACH_TOP_Y).toBeGreaterThan(0); // sanity: the crest the clutter drapes onto is above the sea
  });

  it('claims a pad for the pier and every venue so CityGen/ModelScatter keep clear', () => {
    expect(plan.pads.length).toBeGreaterThanOrEqual(plan.venues.length + 1);
    for (const venue of plan.venues) {
      expect(plan.pads.some((pad) => Math.hypot(pad.x - venue.x, pad.z - venue.z) < 1 && pad.radius >= 12)).toBe(true);
    }
  });
});

describe('buildPleasurePier', () => {
  it('builds a deterministic, sane pier with a standable deck and railing tiers', () => {
    const first = buildPleasurePier(42, { length: 120, width: 8.5, sign: 'KAAPSTAD QUAY' });
    const second = buildPleasurePier(42, { length: 120, width: 8.5, sign: 'KAAPSTAD QUAY' });
    expect(second.tiers).toEqual(first.tiers);
    let meshes = 0; const bounds = new THREE.Box3().setFromObject(first.group);
    first.group.traverse((object) => { if (object instanceof THREE.Mesh) { meshes++; expect(object.geometry.getAttribute('position').count).toBeGreaterThan(0); } });
    expect(meshes).toBeGreaterThan(50);
    expect(bounds.min.z).toBeLessThan(-120); // reaches past the deck end (pavilion)
    expect(bounds.max.z).toBeGreaterThan(2); // entrance steps on the shore side
    expect(bounds.min.y).toBeLessThan(-6); // pylons reach the seabed
    const deck = first.tiers.find((tier) => tier.minZ <= -100 && tier.maxZ >= -10 && tier.maxX - tier.minX > 6);
    expect(deck, 'full-length standable deck tier').toBeDefined();
    expect(deck!.y1).toBeCloseTo(2.35, 3);
    const rails = first.tiers.filter((tier) => tier.y0 >= 2.3 && tier.y1 > 3);
    expect(rails.length).toBeGreaterThanOrEqual(2); // both sides fenced so nothing drives off
  });

  it('honours the length/width options', () => {
    const short = buildPleasurePier(7, { length: 60, width: 6 });
    const deck = short.tiers.find((tier) => tier.maxX - tier.minX >= 5.9 && tier.maxX - tier.minX <= 6.1 && tier.minZ === -60);
    expect(deck).toBeDefined();
  });
});
