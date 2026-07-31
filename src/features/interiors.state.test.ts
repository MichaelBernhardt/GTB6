import { describe, expect, it } from 'vitest';
import { sanitizeInteriorsState, streetsHere } from './interiors.state';
import { GENERATED_ROADS, MAP_WORLD_SIZE } from '../world/mapData';

describe('the preload ring', () => {
  // Everything the eager half is allowed to know: "is the player standing in a street". The door
  // table itself cannot live here — see the chunk note at the top of interiors.state.ts.
  it('says yes on a road', () => {
    const road = GENERATED_ROADS.find((entry) => entry.points.length > 2)!;
    const point = road.points[1]!;
    expect(streetsHere(point.x, point.z)).toBe(true);
  });

  it('says no far outside the map, where no door can exist', () => {
    const far = MAP_WORLD_SIZE * 4;
    expect(streetsHere(far, far)).toBe(false);
  });

  it('is cheap enough to run every frame', () => {
    const road = GENERATED_ROADS[0]!.points[0]!;
    const started = performance.now();
    for (let i = 0; i < 20000; i++) streetsHere(road.x + i * 0.01, road.z);
    const each = (performance.now() - started) / 20000;
    expect(each, `${(each * 1000).toFixed(1)}µs per call`).toBeLessThan(0.05);
  });
});

describe('interiors save slice', () => {
  it('keeps a clean visited list and a bounded find count', () => {
    expect(sanitizeInteriorsState({ visited: ['a:b', 'c:d'], finds: 2, picks: 7 })).toEqual({ visited: ['a:b', 'c:d'], finds: 2, picks: 7 });
  });

  it('survives junk, missing keys and hostile shapes', () => {
    expect(sanitizeInteriorsState(undefined)).toEqual({ visited: [], finds: 0, picks: 0 });
    expect(sanitizeInteriorsState({})).toEqual({ visited: [], finds: 0, picks: 0 });
    expect(sanitizeInteriorsState({ visited: 'spaza' })).toEqual({ visited: [], finds: 0, picks: 0 });
    expect(sanitizeInteriorsState({ visited: [1, null, { a: 1 }, 'flat'] })).toEqual({ visited: ['flat'], finds: 0, picks: 0 });
    expect(sanitizeInteriorsState({ visited: [`${'x'.repeat(64)}`] })).toEqual({ visited: [], finds: 0, picks: 0 });
    expect(sanitizeInteriorsState({ visited: new Array(80).fill('spaza') }).visited).toHaveLength(32);
    expect(sanitizeInteriorsState({ finds: 9999 }).finds).toBe(12);
    expect(sanitizeInteriorsState({ finds: -4 }).finds).toBe(0);
    expect(sanitizeInteriorsState({ finds: 'lots' }).finds).toBe(0);
    expect(sanitizeInteriorsState({ picks: 3.9 }).picks).toBe(3);
    expect(sanitizeInteriorsState({ picks: -2 }).picks).toBe(0);
    expect(sanitizeInteriorsState({ picks: 'many' }).picks).toBe(0);
  });
});
