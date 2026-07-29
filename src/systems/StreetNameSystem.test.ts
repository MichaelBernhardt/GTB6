import { describe, expect, it } from 'vitest';
import { StreetNameIndex } from './StreetNameSystem';

const roads = [
  { name: 'Pothole Street', points: [{ x: -300, z: 0 }, { x: 300, z: 0 }] },
  { name: 'Loadshed Lane', points: [{ x: 100, z: -300 }, { x: 100, z: 300 }] },
  { name: 'Unnamed service', points: [{ x: 0, z: 10 }, { x: 100, z: 10 }] },
  { name: 'Water', points: [{ x: 0, z: 20 }, { x: 100, z: 20 }] },
];

describe('street-name spatial index', () => {
  it('finds the exact nearest named segment, including between sparse vertices', () => {
    const index = new StreetNameIndex(roads, 50);
    expect(index.nearest(-175, 8, 30)).toEqual({ name: 'Pothole Street', distance: 8 });
    expect(index.nearest(92, 80, 30)).toEqual({ name: 'Loadshed Lane', distance: 8 });
  });

  it('filters generated placeholder names and respects the display range', () => {
    const index = new StreetNameIndex(roads, 50);
    expect(index.nearest(30, 11, 30)?.name).toBe('Pothole Street');
    expect(index.nearest(400, 100, 40)).toBeUndefined();
    expect(index.nearest(Number.NaN, 0)).toBeUndefined();
  });
});
