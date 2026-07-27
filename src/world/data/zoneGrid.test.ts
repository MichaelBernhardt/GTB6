import { describe, expect, it } from 'vitest';
import { WORLD_SIZE } from '../../config';
import { SPAWN_POINT } from '../placements';
import {
  activeZones, advanceAxis, advanceZone, axisIndex, ZONE_COLS, ZONE_HYSTERESIS, ZONE_SIZE, zoneCharacter, zoneKey, zoneOf,
} from './zoneGrid';
import { ZONES } from './zoning';

describe('zone grid geometry', () => {
  it('dices the whole world into a square grid', () => {
    expect(ZONE_COLS).toBe(Math.ceil(WORLD_SIZE / ZONE_SIZE));
    expect(ZONE_COLS * ZONE_SIZE).toBeGreaterThanOrEqual(WORLD_SIZE); // the far edge is always covered
  });

  it('maps a coordinate to its axis cell and clamps at the borders', () => {
    expect(axisIndex(0)).toBe(Math.floor((WORLD_SIZE / 2) / ZONE_SIZE)); // world centre
    expect(axisIndex(-WORLD_SIZE)).toBe(0); // far past the low edge clamps in
    expect(axisIndex(WORLD_SIZE)).toBe(ZONE_COLS - 1); // far past the high edge clamps in
    expect(axisIndex(-WORLD_SIZE / 2)).toBe(0); // exact low corner
  });

  it('places a point in the cell spanning its coordinates', () => {
    const centre = zoneOf(0, 0);
    expect(centre).toEqual({ col: axisIndex(0), row: axisIndex(0) });
    // a point one cell up and right lands one cell up and right
    expect(zoneOf(ZONE_SIZE, ZONE_SIZE)).toEqual({ col: centre.col + 1, row: centre.row + 1 });
  });

  it('gives every cell a distinct key', () => {
    expect(zoneKey(0, 0)).not.toBe(zoneKey(1, 0));
    expect(zoneKey(0, 1)).not.toBe(zoneKey(1, 0));
    expect(zoneKey(3, 4)).toBe(4 * ZONE_COLS + 3);
  });
});

describe('active set + hysteresis', () => {
  // An INTERIOR cell — one with a full ring of neighbours — derived from the grid rather than pinned
  // at 5. The 2/3 crop takes the world from 19,200u (11x11 zones) to 9,806u (6x6), which made cell 5
  // the far EDGE: the 3x3 assertions below were silently testing a corner clip, not the interior.
  const MID = Math.floor((ZONE_COLS - 1) / 2);

  it('activates the current cell and its eight neighbours', () => {
    const cells = activeZones({ col: MID, row: MID });
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual({ col: MID, row: MID });
    expect(cells).toContainEqual({ col: MID - 1, row: MID - 1 });
    expect(cells).toContainEqual({ col: MID + 1, row: MID + 1 });
  });

  it('clips the active set at the map edge (no wrap, no out-of-grid cells)', () => {
    const corner = activeZones({ col: 0, row: 0 });
    expect(corner).toHaveLength(4); // only itself + 3 in-bounds neighbours
    for (const cell of corner) {
      expect(cell.col).toBeGreaterThanOrEqual(0); expect(cell.row).toBeGreaterThanOrEqual(0);
      expect(cell.col).toBeLessThan(ZONE_COLS); expect(cell.row).toBeLessThan(ZONE_COLS);
    }
  });

  it('holds the current cell until the player is well past a boundary', () => {
    const lower = MID * ZONE_SIZE - WORLD_SIZE / 2; // the middle cell spans [lower, lower + ZONE_SIZE]
    const upper = lower + ZONE_SIZE;
    expect(advanceAxis(MID, upper)).toBe(MID); // exactly on the boundary: no switch
    expect(advanceAxis(MID, upper + ZONE_HYSTERESIS)).toBe(MID); // inside the dead-band: still no switch
    expect(advanceAxis(MID, upper + ZONE_HYSTERESIS + 1)).toBe(MID + 1); // past the dead-band: advance
    expect(advanceAxis(MID, lower - ZONE_HYSTERESIS - 1)).toBe(MID - 1); // and the other way
  });

  it('snaps straight to the destination cell on a big jump (a teleport)', () => {
    expect(advanceAxis(5, WORLD_SIZE / 2 - 1)).toBe(axisIndex(WORLD_SIZE / 2 - 1));
    expect(advanceZone({ col: 5, row: 5 }, -WORLD_SIZE / 2 + 1, -WORLD_SIZE / 2 + 1)).toEqual({ col: 0, row: 0 });
  });

  it('does not thrash the current cell while dithering across a boundary', () => {
    const boundary = (MID + 1) * ZONE_SIZE - WORLD_SIZE / 2; // shared edge of MID and MID+1 on the x axis
    let current = { col: MID, row: MID };
    for (const nudge of [-1, 1, -2, 3, -1, 2]) current = advanceZone(current, boundary + nudge, 0);
    expect(current.col).toBe(MID); // small wobbles within the hysteresis band never flip the zone
  });
});

describe('zone character', () => {
  it('classifies the CBD block as a highrise core and is stable/cached', () => {
    const cbd = zoneOf(SPAWN_POINT.x, SPAWN_POINT.z);
    expect(zoneCharacter(cbd.col, cbd.row)).toBe('commercial-highrise');
    expect(zoneCharacter(cbd.col, cbd.row)).toBe(zoneCharacter(cbd.col, cbd.row)); // deterministic
  });

  it('always returns a defined land-use zone for any in-grid cell', () => {
    // Sample the whole grid rather than indices that only existed on the 11x11 world.
    for (let col = 0; col < ZONE_COLS; col += 1) for (let row = 0; row < ZONE_COLS; row += 1) expect(ZONES).toContain(zoneCharacter(col, row));
  });
});
