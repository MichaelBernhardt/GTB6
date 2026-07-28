import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIMAP_ZOOM, MinimapRoadIndex, MINIMAP_ZOOM_NAMES, MINIMAP_ZOOM_SCALES, minimapNorthAngle, sanitizeMinimapZoom, stepMinimapZoom, tracePumpGlyph } from './MinimapView';

// Screen position (0 = up, clockwise) the compass 'N' lands at for a given player heading.
const northScreenDir = (heading: number) => { const p = minimapNorthAngle(heading); return { x: Math.sin(p), y: -Math.cos(p) }; };

describe('minimap compass', () => {
  it('puts north at the top only when the player faces north (heading = PI)', () => {
    const up = northScreenDir(Math.PI);
    expect(up.x).toBeCloseTo(0); expect(up.y).toBeCloseTo(-1); // straight up
  });

  it('points north opposite the player-forward direction (player faces up on a player-up map)', () => {
    // Player forward on screen is always up; north is a real-world direction, so it moves as the player turns.
    const forward = northScreenDir(0); // facing +Z: north (-Z) is behind -> screen bottom
    expect(forward.x).toBeCloseTo(0); expect(forward.y).toBeCloseTo(1);
  });

  it('rotates the N clockwise by exactly the turn the player makes', () => {
    expect(minimapNorthAngle(1.2) - minimapNorthAngle(0.5)).toBeCloseTo(0.7);
    const east = northScreenDir(Math.PI + Math.PI / 2); // quarter-turn right of facing-north
    expect(east.x).toBeCloseTo(1); expect(east.y).toBeCloseTo(0); // N swings to the right edge
  });
});

describe('the petrol-pump blip', () => {
  /** A Path2D stand-in that just records the traced points, so the glyph can be measured in node. */
  function tracer(): { pts: Array<[number, number]>; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; closePath(): void } {
    const pts: Array<[number, number]> = [];
    return { pts, moveTo: (x, y) => { pts.push([x, y]); }, lineTo: (x, y) => { pts.push([x, y]); }, closePath: () => {} };
  }

  it('traces a pump, not another dot: two closed parts, taller than wide, inside the blip radius', () => {
    const t = tracer();
    tracePumpGlyph(t as unknown as Path2D, 6.5);
    expect(t.pts.length).toBe(8); // body quad + nozzle quad
    const xs = t.pts.map(([x]) => x); const ys = t.pts.map(([, y]) => y);
    const w = Math.max(...xs) - Math.min(...xs); const h = Math.max(...ys) - Math.min(...ys);
    expect(h).toBeGreaterThan(w * 0.9);                 // upright, like a pump
    expect(Math.max(...xs.map(Math.abs))).toBeLessThanOrEqual(6.5);
    expect(Math.max(...ys.map(Math.abs))).toBeLessThanOrEqual(6.5);
  });

  it('is the same path the full-screen map draws — mapRender cannot import it, so it is copied', () => {
    // mapRender.ts is inline-copied into the mapgen preview and may not import from src (see its
    // header), so the pump path exists twice. This keeps the copies honest.
    const here = dirname(fileURLToPath(import.meta.url));
    const mapRender = readFileSync(join(here, 'mapRender.ts'), 'utf8');
    const minimap = readFileSync(join(here, 'MinimapView.ts'), 'utf8');
    for (const coefficient of ['0.62', '0.20', '0.95', '0.34', '0.80', '0.42', '0.30', '0.85']) {
      expect(mapRender, coefficient).toContain(`s * ${coefficient}`);
      expect(minimap, coefficient).toContain(`s * ${coefficient}`);
    }
    expect(mapRender).toContain("shape === 'fuel'");
    expect(minimap).toContain("marker.shape === 'fuel'");
  });
});

