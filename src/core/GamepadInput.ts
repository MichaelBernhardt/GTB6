/**
 * Pure standard-gamepad mapping. The DOM-facing InputManager owns polling and edge detection; this
 * module only turns one immutable browser snapshot into the same controls keyboard, mouse and touch
 * already feed. Keeping the mapping pure makes controller support testable without a connected pad.
 */

export type GamepadMode = 'foot' | 'vehicle' | 'flight' | 'menu';

export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonLike[];
}

export interface GamepadFrame {
  readonly held: ReadonlySet<string>;
  /** Analogue strength for directional/throttle controls, 0..1. Digital controls live in held. */
  readonly strengths: ReadonlyMap<string, number>;
  /** Existing camera input uses mouse counts; these are counts per second. */
  readonly lookDX: number;
  readonly lookDY: number;
  readonly firing: boolean;
  readonly aiming: boolean;
}

export const GAMEPAD_DEADZONE = 0.16;
const DIGITAL_AXIS_THRESHOLD = 0.52;
const LOOK_EXPO = 2;
const LOOK_MAX_RATE = 1300;
const LOOK_VERTICAL_SCALE = 0.55;

const BUTTON = {
  south: 0, east: 1, west: 2, north: 3,
  leftBumper: 4, rightBumper: 5, leftTrigger: 6, rightTrigger: 7,
  view: 8, menu: 9, leftStick: 10, rightStick: 11,
  up: 12, down: 13, left: 14, right: 15,
} as const;

function buttonValue(pad: GamepadLike, index: number): number {
  const button = pad.buttons[index];
  if (!button) return 0;
  const value = Math.min(1, Math.max(0, Number.isFinite(button.value) ? button.value : 0));
  // Standard analogue triggers may report `pressed` well before full travel. Preserve their real
  // pressure; only synthesize 1 for digital/non-conforming pads that say pressed while exposing 0.
  return value > 0 ? value : button.pressed ? 1 : 0;
}

function buttonDown(pad: GamepadLike, index: number): boolean {
  return buttonValue(pad, index) > 0.5;
}

/** Removes hardware drift, then rescales the remaining travel back to the full -1..1 range. */
export function gamepadAxis(raw: number | undefined, deadzone = GAMEPAD_DEADZONE): number {
  const value = Math.min(1, Math.max(-1, Number.isFinite(raw) ? raw! : 0));
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  return Math.sign(value) * (magnitude - deadzone) / (1 - deadzone);
}

function addButton(held: Set<string>, pad: GamepadLike, index: number, code: string): void {
  if (buttonDown(pad, index)) held.add(code);
}

function addAxis(
  held: Set<string>,
  strengths: Map<string, number>,
  value: number,
  negativeCode: string,
  positiveCode: string,
): void {
  if (value < 0) strengths.set(negativeCode, -value);
  if (value > 0) strengths.set(positiveCode, value);
  if (value <= -DIGITAL_AXIS_THRESHOLD) held.add(negativeCode);
  if (value >= DIGITAL_AXIS_THRESHOLD) held.add(positiveCode);
}

function lookRate(x: number, y: number): { dx: number; dy: number } {
  const raw = Math.hypot(x, y);
  const magnitude = Math.min(raw, 1);
  if (magnitude < GAMEPAD_DEADZONE) return { dx: 0, dy: 0 };
  const curved = ((magnitude - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE)) ** LOOK_EXPO;
  const scale = (LOOK_MAX_RATE * curved) / raw;
  return { dx: x * scale, dy: y * scale * LOOK_VERTICAL_SCALE };
}

/**
 * Standard Xbox/PlayStation layout:
 * - left stick moves/steers, right stick looks
 * - south jumps/handbrakes, north interacts, east melees/recovers, west reloads/siren
 * - triggers drive; bumpers aim/fire from a vehicle
 * - View opens the map, Menu pauses, R3 changes camera
 */
