/** Pure logic for the touch control overlay: mode detection, joystick → key synthesis, and
 *  HUD-prompt → context-button parsing. No DOM — everything here is unit-testable. */

/** Touch UI switches on for coarse-pointer touch devices; ?touch=1/0 forces it either way
 *  (desktop/headless testing). Desktop stays byte-identical: when this is false the overlay
 *  is never constructed. */
export function shouldEnableTouch(search: string, hasTouch: boolean, coarsePointer: boolean): boolean {
  const forced = new URLSearchParams(search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return hasTouch && coarsePointer;
}

/** Touch devices default the render quality to low — but only on a fresh install; a saved
 *  choice (the settings menu can raise it) always wins. */
export function touchQuality<Q>(hasSave: boolean, saved: Q, low: Q): Q {
  return hasSave ? saved : low;
}

/** Converts look-drag pixels to mouse-movement counts so the existing sensitivity setting
 *  applies downstream: a ~full-width drag on a phone sweeps roughly a half turn. */
export const TOUCH_LOOK_GAIN = 3;

const DEADZONE = 0.16;
/** 8-way sectors: a direction key engages when its axis share exceeds sin(22.5°) and releases
 *  below a lower bound, so the thumb can ride a sector edge without key flicker. */
const DIRECTION_ACQUIRE = 0.3827;
const DIRECTION_RELEASE = 0.28;
/** Deflection tiers reuse existing keys, so movement code needs no changes: a shallow push
 *  strolls (holds ALT), full deflection sprints (holds SHIFT — which also pedals bicycles
 *  hard). Each threshold pair is hysteretic to stop tier flicker at the boundary. */
const WALK_BELOW = 0.4;
const WALK_EXIT = 0.46;
const SPRINT_ABOVE = 0.95;
const SPRINT_EXIT = 0.88;

/** One frame of joystick state → the set of key codes the stick should hold down.
 *  x is right-positive, y is down-positive (screen space), both in base-radius units.
 *  `previous` is the last returned set — it drives the hysteresis. */
export function stickKeys(x: number, y: number, previous: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  const magnitude = Math.min(Math.hypot(x, y), 1);
  if (magnitude < DEADZONE) return keys;
  const share = (component: number, code: string): boolean =>
    component / magnitude > (previous.has(code) ? DIRECTION_RELEASE : DIRECTION_ACQUIRE);
  if (share(-y, 'KeyW')) keys.add('KeyW');
  if (share(y, 'KeyS')) keys.add('KeyS');
  if (share(-x, 'KeyA')) keys.add('KeyA');
  if (share(x, 'KeyD')) keys.add('KeyD');
  if (magnitude < (previous.has('AltLeft') ? WALK_EXIT : WALK_BELOW)) keys.add('AltLeft');
  else if (magnitude > (previous.has('ShiftLeft') ? SPRINT_EXIT : SPRINT_ABOVE)) keys.add('ShiftLeft');
  return keys;
}

/** Airborne flight remap: the stick becomes the yoke — stick up climbs (ArrowDown is "pull
 *  back" on the keyboard), stick sideways banks. Throttle moves to the W/S hold-buttons on
 *  the right cluster, so the walk/sprint tiers are stripped rather than translated. */
const FLIGHT_REMAP: Record<string, string> = { KeyW: 'ArrowDown', KeyS: 'ArrowUp', KeyA: 'ArrowLeft', KeyD: 'ArrowRight' };
export function remapForFlight(keys: ReadonlySet<string>): Set<string> {
  const remapped = new Set<string>();
  for (const code of keys) { const flight = FLIGHT_REMAP[code]; if (flight) remapped.add(flight); }
  return remapped;
}

export interface PromptAction {
  key: string; // display glyph, e.g. "E"
  code: string; // KeyboardEvent.code to synthesize
  label: string;
}

/** Key tokens the context button understands. Movement pairs (W/S, A/D) are deliberately
 *  absent — the stick already covers them — and CTRL (cover peek) is a hold read from the
 *  held-key set, which a tap can't satisfy; the AIM toggle already drives that path. */
const PROMPT_KEY_CODES: Record<string, string> = {
  E: 'KeyE', F: 'KeyF', Q: 'KeyQ', R: 'KeyR', L: 'KeyL', V: 'KeyV', H: 'KeyH',
  ENTER: 'Enter', SPACE: 'Space',
};

/** The HUD prompt string is the single source of truth for what E/F/Q/… do right now
 *  (Game.renderHUD keeps prompt and key in agreement). Context buttons parse it instead of
 *  re-deriving world state: "E  Exit vehicle  ·  F  Recover" → two tappable pills. */
export function parsePromptActions(prompt: string, limit = 2): PromptAction[] {
  if (!prompt) return [];
  const actions: PromptAction[] = [];
  for (const segment of prompt.split('·')) {
    const match = /^\s*([A-Z]+)\s{2,}(.+?)\s*$/.exec(segment);
    const code = match && PROMPT_KEY_CODES[match[1]!];
    if (!match || !code) continue;
    actions.push({ key: match[1]!, code, label: match[2]! });
    if (actions.length >= limit) break;
  }
  return actions;
}
