import { describe, expect, it } from 'vitest';
import { allBuildings, buildingStats, CELL_BUILDING_CAP, CELL_SIZE, footprintOverlapXZ, footprintRailwayClearance, footprintRoadClearance, generateCell, OCCUPANCY_FACTOR, RAILWAY_BUILDING_CLEARANCE, RAILWAY_STATION_CLEARANCE, zonePackingGap, type GeneratedBuilding } from './CityGen';
import { ARCHITECTURE_VARIANTS } from './BuildingArchitecture';
import { AERODROME_POLYGONS, DIRT_POLYGONS, FARM_POLYGONS, GREEN_POLYGONS, MAP_STATS, MAP_WORLD_SIZE, METRES_PER_UNIT, RAILWAY_STATION_SITES, WATER_POLYGONS, nearestRoadSpot, pointInAnyPolygon } from './mapData';
import { MANICURED_FOOTPRINTS } from './data/manicured';
import { KELVIN_FENCE_RADIUS, KELVIN_YARD_CENTER } from './placements';

const HALF = MAP_WORLD_SIZE / 2;
const QUARTER = Math.PI / 2;
const cellOf = (b: GeneratedBuilding): [number, number] => [Math.floor(b.x / CELL_SIZE), Math.floor(b.z / CELL_SIZE)];

