import { FEATURES } from './registry';

/**
 * The save seam. `SavedGame.features` is a single `Record<string, unknown>` slot: every feature
 * stores its slice under its own key, so no feature ever touches src/types.ts, SaveManager.ts or
 * Game.persist() again.
 *
 * No save version bump is needed — deserialize already accepts 1|2|3, rewrites to 3, and funnels
 * every field through a sanitizer. A save written before this key existed simply arrives as {}.
 */

const MAX_DEPTH = 6;
const MAX_KEYS = 64;
const MAX_ITEMS = 512;
const MAX_STRING = 512;
const BANNED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Generic JSON-safe deep copy with hard caps. localStorage is attacker-writable, so a stored blob
 * gets structurally rebuilt rather than trusted: functions, symbols, class instances, NaN/Infinity
 * and prototype-polluting keys are dropped, and depth/size are bounded so a hostile save can't hang
 * the load. Features that want a stricter shape add their own `sanitize` on top of this.
 */
export function sanitizeFeatureBlob(raw: unknown, depth = 0): unknown {
  if (raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'string') return raw.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(raw)) {
    const items: unknown[] = [];
    for (const item of raw.slice(0, MAX_ITEMS)) {
      const value = sanitizeFeatureBlob(item, depth + 1);
      if (value !== undefined) items.push(value);
    }
    return items;
  }
  if (typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(source)) {
    if (kept >= MAX_KEYS) break;
    if (BANNED_KEYS.has(key) || key.length > 64) continue;
    const value = sanitizeFeatureBlob(source[key], depth + 1);
    if (value === undefined) continue;
    out[key] = value; kept++;
  }
  return out;
}

/**
 * The one delegating sanitizer SaveManager.deserialize calls. Only registered save keys survive, so
 * a slice belonging to a feature this build doesn't know about is dropped rather than carried, and a
 * feature's own `sanitize` refines the generic blob afterwards.
 */
export function sanitizeFeatureSaves(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const feature of FEATURES) {
    if (!Object.prototype.hasOwnProperty.call(source, feature.saveKey)) continue;
    const generic = sanitizeFeatureBlob(source[feature.saveKey]);
    if (generic === undefined) continue;
    let value: unknown = generic;
    if (feature.sanitize) {
      // A feature's sanitizer runs inside the save load: a throw there must not cost the whole save.
      try { value = feature.sanitize(generic); }
      catch { value = undefined; }
    }
    if (value !== undefined) out[feature.saveKey] = value;
  }
  return out;
}
