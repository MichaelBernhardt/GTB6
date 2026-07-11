import { describe, expect, it } from 'vitest';
import { clampScopeLevel, SCOPE_BASE_FOV, SCOPE_FOV_LEVELS, scopeActive, scopeFov, scopeMagnification, scopeSensitivity, scopeWeapon, scopeZoomLabel, SNIPER_RECOIL, stepScopeLevel, wheelAction } from './ScopeRules';

describe('scope zoom ladder', () => {
  it('offers four to six strictly tightening FOV steps from ~30 down to ~4 degrees', () => {
    expect(SCOPE_FOV_LEVELS.length).toBeGreaterThanOrEqual(4);
    expect(SCOPE_FOV_LEVELS.length).toBeLessThanOrEqual(6);
    expect(SCOPE_FOV_LEVELS[0]).toBe(30);
    expect(SCOPE_FOV_LEVELS[SCOPE_FOV_LEVELS.length - 1]).toBeLessThanOrEqual(5);
    for (let i = 1; i < SCOPE_FOV_LEVELS.length; i++) expect(SCOPE_FOV_LEVELS[i]!).toBeLessThan(SCOPE_FOV_LEVELS[i - 1]!);
  });

  it('steps one notch per wheel click and clamps at both ends without wrapping', () => {
    expect(stepScopeLevel(0, 1)).toBe(1);
    expect(stepScopeLevel(1, -1)).toBe(0);
    expect(stepScopeLevel(0, -1)).toBe(0);
    expect(stepScopeLevel(SCOPE_FOV_LEVELS.length - 1, 1)).toBe(SCOPE_FOV_LEVELS.length - 1);
  });

  it('sanitizes out-of-range and junk levels onto the ladder', () => {
    expect(clampScopeLevel(-3)).toBe(0);
    expect(clampScopeLevel(99)).toBe(SCOPE_FOV_LEVELS.length - 1);
    expect(clampScopeLevel(Number.NaN)).toBe(0);
    expect(scopeFov(99)).toBe(SCOPE_FOV_LEVELS[SCOPE_FOV_LEVELS.length - 1]);
  });

  it('reads magnification against the resting FOV, from 2x up to at least 10x', () => {
    expect(scopeMagnification(0)).toBeCloseTo(SCOPE_BASE_FOV / 30);
    expect(scopeMagnification(SCOPE_FOV_LEVELS.length - 1)).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < SCOPE_FOV_LEVELS.length; i++) expect(scopeMagnification(i)).toBeGreaterThan(scopeMagnification(i - 1));
    expect(scopeZoomLabel(0)).toBe('2.0x');
    expect(scopeZoomLabel(SCOPE_FOV_LEVELS.length - 1)).toMatch(/^\d+\.\dx$/);
  });

  it('scales mouse sensitivity proportionally with the FOV so 15x stays controllable', () => {
    const base = 0.0025;
    for (let level = 0; level < SCOPE_FOV_LEVELS.length; level++) expect(scopeSensitivity(base, level) / base).toBeCloseTo(scopeFov(level) / SCOPE_BASE_FOV);
    expect(scopeSensitivity(base, SCOPE_FOV_LEVELS.length - 1)).toBeLessThan(scopeSensitivity(base, 0));
  });
});

describe('scope activation and wheel priority', () => {
  it('scopes only while aiming the sniper on foot', () => {
    expect(scopeActive(true, 'sniper', false)).toBe(true);
    expect(scopeActive(false, 'sniper', false)).toBe(false);
    expect(scopeActive(true, 'pistol', false)).toBe(false);
    expect(scopeActive(true, 'sniper', true)).toBe(false); // no drive-by sniping
  });

  it('hands the wheel to the zoom ladder while scoped and back to weapon cycling otherwise', () => {
    expect(wheelAction(true)).toBe('zoom');
    expect(wheelAction(false)).toBe('cycle');
  });

  it('flags only the sniper as a scoped weapon and kicks with real recoil', () => {
    expect(scopeWeapon('sniper')).toBe(true);
    expect(scopeWeapon('pistol')).toBe(false);
    expect(SNIPER_RECOIL).toBeGreaterThan(0);
    expect(SNIPER_RECOIL).toBeLessThan(0.2); // a thump, not a somersault
  });
});