describe('minimap zoom', () => {
  it('keeps names, scales and default in agreement', () => {
    expect(MINIMAP_ZOOM_NAMES.length).toBe(MINIMAP_ZOOM_SCALES.length);
    expect(DEFAULT_MINIMAP_ZOOM).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_MINIMAP_ZOOM).toBeLessThan(MINIMAP_ZOOM_SCALES.length);
    const sorted = [...MINIMAP_ZOOM_SCALES].sort((a, b) => a - b);
    expect([...MINIMAP_ZOOM_SCALES]).toEqual(sorted); // ascending: higher index = closer view
  });

  it('sanitizes anything that is not a valid level index', () => {
    expect(sanitizeMinimapZoom(0)).toBe(0);
    expect(sanitizeMinimapZoom(MINIMAP_ZOOM_SCALES.length - 1)).toBe(MINIMAP_ZOOM_SCALES.length - 1);
    expect(sanitizeMinimapZoom(undefined)).toBe(DEFAULT_MINIMAP_ZOOM);
    expect(sanitizeMinimapZoom('close')).toBe(DEFAULT_MINIMAP_ZOOM);
    expect(sanitizeMinimapZoom(-1)).toBe(DEFAULT_MINIMAP_ZOOM);
    expect(sanitizeMinimapZoom(MINIMAP_ZOOM_SCALES.length)).toBe(DEFAULT_MINIMAP_ZOOM);
    expect(sanitizeMinimapZoom(1.5)).toBe(DEFAULT_MINIMAP_ZOOM);
    expect(sanitizeMinimapZoom(Number.NaN)).toBe(DEFAULT_MINIMAP_ZOOM);
  });

  it('steps up and down one level at a time and clamps at the ends', () => {
    expect(stepMinimapZoom(DEFAULT_MINIMAP_ZOOM, 1)).toBe(DEFAULT_MINIMAP_ZOOM + 1);
    expect(stepMinimapZoom(DEFAULT_MINIMAP_ZOOM, -1)).toBe(DEFAULT_MINIMAP_ZOOM - 1);
    expect(stepMinimapZoom(MINIMAP_ZOOM_SCALES.length - 1, 1)).toBe(MINIMAP_ZOOM_SCALES.length - 1);
    expect(stepMinimapZoom(0, -1)).toBe(0);
  });

  it('recovers from a garbage zoom before stepping', () => {
    expect(stepMinimapZoom(99, 1)).toBe(DEFAULT_MINIMAP_ZOOM + 1);
    expect(stepMinimapZoom(Number.NaN, -1)).toBe(DEFAULT_MINIMAP_ZOOM - 1);
  });
});

describe('MinimapRoadIndex', () => {
  it('returns local roads, de-duplicates cell-spanning roads, and excludes distant cells', () => {
    const local = [{ x: -20, z: -20 }, { x: 20, z: 20 }];
    const spanning = [{ x: -900, z: 0 }, { x: 900, z: 0 }];
    const distant = [{ x: 4_000, z: 4_000 }, { x: 4_200, z: 4_200 }];
    const roads = [local, spanning, distant];
    const index = new MinimapRoadIndex(roads, 256);
    const visible: typeof roads = [];
    const key = index.query(0, 0, 100, visible);
    expect(visible).toEqual(expect.arrayContaining([local, spanning]));
    expect(visible.filter((road) => road === spanning)).toHaveLength(1);
    expect(visible).not.toContain(distant);
    expect(index.query(20, 20, 100, visible)).toBe(key); // same cells: retained Path2D remains valid
    index.query(4_100, 4_100, 100, visible);
    expect(visible).toContain(distant);
    expect(visible).not.toContain(local);
  });

  it('handles an empty index and queries beyond the indexed world bounds', () => {
    const visible: Array<Array<{ x: number; z: number }>> = [];
    expect(new MinimapRoadIndex([]).query(0, 0, 1_000_000, visible)).toBe('empty');
    expect(visible).toEqual([]);
    const index = new MinimapRoadIndex([[{ x: 0, z: 0 }, { x: 10, z: 10 }]], 256);
    expect(index.query(1_000_000, 1_000_000, 10, visible)).toBe('empty');
    expect(visible).toEqual([]);
  });
});
