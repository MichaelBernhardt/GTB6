import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIMAP_ZOOM, MINIMAP_ZOOM_NAMES, MINIMAP_ZOOM_SCALES, minimapNorthAngle, sanitizeMinimapZoom, stepMinimapZoom } from './MinimapView';

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