export function mapStandardGamepad(pad: GamepadLike, mode: GamepadMode): GamepadFrame {
  const held = new Set<string>();
  const strengths = new Map<string, number>();
  const leftX = gamepadAxis(pad.axes[0]); const leftY = gamepadAxis(pad.axes[1]);
  const look = lookRate(gamepadAxis(pad.axes[2]), gamepadAxis(pad.axes[3]));

  if (mode === 'menu') {
    if (leftY <= -DIGITAL_AXIS_THRESHOLD || buttonDown(pad, BUTTON.up)) held.add('ArrowUp');
    if (leftY >= DIGITAL_AXIS_THRESHOLD || buttonDown(pad, BUTTON.down)) held.add('ArrowDown');
    if (leftX <= -DIGITAL_AXIS_THRESHOLD || buttonDown(pad, BUTTON.left)) held.add('ArrowLeft');
    if (leftX >= DIGITAL_AXIS_THRESHOLD || buttonDown(pad, BUTTON.right)) held.add('ArrowRight');
    addButton(held, pad, BUTTON.south, 'Enter');
    if (buttonDown(pad, BUTTON.east) || buttonDown(pad, BUTTON.menu)) held.add('Escape');
    return { held, strengths, lookDX: 0, lookDY: 0, firing: false, aiming: false };
  }

  addButton(held, pad, BUTTON.north, 'KeyE');
  addButton(held, pad, BUTTON.view, 'KeyM');
  addButton(held, pad, BUTTON.menu, 'Escape');
  addButton(held, pad, BUTTON.rightStick, 'KeyV');

  if (mode === 'vehicle') {
    addAxis(held, strengths, leftX, 'KeyA', 'KeyD');
    const throttle = Math.max(buttonValue(pad, BUTTON.rightTrigger), Math.max(0, -leftY));
    const brake = Math.max(buttonValue(pad, BUTTON.leftTrigger), Math.max(0, leftY));
    if (throttle > 0) strengths.set('KeyW', throttle);
    if (brake > 0) strengths.set('KeyS', brake);
    if (throttle > DIGITAL_AXIS_THRESHOLD) held.add('KeyW');
    if (brake > DIGITAL_AXIS_THRESHOLD) held.add('KeyS');
    addButton(held, pad, BUTTON.south, 'Space');
    addButton(held, pad, BUTTON.east, 'KeyF');
    addButton(held, pad, BUTTON.west, 'KeyG');
    addButton(held, pad, BUTTON.leftStick, 'KeyB');
    addButton(held, pad, BUTTON.up, 'KeyT');
    addButton(held, pad, BUTTON.down, 'KeyY');
    if (buttonDown(pad, BUTTON.left)) { held.add('ShiftLeft'); held.add('KeyN'); }
    addButton(held, pad, BUTTON.right, 'KeyN');
    return {
      held, strengths, lookDX: look.dx, lookDY: look.dy,
      firing: buttonDown(pad, BUTTON.rightBumper),
      aiming: buttonDown(pad, BUTTON.leftBumper),
    };
  }

  if (mode === 'flight') {
    addAxis(held, strengths, leftX, 'ArrowLeft', 'ArrowRight');
    // Stick convention: pushing up pulls back and climbs, matching the shipped keyboard/touch deck.
    addAxis(held, strengths, leftY, 'ArrowDown', 'ArrowUp');
    const throttle = buttonValue(pad, BUTTON.rightTrigger);
    const brake = buttonValue(pad, BUTTON.leftTrigger);
    if (throttle > 0) strengths.set('KeyW', throttle);
    if (brake > 0) strengths.set('KeyS', brake);
    if (throttle > DIGITAL_AXIS_THRESHOLD) held.add('KeyW');
    if (brake > DIGITAL_AXIS_THRESHOLD) held.add('KeyS');
    addButton(held, pad, BUTTON.south, 'Space');
    addButton(held, pad, BUTTON.east, 'KeyF');
    return { held, strengths, lookDX: look.dx, lookDY: look.dy, firing: false, aiming: false };
  }

  addAxis(held, strengths, leftX, 'KeyA', 'KeyD');
  addAxis(held, strengths, leftY, 'KeyW', 'KeyS');
  addButton(held, pad, BUTTON.south, 'Space');
  addButton(held, pad, BUTTON.east, 'KeyF');
  addButton(held, pad, BUTTON.west, 'KeyR');
  addButton(held, pad, BUTTON.leftBumper, 'Tab');
  addButton(held, pad, BUTTON.rightBumper, 'KeyQ');
  addButton(held, pad, BUTTON.leftStick, 'ShiftLeft');
  addButton(held, pad, BUTTON.up, 'KeyH');
  addButton(held, pad, BUTTON.down, 'KeyL');
  addButton(held, pad, BUTTON.left, 'WheelPrevious');
  addButton(held, pad, BUTTON.right, 'WheelNext');
  return {
    held, strengths, lookDX: look.dx, lookDY: look.dy,
    firing: buttonDown(pad, BUTTON.rightTrigger),
    aiming: buttonDown(pad, BUTTON.leftTrigger),
  };
}

/** Whether this frame should switch the HUD from keyboard glyphs to controller glyphs. */
export function activeGamepadFrame(frame: GamepadFrame): boolean {
  return frame.held.size > 0 || frame.strengths.size > 0 || frame.firing || frame.aiming
    || frame.lookDX !== 0 || frame.lookDY !== 0;
}

const FOOT_GLYPHS: Readonly<Record<string, string>> = {
  WASD: 'LS', MOUSE: 'RS', SHIFT: 'L3', 'CTRL/RMB': 'LT', CTRL: 'LT', LMB: 'RT',
  SPACE: 'A', E: 'Y', Q: 'RB', F: 'B', TAB: 'LB', SCROLL: 'DPAD', R: 'X',
  H: 'DPAD↑', L: 'DPAD↓', V: 'R3', M: 'VIEW', ESC: 'MENU',
};
const VEHICLE_GLYPHS: Readonly<Record<string, string>> = {
  ...FOOT_GLYPHS,
  'W/S': 'RT/LT', 'A/D': 'LS', N: 'DPAD→', T: 'DPAD↑', Y: 'DPAD↓', G: 'X', B: 'L3',
};
const FLIGHT_GLYPHS: Readonly<Record<string, string>> = {
  ...FOOT_GLYPHS,
  'W/S': 'RT/LT', '←/→': 'LS', 'A/D': 'LS',
};

/** Rewrites only leading control tokens; ordinary prompt copy is never touched. */
export function gamepadPrompt(prompt: string, mode: Exclude<GamepadMode, 'menu'>): string {
  const glyphs = mode === 'vehicle' ? VEHICLE_GLYPHS : mode === 'flight' ? FLIGHT_GLYPHS : FOOT_GLYPHS;
  return prompt.split('·').map((segment) => {
    const match = /^(\s*)([A-Z←→/]+)(\s{2,})/.exec(segment);
    const glyph = match ? glyphs[match[2]!] : undefined;
    return glyph && match ? `${match[1]}${glyph}${match[3]}${segment.slice(match[0].length)}` : segment;
  }).join('·');
}
