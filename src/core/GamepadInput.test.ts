import { describe, expect, it } from 'vitest';
import {
  activeGamepadFrame, gamepadAxis, gamepadPrompt, mapStandardGamepad, type GamepadLike,
} from './GamepadInput';

function pad(axes: number[] = [0, 0, 0, 0], pressed: number[] = [], values: Record<number, number> = {}): GamepadLike {
  return {
    axes,
    buttons: Array.from({ length: 16 }, (_, index) => ({
      pressed: pressed.includes(index),
      value: values[index] ?? (pressed.includes(index) ? 1 : 0),
    })),
  };
}

describe('standard gamepad mapping', () => {
  it('removes stick drift and rescales usable travel', () => {
    expect(gamepadAxis(0.1)).toBe(0);
    expect(gamepadAxis(-0.16)).toBe(0);
    expect(gamepadAxis(1)).toBe(1);
    expect(gamepadAxis(-1)).toBe(-1);
    expect(gamepadAxis(0.58)).toBeCloseTo(0.5, 5);
  });

  it('keeps foot movement analogue while mapping the GTA-style action deck', () => {
    const frame = mapStandardGamepad(pad([0.58, -1, 0.5, -0.5], [0, 2, 3, 4, 8, 9, 10, 11, 12], { 6: 0.7, 7: 0.8 }), 'foot');
    expect(frame.strengths.get('KeyD')).toBeCloseTo(0.5, 5);
    expect(frame.strengths.get('KeyW')).toBe(1);
    expect(frame.held).toEqual(expect.objectContaining(new Set([
      'KeyD', 'KeyW', 'Space', 'KeyF', 'KeyR', 'KeyE', 'Tab', 'KeyM', 'Escape',
      'ShiftLeft', 'KeyV', 'KeyH',
    ])));
    expect(frame.aiming).toBe(true);
    expect(frame.firing).toBe(true);
    expect(frame.lookDX).toBeGreaterThan(0);
    expect(frame.lookDY).toBeLessThan(0);
    expect(activeGamepadFrame(frame)).toBe(true);
  });

  it('uses analogue triggers for driving and bumpers for drive-by combat', () => {
    const frame = mapStandardGamepad(pad([-1, 0, 0, 0], [0, 1, 2, 3, 4, 5, 10, 14], { 6: 0.35, 7: 0.8 }), 'vehicle');
    expect(frame.strengths.get('KeyA')).toBe(1);
    expect(frame.strengths.get('KeyW')).toBe(0.8);
    expect(frame.strengths.get('KeyS')).toBe(0.35);
    expect(frame.held.has('Space')).toBe(true);
    expect(frame.held.has('KeyF')).toBe(true);
    expect(frame.held.has('KeyG')).toBe(true);
    expect(frame.held.has('KeyE')).toBe(true);
    expect(frame.held.has('KeyB')).toBe(true);
    expect(frame.held.has('KeyN')).toBe(true);
    expect(frame.held.has('ShiftLeft')).toBe(true);
    expect(frame.aiming).toBe(true);
    expect(frame.firing).toBe(true);
  });

  it('preserves partial trigger travel after the browser marks a trigger pressed', () => {
    const frame = mapStandardGamepad(pad([0, 0, 0, 0], [6, 7], { 6: 0.34, 7: 0.72 }), 'vehicle');
    expect(frame.strengths.get('KeyS')).toBeCloseTo(0.34);
    expect(frame.strengths.get('KeyW')).toBeCloseTo(0.72);
  });

  it('maps the left stick to the aircraft yoke and triggers to throttle', () => {
    const frame = mapStandardGamepad(pad([0.8, -0.8, 0, 0], [3], { 6: 0.25, 7: 1 }), 'flight');
    expect(frame.strengths.get('ArrowRight')).toBeGreaterThan(0);
    expect(frame.strengths.get('ArrowDown')).toBeGreaterThan(0);
    expect(frame.strengths.get('KeyW')).toBe(1);
    expect(frame.strengths.get('KeyS')).toBe(0.25);
    expect(frame.held.has('KeyE')).toBe(true);
  });

  it('turns stick and face buttons into edge-detectable menu controls', () => {
    const frame = mapStandardGamepad(pad([0, 1, 0, 0], [0, 1, 14]), 'menu');
    expect([...frame.held].sort()).toEqual(['ArrowDown', 'ArrowLeft', 'Enter', 'Escape']);
    expect(frame.lookDX).toBe(0);
    expect(frame.firing).toBe(false);
  });

  it('shows controller glyphs without rewriting ordinary copy', () => {
    expect(gamepadPrompt('E  Exit vehicle  ·  F  Recover  ·  N  Radio', 'vehicle'))
      .toBe('Y  Exit vehicle  ·  B  Recover  ·  DPAD→  Radio');
    expect(gamepadPrompt('WASD  Move  ·  SHIFT  Sprint  ·  M  City map', 'foot'))
      .toBe('LS  Move  ·  L3  Sprint  ·  VIEW  City map');
    expect(gamepadPrompt('JMPD ON YOU — break away or get nicked!', 'foot'))
      .toBe('JMPD ON YOU — break away or get nicked!');
  });
});
