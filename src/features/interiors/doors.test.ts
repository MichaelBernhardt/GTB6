/**
 * A door has to be on a REAL BUILDING, on the wall the model actually drew a door on.
 *
 * The owner's report on the previous attempt was "tried a bunch of buildings; can't see how to enter,
 * even when the model has a clear door". So this suite does not check that doors exist — it checks
 * that every door it produces sits on the entrance BuildingArchitecture tagged while drawing the
 * facade, at the plane that tag names, on a parcel that is really there.
 */
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { BuildingArchitecture } from '../../world/BuildingArchitecture';
import { allBuildings, generateCell, CELL_SIZE, type GeneratedBuilding } from '../../world/CityGen';
import { distanceToRoadEdge, nearestDistrict } from '../../world/mapData';
import { allScatteredModels } from '../../world/ModelScatter';
import { MODEL_INDEX } from '../../world/models/catalog';
import { neighbourhoodBuildingVariant } from '../../world/data/neighbourhoods';
import { DOOR_RADIUS } from '../interiors.state';
import { doorFor, doorNear, doorsNear, nearestDoor, resetDoorCache, scatterDoorFor } from './doors';
import { solveFloor } from './floor';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

function planOf(building: GeneratedBuilding) {
  return architecture.plan({
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style,
    variant: neighbourhoodBuildingVariant(nearestDistrict(building.x, building.z).name, building.variant),
    facade, roof,
  });
}

