import { activeGamepadFrame, mapStandardGamepad, type GamepadMode } from './GamepadInput';

export const typingInField = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);

export class InputManager {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private gamepadHeld = new Set<string>();
  private previousGamepadHeld = new Set<string>();
  private gamepadStrengths = new Map<string, number>();
  private wheel = 0;
  private suspended = false; // console open: keyboard belongs to the command line, mouse look frozen
  private pointerFiring = false;
  private gamepadFiring = false;
  private previousGamepadFiring = false;
  private gamepadAiming = false;
  private gamepadConnected = false;
  private lastDevice: 'keyboard-mouse' | 'gamepad' = 'keyboard-mouse';
  mouseDX = 0;
  mouseDY = 0;
  firePressed = false;
  private rmbHeld = false;
  private ignoreNextMove = false; // swallow the first delta after a (re)lock: browsers report a huge movementX/Y jump from the drifted cursor to the lock point, which would snap the camera
  /** Touch mode: taps fire compatibility mousedown/mouseup events, which would read every UI tap
   *  as pulling the trigger. TouchControls sets this so only synthesized fire state counts. */
  ignoreMouse = false;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (event) => {
      if (this.suspended || typingInField(event.target)) return; // a focused text field owns the keyboard — WASD/Space must insert letters, not steer
      this.lastDevice = 'keyboard-mouse';
      if (!this.held.has(event.code)) this.pressed.add(event.code);
      this.held.add(event.code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Tab', 'PageUp', 'PageDown', 'AltLeft'].includes(event.code)) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    window.addEventListener('blur', () => { this.held.clear(); this.pointerFiring = false; });
    window.addEventListener('mousemove', (event) => {
      if (!this.suspended && document.pointerLockElement === this.element) {
        if (this.ignoreNextMove) { this.ignoreNextMove = false; return; } // drop the post-relock spike, not the whole frame
        if (event.movementX || event.movementY) this.lastDevice = 'keyboard-mouse';
        this.mouseDX += event.movementX;
        this.mouseDY += event.movementY;
      }
    });
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement === this.element) this.ignoreNextMove = true; }); // fresh lock: arm the one-shot spike guard
    window.addEventListener('mousedown', (event) => {
      if (this.suspended || this.ignoreMouse) return;
      this.lastDevice = 'keyboard-mouse';
      if (event.button === 0) { this.pointerFiring = true; this.firePressed = true; }
      if (event.button === 2) this.rmbHeld = true;
    });
    window.addEventListener('mouseup', (event) => { if (this.ignoreMouse) return; if (event.button === 0) this.pointerFiring = false; if (event.button === 2) this.rmbHeld = false; });
    window.addEventListener('contextmenu', (event) => { if (document.pointerLockElement === this.element) event.preventDefault(); });
    window.addEventListener('wheel', (event) => { if (!this.suspended && document.pointerLockElement === this.element) this.wheel += Math.sign(event.deltaY); }, { passive: true });
    this.element.addEventListener('click', () => { if (!document.pointerLockElement) void this.element.requestPointerLock().catch(() => undefined); });
  }

  // --- Touch synthesis (TouchControls) -------------------------------------------------------
  // Writes the exact state the DOM listeners write, so down()/consume()/aiming/mouseDX behave
  // identically for touch and keyboard players. Suspension applies the same way: while the
  // console or map owns input, synthesized events are dropped just like real ones. The overlay
  // re-asserts its held keys every frame, so state lost to a reset()/suspend cycle recovers on
  // the next frame (same as a keyboard's auto-repeat re-adding a still-held key).
  synthKey(code: string, held: boolean): void {
    if (this.suspended) return;
    if (!held) { this.held.delete(code); return; }
    if (!this.held.has(code)) this.pressed.add(code);
    this.held.add(code);
  }
  synthPress(code: string): void { if (!this.suspended) this.pressed.add(code); }
  synthLook(dx: number, dy: number): void { if (!this.suspended) { this.mouseDX += dx; this.mouseDY += dy; } }
  synthFire(held: boolean): void { if (this.suspended) return; if (held && !this.pointerFiring) this.firePressed = true; this.pointerFiring = held; }
  synthAim(held: boolean): void { if (!this.suspended) this.rmbHeld = held; }
  synthWheel(step: number): void { if (!this.suspended) this.wheel += step; }

  /**
   * Poll once per rendered frame, before simulation. Edge detection is based on the previous
   * physical pad frame rather than reset(), so holding Menu while resuming cannot instantly pause
   * again and holding South to start cannot become a surprise jump on the next frame.
   */
  pollGamepad(dt: number, mode: GamepadMode): 'connected' | 'disconnected' | undefined {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = [...pads].find((candidate): candidate is Gamepad => Boolean(candidate?.connected));
    if (!pad) {
      const event = this.gamepadConnected ? 'disconnected' : undefined;
      this.gamepadConnected = false; this.gamepadHeld.clear(); this.previousGamepadHeld.clear();
      this.gamepadStrengths.clear(); this.gamepadFiring = false; this.previousGamepadFiring = false; this.gamepadAiming = false;
      if (event) this.lastDevice = 'keyboard-mouse';
      return event;
    }

    const event = this.gamepadConnected ? undefined : 'connected';
    this.gamepadConnected = true;
    const frame = mapStandardGamepad(pad, mode);
    this.gamepadHeld = new Set(frame.held);
    this.gamepadStrengths = new Map(frame.strengths);
    for (const code of frame.held) {
      if (this.previousGamepadHeld.has(code)) continue;
      if (code === 'WheelPrevious') this.wheel -= 1;
      else if (code === 'WheelNext') this.wheel += 1;
      else this.pressed.add(code);
    }
    this.previousGamepadHeld = new Set(frame.held);
    this.gamepadFiring = frame.firing;
    if (frame.firing && !this.previousGamepadFiring) this.firePressed = true;
    this.previousGamepadFiring = frame.firing;
    this.gamepadAiming = frame.aiming;
    if (!this.suspended && mode !== 'menu') {
      this.mouseDX += frame.lookDX * Math.max(0, dt);
      this.mouseDY += frame.lookDY * Math.max(0, dt);
    }
    if (activeGamepadFrame(frame)) this.lastDevice = 'gamepad';
    return event;
  }

  reset(): void {
    this.held.clear(); this.pressed.clear(); this.gamepadHeld.clear(); this.gamepadStrengths.clear();
    this.pointerFiring = false; this.gamepadFiring = false; this.firePressed = false; this.gamepadAiming = false;
    this.rmbHeld = false; this.wheel = 0; this.mouseDX = 0; this.mouseDY = 0;
  }
  suspend(value: boolean): void { this.suspended = value; this.reset(); }
  get aiming(): boolean { return !this.suspended && (this.gamepadAiming || this.rmbHeld || this.held.has('ControlLeft') || this.held.has('ControlRight')); }
  get firing(): boolean { return !this.suspended && (this.pointerFiring || this.gamepadFiring); }
  /** LMB/touch fire specifically — the drag-steering gesture must not treat a gamepad trigger as a mouse. */
  get pointerFireHeld(): boolean { return !this.suspended && this.pointerFiring; }
  get gamepadActive(): boolean { return this.lastDevice === 'gamepad'; }
  get hasGamepad(): boolean { return this.gamepadConnected; }
  value(code: string): number {
    const analogue = this.gamepadStrengths.get(code);
    const digital = this.held.has(code) || (analogue === undefined && this.gamepadHeld.has(code)) ? 1 : 0;
    return Math.max(digital, analogue ?? 0);
  }
  axis(negativeCode: string, positiveCode: string): number { return this.value(positiveCode) - this.value(negativeCode); }
  down(code: string): boolean { return this.held.has(code) || this.gamepadHeld.has(code) || (this.gamepadStrengths.get(code) ?? 0) > 0.16; }
  consume(code: string): boolean { const value = this.pressed.has(code); this.pressed.delete(code); return value; }
  consumeWheel(): number { const value = this.wheel; this.wheel = 0; return value; }
  endFrame(): void { this.mouseDX = 0; this.mouseDY = 0; this.pressed.clear(); this.firePressed = false; this.wheel = 0; }
}

/** Test doubles written before analogue input expose only down(); retain that tiny structural seam. */
export function inputValue(input: InputManager, code: string): number {
  const value = (input as InputManager & { value?: (key: string) => number }).value;
  return typeof value === 'function' ? value.call(input, code) : Number(input.down(code));
}

export function inputAxis(input: InputManager, negativeCode: string, positiveCode: string): number {
  return inputValue(input, positiveCode) - inputValue(input, negativeCode);
}
