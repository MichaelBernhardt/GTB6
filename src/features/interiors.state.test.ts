import { describe, expect, it } from 'vitest';
import { doorNear, interiorDoors, sanitizeInteriorsState, DOOR_RADIUS } from './interiors.state';
import { distanceToRoadEdge } from '../world/mapData';

describe('interior doorsteps', () => {
  it('derives a door for every interior from the generated map', () => {
    const doors = interiorDoors();
    expect(doors.map((door) => door.id)).toEqual(['spaza', 'flat', 'ponte']);
    for (const door of doors) {
      expect(Number.isFinite(door.x) && Number.isFinite(door.z)).toBe(true);
      expect(Number.isFinite(door.heading)).toBe(true);
    }
  });

  it('puts every doorstep on the pavement — off the road surface, not in it', () => {
    for (const door of interiorDoors()) {
      // besideRoad steps a full 3.4u beyond the kerb, so the step is never inside the carriageway.
      expect(distanceToRoadEdge(door.x, door.z)).toBeGreaterThan(1);
    }
  });

  it('faces the street: walking along the heading from the step reaches the road', () => {
    for (const door of interiorDoors()) {
      const ahead = { x: door.x + Math.sin(door.heading) * 4, z: door.z + Math.cos(door.heading) * 4 };
      expect(distanceToRoadEdge(ahead.x, ahead.z)).toBeLessThan(distanceToRoadEdge(door.x, door.z));
    }
  });

  it('keeps doorsteps clear of each other and of the shop pads they would fight for prompts with', () => {
    const doors = interiorDoors();
    for (let a = 0; a < doors.length; a++) for (let b = a + 1; b < doors.length; b++) {
      expect(Math.hypot(doors[a]!.x - doors[b]!.x, doors[a]!.z - doors[b]!.z)).toBeGreaterThan(26);
    }
  });

  it('memoises, so the every-frame approach test is a handful of distance checks', () => {
    expect(interiorDoors()).toBe(interiorDoors());
  });

  it('doorNear agrees with the ring the prompt promises', () => {
    const door = interiorDoors()[0]!;
    expect(doorNear(door.x, door.z)?.id).toBe(door.id);
    expect(doorNear(door.x + DOOR_RADIUS - 0.5, door.z)?.id).toBe(door.id);
    expect(doorNear(door.x + DOOR_RADIUS + 0.5, door.z)).toBeUndefined();
  });
});

describe('interiors save slice', () => {
  it('keeps a clean visited list', () => {
    expect(sanitizeInteriorsState({ visited: ['spaza', 'ponte'] })).toEqual({ visited: ['spaza', 'ponte'] });
  });

  it('survives junk, missing keys and hostile shapes', () => {
    expect(sanitizeInteriorsState(undefined)).toEqual({ visited: [] });
    expect(sanitizeInteriorsState({})).toEqual({ visited: [] });
    expect(sanitizeInteriorsState({ visited: 'spaza' })).toEqual({ visited: [] });
    expect(sanitizeInteriorsState({ visited: [1, null, { a: 1 }, 'flat'] })).toEqual({ visited: ['flat'] });
    expect(sanitizeInteriorsState({ visited: [`${'x'.repeat(64)}`] })).toEqual({ visited: [] });
    expect(sanitizeInteriorsState({ visited: new Array(80).fill('spaza') }).visited).toHaveLength(32);
  });
});
