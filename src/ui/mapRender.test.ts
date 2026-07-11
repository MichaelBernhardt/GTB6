import { describe, expect, it } from 'vitest';
import {
  clampZoom, fitZoom, MAP_MAX_ZOOM, MAP_MIN_ZOOM, markerScreen, screenToWorld,
  weaponWheelResponds, worldToScreen, type MapCamera,
} from './mapRender';

const cam: MapCamera = { zoom: 2, viewX: 100, viewZ: 50, width: 800, height: 600, dpr: 1 };

describe('worldToScreen / screenToWorld', () => {
  it('projects the camera centre to the middle of the canvas', () => {
    expect(worldToScreen(cam.viewX, cam.viewZ, cam)).toEqual({ sx: 400, sy: 300 });
  });

  it('scales world offsets by the zoom factor', () => {
    expect(worldToScreen(110, 50, cam)).toEqual({ sx: 420, sy: 300 });
    expect(worldToScreen(100, 65, cam)).toEqual({ sx: 400, sy: 330 });
  });

  it('round-trips through the inverse projection', () => {
    for (const [x, z] of [[0, 0], [-250, 780], [1234, -56]] as const) {
      const { sx, sy } = worldToScreen(x, z, cam);
      const back = screenToWorld(sx, sy, cam);
      expect(back.x).toBeCloseTo(x, 9);
      expect(back.z).toBeCloseTo(z, 9);
    }
  });
});

describe('clampZoom', () => {
  it('clamps to the supported range', () => {
    expect(clampZoom(1000)).toBe(MAP_MAX_ZOOM);
    expect(clampZoom(0.0001)).toBe(MAP_MIN_ZOOM);
    expect(clampZoom(3.5)).toBe(3.5);
  });

  it('honours custom bounds', () => {
    expect(clampZoom(9, 0.5, 4)).toBe(4);
    expect(clampZoom(0.1, 0.5, 4)).toBe(0.5);
  });
});

describe('fitZoom', () => {
  it('frames a square world into the smaller viewport axis, with padding', () => {
    expect(fitZoom(6000, 800, 600)).toBeCloseTo(600 / (6000 * 1.08), 9);
    expect(fitZoom(6000, 400, 900)).toBeCloseTo(400 / (6000 * 1.08), 9);
  });
});

describe('markerScreen', () => {
  it('places a marker and reports it on-screen', () => {
    const p = markerScreen({ x: cam.viewX, z: cam.viewZ }, cam);
    expect(p).toMatchObject({ sx: 400, sy: 300, onScreen: true });
  });

  it('flags markers outside the viewport (plus pad) as off-screen', () => {
    expect(markerScreen({ x: 100000, z: 50 }, cam).onScreen).toBe(false);
    expect(markerScreen({ x: 100, z: -100000 }, cam).onScreen).toBe(false);
  });
});

describe('weaponWheelResponds', () => {
  it('gates weapon-cycle scroll while the full-screen map is open', () => {
    expect(weaponWheelResponds(false)).toBe(true);
    expect(weaponWheelResponds(true)).toBe(false);
  });
});
