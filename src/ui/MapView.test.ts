import { describe, expect, it } from 'vitest';
import { closesMapOverlay, liveMarkerSearchEntries, mapOverlayKeyAction, markerHoverLabel } from './MapView';
import type { MapCamera } from './mapRender';

describe('map overlay key gating', () => {
  it('closes on both M and Escape', () => {
    expect(closesMapOverlay('KeyM')).toBe(true);
    expect(closesMapOverlay('Escape')).toBe(true);
    expect(mapOverlayKeyAction('KeyM', false)).toBe('close');
    expect(mapOverlayKeyAction('Escape', false)).toBe('close');
  });

  it('ignores everything else so gameplay keys pass through to the suspended InputManager untouched', () => {
    for (const code of ['KeyW', 'KeyA', 'Space', 'Backquote', 'Tab', 'PageUp']) {
      expect(closesMapOverlay(code)).toBe(false);
      expect(mapOverlayKeyAction(code, false)).toBe('ignore');
      expect(mapOverlayKeyAction(code, true)).toBe('ignore');
    }
  });

  it('swallows auto-repeats of the close keys without closing (held M must not strobe the map)', () => {
    expect(mapOverlayKeyAction('KeyM', true)).toBe('swallow');
    expect(mapOverlayKeyAction('Escape', true)).toBe('swallow');
  });
});

describe('map marker hover labels', () => {
  const camera: MapCamera = { zoom: 2, viewX: 10, viewZ: -20, width: 200, height: 120, dpr: 1 };

  it('returns the closest named marker inside the screen-space hit radius', () => {
    const markers = [
      { x: 10, z: -20, color: '#fff', label: 'Robot Run' },
      { x: 12, z: -20, color: '#fff', label: 'Bra Vusi’s Chop Shop' },
    ];
    expect(markerHoverLabel(markers, camera, 104, 60)).toBe('Bra Vusi’s Chop Shop');
    expect(markerHoverLabel(markers, camera, 100, 60)).toBe('Robot Run');
  });

  it('ignores anonymous, distant, and off-screen markers', () => {
    expect(markerHoverLabel([
      { x: 10, z: -20, color: '#fff' },
      { x: 1000, z: 1000, color: '#fff', label: 'Off screen' },
    ], camera, 100, 60)).toBeUndefined();
    expect(markerHoverLabel([{ x: 10, z: -20, color: '#fff', label: 'Safehouse' }], camera, 150, 60)).toBeUndefined();
  });
});

describe('live marker map search', () => {
  it('classifies objectives, safehouses, and other named places', () => {
    expect(liveMarkerSearchEntries([
      { x: 1, z: 2, color: '#fc0', label: 'Auntie Portia', objective: true },
      { x: 3, z: 4, color: '#0c8', label: 'Main Main Mansions', shape: 'house' },
      { x: 5, z: 6, color: '#b5f', label: 'Robot Run', shape: 'diamond' },
    ])).toEqual([
      { x: 1, z: 2, name: 'Auntie Portia', kind: 'objective' },
      { x: 3, z: 4, name: 'Main Main Mansions', kind: 'safehouse' },
      { x: 5, z: 6, name: 'Robot Run', kind: 'place' },
    ]);
  });

  it('trims names, ignores anonymous markers, and collapses duplicate labels', () => {
    expect(liveMarkerSearchEntries([
      { x: 1, z: 2, color: '#fff' },
      { x: 3, z: 4, color: '#fff', label: '  Jozi Arms  ' },
      { x: 5, z: 6, color: '#fff', label: 'jozi arms' },
    ])).toEqual([{ x: 3, z: 4, name: 'Jozi Arms', kind: 'place' }]);
  });
});
