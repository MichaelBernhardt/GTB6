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
import { distanceToRoadEdge } from '../../world/mapData';
import { DOOR_RADIUS } from '../interiors.state';
import { doorFor, doorNear, doorsNear, nearestDoor, resetDoorCache } from './doors';

const architecture = new BuildingArchitecture(new THREE.Group());
const facade = new THREE.MeshBasicMaterial();
const roof = new THREE.MeshBasicMaterial();

function planOf(building: GeneratedBuilding) {
  return architecture.plan({
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant: building.variant, facade, roof,
  });
}

describe('doors', () => {
  beforeEach(() => { resetDoorCache(); });

  it('puts the doorstep in front of the plane the model tagged, on the building it belongs to', () => {
    let checked = 0; let tucked = 0;
    for (const building of allBuildings().filter((_, index) => index % 31 === 0)) {
      const door = doorFor(building);
      if (!door) continue;
      checked++;
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
      if (standOff < 2.6) tucked++;
      // The step belongs to THIS building: never further from its centre than its own half-diagonal
      // plus that stride.
      const reach = Math.hypot(building.width, building.depth) / 2 + 3.0;
      expect(Math.hypot(door.x - building.x, door.z - building.z)).toBeLessThanOrEqual(reach);
      expect(door.facts.id).toBe(`${Math.round(building.x)}:${Math.round(building.z)}`);
      expect(door.openWidth).toBe(tag.width);
    }
    expect(checked, 'no doors were checked at all').toBeGreaterThan(30);
    // Almost every doorstep makes the full stand-off; only a pavement too narrow for it tucks in.
    expect(tucked / checked, `${tucked}/${checked} doorsteps had to tuck against their wall`).toBeLessThan(0.05);
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
