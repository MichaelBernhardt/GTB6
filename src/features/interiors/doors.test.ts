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
    let checked = 0;
    for (const building of allBuildings().filter((_, index) => index % 31 === 0)) {
      const door = doorFor(building);
      if (!door) continue;
      checked++;
      const tag = planOf(building).entrance!;
      // The frame sits on the tagged plane, transformed by the building's own placement.
      const c = Math.cos(building.heading); const s = Math.sin(building.heading);
      expect(door.faceX).toBeCloseTo(building.x + tag.x * c + tag.z * s, 6);
      expect(door.faceZ).toBeCloseTo(building.z - tag.x * s + tag.z * c, 6);
      // ...and the step is one stride out along the building's own outward normal.
      expect(Math.hypot(door.x - door.faceX, door.z - door.faceZ)).toBeCloseTo(2.1, 6);
      // The step belongs to THIS building: never further from its centre than its own half-diagonal
      // plus that stride.
      const reach = Math.hypot(building.width, building.depth) / 2 + 2.2;
      expect(Math.hypot(door.x - building.x, door.z - building.z)).toBeLessThanOrEqual(reach);
      expect(door.facts.id).toBe(`${Math.round(building.x)}:${Math.round(building.z)}`);
      expect(door.openWidth).toBe(tag.width);
    }
    expect(checked, 'no doors were checked at all').toBeGreaterThan(30);
  }, 120000);

  it('never opens a loading dock, and never a building the facade pass left plain', () => {
    for (const building of allBuildings().filter((_, index) => index % 17 === 0)) {
      const tag = planOf(building).entrance;
      const door = doorFor(building);
      if (!tag || tag.kind === 'dock') expect(door, `${building.style} opened a ${tag?.kind ?? 'blank wall'}`).toBeUndefined();
    }
  }, 120000);

  it('keeps every doorstep off the carriageway, so E still opens a car at the kerb', () => {
    const doors = doorsNear(0, 0, CELL_SIZE * 2);
    expect(doors.length).toBeGreaterThan(0);
    for (const door of doors) {
      expect(distanceToRoadEdge(door.x, door.z), door.name).toBeGreaterThanOrEqual(2.4);
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
