import { describe, expect, it } from 'vitest';
import {
  allScatteredModels,
  scatterCell,
  scatterStats,
  nearCoast,
  SCATTER_CELL_CAP,
  STRUCT_ROAD_CLEARANCE,
  FOLIAGE_ROAD_CLEARANCE,
  type ScatteredModel,
} from './ModelScatter';
import { CELL_SIZE, RAILWAY_BUILDING_CLEARANCE, RAILWAY_STATION_CLEARANCE, allBuildings, footprintRailwayClearance, footprintRoadClearance, type GeneratedBuilding } from './CityGen';
import { MODEL_INDEX } from './models/catalog';
import { MAP_STATS, MAP_WORLD_SIZE, METRES_PER_UNIT, WATER_POLYGONS, AERODROME_POLYGONS, FARM_POLYGONS, RAILWAY_STATION_SITES, distanceToBuiltRoadEdge, pointInAnyPolygon } from './mapData';
import { buildCityNavPaths, ROAD_NETWORK } from './City';
import { TREE_SPECIES } from './FoliageAssets';
import { PLAYER } from '../config';
import { classifyZone } from './data/zoning';
import { MANICURED_FOOTPRINTS } from './data/manicured';

const HALF = MAP_WORLD_SIZE / 2;
const QUARTER = Math.PI / 2;
const cellOf = (m: ScatteredModel): [number, number] => [Math.floor(m.x / CELL_SIZE), Math.floor(m.z / CELL_SIZE)];
const isFoliage = (name: string): boolean => MODEL_INDEX.get(name)?.category === 'foliage';

