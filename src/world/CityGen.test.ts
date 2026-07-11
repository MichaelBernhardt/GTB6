import { describe, expect, it } from 'vitest';
import { allBuildings, buildingStats, CELL_BUILDING_CAP, CELL_SIZE, footprintRoadClearance, generateCell, type GeneratedBuilding } from './CityGen';
import { MAP_WORLD_SIZE } from './mapData';
import { MANICURED_FOOTPRINTS } from './data/manicured';

const HALF = MAP_WORLD_SIZE / 2;
const QUARTER = Math.PI / 2;
const cellOf = (b: GeneratedBuilding): [number, number] => [Math.floor(b.x / CELL_SIZE), Math.floor(b.z / CELL_SIZE)];

describe('citywide parcel layout', () => {
  const all = allBuildings();

  it('populates the whole map, not just the CBD test patch', () => {
    expect(all.length).toBeGreaterThan(1500);
    // buildings must reach well beyond the CBD in every quadrant (inhabited citywide)
    const quadrants = new Set(all.map((b) => `${Math.sign(b.x)},${Math.sign(b.z)}`));
    expect(quadrants.size).toBeGreaterThanOrEqual(4);
  });

  it('keeps every building inside the world bounds', () => {
    expect(all.every((b) => Math.abs(b.x) < HALF && Math.abs(b.z) < HALF)).toBe(true);
  });

  it('orients every building to its street (quarter-snapped heading, so AABB colliders stay valid)', () => {
    for (const b of all) {
      const turns = b.heading / QUARTER;
      expect(Math.abs(turns - Math.round(turns)), `heading ${b.heading}`).toBeLessThan(1e-6);
    }
  });

  it('sizes buildings by zone (highrise towers dwarf houses; estates and industry present)', () => {
    const byZone = new Map<string, number[]>();
    for (const b of all) { const list = byZone.get(b.zone) ?? []; list.push(b.height); byZone.set(b.zone, list); }
    const avg = (z: string) => { const l = byZone.get(z) ?? []; return l.reduce((a, b) => a + b, 0) / Math.max(1, l.length); };
    expect(byZone.get('commercial-highrise')?.length ?? 0).toBeGreaterThan(0);
    expect(byZone.get('estate')?.length ?? 0).toBeGreaterThan(0);
    expect(byZone.get('industrial')?.length ?? 0).toBeGreaterThan(0);
    expect(byZone.get('residential')?.length ?? 0).toBeGreaterThan(0);
    expect(avg('commercial-highrise')).toBeGreaterThan(avg('residential') * 2);
  });

  it('never exceeds the per-cell building cap (bounds draw calls + generation cost)', () => {
    expect(buildingStats().maxPerCell).toBeLessThanOrEqual(CELL_BUILDING_CAP);
  });

  it('never places a building footprint over a road corridor (no mass overhangs the street)', () => {
    // Owner's rule: buildings must not block the way. Every footprint must clear the carriageway +
    // its sidewalk apron — checked over the whole quarter-snapped W×D rectangle, not just the centre.
    let onCarriageway = 0; let worst = Infinity;
    for (const b of all) {
      const clr = footprintRoadClearance(b.x, b.z, b.width, b.depth, b.heading);
      if (clr < worst) worst = clr;
      if (clr < 0) onCarriageway++; // footprint sample sits on a road surface
    }
    expect(onCarriageway, `${onCarriageway} buildings overlap a road surface`).toBe(0);
    // Beyond just clearing the tarmac, every footprint keeps the sidewalk margin the generator reserves.
    expect(worst).toBeGreaterThanOrEqual(1.0);
  });

  it('keeps the road-corridor guarantee in the tight CBD grid AND a low-density suburb', () => {
    // Representative sample from both ends of the density range: the highrise CBD (thin blocks, big
    // footprints — the reported failure case) and estate/residential suburbs (large villas).
    const cbd = all.filter((b) => b.zone === 'commercial-highrise');
    const suburb = all.filter((b) => b.zone === 'estate' || b.zone === 'residential');
    expect(cbd.length).toBeGreaterThan(0);
    expect(suburb.length).toBeGreaterThan(0);
    for (const group of [cbd, suburb]) {
      for (const b of group) {
        expect(footprintRoadClearance(b.x, b.z, b.width, b.depth, b.heading)).toBeGreaterThanOrEqual(1.0);
      }
    }
  });

  it('carves out manicured site footprints so nothing collides with a special place', () => {
    for (const site of MANICURED_FOOTPRINTS) {
      const nearest = Math.min(...all.map((b) => Math.hypot(b.x - site.x, b.z - site.z)));
      expect(nearest, site.id).toBeGreaterThan(site.radius * 0.5);
    }
  });
});

describe('generateCell (on-demand streaming contract)', () => {
  const densest = (() => {
    const counts = new Map<string, number>();
    for (const b of allBuildings()) { const k = cellOf(b).join(','); counts.set(k, (counts.get(k) ?? 0) + 1); }
    let key = '0,0'; let best = 0;
    for (const [k, n] of counts) if (n > best) { best = n; key = k; }
    return key.split(',').map(Number) as [number, number];
  })();

  it('returns buildings for a populated cell, capped', () => {
    const cell = generateCell(densest[0], densest[1]);
    expect(cell.length).toBeGreaterThan(0);
    expect(cell.length).toBeLessThanOrEqual(CELL_BUILDING_CAP);
  });

  it('regenerates a cell byte-identically (generate → dispose → regenerate)', () => {
    const first = generateCell(densest[0], densest[1]);
    // touch other cells in between (mimics driving away and back)
    generateCell(densest[0] + 3, densest[1]);
    generateCell(densest[0], densest[1] + 3);
    const again = generateCell(densest[0], densest[1]);
    expect(again).toEqual(first);
  });

  it('returns fresh spec objects each call (safe for the caller to consume/dispose)', () => {
    const a = generateCell(densest[0], densest[1]);
    const b = generateCell(densest[0], densest[1]);
    expect(a[0]).not.toBe(b[0]);   // different object identity
    expect(a[0]).toEqual(b[0]);    // same value
  });

  it('is empty for an out-of-map cell', () => {
    expect(generateCell(9999, 9999)).toEqual([]);
  });
});
