import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DETAIL_WAVES, FOUNTAIN_RIPPLE, OCEAN_WAVES, POND_RIPPLE, REFLECTOR_FAR_INTERVAL, REFLECTOR_RANGE, WATER_KEYFRAMES, createWaterNormalTexture, rectDistanceSq, reflectorShouldRender, rippleEnvelope, ripplePhase, rippleSlope, rippleSlopeGlsl, sampleWaterColor, tileableNoise, waterNoiseHeight, waterTier, waveHeight, waveHeightGlsl, waveSlope, waveSlopeGlsl } from './Water';

describe('water tier selection', () => {
  it('maps quality presets onto distinct tiers', () => {
    expect(waterTier('high')).toBe('planar');
    expect(waterTier('medium')).toBe('physical');
    expect(waterTier('low')).toBe('flat');
    expect(new Set([waterTier('high'), waterTier('medium'), waterTier('low')]).size).toBe(3);
  });
});

describe('ocean waves', () => {
  const totalAmplitude = OCEAN_WAVES.reduce((sum, wave) => sum + wave.amplitude, 0);

  it('keeps the swell gentle and bounded by the summed amplitudes', () => {
    expect(totalAmplitude).toBeLessThan(0.5); // gentle: boats, not surfers
    for (let i = 0; i < 200; i++) expect(Math.abs(waveHeight(i * 7.3, i * -3.1, i * 0.13))).toBeLessThanOrEqual(totalAmplitude + 1e-9);
  });

  it('actually moves: the surface at a fixed point changes over time', () => {
    expect(waveHeight(20, -340, 0)).not.toBeCloseTo(waveHeight(20, -340, 1.7), 4);
  });

  it('derives slopes that match a numeric derivative of the height field', () => {
    const eps = 1e-4;
    for (const [x, z, t] of [[135, -340, 0], [12.7, -301.2, 3.9], [-88, -360, 11.4]] as const) {
      const [sx, sz] = waveSlope(x, z, t);
      expect(sx).toBeCloseTo((waveHeight(x + eps, z, t) - waveHeight(x - eps, z, t)) / (2 * eps), 5);
      expect(sz).toBeCloseTo((waveHeight(x, z + eps, t) - waveHeight(x, z - eps, t)) / (2 * eps), 5);
    }
  });

  it('generates GLSL from the same wave table, one term per wave', () => {
    const height = waveHeightGlsl('p.x', 'p.y', 'uTime');
    const slope = waveSlopeGlsl('p.x', 'p.y', 'uTime', [...OCEAN_WAVES, ...DETAIL_WAVES]);
    expect(height.match(/sin\(/g)).toHaveLength(OCEAN_WAVES.length);
    expect(slope.match(/cos\(/g)).toHaveLength(OCEAN_WAVES.length + DETAIL_WAVES.length);
    expect(height).toContain('p.x'); expect(height).toContain('uTime');
    for (const chunk of [height, slope]) { expect(chunk).not.toContain('NaN'); expect(chunk).not.toContain('Infinity'); }
    for (const literal of height.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []) expect(Number.isFinite(Number(literal))).toBe(true);
  });
});

describe('basin ripples', () => {
  it('moves crests outward at the spec speed', () => {
    const dt = 0.37;
    for (const spec of [FOUNTAIN_RIPPLE, POND_RIPPLE]) {
      expect(ripplePhase(2 + spec.speed * dt, 5 + dt, spec)).toBeCloseTo(ripplePhase(2, 5, spec));
    }
  });

  it('fades to nothing at the basin rim so the waterline stays still', () => {
    expect(rippleEnvelope(0, 4.7)).toBe(1);
    expect(rippleEnvelope(4.7, 4.7)).toBe(0);
    expect(rippleEnvelope(6, 4.7)).toBe(0);
    expect(rippleEnvelope(1, 4.7)).toBeGreaterThan(rippleEnvelope(3, 4.7));
    expect(Math.abs(rippleSlope(4.7, 2.2, 4.7, FOUNTAIN_RIPPLE))).toBe(0);
    expect(Math.abs(rippleSlope(0.5, (0.5 - 0) / FOUNTAIN_RIPPLE.speed, 4.7, FOUNTAIN_RIPPLE))).toBeGreaterThan(0.3); // crest passing 0.5u out
  });

  it('bakes matching constants into the GLSL twin', () => {
    const chunk = rippleSlopeGlsl('d', 'uTime', 4.7, FOUNTAIN_RIPPLE, 1.7);
    expect(chunk).toContain('4.7');
    expect(chunk).toContain(String(FOUNTAIN_RIPPLE.amplitude));
    expect(chunk).toContain('1.7)');
    expect(chunk.match(/cos\(/g)).toHaveLength(1);
  });
});

describe('water colour follows the clock', () => {
  const color = new THREE.Color();

  it('keeps keyframes sorted from hour 0 for well-defined interpolation', () => {
    expect(WATER_KEYFRAMES[0]!.hour).toBe(0);
    for (let i = 1; i < WATER_KEYFRAMES.length; i++) expect(WATER_KEYFRAMES[i]!.hour).toBeGreaterThan(WATER_KEYFRAMES[i - 1]!.hour);
    expect(WATER_KEYFRAMES.at(-1)!.hour).toBeLessThan(24);
  });

  it('runs deep blue at midnight, teal at noon, warm at dusk', () => {
    sampleWaterColor(0, color);
    expect(color.b).toBeGreaterThan(color.r * 2);
    const night = { r: color.r, b: color.b };
    sampleWaterColor(12, color);
    expect(color.g).toBeGreaterThan(color.r); expect(color.b).toBeGreaterThan(color.r);
    sampleWaterColor(18.2, color);
    expect(color.r / color.b).toBeGreaterThan(night.r / night.b * 3); // dusk copper vs night blue
  });

  it('wraps smoothly across midnight', () => {
    const late = sampleWaterColor(23.999, new THREE.Color());
    const early = sampleWaterColor(0, new THREE.Color());
    expect(late.getHex()).toBe(early.getHex());
    expect(sampleWaterColor(-3, new THREE.Color()).getHex()).toBe(sampleWaterColor(21, new THREE.Color()).getHex());
  });
});

describe('planar reflector gating', () => {
  it('measures squared distance to the harbour rectangle, zero inside', () => {
    expect(rectDistanceSq(135, -340, 135, -340, 470, 90)).toBe(0);
    expect(rectDistanceSq(0, -300, 135, -340, 470, 90)).toBe(0); // promenade edge is inside the slab
    expect(rectDistanceSq(135, -200, 135, -340, 470, 90)).toBeCloseTo(95 * 95);
    expect(rectDistanceSq(400, -200, 135, -340, 470, 90)).toBeCloseTo(30 * 30 + 95 * 95);
  });

  it('always renders the very first frame so the mirror never shows black', () => {
    expect(reflectorShouldRender(Number.MAX_SAFE_INTEGER, 0, -1)).toBe(true);
  });

  it('renders once per frame however many passes draw the mesh', () => {
    expect(reflectorShouldRender(0, 10, 10)).toBe(false);
  });

  it('renders every frame near the water and only periodically beyond REFLECTOR_RANGE', () => {
    const near = REFLECTOR_RANGE * REFLECTOR_RANGE;
    expect(reflectorShouldRender(near, 11, 10)).toBe(true);
    expect(reflectorShouldRender(near + 1, 11, 10)).toBe(false);
    expect(reflectorShouldRender(near + 1, 10 + REFLECTOR_FAR_INTERVAL, 10)).toBe(true);
  });
});

describe('procedural water normal texture', () => {
  it('builds on tileable noise: opposite edges match exactly', () => {
    for (const v of [0, 0.21, 0.77]) {
      expect(tileableNoise(0, v, 8)).toBeCloseTo(tileableNoise(1, v, 8), 10);
      expect(tileableNoise(v, 0, 8)).toBeCloseTo(tileableNoise(v, 1, 8), 10);
    }
    for (let i = 0; i < 50; i++) { const n = tileableNoise(i * 0.037, i * 0.081, 6, i); expect(n).toBeGreaterThanOrEqual(0); expect(n).toBeLessThanOrEqual(1); }
    expect(waterNoiseHeight(0.1, 0.4)).not.toBeCloseTo(waterNoiseHeight(0.6, 0.9), 4);
  });

  it('encodes mostly-up unit normals with full alpha', () => {
    const texture = createWaterNormalTexture(16);
    const data = texture.image.data as Uint8Array;
    expect(data.length).toBe(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i + 2]!).toBeGreaterThan(127); // z (up) always positive
      expect(data[i + 3]!).toBe(255);
      const length = Math.hypot(data[i]! / 127.5 - 1, data[i + 1]! / 127.5 - 1, data[i + 2]! / 127.5 - 1);
      expect(length).toBeGreaterThan(0.94); expect(length).toBeLessThan(1.06);
    }
    texture.dispose();
  });
});
