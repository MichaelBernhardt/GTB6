import type { Quality } from '../types';

/** Bound the actual buffer, including supersampling. A DPR cap alone still allows a 5K display
 * to allocate several enormous HDR/MSAA targets when the window is maximised. */
export const RENDER_PIXEL_BUDGET: Record<Quality, number> = {
  potato: 1280 * 720,
  low: 1920 * 1080,
  medium: 2560 * 1440,
  high: 2560 * 1440,
  ultra: 3840 * 2160,
};

export interface RenderSize {
  width: number;
  height: number;
  pixelRatio: number;
}

const positive = (value: number, fallback = 1): number => Number.isFinite(value) && value > 0 ? value : fallback;

/** CSS size stays native; only the drawing buffer scales. Recompute after a resize or a move to a
 * different-DPR screen, and respect the driver's texture/renderbuffer limit in both dimensions. */
export function renderSize(quality: Quality, width: number, height: number, deviceRatio: number, maxDimension: number): RenderSize {
  width = Math.max(1, Math.floor(positive(width)));
  height = Math.max(1, Math.floor(positive(height)));
  const dpr = positive(deviceRatio);
  const dimension = Math.max(1, Math.floor(positive(maxDimension, 4096)));
  const requested = quality === 'potato' ? 0.5
    : quality === 'ultra' ? Math.min(3, Math.max(dpr, 2))
    : Math.min(dpr, { low: 1, medium: 1.25, high: 1.5 }[quality]);
  const pixelRatio = Math.min(requested, Math.sqrt(RENDER_PIXEL_BUDGET[quality] / width / height), dimension / width, dimension / height);
  return { width, height, pixelRatio };
}
