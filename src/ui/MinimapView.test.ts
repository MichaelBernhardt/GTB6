import { describe, expect, it } from 'vitest';
import { DEFAULT_MINIMAP_ZOOM, MINIMAP_ZOOM_NAMES, MINIMAP_ZOOM_SCALES, sanitizeMinimapZoom, stepMinimapZoom } from './MinimapView';

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