describe('citywide model scatter', () => {
  const all = allScatteredModels();

  it('fills the map broadly with thousands of models across every quadrant', () => {
    // Dense-clutter floor: streets and veld must read inhabited. Stated as a density rather than the
    // old flat 20,000, which was ~51% of what the 19,200-unit map actually scattered (39,112 over its
    // 333.3 km² / 339.4 million square units of land). Clutter is placed in world units, so the same
    // 51%-of-nominal floor over this crop's own 90.2-million-u² of land is the like-for-like figure.
    const CLUTTER_FLOOR_PER_SQUARE_UNIT = 20000 / 339.4e6;
    const landSquareUnits = ((MAP_STATS.landKm2 ?? 333.3) * 1e6) / METRES_PER_UNIT ** 2;
    expect(all.length).toBeGreaterThan(CLUTTER_FLOOR_PER_SQUARE_UNIT * landSquareUnits);

    const quadrants = new Set(all.map((m) => `${Math.sign(m.x)},${Math.sign(m.z)}`));
    expect(quadrants.size).toBeGreaterThanOrEqual(4);
  });

  it('only references models that exist in the catalog', () => {
    for (const m of all) expect(MODEL_INDEX.has(m.name), m.name).toBe(true);
  });

  it('keeps every model inside the world bounds', () => {
    expect(all.every((m) => Math.abs(m.x) < HALF && Math.abs(m.z) < HALF)).toBe(true);
  });

  it('gives models free headings (road structures align to the street, fields rotate naturally — no compass snap)', () => {
    // Oriented-box colliders follow any heading now, so models are no longer forced to N/S/E/W. Road-facing
    // structures take the true kerb angle and area fill takes a continuous random yaw, so the overwhelming
    // majority of headings are non-quarter-turns.
    const snapped = all.filter((m) => { const t = m.heading / QUARTER; return Math.abs(t - Math.round(t)) < 1e-3; });
    expect(snapped.length / all.length).toBeLessThan(0.5);
  });

  it('represents every model category (structures + foliage across all zones)', () => {
    const cats = scatterStats().perCategory;
    for (const cat of ['rural', 'commercial', 'industrial', 'coastal', 'residential', 'civic', 'foliage']) {
      expect(cats[cat] ?? 0, cat).toBeGreaterThan(0);
    }
    // foliage instances heavily — it should dominate the scatter
    expect(cats.foliage!).toBeGreaterThan(all.length * 0.4);
  });

  it('never overhangs a road: buildings clear the corridor, verge furniture stays off the tar', () => {
    // Foliage and roadside furniture (billboards, cell-towers) sit ON the verge by design, so they
    // only owe the weak off-the-carriageway clearance; every building mass owes the full corridor.
    const verge = new Set(['billboard', 'cell-tower']);
    for (const m of all) {
      const def = MODEL_INDEX.get(m.name)!;
      const clr = footprintRoadClearance(m.x, m.z, def.maxFootprint.w, def.maxFootprint.d, m.heading);
      const min = isFoliage(m.name) || verge.has(m.name) ? FOLIAGE_ROAD_CLEARANCE : STRUCT_ROAD_CLEARANCE;
      expect(clr, `${m.name} @ ${m.x.toFixed(1)},${m.z.toFixed(1)}`).toBeGreaterThanOrEqual(min - 1e-6);
      // Nothing, ever, sits on the carriageway itself.
      expect(clr, `${m.name} on the tar`).toBeGreaterThanOrEqual(FOLIAGE_ROAD_CLEARANCE - 1e-6);
    }
  }, 30_000); // full-city scan across ~41k scattered models (post-density-increase) needs more than the 5 s default

  it('keeps structures, foliage, and station approaches clear of railway land', () => {
    const verge = new Set(['billboard', 'cell-tower']);
    for (const model of all) {
      const def = MODEL_INDEX.get(model.name)!;
      const clearance = footprintRailwayClearance(model.x, model.z, def.maxFootprint.w, def.maxFootprint.d, model.heading);
      const minimum = isFoliage(model.name) || verge.has(model.name) ? FOLIAGE_ROAD_CLEARANCE : RAILWAY_BUILDING_CLEARANCE;
      expect(clearance, `${model.name} covers railway at ${model.x.toFixed(1)},${model.z.toFixed(1)}`).toBeGreaterThanOrEqual(minimum - 1e-6);
    }
    for (const station of RAILWAY_STATION_SITES) {
      const nearestFootprint = Math.min(...all.map((model) => {
        const def = MODEL_INDEX.get(model.name)!;
        return Math.hypot(model.x - station.x, model.z - station.z) - Math.hypot(def.maxFootprint.w, def.maxFootprint.d) / 2;
      }));
      expect(nearestFootprint, station.name).toBeGreaterThanOrEqual(RAILWAY_STATION_CLEARANCE);
    }
  });

  it('respects the crafted-first contract: nothing overlaps a manicured site claim', () => {
    for (const site of MANICURED_FOOTPRINTS) {
      for (const m of all) {
        const d = Math.hypot(m.x - site.x, m.z - site.z);
        expect(d, `${m.name} intrudes on ${site.id}`).toBeGreaterThan(site.radius * 0.5);
      }
    }
  });

  it('never places a model inside water or on the aerodrome', () => {
    for (const m of all) {
      expect(pointInAnyPolygon(WATER_POLYGONS, m.x, m.z), `${m.name} in water`).toBe(false);
      expect(pointInAnyPolygon(AERODROME_POLYGONS, m.x, m.z), `${m.name} on runway`).toBe(false);
    }
  });

  it('keeps model footprints separate and honours same-model spacing citywide', () => {
    const grid = new Map<string, ScatteredModel[]>(); const cell = 64; let maxRadius = 0;
    for (const model of all) {
      const def = MODEL_INDEX.get(model.name)!; const radius = Math.hypot(def.maxFootprint.w, def.maxFootprint.d) / 2;
      const cx = Math.floor(model.x / cell); const cz = Math.floor(model.z / cell);
      const reach = Math.max(1, Math.ceil(Math.max(radius + maxRadius, def.spacing) / cell) + 1);
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        for (const other of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const otherDef = MODEL_INDEX.get(other.name)!;
          const otherRadius = Math.hypot(otherDef.maxFootprint.w, otherDef.maxFootprint.d) / 2;
          const distance = Math.hypot(model.x - other.x, model.z - other.z);
          if (distance < radius + otherRadius - 1e-6) throw new Error(`${model.name} overlaps ${other.name}`);
          if (model.name === other.name && distance < Math.max(def.spacing, otherDef.spacing) - 1e-6) throw new Error(`${model.name} violates spacing`);
        }
      }
      const key = `${cx},${cz}`; const bucket = grid.get(key);
      if (bucket) bucket.push(model); else grid.set(key, [model]);
      maxRadius = Math.max(maxRadius, radius);
    }
  }, 30_000);

  it('never overlaps a streamed procedural building', () => {
    const cell = 256; const grid = new Map<string, GeneratedBuilding[]>(); let maxRadius = 0;
    for (const building of allBuildings()) {
      const key = `${Math.floor(building.x / cell)},${Math.floor(building.z / cell)}`;
      const bucket = grid.get(key); if (bucket) bucket.push(building); else grid.set(key, [building]);
      maxRadius = Math.max(maxRadius, Math.hypot(building.width, building.depth) / 2);
    }
    for (const model of all) {
      const def = MODEL_INDEX.get(model.name)!; const radius = Math.hypot(def.maxFootprint.w, def.maxFootprint.d) / 2;
      const cx = Math.floor(model.x / cell); const cz = Math.floor(model.z / cell);
      const reach = Math.max(1, Math.ceil((radius + maxRadius) / cell) + 1);
      for (let dx = -reach; dx <= reach; dx++) for (let dz = -reach; dz <= reach; dz++) {
        for (const building of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
          const buildingRadius = Math.hypot(building.width, building.depth) / 2;
          if (Math.hypot(model.x - building.x, model.z - building.z) < radius + buildingRadius - 1e-6) throw new Error(`${model.name} overlaps ${building.style}`);
        }
      }
    }
  }, 30_000);

  it('keeps zone affinity: coastal-only models hug the coast, industry stays in the belt', () => {
    // Models that can ONLY come from the coastal promenade / beach passes must be near a beach.
    const coastOnly = new Set(['beach-cafe', 'boat-shed', 'lifeguard-tower', 'beach-loungers', 'pier-kiosk']);
    for (const m of all) if (coastOnly.has(m.name)) expect(nearCoast(m.x, m.z), `${m.name} strayed inland`).toBe(true);

    // Rural farmstead structures overwhelmingly sit in farmland / the rural corridor (a few frontage
    // set-backs may drift a couple of metres past a polygon edge — assert the strong majority).
    const rural = all.filter((m) => ['farmhouse', 'barn', 'kraal', 'grain-silo', 'windpomp', 'tractor-shed'].includes(m.name));
    expect(rural.length).toBeGreaterThan(0);
    const inVeld = rural.filter((m) => pointInAnyPolygon(FARM_POLYGONS, m.x, m.z) || classifyZone(m.x, m.z) === 'rural').length;
    expect(inVeld / rural.length).toBeGreaterThan(0.85);

    // Residential SA houses never come from the coastal pass, so they must not sit near a beach.
    for (const m of all) if (['face-brick-house', 'sandton-villa', 'townhouse-row'].includes(m.name)) {
      expect(nearCoast(m.x, m.z), `${m.name} on the beachfront`).toBe(false);
    }
  });

  it('never exceeds the per-cell cap (bounds draw calls + generation cost)', () => {
    expect(scatterStats().maxPerCell).toBeLessThanOrEqual(SCATTER_CELL_CAP);
    // Budget window: high enough that busy cells read dense, capped so a cell's merge stays bounded.
    expect(SCATTER_CELL_CAP).toBeGreaterThanOrEqual(150);
    expect(SCATTER_CELL_CAP).toBeLessThanOrEqual(220);
  });

  it('never plants a solid trunk where a player or a ped has to walk', () => {
    // Authored tree trunks are SOLID props (see City.trunkProp), so where they land is now a
    // gameplay fact, not dressing: a trunk overlapping a pavement is an invisible wall on a route
    // the game tells you to use, and a trunk on a ped walk line is somewhere a pedestrian gets
    // pinned. Both are worse than the bug this fixed, so both are pinned here.
    const FATTEST_TRUNK_RADIUS = 0.85; // landmark-tree, 1.7 m authored diameter — see art/foliage/recipe.json
    const trees = all.filter((model) => (TREE_SPECIES as readonly string[]).includes(model.name));
    expect(trees.length).toBeGreaterThan(4000);

    for (const tree of trees) {
      // Clear of the road AS BUILT — tar plus kerb plus sidewalk — by more than the trunk's own radius.
      expect(distanceToBuiltRoadEdge(tree.x, tree.z), `${tree.name} @ ${tree.x.toFixed(1)},${tree.z.toFixed(1)}`)
        .toBeGreaterThan(FATTEST_TRUNK_RADIUS);
    }

    // And clear of the walk lines the ped nav routes on by the trunk radius plus a body: a ped
    // following its lane never has to resolve a blocked step against a tree.
    const cell = 24;
    const walks = new Map<string, Array<[number, number, number, number]>>();
    for (const path of buildCityNavPaths(ROAD_NETWORK).walks) {
      for (let index = 0; index < path.points.length - 1; index++) {
        const a = path.points[index]!; const b = path.points[index + 1]!;
        const key = `${Math.floor((a.x + b.x) / 2 / cell)},${Math.floor((a.z + b.z) / 2 / cell)}`;
        const bucket = walks.get(key) ?? [];
        bucket.push([a.x, a.z, b.x, b.z]); walks.set(key, bucket);
      }
    }
    let nearest = Infinity;
    for (const tree of trees) {
      const cx = Math.floor(tree.x / cell); const cz = Math.floor(tree.z / cell);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        for (const [ax, az, bx, bz] of walks.get(`${cx + dx},${cz + dz}`) ?? []) {
          const sx = bx - ax; const sz = bz - az; const lengthSquared = sx * sx + sz * sz;
          const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((tree.x - ax) * sx + (tree.z - az) * sz) / lengthSquared));
          nearest = Math.min(nearest, Math.hypot(tree.x - (ax + sx * t), tree.z - (az + sz * t)));
        }
      }
    }
    expect(nearest).toBeGreaterThan(FATTEST_TRUNK_RADIUS + PLAYER.radius);
  }, 30_000);

  it('streams every new district-specific structure archetype', () => {
    const counts = scatterStats().perModel;
    for (const name of [
      'mixed-use-corner', 'parking-garage', 'semi-detached-house', 'walk-up-flats',
      'rdp-row', 'workshop-row', 'logistics-depot', 'farm-worker-cottages',
    ]) expect(counts[name] ?? 0, name).toBeGreaterThan(0);
  });

  it('reports exactly the capped model set returned by all scatter cells', () => {
    const cells = new Set(all.map((model) => cellOf(model).join(',')));
    const streamedTotal = [...cells].reduce((total, key) => {
      const [cellX, cellZ] = key.split(',').map(Number) as [number, number];
      return total + scatterCell(cellX, cellZ).length;
    }, 0);
    expect(streamedTotal).toBe(all.length);
    expect(scatterStats().total).toBe(all.length);
  });
});