describe('doors', () => {
  beforeEach(() => { resetDoorCache(); });

  it('puts the doorstep in front of the plane the model tagged, on the building it belongs to', () => {
    let checked = 0; let tucked = 0; let suburbanChecked = 0; let suburbanTucked = 0;
    for (const building of allBuildings().filter((_, index) => index % 31 === 0)) {
      const door = doorFor(building);
      if (!door) continue;
      checked++;
      const streetWall = building.style === 'downtown';
      if (!streetWall) suburbanChecked++;
      const tag = planOf(building).entrance!;
      // The frame sits on the tagged plane, transformed by the building's own placement.
      const c = Math.cos(building.heading); const s = Math.sin(building.heading);
      expect(door.faceX).toBeCloseTo(building.x + tag.x * c + tag.z * s, 6);
      expect(door.faceZ).toBeCloseTo(building.z - tag.x * s + tag.z * c, 6);
      // ...and the step is a stride out along the building's own outward normal, clear of the wall
      // by more than CoverSystem's 2.5 snap unless the pavement is too narrow to allow it.
      const standOff = Math.hypot(door.x - door.faceX, door.z - door.faceZ);
      expect(standOff, door.name).toBeLessThanOrEqual(2.9 + 1e-6);
      expect(standOff, door.name).toBeGreaterThan(0.3);
      if (standOff < 2.6) { tucked++; if (!streetWall) suburbanTucked++; }
      // The step belongs to THIS building: never further from its centre than its own half-diagonal
      // plus that stride.
      const reach = Math.hypot(building.width, building.depth) / 2 + 3.0;
      expect(Math.hypot(door.x - building.x, door.z - building.z)).toBeLessThanOrEqual(reach);
      expect(door.facts.id).toBe(`${Math.round(building.x)}:${Math.round(building.z)}`);
      expect(door.openWidth).toBe(tag.width);
    }
    expect(checked, 'no doors were checked at all').toBeGreaterThan(30);
    // Outside the CBD street wall, almost every doorstep makes the full stand-off; only a pavement
    // too narrow for it tucks in. Downtown is EXPECTED to tuck: the city-density pass stands its
    // buildings at yard 0.6 — the Joburg street wall, where a lobby door genuinely opens onto the
    // pavement — so the tuck ladder (STAND_OFFS) doing its designed job there is not the
    // floating-doorstep bug this ratio was written to catch. The wall-plane, ownership and
    // step-exists assertions above still hold for every door, downtown included.
    expect(suburbanTucked / suburbanChecked, `${suburbanTucked}/${suburbanChecked} non-street-wall doorsteps had to tuck against their wall`).toBeLessThan(0.05);
    expect(tucked / checked, `${tucked}/${checked} doorsteps tucked citywide — even the CBD street wall should leave most of the city standing clear`).toBeLessThan(0.45);
  }, 120000);

  /**
   * THE OWNER'S OWN TEST, as an assertion: walk up to buildings at random and get a prompt every
   * time. This used to open 1,474 of the city's 3,722 parcels — a 0.62 lottery over the tagged ones,
   * a ban on loading docks, a 30-a-cell ceiling and a facade-parity rule upstream. Every one of
   * those has gone: nothing is generated until somebody walks in, so a shut building saves nothing
   * and costs the player the belief that the feature works at all.
   */
  it('opens essentially every parcel in the city', () => {
    const all = allBuildings();
    const open = all.filter((building) => doorFor(building)).length;
    expect(all.length).toBeGreaterThan(3000);
    expect(open / all.length, `only ${open} of ${all.length} parcels open`).toBeGreaterThan(0.99);
  }, 300000);

  it('opens every structural family, works and houses included', () => {
    const seen = new Map<string, { open: number; total: number }>();
    for (const building of allBuildings()) {
      const row = seen.get(building.style) ?? { open: 0, total: 0 };
      row.total++;
      if (doorFor(building)) row.open++;
      seen.set(building.style, row);
    }
    // Every family the map zones has to be represented and has to be almost entirely open.
    expect([...seen.keys()].sort()).toContain('industrial');
    expect([...seen.keys()].sort()).toContain('suburban');
    for (const [style, row] of seen) {
      expect(row.open / row.total, `${style}: ${row.open}/${row.total} open`).toBeGreaterThan(0.95);
    }
  }, 300000);

  it('keeps every doorstep off the carriageway, so E still opens a car at the kerb', () => {
    const doors = doorsNear(0, 0, CELL_SIZE * 2);
    expect(doors.length).toBeGreaterThan(0);
    for (const door of doors) {
      // 2.4 is the target; a pavement too narrow for it tucks the step against its own wall, and
      // then all that is asked is that the step is not on the tar. See STAND_OFFS.
      expect(distanceToRoadEdge(door.x, door.z), door.name).toBeGreaterThanOrEqual(0.5);
    }
  }, 300000);

  it('offers hundreds of doors across the city, not three', () => {
    let total = 0;
    for (let cellX = -3; cellX <= 3; cellX++) {
      for (let cellZ = -3; cellZ <= 3; cellZ++) {
        total += generateCell(cellX, cellZ).filter((building) => doorFor(building)).length;
      }
    }
    expect(total).toBeGreaterThan(200);
  }, 300000);

  it('answers on a doorstep that lies across a chunk-cell line from its building', () => {
    // A parcel's door is stored under its BUILDING CENTRE's cell, but the step is out past the
    // facade — 65 of 7,415 doorsteps citywide sat in the neighbouring cell, and doorNear's 4.2 u
    // ring never opened it: a lit marker that never offered a prompt. The audit's worked example
    // lives near (-4378, -1960); scan that block, find every cross-cell step, and prove each one
    // now answers to the exact door standing on it.
    const nearCellX = Math.floor(-4378 / CELL_SIZE); const nearCellZ = Math.floor(-1960 / CELL_SIZE);
    const crossers = [];
    for (let cx = nearCellX - 1; cx <= nearCellX + 1; cx++) {
      for (let cz = nearCellZ - 1; cz <= nearCellZ + 1; cz++) {
        const centreX = (cx + 0.5) * CELL_SIZE; const centreZ = (cz + 0.5) * CELL_SIZE;
        for (const door of doorsNear(centreX, centreZ, CELL_SIZE * 0.75)) {
          if (door.id.startsWith('s')) continue; // scatter doors tile with their own reach already
          const stepCellX = Math.floor(door.x / CELL_SIZE); const stepCellZ = Math.floor(door.z / CELL_SIZE);
          const homeCellX = Math.floor(door.facts.x / CELL_SIZE); const homeCellZ = Math.floor(door.facts.z / CELL_SIZE);
          if (stepCellX !== homeCellX || stepCellZ !== homeCellZ) crossers.push(door);
        }
      }
    }
    expect(crossers.length, 'the audit found cross-cell steps in this block; the fixture has moved if none remain').toBeGreaterThan(0);
    for (const door of crossers) {
      expect(doorNear(door.x, door.z)?.id, `standing on ${door.id}'s step must prompt ${door.id}`).toBe(door.id);
    }
  });

  it('resolves the prompt and the press through the same ring', () => {
    const door = nearestDoor(0, 0);
    expect(door).toBeDefined();
    expect(doorNear(door!.x, door!.z)?.id).toBe(door!.id);
    // A stride beyond the ring, this door is no longer the answer.
    const away = doorNear(door!.x + DOOR_RADIUS + 1.5, door!.z);
    expect(away?.id === door!.id).toBe(false);
  }, 120000);

  it('is the same set of doors on the second walk down the street', () => {
    const first = doorsNear(0, 0, 600).map((door) => `${door.id}@${door.x}:${door.z}`);
    resetDoorCache();
    const again = doorsNear(0, 0, 600).map((door) => `${door.id}@${door.x}:${door.z}`);
    expect(again).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  }, 120000);
});

/**
 * THE OTHER 3,721 BUILDINGS.
 *
 * The previous report said 3,721 of 3,722 open and the owner walked outside and found buildings that
 * did not. Both were true: that number counted CityGen's parcels, and the city ALSO carries 13,900
 * scattered catalog models, of which 3,721 are things a person lives or works in. So these tests
 * count the whole universe — every enterable-looking object placed by either pass — because the
 * denominator is the part of the last report that was wrong.
 */
