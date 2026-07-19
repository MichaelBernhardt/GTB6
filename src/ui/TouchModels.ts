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

/** First-visit "pin to home screen" hint: browser-tab fullscreen still shows Android's status bar,
 *  and iOS Safari has no fullscreen API at all — an installed (A2HS) launch is the only true
 *  immersive path on both. Show the hint only in a browser tab (not an installed standalone /
 *  fullscreen launch, where it's moot) and only until dismissed once — never nag twice. */
export function shouldShowInstallHint(dismissed: boolean, standaloneDisplay: boolean): boolean {
  return !dismissed && !standaloneDisplay;
}

/** Touch devices default the render quality to the floor tier (potato/Skorokoro) — but only on a
 *  fresh install; a saved choice (the settings menu can raise it) always wins. */
export function touchQuality<Q>(hasSave: boolean, saved: Q, floor: Q): Q {
  return hasSave ? saved : floor;
}

const DEADZONE = 0.16;
/** 8-way sectors: a direction key engages when its axis share exceeds sin(22.5°) and releases
 *  below a lower bound, so the thumb can ride a sector edge without key flicker. */
const DIRECTION_ACQUIRE = 0.3827;
const DIRECTION_RELEASE = 0.28;
/** The movement stick is DISCRETE — exactly the WASD keys, no analog speed tiers — except full
 *  deflection, which sprints (holds SHIFT — which also pedals bicycles hard). The threshold
 *  pair is hysteretic to stop tier flicker at the boundary. */
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
  if (magnitude > (previous.has('ShiftLeft') ? SPRINT_EXIT : SPRINT_ABOVE)) keys.add('ShiftLeft');
  return keys;
}

/** The free-look stick is ANALOGUE: deflection → continuous look rate, independent of movement.
 *  Rates are in mouse-movement counts per second, so the existing mouse-sensitivity setting
 *  applies downstream exactly as it does to a physical mouse. */
export const LOOK_DEADZONE = 0.15;
/** Squared response: half deflection turns at ~17% of max — fine aim near centre, fast sweep at the edge. */
export const LOOK_EXPO = 2;
/** Counts/s at full deflection: × the 0.0025 rad/count default sensitivity ≈ a 180°/s sweep. */
export const LOOK_MAX_RATE = 1300;
/** Pitch runs slower than yaw — the pitch range is a fraction of a full turn. */
export const LOOK_VERTICAL_SCALE = 0.55;

/** Look-stick deflection → look velocity (counts/s). Feed as synthLook(dx·dt, dy·dt) each frame. */
export function lookRate(x: number, y: number): { dx: number; dy: number } {
  const raw = Math.hypot(x, y);
  const magnitude = Math.min(raw, 1); // over-deflection clamps to the rim rate
  if (magnitude < LOOK_DEADZONE) return { dx: 0, dy: 0 };
  const curved = ((magnitude - LOOK_DEADZONE) / (1 - LOOK_DEADZONE)) ** LOOK_EXPO;
  const scale = (LOOK_MAX_RATE * curved) / raw; // ÷ raw magnitude: direction preserved, length curved
  return { dx: x * scale, dy: y * scale * LOOK_VERTICAL_SCALE };
}

/** Where the movement knob VISUALLY sits for a synthesized key set: snapped to the active 8-way
 *  direction (unit vector) so the discreteness is visible, at the sprint or walk display radius.
 *  Returns null when idle (knob re-centres). */
export function stickKnobOffset(keys: ReadonlySet<string>): { x: number; y: number; sprint: boolean } | null {
  const x = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
  const y = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
  if (!x && !y) return null;
  const inv = 1 / Math.hypot(x, y);
  return { x: x * inv, y: y * inv, sprint: keys.has('ShiftLeft') };
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
  E: 'KeyE', F: 'KeyF', Q: 'KeyQ', R: 'KeyR', L: 'KeyL', V: 'KeyV', H: 'KeyH', N: 'KeyN',
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
