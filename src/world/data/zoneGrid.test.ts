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
  it('activates the current cell and its eight neighbours', () => {
    const cells = activeZones({ col: 5, row: 5 });
    expect(cells).toHaveLength(9);
    expect(cells).toContainEqual({ col: 5, row: 5 });
    expect(cells).toContainEqual({ col: 4, row: 4 });
    expect(cells).toContainEqual({ col: 6, row: 6 });
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
    const lower = 5 * ZONE_SIZE - WORLD_SIZE / 2; // cell 5 spans [lower, lower + ZONE_SIZE]
    const upper = lower + ZONE_SIZE;
    expect(advanceAxis(5, upper)).toBe(5); // exactly on the boundary: no switch
    expect(advanceAxis(5, upper + ZONE_HYSTERESIS)).toBe(5); // inside the dead-band: still no switch
    expect(advanceAxis(5, upper + ZONE_HYSTERESIS + 1)).toBe(6); // past the dead-band: advance
    expect(advanceAxis(5, lower - ZONE_HYSTERESIS - 1)).toBe(4); // and the other way
  });

  it('snaps straight to the destination cell on a big jump (a teleport)', () => {
    expect(advanceAxis(5, WORLD_SIZE / 2 - 1)).toBe(axisIndex(WORLD_SIZE / 2 - 1));
    expect(advanceZone({ col: 5, row: 5 }, -WORLD_SIZE / 2 + 1, -WORLD_SIZE / 2 + 1)).toEqual({ col: 0, row: 0 });
  });

  it('does not thrash the current cell while dithering across a boundary', () => {
    const boundary = 6 * ZONE_SIZE - WORLD_SIZE / 2; // shared edge of cells 5 and 6 on the x axis
    let current = { col: 5, row: 5 };
    for (const nudge of [-1, 1, -2, 3, -1, 2]) current = advanceZone(current, boundary + nudge, 0);
    expect(current.col).toBe(5); // small wobbles within the hysteresis band never flip the zone
  });
});

describe('zone character', () => {
  it('classifies the CBD block as a highrise core and is stable/cached', () => {
    const cbd = zoneOf(SPAWN_POINT.x, SPAWN_POINT.z);
    expect(zoneCharacter(cbd.col, cbd.row)).toBe('commercial-highrise');
    expect(zoneCharacter(cbd.col, cbd.row)).toBe(zoneCharacter(cbd.col, cbd.row)); // deterministic
  });

  it('always returns a defined land-use zone for any in-grid cell', () => {
    for (const col of [0, 3, 6, 9]) for (const row of [0, 3, 6, 9]) expect(ZONES).toContain(zoneCharacter(col, row));
  });
});
