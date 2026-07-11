import { describe, expect, it } from 'vitest';
import { closesMapOverlay, mapOverlayKeyAction } from './MapView';

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