describe('doors on scattered models', () => {
  beforeEach(() => { resetDoorCache(); });

  /** The exact spot the owner reported: "-3011.8,484.1 has a common building type with no entrance."
   *  It is a scattered office-block, six metres off, and the parcel pass has nothing within 38 u. */
  it('offers a prompt at the coordinate the owner reported as shut', () => {
    const door = doorNear(-3011.8, 484.1);
    expect(door, 'no prompt at -3011.8,484.1').toBeDefined();
    expect(door!.id.startsWith('s'), 'the door there should be a scattered model, not a parcel').toBe(true);
    expect(doorNear(door!.x, door!.z)?.id).toBe(door!.id);
  }, 300000);

  it('opens essentially every scattered model a person would live or work in', () => {
    const enterable = allScatteredModels().filter((model) => MODEL_INDEX.get(model.name)?.interior);
    // Floor recalibrated for the city-density passes: procedural parcels claim frontage before
    // scatter, and packing the CBD (3,712 → ~5,450 parcels) then the suburbs (→ ~8,370) moved
    // enterable buildings from the scatter column to the parcel column (~2,550 → ~1,740 scattered
    // enterables, while the combined universe GREW ~8,000 → ~10,100). The 0.99 open ratio below
    // is the real guard; this floor only proves scatter still contributes a real share.
    expect(enterable.length).toBeGreaterThan(1500);
    const open = enterable.filter((model) => scatterDoorFor(model)).length;
    expect(open / enterable.length, `only ${open} of ${enterable.length} scattered buildings open`).toBeGreaterThan(0.99);
  }, 900000);

  it('never opens a silo, a pylon, a tree or a stock kraal', () => {
    for (const name of ['grain-silo', 'water-tower', 'windpomp', 'kraal', 'cell-tower', 'billboard', 'tank-farm', 'container-stack', 'jacaranda', 'veld-grass']) {
      expect(MODEL_INDEX.get(name)?.interior, name).toBeUndefined();
    }
    const shut = allScatteredModels().filter((model) => !MODEL_INDEX.get(model.name)?.interior);
    for (const model of shut.filter((_, index) => index % 97 === 0)) {
      expect(scatterDoorFor(model), model.name).toBeUndefined();
    }
  }, 300000);

  /** A shed that generates a lounge is worse than a shed that stays shut, so every scattered family
   *  has to land on the grammar its own model family asks for. */
  it('matches the interior grammar to the model family', () => {
    const wanted: Record<string, string> = {
      farmhouse: 'PLOT', 'tin-roof-house': 'HOUSE', 'sandton-villa': 'HOUSE', 'rdp-row': 'HOUSE',
      barn: 'WORKS', 'tractor-shed': 'WORKS', warehouse: 'WORKS', 'boat-shed': 'WORKS',
      'spaza-shop': 'SPAZA', padstal: 'SPAZA', 'strip-mall': 'SPAZA',
      church: 'HALL', mosque: 'HALL', school: 'HALL', 'community-hall': 'HALL',
      'office-block': 'LOBBY', 'walk-up-flats': 'LOBBY',
    };
    const seen = new Set<string>();
    for (const model of allScatteredModels()) {
      const want = wanted[model.name];
      if (!want || seen.has(model.name)) continue;
      const door = scatterDoorFor(model);
      if (!door) continue;
      seen.add(model.name);
      const plan = solveFloor(door.facts, 0);
      expect(plan.eyebrow, `${model.name} generated a ${plan.eyebrow}`).toBe(want);
      expect(plan.rooms.length).toBeGreaterThan(0);
    }
    expect([...seen].sort()).toEqual(Object.keys(wanted).sort());
  }, 900000);

  /** Both passes in one list, resolved the same way, with no two doorsteps on one paving slab. */
  it('mixes both systems into one ring with no duplicate steps', () => {
    const near = doorsNear(-3011.8, 484.1, 190);
    expect(near.some((door) => door.id.startsWith('s'))).toBe(true);
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        expect(Math.hypot(near[i]!.x - near[j]!.x, near[i]!.z - near[j]!.z), `${near[i]!.name} / ${near[j]!.name}`).toBeGreaterThanOrEqual(2.6);
      }
    }
  }, 300000);

  it('is the same set of scattered doors on the second walk past', () => {
    const first = doorsNear(-3011.8, 484.1, 400).map((door) => `${door.id}@${door.x}:${door.z}:${door.name}`);
    resetDoorCache();
    const again = doorsNear(-3011.8, 484.1, 400).map((door) => `${door.id}@${door.x}:${door.z}:${door.name}`);
    expect(again).toEqual(first);
    expect(first.filter((entry) => entry.startsWith('s')).length).toBeGreaterThan(0);
  }, 300000);
});
