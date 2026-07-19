import { describe, expect, it } from 'vitest';
import { parsePromptActions, remapForFlight, shouldEnableTouch, stickKeys, touchQuality } from './TouchModels';

const none = new Set<string>();
const keys = (x: number, y: number, previous = none): string[] => [...stickKeys(x, y, previous)].sort();

describe('shouldEnableTouch', () => {
  it('turns on for coarse-pointer touch devices', () => {
    expect(shouldEnableTouch('', true, true)).toBe(true);
    expect(shouldEnableTouch('', true, false)).toBe(false); // touch-capable laptop with a mouse
    expect(shouldEnableTouch('', false, true)).toBe(false);
  });
  it('?touch=1/0 forces the mode either way', () => {
    expect(shouldEnableTouch('?touch=1', false, false)).toBe(true);
    expect(shouldEnableTouch('?foo=2&touch=1', false, false)).toBe(true);
    expect(shouldEnableTouch('?touch=0', true, true)).toBe(false);
  });
});

describe('touchQuality', () => {
  it('defaults a fresh install to low but keeps a saved choice', () => {
    expect(touchQuality(false, 'high', 'low')).toBe('low');
    expect(touchQuality(true, 'high', 'low')).toBe('high');
  });
});

describe('stickKeys', () => {
  it('is silent inside the deadzone', () => {
    expect(keys(0, 0)).toEqual([]);
    expect(keys(0.1, 0.05)).toEqual([]);
  });
  it('maps 8-way directions (screen coords: -y is forward)', () => {
    expect(keys(0, -0.7)).toEqual(['KeyW']);
    expect(keys(0, 0.7)).toEqual(['KeyS']);
    expect(keys(-0.7, 0)).toEqual(['KeyA']);
    expect(keys(0.7, 0)).toEqual(['KeyD']);
    expect(keys(0.5, -0.5)).toEqual(['KeyD', 'KeyW']);
  });
  it('deflection tiers: shallow strolls (ALT), full sprints (SHIFT)', () => {
    expect(keys(0, -0.3)).toEqual(['AltLeft', 'KeyW']);
    expect(keys(0, -0.7)).toEqual(['KeyW']); // run: no modifier
    expect(keys(0, -1)).toEqual(['KeyW', 'ShiftLeft']);
  });
  it('clamps over-deflection to the rim', () => {
    expect(keys(0, -3)).toEqual(['KeyW', 'ShiftLeft']);
  });
  it('direction hysteresis: a held key survives a sector-edge dip a fresh key would not acquire', () => {
    const holding = new Set(['KeyW', 'KeyD']);
    const atEdge = keys(0.3, -0.9, holding); // D share ≈ 0.32: below acquire, above release
    expect(atEdge).toContain('KeyD');
    expect(keys(0.3, -0.9)).toEqual(['KeyW']); // same pose, nothing held: D not acquired
  });
  it('sprint hysteresis: engaged at the rim, released only below the exit threshold', () => {
    const sprinting = new Set(['KeyW', 'ShiftLeft']);
    expect(keys(0, -0.91, sprinting)).toContain('ShiftLeft'); // 0.91 > exit 0.88: keep sprinting
    expect(keys(0, -0.91)).toEqual(['KeyW']); // fresh: 0.91 < 0.95, no sprint
    expect(keys(0, -0.8, sprinting)).toEqual(['KeyW']);
  });
  it('walk hysteresis mirrors sprint at the low boundary', () => {
    const strolling = new Set(['KeyW', 'AltLeft']);
    expect(keys(0, -0.43, strolling)).toContain('AltLeft'); // 0.43 < exit 0.46: keep strolling
    expect(keys(0, -0.43)).toEqual(['KeyW']);
  });
});

describe('remapForFlight', () => {
  it('turns the stick into the yoke and drops the gait modifiers', () => {
    expect([...remapForFlight(new Set(['KeyW', 'KeyA', 'ShiftLeft']))].sort()).toEqual(['ArrowDown', 'ArrowLeft']);
    expect([...remapForFlight(new Set(['KeyS', 'KeyD', 'AltLeft']))].sort()).toEqual(['ArrowRight', 'ArrowUp']);
  });
});

describe('parsePromptActions', () => {
  it('parses a single-action prompt', () => {
    expect(parsePromptActions('E  Enter vehicle')).toEqual([{ key: 'E', code: 'KeyE', label: 'Enter vehicle' }]);
  });
  it('parses multi-action prompts, capped at two pills', () => {
    const actions = parsePromptActions('E  Exit vehicle  ·  F  Recover  ·  Q  Siren');
    expect(actions).toEqual([
      { key: 'E', code: 'KeyE', label: 'Exit vehicle' },
      { key: 'F', code: 'KeyF', label: 'Recover' },
    ]);
  });
  it('skips movement pairs, prices, and informational prompts', () => {
    expect(parsePromptActions("E  Pay-'n'-Spray · R450")).toEqual([{ key: 'E', code: 'KeyE', label: "Pay-'n'-Spray" }]);
    expect(parsePromptActions('A/D  Slide to a corner  ·  Q  Leave cover')).toEqual([{ key: 'Q', code: 'KeyQ', label: 'Leave cover' }]);
    expect(parsePromptActions('JMPD ON YOU — break away or get nicked!')).toEqual([]);
    expect(parsePromptActions('Drive a vehicle onto the marker to store')).toEqual([]);
    expect(parsePromptActions('')).toEqual([]);
  });
  it('skips CTRL (a hold the AIM toggle already covers) but keeps SPACE', () => {
    expect(parsePromptActions('CTRL  Peek and fire  ·  Q  Leave cover')).toEqual([{ key: 'Q', code: 'KeyQ', label: 'Leave cover' }]);
    expect(parsePromptActions('SPACE  Deploy chute')).toEqual([{ key: 'SPACE', code: 'Space', label: 'Deploy chute' }]);
  });
});
