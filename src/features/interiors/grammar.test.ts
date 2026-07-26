import { describe, expect, it } from 'vitest';
import { generateInterior } from './grammar';
import type { InteriorDoor } from '../interiors.state';

const door = (over: Partial<InteriorDoor> = {}): InteriorDoor => ({
  id: 'spaza', kind: 'spaza', name: 'Test Spaza', x: 1234.5, z: -678.25, heading: 0.7, ...over,
});

/** The mat you arrive on and leave from, in room-local space. */
const mat = (depth: number): { x: number; z: number } => ({ x: 0, z: -depth / 2 + 0.85 });

describe('interior grammar', () => {
  it('is deterministic: the same doorstep always builds the same room', () => {
    const a = generateInterior(door());
    const b = generateInterior(door());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('varies with the doorstep, so two spazas are not the same spaza', () => {
    const a = generateInterior(door());
    const b = generateInterior(door({ x: 90.5, z: 4102.75 }));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('quantises every derived dimension, so a rebuild is byte-identical across engines', () => {
    for (const kind of ['spaza', 'flat'] as const) {
      const layout = generateInterior(door({ kind, id: kind }));
      for (const value of [layout.width, layout.depth, layout.height]) {
        expect(Math.round(value * 1e8) / 1e8).toBe(value);
      }
    }
  });

  it('builds rooms you can actually walk around', () => {
    for (const kind of ['spaza', 'flat', 'ponte'] as const) {
      for (const seed of [0, 1, 2, 3, 4, 5, 6, 7]) {
        const layout = generateInterior(door({ kind, id: kind, x: 100 + seed * 137.5, z: -50 - seed * 91.25 }));
        expect(layout.width).toBeGreaterThan(4.5);
        expect(layout.depth).toBeGreaterThan(5.5);
        expect(layout.height).toBeGreaterThan(2.4);
        expect(layout.props.length).toBeGreaterThan(3);
      }
    }
  });

  it('never puts furniture through a wall', () => {
    for (const kind of ['spaza', 'flat', 'ponte'] as const) {
      for (const seed of [0, 3, 9, 17]) {
        const layout = generateInterior(door({ kind, id: kind, x: 10 + seed * 211.5, z: seed * 77.25 }));
        for (const prop of layout.props) {
          expect(Math.abs(prop.x) - prop.w / 2).toBeLessThanOrEqual(layout.width / 2 + 0.001);
          expect(Math.abs(prop.z) - prop.d / 2).toBeLessThanOrEqual(layout.depth / 2 + 0.001);
          expect(prop.y + prop.h).toBeLessThanOrEqual(layout.height + 0.001);
        }
      }
    }
  });

  it('keeps the doorway reachable: nothing solid stands on the mat', () => {
    for (const kind of ['spaza', 'flat', 'ponte'] as const) {
      for (const seed of [0, 2, 5, 11, 23, 31]) {
        const layout = generateInterior(door({ kind, id: kind, x: seed * 313.5, z: 1000 - seed * 47.75 }));
        const spot = mat(layout.depth);
        for (const prop of layout.props) {
          if (!prop.solid) continue;
          const clear = Math.abs(spot.x - prop.x) > prop.w / 2 + 0.7 || Math.abs(spot.z - prop.z) > prop.d / 2 + 0.7;
          expect(clear, `${kind}/${seed}: ${prop.shape} blocks the mat`).toBe(true);
        }
      }
    }
  });

  it('never overlaps two solid pieces of furniture', () => {
    for (const kind of ['spaza', 'flat', 'ponte'] as const) {
      for (const seed of [0, 4, 8, 12, 40]) {
        const layout = generateInterior(door({ kind, id: kind, x: 55 + seed * 129.5, z: -900 + seed * 63.25 }));
        const solids = layout.props.filter((prop) => prop.solid);
        for (let a = 0; a < solids.length; a++) for (let b = a + 1; b < solids.length; b++) {
          const one = solids[a]!; const two = solids[b]!;
          const overlap = Math.abs(one.x - two.x) < (one.w + two.w) / 2 - 0.001 && Math.abs(one.z - two.z) < (one.d + two.d) / 2 - 0.001;
          expect(overlap, `${kind}/${seed}: ${one.shape} intersects ${two.shape}`).toBe(false);
        }
      }
    }
  });

  it('leaves the fixture somewhere the shopkeeper can actually stand', () => {
    for (const seed of [0, 6, 13, 27]) {
      const layout = generateInterior(door({ x: seed * 401.5, z: seed * -233.25 }));
      expect(layout.fixture).toBeDefined();
      const spot = layout.fixture!;
      expect(Math.abs(spot.x)).toBeLessThan(layout.width / 2 - 0.4);
      expect(Math.abs(spot.z)).toBeLessThan(layout.depth / 2 - 0.4);
    }
  });

  it('pays a small, celebrated find rather than a grind', () => {
    for (const kind of ['spaza', 'flat', 'ponte'] as const) {
      const layout = generateInterior(door({ kind, id: kind }));
      expect(layout.find).toBeGreaterThanOrEqual(20);
      expect(layout.find).toBeLessThanOrEqual(150);
      expect(layout.findLine.length).toBeGreaterThan(8);
    }
  });

  it('hand-authors Ponte: the bespoke path ignores the seed for everything but the find', () => {
    const a = generateInterior(door({ kind: 'ponte', id: 'ponte', x: 1, z: 2 }));
    const b = generateInterior(door({ kind: 'ponte', id: 'ponte', x: 9000, z: -9000 }));
    expect(a.width).toBe(b.width);
    expect(a.depth).toBe(b.depth);
    expect(a.props.length).toBe(b.props.length);
    expect(a.name).toBe('Ponte — seventh floor');
  });
});