describe('citywide parcel layout', () => {
  const all = allBuildings();

  it('populates the whole map, not just the CBD test patch', () => {
    // Before the density pass only 5,158 capped parcels could stream. Keep the promised 60–80%
    // increase explicit while retaining an upper bound for streaming/collider memory.
    //
    // The 5,158 was counted on the 19,200-unit map: 333.3 km² of land, which at 0.9914 m/unit is
    // 339.4 million square UNITS. Parcels are laid out in world units, so the comparable baseline on
    // any map is that same parcels-per-square-unit rate over its own buildable area (1,370 on this
    // 90.2-million-u² crop). The 1.6x is the thing this assertion is about and it is unchanged — an
    // absolute count would only be asserting how big the map is.
    const PRE_DENSITY_PARCELS_PER_SQUARE_UNIT = 5158 / 339.4e6;
    const landSquareUnits = ((MAP_STATS.landKm2 ?? 333.3) * 1e6) / METRES_PER_UNIT ** 2;
    expect(all.length).toBeGreaterThanOrEqual(Math.ceil(PRE_DENSITY_PARCELS_PER_SQUARE_UNIT * landSquareUnits * 1.6));
    expect(all.length).toBeLessThanOrEqual(9000); // absolute runtime cap: streaming + collider memory, not a map-size figure
    // buildings must reach well beyond the CBD in every quadrant (inhabited citywide)
    const quadrants = new Set(all.map((b) => `${Math.sign(b.x)},${Math.sign(b.z)}`));
    expect(quadrants.size).toBeGreaterThanOrEqual(4);
  });

  it('uses six live district characters and every massing assigned to each one', () => {
    const liveStyles = ['downtown', 'mixed-use', 'dense-residential', 'suburban', 'industrial', 'estate'] as const;
    for (const style of liveStyles) {
      const buildings = all.filter((building) => building.style === style);
      expect(buildings.length, style).toBeGreaterThan(0);
      const counts = Array.from({ length: ARCHITECTURE_VARIANTS[style] }, () => 0);
      for (const building of buildings) counts[building.variant % counts.length]++;
      expect(counts.every((count) => count > 0), `${style}: ${counts.join(',')}`).toBe(true);
      expect(Math.max(...counts) / buildings.length, style).toBeLessThan(0.4);
    }
  });

  it('keeps every building inside the world bounds', () => {
    expect(all.every((b) => Math.abs(b.x) < HALF && Math.abs(b.z) < HALF)).toBe(true);
  });

  it('aligns buildings to their actual street, not the compass (diagonal roads → diagonal buildings)', () => {
    // Colliders are oriented boxes now, so buildings follow the true road angle instead of snapping to
    // N/S/E/W. Most of the map's roads run off-axis, so the majority of headings must be non-quarter-turns.
    const snapped = all.filter((b) => { const t = b.heading / QUARTER; return Math.abs(t - Math.round(t)) < 1e-3; });
    expect(snapped.length / all.length).toBeLessThan(0.5);
  });

  it('faces each building square to the nearest road segment', () => {
    // The frontage (local +z) points at the road, so the facing vector must be perpendicular to the road
    // tangent: |facing · roadTangent| ≈ 0. Nearest-vertex lookup can pick a cross street at corners, so
    // require the overwhelming majority to square up rather than every single one.
    let aligned = 0; let total = 0;
    for (const b of all) {
      const spot = nearestRoadSpot(b.x, b.z);
      if (!spot) continue;
      total++;
      const dot = Math.abs(Math.sin(b.heading) * spot.dirX + Math.cos(b.heading) * spot.dirZ);
      if (dot < 0.35) aligned++;
    }
    expect(aligned / total).toBeGreaterThan(0.75);
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
    // Budget window: the CBD-density pass raised the cap 64 → 160 because at 64 one third of every
    // committed CBD building was silently dropped at bucketing (the empty-lot report); the suburbs
    // pass raised it to 256 because at real-erf pitch the shared CBD/residential cells capped and
    // dropped whole streets of houses. Cells still merge to a handful of draw calls per material;
    // the streamer frame-budgets generation cost.
    expect(CELL_BUILDING_CAP).toBeGreaterThanOrEqual(50);
    expect(CELL_BUILDING_CAP).toBeLessThanOrEqual(256);
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

  it('keeps every complete building footprint out of railway corridors and station sites', () => {
    let worst = Infinity;
    for (const building of all) {
      const clearance = footprintRailwayClearance(building.x, building.z, building.width, building.depth, building.heading);
      worst = Math.min(worst, clearance);
      expect(clearance, `${building.style} covers railway at ${building.x.toFixed(1)},${building.z.toFixed(1)}`).toBeGreaterThanOrEqual(RAILWAY_BUILDING_CLEARANCE - 1e-6);
    }
    expect(worst).toBeLessThan(10); // the guard is exercised by real parcels near the railway belt
    for (const station of RAILWAY_STATION_SITES) {
      const nearestFootprint = Math.min(...all.map((building) => Math.hypot(building.x - station.x, building.z - station.z) - Math.hypot(building.width, building.depth) / 2));
      expect(nearestFootprint, station.name).toBeGreaterThanOrEqual(RAILWAY_STATION_CLEARANCE);
    }
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

  it('keeps complete procedural footprints out of the Kelvin Yard stealth arena', () => {
    const nearestEdge = Math.min(...all.map((building) => (
      Math.hypot(building.x - KELVIN_YARD_CENTER.x, building.z - KELVIN_YARD_CENTER.z)
      - Math.hypot(building.width, building.depth) / 2
    )));
    // Three units outside the fence are intentionally walkable: this is the route from the gate to
    // the rear breach. A generated warehouse here used to bury the entire flagship mission arena.
    expect(nearestEdge).toBeGreaterThan(KELVIN_FENCE_RADIUS + 3);
  });

  it('keeps complete footprints out of parks, farms, water, dirt land, and the aerodrome', () => {
    const excluded = [WATER_POLYGONS, GREEN_POLYGONS, DIRT_POLYGONS, FARM_POLYGONS, AERODROME_POLYGONS];
    for (const building of all) {
      const c = Math.cos(building.heading); const s = Math.sin(building.heading);
      for (const fx of [-0.5, 0, 0.5]) for (const fz of [-0.5, 0, 0.5]) {
        const x = building.x + fx * building.width * c + fz * building.depth * s;
        const z = building.z - fx * building.width * s + fz * building.depth * c;
        for (const polygons of excluded) {
          if (pointInAnyPolygon(polygons, x, z)) throw new Error(`${building.style} footprint entered protected land at ${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
    }
  }, 20_000);

  it('keeps parcel occupancy separated even for the largest estate and tower footprints', () => {
    // Mirrors Occupancy.free exactly: an exact-packed pair (both zones carry a packing gap) is
    // held to the real footprint rule — CBD pairs may abut up to STREETWALL_MAX_OVERLAP of
    // measured interpenetration (party walls, never towers inside towers), residential pairs must
    // keep RESIDENTIAL_MIN_GAP of clear air (rects grown by the gap stay disjoint), a mixed pair
    // takes the stricter demand — while every other pair keeps the conservative circle spacing.
    const grown = (b: GeneratedBuilding, pad: number): GeneratedBuilding => ({ ...b, width: b.width + pad, depth: b.depth + pad });
    const grid = new Map<string, GeneratedBuilding[]>(); const cell = 256;
    for (const building of all) {
      const cx = Math.floor(building.x / cell); const cz = Math.floor(building.z / cell);
      const radius = Math.hypot(building.width, building.depth) / 2;
      const gap = zonePackingGap(building.zone);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const other of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const otherRadius = Math.hypot(other.width, other.depth) / 2;
          const otherGap = zonePackingGap(other.zone);
          if (gap !== undefined && otherGap !== undefined) {
            const need = Math.max(gap, otherGap);
            if (need <= 0) expect(footprintOverlapXZ(building, other)).toBeLessThanOrEqual(-need + 1e-6);
            else expect(footprintOverlapXZ(grown(building, need), grown(other, need)), `${building.zone}@${building.x.toFixed(0)},${building.z.toFixed(0)} vs ${other.zone}`).toBeLessThanOrEqual(1e-6);
          } else {
            expect(Math.hypot(building.x - other.x, building.z - other.z)).toBeGreaterThanOrEqual((radius + otherRadius) * OCCUPANCY_FACTOR + 1.5 - 1e-6);
          }
        }
      }
      const key = `${cx},${cz}`; const bucket = grid.get(key);
      if (bucket) bucket.push(building); else grid.set(key, [building]);
    }
  }, 30_000); // ~8,300 parcels; the residential-rect SAT mirror is quadratic in dense cells

  it('reports exactly the capped set returned by all generated cells', () => {
    const cells = new Set(all.map((building) => cellOf(building).join(',')));
    const streamedTotal = [...cells].reduce((total, key) => {
      const [cellX, cellZ] = key.split(',').map(Number) as [number, number];
      return total + generateCell(cellX, cellZ).length;
    }, 0);
    expect(streamedTotal).toBe(all.length);
    expect(buildingStats().total).toBe(all.length);
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
