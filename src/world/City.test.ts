import { describe, expect, it } from 'vitest';
import { ARCHITECTURE_VARIANTS } from './BuildingArchitecture';
import { districtAt, ROAD_NETWORK, TRACK_NETWORK } from './City';
import { CBD_CENTER, districtCenter, MAP_WORLD_SIZE } from './mapData';
import { CITY_JUNCTIONS, signalCornerOffset } from './UrbanInfrastructure';

describe('generated Joburg road topology', () => {
  it('carries the real OSM network at driveable scale', () => {
    expect(ROAD_NETWORK.length).toBeGreaterThan(1000);
    expect(ROAD_NETWORK.every((road) => road.width >= 5 && road.points.length >= 2)).toBe(true);
    const names = new Set(ROAD_NETWORK.map((road) => road.name));
    expect(names.has('Commissioner Street')).toBe(true); // the keeper icons stay real
    expect(names.has('Jan Smuts Avenue')).toBe(true);
    expect(names.has('Egoli Orbital')).toBe(true); // boundary orbital so no road stops dead at the crop edge
  });

  it('renames the parody streets around the spawn blocks', () => {
    const names = new Set(ROAD_NETWORK.map((road) => road.name));
    for (const parody of ['Risk-It Street', 'Martial Street', 'Fax Street', 'Main Main Street', 'Loadshed Lane', 'Eish-loff Street']) {
      expect(names.has(parody), parody).toBe(true);
    }
  });

  it('keeps every road inside the generated world bounds', () => {
    const half = MAP_WORLD_SIZE / 2 + 240; // the orbital runs slightly outside the road bbox
    expect(ROAD_NETWORK.every((road) => road.points.every((point) => Math.abs(point.x) <= half && Math.abs(point.z) <= half))).toBe(true);
  });

  it('renders off-road tracks separately from the driveable network', () => {
    expect(TRACK_NETWORK.length).toBeGreaterThan(10);
    expect(TRACK_NETWORK.every((track) => track.width <= 6)).toBe(true);
  });

  it('defines named, phased signalized intersections at major crossings', () => {
    expect(CITY_JUNCTIONS.length).toBeGreaterThanOrEqual(24);
    expect(CITY_JUNCTIONS.length).toBeLessThanOrEqual(80); // visual/update budget
    expect(CITY_JUNCTIONS.every((junction) => junction.roadA.length > 0 && junction.roadB.length > 0 && junction.roadA !== junction.roadB)).toBe(true);
    expect(CITY_JUNCTIONS.every((junction) => signalCornerOffset(junction.widest) > junction.widest / 2 + 2)).toBe(true);
    const cbdSignals = CITY_JUNCTIONS.filter((junction) => Math.hypot(junction.x - CBD_CENTER.x, junction.z - CBD_CENTER.z) < 400);
    expect(cbdSignals.length).toBeGreaterThanOrEqual(3); // robots are visible around the spawn district
  });

  it('provides multiple structural building families in every district', () => {
    expect(ARCHITECTURE_VARIANTS.downtown).toBeGreaterThanOrEqual(5);
    expect(ARCHITECTURE_VARIANTS.residential).toBeGreaterThanOrEqual(4);
    expect(ARCHITECTURE_VARIANTS.industrial).toBeGreaterThanOrEqual(4);
  });
});

describe('district naming (generated place nodes)', () => {
  it('names the key districts for dispatch callouts', () => {
    for (const name of ['Joburg CBD', 'Sandton', 'Braamfontein', 'Hillbrow', 'Newtown']) {
      const center = districtCenter(name);
      expect(center, name).toBeDefined();
      expect(districtAt(center!.x, center!.z)).toBe(name);
    }
  });

  it('answers with the nearest district everywhere on the map', () => {
    expect(districtAt(CBD_CENTER.x + 5, CBD_CENTER.z - 5)).toBe('Joburg CBD');
    expect(typeof districtAt(-MAP_WORLD_SIZE / 2, -MAP_WORLD_SIZE / 2)).toBe('string');
    expect(districtAt(-MAP_WORLD_SIZE / 2, -MAP_WORLD_SIZE / 2).length).toBeGreaterThan(0);
  });
});
