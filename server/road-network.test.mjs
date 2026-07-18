import { describe, expect, it } from 'vitest';
import { HOT_BAKKIE_ROUTES, ONLINE_SPAWNS } from './multiplayer.mjs';
import { ROAD_INDEX, RoadSegmentIndex } from './road-network.mjs';

describe('authoritative road segment index', () => {
  it('accepts generated-road travel and rejects building-cutting travel', () => {
    const start = HOT_BAKKIE_ROUTES[0].spawn;
    const alongX = start.x + Math.sin(start.heading) * 3; const alongZ = start.z + Math.cos(start.heading) * 3;
    expect(ROAD_INDEX.acceptsMove(start.x, start.z, alongX, alongZ)).toBe(true);
    expect(ROAD_INDEX.acceptsMove(start.x, start.z, start.x + 20, start.z + 20)).toBe(false);
    expect(ROAD_INDEX.onRoad(8750, 8750)).toBe(false);
  });

  it('keeps every event point on committed Johannesburg tar', () => {
    for (const route of HOT_BAKKIE_ROUTES) {
      expect(ROAD_INDEX.edgeDistance(route.spawn.x, route.spawn.z), route.name).toBeLessThan(-0.8);
      for (const checkpoint of route.checkpoints) expect(ROAD_INDEX.edgeDistance(checkpoint.x, checkpoint.z), checkpoint.label).toBeLessThan(-0.8);
    }
  });

  it('uses four validated CBD pavement spawns near the routes', () => {
    expect(ONLINE_SPAWNS).toHaveLength(4);
    for (const spawn of ONLINE_SPAWNS) {
      expect(ROAD_INDEX.edgeDistance(spawn.x, spawn.z)).toBeGreaterThan(0.4);
      expect(Math.min(...HOT_BAKKIE_ROUTES.flatMap((route) => [route.spawn, ...route.checkpoints]).map((point) => Math.hypot(point.x - spawn.x, point.z - spawn.z)))).toBeLessThan(250);
    }
  });

  it('can index a small synthetic road without scanning unrelated segments', () => {
    const index = new RoadSegmentIndex([{ name: 'Test Road', width: 8, points: [[0, 0], [20, 0]] }], 10, 20);
    expect(index.onRoad(10, 3.5, 0)).toBe(true); expect(index.onRoad(10, 4.5, 0)).toBe(false);
    expect(index.nearestPose(12, 9)).toMatchObject({ x: 12, z: 0, road: 'Test Road' });
  });
});
