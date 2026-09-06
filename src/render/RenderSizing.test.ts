import { describe, expect, it } from 'vitest';
import type { Quality } from '../types';
import { RENDER_PIXEL_BUDGET, renderSize } from './RenderSizing';

describe('drawing-buffer budget', () => {
  it('preserves native 1080p and Ultra supersampling on a standard display', () => {
    expect(renderSize('high', 1920, 1080, 1, 16384)).toEqual({ width: 1920, height: 1080, pixelRatio: 1 });
    expect(renderSize('ultra', 1920, 1080, 1, 16384).pixelRatio).toBe(2);
    expect(renderSize('potato', 1920, 1080, 3, 16384).pixelRatio).toBe(0.5);
  });

  it('bounds every tier on Retina, 5K and ultrawide displays without distorting its aspect ratio', () => {
    for (const quality of Object.keys(RENDER_PIXEL_BUDGET) as Quality[]) {
      for (const [width, height, dpr] of [[1920, 1080, 2], [5120, 2880, 3], [16384, 900, 2], [900, 16384, 2]]) {
        const size = renderSize(quality, width, height, dpr, 4096);
        const bufferWidth = Math.floor(size.width * size.pixelRatio);
        const bufferHeight = Math.floor(size.height * size.pixelRatio);
        expect(bufferWidth).toBeGreaterThan(0); expect(bufferHeight).toBeGreaterThan(0);
        expect(Math.max(bufferWidth, bufferHeight)).toBeLessThanOrEqual(4096);
        expect(bufferWidth * bufferHeight).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET[quality]);
        expect(size.width / size.height).toBe(width / height);
      }
    }
  });

  it('adapts when the window moves between screens and grows to fullscreen', () => {
    const lowDpi = renderSize('high', 1280, 720, 1, 8192);
    const retina = renderSize('high', 1280, 720, 2, 8192);
    const fullscreen = renderSize('high', 5120, 2880, 2, 8192);
    expect(retina.pixelRatio).toBeGreaterThan(lowDpi.pixelRatio);
    expect(fullscreen.pixelRatio).toBeLessThan(1);
    expect(fullscreen.width * fullscreen.height * fullscreen.pixelRatio ** 2).toBeLessThanOrEqual(RENDER_PIXEL_BUDGET.high);
  });

  it('keeps zero-sized and malformed resize events finite', () => {
    for (const value of [0, -1, NaN, Infinity]) {
      const size = renderSize('high', value, value, value, value);
      expect(size.width).toBe(1); expect(size.height).toBe(1);
      expect(Number.isFinite(size.pixelRatio)).toBe(true);
      expect(size.pixelRatio).toBeGreaterThan(0);
    }
  });
});