describe('scatterCell (on-demand streaming contract)', () => {
  const densest = (() => {
    const counts = new Map<string, number>();
    for (const m of allScatteredModels()) { const k = cellOf(m).join(','); counts.set(k, (counts.get(k) ?? 0) + 1); }
    let key = '0,0'; let best = 0;
    for (const [k, n] of counts) if (n > best) { best = n; key = k; }
    return key.split(',').map(Number) as [number, number];
  })();

  it('returns models for a populated cell, capped', () => {
    const cell = scatterCell(densest[0], densest[1]);
    expect(cell.length).toBeGreaterThan(0);
    expect(cell.length).toBeLessThanOrEqual(SCATTER_CELL_CAP);
  });

  it('regenerates a cell byte-identically (generate → dispose → regenerate)', () => {
    const first = scatterCell(densest[0], densest[1]);
    scatterCell(densest[0] + 3, densest[1]); // drive away and back
    scatterCell(densest[0], densest[1] + 3);
    const again = scatterCell(densest[0], densest[1]);
    expect(again).toEqual(first);
  });

  it('returns fresh spec objects each call (safe for the caller to consume/dispose)', () => {
    const a = scatterCell(densest[0], densest[1]);
    const b = scatterCell(densest[0], densest[1]);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0]).toEqual(b[0]);
  });

  it('is empty for an out-of-map cell', () => {
    expect(scatterCell(9999, 9999)).toEqual([]);
  });
});
