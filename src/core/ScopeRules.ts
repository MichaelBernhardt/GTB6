import type { WeaponId } from '../config';

/** Sniper scope FOV ladder in degrees: the mousewheel steps through it, widest first. */
export const SCOPE_FOV_LEVELS = [30, 18, 10, 6, 4] as const;
/** The game camera's resting FOV — magnification reads relative to this. */
export const SCOPE_BASE_FOV = 60;
/** Upward pitch bump (radians) per sniper shot; most of it settles back over the bolt cycle. */
export const SNIPER_RECOIL = 0.05;

export function scopeWeapon(id: WeaponId): boolean { return id === 'sniper'; }

/** Aiming the sniper on foot swaps the shoulder zoom for the scope; vehicles never scope (no drive-by sniping). */
export function scopeActive(aiming: boolean, weapon: WeaponId, inVehicle: boolean): boolean {
  return aiming && scopeWeapon(weapon) && !inVehicle;
}

/** Wheel priority: while scoped the wheel drives zoom; everywhere else it cycles weapons. */
export function wheelAction(scoped: boolean): 'zoom' | 'cycle' { return scoped ? 'zoom' : 'cycle'; }

export function clampScopeLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(SCOPE_FOV_LEVELS.length - 1, Math.max(0, Math.round(level))) : 0;
}

/** One wheel notch per step, clamped at both ends of the ladder (no wrap: past 15x you stay at 15x). */
export function stepScopeLevel(level: number, direction: 1 | -1): number { return clampScopeLevel(clampScopeLevel(level) + direction); }

export function scopeFov(level: number): number { return SCOPE_FOV_LEVELS[clampScopeLevel(level)] ?? SCOPE_BASE_FOV; }

export function scopeMagnification(level: number): number { return SCOPE_BASE_FOV / scopeFov(level); }

export function scopeZoomLabel(level: number): string { return `${scopeMagnification(level).toFixed(1)}x`; }

/** Mouse sensitivity shrinks with the FOV so a 15x scope tracks as controllably as the naked eye. */
export function scopeSensitivity(base: number, level: number): number { return base * scopeFov(level) / SCOPE_BASE_FOV; }
