import type { InputManager } from '../core/InputManager';
import { lookRate, parsePromptActions, remapForFlight, stickKeys, stickKnobOffset } from './TouchModels';

export interface TouchFrame {
  /** Overlay shows only while actually playing with no DOM overlay (map/console/menus) on top. */
  active: boolean;
  prompt: string;
  dialogue: boolean;
  driving: boolean;
  flying: boolean;
  airborneFlight: boolean; // wheels off the ground: stick becomes the yoke, throttle moves to buttons
  weapon: string;
  swap: boolean; // settings toggle: mirror the clusters (stick right, buttons left)
}

const STICK_RADIUS = 68; // px, half the base circle
/** Knob display radii as a fraction of the base: the move knob SNAPS to the active 8-way
 *  direction (walk ring) and jumps to the outer ring when the sprint tier engages. */
const KNOB_WALK = 0.38;
const KNOB_SPRINT = 0.62;

/** Per-stick floating-base drag state (both sticks re-centre under the thumb inside their zone). */
interface StickState { pointer?: number; center: { x: number; y: number } }

/** On-screen touch controls. Renders a DOM overlay (left discrete movement stick — plain 8-way
 *  WASD, full deflection sprints — right analogue free-look stick whose deflection is a continuous
 *  look rate, action buttons, context pills) and SYNTHESIZES InputManager state — gameplay code
 *  reads keys/mouse exactly as it does on desktop. Constructed only when touch mode is on. */
export class TouchControls {
  readonly root = document.createElement('div');
  private readonly rotateOverlay = document.createElement('div');
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly moveZone: HTMLElement;
  private readonly lookZone: HTMLElement;
  private readonly fireButton: HTMLButtonElement;
  private readonly aimButton: HTMLButtonElement;
  private readonly jumpButton: HTMLButtonElement;
  private readonly weaponButton: HTMLButtonElement;
  private readonly contextRow = document.createElement('div');

  private readonly lookStick: HTMLElement;
  private readonly lookKnob: HTMLElement;
  private moveState: StickState = { center: { x: 0, y: 0 } };
  private lookState: StickState = { center: { x: 0, y: 0 } };
  private rawStick = new Set<string>(); // WASD-domain keys, feeds the hysteresis
  private applied = new Set<string>(); // codes currently synthesized as held (post flight remap)
  private lookVec = { x: 0, y: 0 }; // live look-stick deflection in base-radius units
  private fireHeld = false;
  private jumpHeld = false;
  private aimOn = false;
  private flying = false;
  private airborneFlight = false;
  private lastPromptKey = '';
  private immersed = false;

  constructor(private input: InputManager, canvas: HTMLElement, parent: HTMLElement = document.body) {
    // iOS Safari has no pointer-lock API at all — the game's requestPointerLock()/exitPointerLock()
    // calls would throw TypeError (not merely reject). Stub both; touch look feeds deltas directly.
    (canvas as HTMLElement & { requestPointerLock: () => Promise<void> }).requestPointerLock = () => Promise.resolve();
    document.exitPointerLock = () => undefined;
    input.ignoreMouse = true; // taps fire compatibility mouse events — don't read them as the trigger
    document.body.classList.add('is-touch');

    this.root.className = 'tc is-hidden';
    this.moveZone = this.zone('tc-zone-move');
    this.lookZone = this.zone('tc-zone-look');
    this.stick = document.createElement('div'); this.stick.className = 'tc-stick tc-stick-move';
    this.stick.innerHTML = '<i class="tc-stick-ring"></i><b class="tc-stick-knob"></b>';
    this.knob = this.stick.querySelector('.tc-stick-knob')!;
    this.lookStick = document.createElement('div'); this.lookStick.className = 'tc-stick tc-stick-look';
    this.lookStick.innerHTML = '<i class="tc-stick-ring"></i><b class="tc-stick-knob"></b><span class="tc-stick-tag">LOOK</span>';
    this.lookKnob = this.lookStick.querySelector('.tc-stick-knob')!;
    // Releases clear BOTH meanings of the button: the mode can flip (enter/exit a plane) while held.
    this.fireButton = this.holdButton('tc-fire', 'FIRE', (held) => {
      this.fireHeld = held;
      if (!held) { this.input.synthFire(false); this.input.synthKey('KeyW', false); }
      else if (this.flying) this.input.synthKey('KeyW', true); else this.input.synthFire(true);
    });
    this.jumpButton = this.holdButton('tc-jump', 'JUMP', (held) => {
      this.jumpHeld = held;
      if (!held) { this.input.synthKey('Space', false); this.input.synthKey('KeyS', false); }
      else this.input.synthKey(this.flying ? 'KeyS' : 'Space', true);
    });
    this.aimButton = this.tapButton('tc-aim', 'AIM', () => {
      this.aimOn = !this.aimOn; this.aimButton.classList.toggle('is-on', this.aimOn);
      this.input.synthAim(this.aimOn && !this.flying); // immediate, not next-frame: aim must not lag the tap
    });
    this.weaponButton = this.tapButton('tc-weapon', '', () => this.input.synthWheel(1));
    this.contextRow.className = 'tc-context';
    const utils = document.createElement('div'); utils.className = 'tc-utils';
    // Text glyphs, not emoji: emoji fonts are unreliable across WebViews and render as tofu boxes.
    for (const [glyph, code, label] of [['❚❚', 'Escape', 'Pause'], ['MAP', 'KeyM', 'Map'], ['CAM', 'KeyV', 'Camera'], ['⚡', 'KeyL', 'Torch']] as const) {
      utils.append(this.tapButton('tc-util', glyph, () => this.input.synthPress(code), label));
    }
    this.root.append(this.moveZone, this.lookZone, this.stick, this.lookStick, this.weaponButton, this.fireButton, this.aimButton, this.jumpButton, this.contextRow, utils);
    parent.append(this.root);

    this.rotateOverlay.className = 'tc-rotate';
    this.rotateOverlay.innerHTML = '<div><b>Rotate your phone</b><span>Groot Theft Bakkie plays in landscape.</span></div>';
    document.body.append(this.rotateOverlay);

    this.bindFloatingStick(this.moveZone, this.stick, this.moveState, (x, y) => this.applyStick(x, y), () => this.applyStick(0, 0));
    this.bindFloatingStick(this.lookZone, this.lookStick, this.lookState, (x, y) => this.moveLook(x, y), () => this.moveLook(0, 0));
    // Fullscreen + landscape lock need a user gesture; grab the first touch anywhere (menus included),
    // and re-arm whenever the user backs out of fullscreen so the next touch re-enters it.
    window.addEventListener('pointerdown', () => this.requestImmersion(), { capture: true });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) this.immersed = false; });
  }

  /** Once per rendered frame, after Game.renderHUD computed the prompt: reconciles visibility,
   *  context pills, mode-dependent labels, and re-asserts held state (input.reset()/suspend()
   *  clears synthesized keys exactly like real ones — re-asserting recovers them, the same way
   *  a held physical key comes back via auto-repeat). */
  update(frame: TouchFrame): void {
    this.flying = frame.flying; this.airborneFlight = frame.airborneFlight;
    this.root.classList.toggle('is-swapped', frame.swap);
    this.root.classList.toggle('is-hidden', !frame.active);
    if (!frame.active) { this.releaseAll(); return; }
    for (const code of this.applied) this.input.synthKey(code, true);
    if (this.fireHeld) { if (this.flying) this.input.synthKey('KeyW', true); else this.input.synthFire(true); }
    if (this.jumpHeld) this.input.synthKey(this.flying ? 'KeyS' : 'Space', true);
    this.input.synthAim(this.aimOn && !this.flying);

    const setLabel = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
    setLabel(this.fireButton, this.flying ? 'THR +' : 'FIRE');
    setLabel(this.jumpButton, this.flying ? 'THR −' : frame.driving ? 'BRAKE' : 'JUMP');
    this.aimButton.classList.toggle('is-hidden', this.flying);
    this.weaponButton.classList.toggle('is-hidden', this.flying);
    setLabel(this.weaponButton, frame.weapon);

    // A live dialogue card advances on E but writes no prompt string — give it a pill of its own.
    const actions = frame.dialogue && !frame.prompt ? [{ key: 'E', code: 'KeyE', label: 'Continue' }] : parsePromptActions(frame.prompt);
    const promptKey = actions.map((action) => action.key + action.label).join('|');
    if (promptKey !== this.lastPromptKey) {
      this.lastPromptKey = promptKey;
      this.contextRow.replaceChildren(...actions.map((action) => {
        const pill = document.createElement('button');
        pill.className = 'tc-pill'; pill.dataset.tc = `context-${action.key}`;
        pill.innerHTML = `<kbd>${action.key}</kbd><span></span>`;
        pill.querySelector('span')!.textContent = action.label;
        pill.addEventListener('click', () => this.input.synthPress(action.code));
        return pill;
      }));
    }
  }

  private releaseAll(): void {
    for (const code of this.applied) this.input.synthKey(code, false);
    this.applied.clear(); this.rawStick.clear();
    if (this.fireHeld) { this.input.synthFire(false); this.input.synthKey('KeyW', false); }
    if (this.jumpHeld) { this.input.synthKey('Space', false); this.input.synthKey('KeyS', false); }
    this.fireHeld = false; this.jumpHeld = false;
    this.input.synthAim(false);
    this.moveLook(0, 0);
    this.resetStickVisual(this.stick); this.resetStickVisual(this.lookStick);
    this.refreshMoveKnob();
    this.moveState.pointer = undefined; this.lookState.pointer = undefined;
  }

  /** Runs each frame BEFORE the camera consumes mouse deltas (endFrame clears them at frame end,
   *  so feeding from the render-time update() would be wiped unread): converts the look stick's
   *  current deflection into this frame's synthetic mouse movement. dt is the sim time the camera
   *  will advance by, so the turn rate tracks game time — paused (dt 0) means no turn. */
  tickLook(dt: number): void {
    if (!this.lookVec.x && !this.lookVec.y) return;
    const { dx, dy } = lookRate(this.lookVec.x, this.lookVec.y);
    this.input.synthLook(dx * dt, dy * dt);
  }

  /** Diffs the desired held-key set against what is currently synthesized. */
  private applyStick(x: number, y: number): void {
    this.rawStick = stickKeys(x, y, this.rawStick);
    const next = this.flying && this.airborneFlight ? remapForFlight(this.rawStick) : this.rawStick;
    for (const code of this.applied) if (!next.has(code)) this.input.synthKey(code, false);
    for (const code of next) this.input.synthKey(code, true);
    this.applied = new Set(next);
    this.refreshMoveKnob();
  }

  /** The move knob renders the SYNTHESIZED state, not the raw thumb: snapped to the active 8-way
   *  direction, walk ring normally, out to the rim when the sprint tier engages, centred when idle.
   *  That makes the discreteness (and the sprint threshold) visible at a glance. */
  private refreshMoveKnob(): void {
    const offset = stickKnobOffset(this.rawStick);
    const radius = STICK_RADIUS * (offset?.sprint ? KNOB_SPRINT : KNOB_WALK);
    this.stick.classList.toggle('is-sprint', Boolean(offset?.sprint));
    this.knob.style.transform = offset ? `translate(${offset.x * radius}px, ${offset.y * radius}px)` : '';
  }

  /** The look knob is ANALOGUE: it follows the thumb (clamped to the rim) and its deflection is
   *  read as a look rate every frame by tickLook. */
  private moveLook(x: number, y: number): void {
    const magnitude = Math.hypot(x, y);
    const clamp = magnitude > 1 ? 1 / magnitude : 1;
    this.lookVec = { x: x * clamp, y: y * clamp };
    this.lookKnob.style.transform = magnitude ? `translate(${x * clamp * STICK_RADIUS * 0.62}px, ${y * clamp * STICK_RADIUS * 0.62}px)` : '';
  }

  /** Floating base shared by both sticks: on touch the base re-centres under the thumb, clamped
   *  into its zone (works for either side — the swap setting moves the zone, not this math) and
   *  on screen; drags report deflection in base-radius units until release. */
  private bindFloatingStick(zone: HTMLElement, stick: HTMLElement, state: StickState, onVector: (x: number, y: number) => void, onRelease: () => void): void {
    const report = (event: PointerEvent): void =>
      onVector((event.clientX - state.center.x) / STICK_RADIUS, (event.clientY - state.center.y) / STICK_RADIUS);
    zone.addEventListener('pointerdown', (event) => {
      if (state.pointer !== undefined) return;
      state.pointer = event.pointerId; TouchControls.capture(zone, event.pointerId);
      const bounds = zone.getBoundingClientRect();
      state.center = {
        x: Math.min(Math.max(event.clientX, bounds.left + STICK_RADIUS + 8), bounds.right - STICK_RADIUS - 8),
        y: Math.min(Math.max(event.clientY, STICK_RADIUS + 8), innerHeight - STICK_RADIUS - 8),
      };
      stick.classList.add('is-live');
      stick.style.left = `${state.center.x - STICK_RADIUS}px`;
      stick.style.top = `${state.center.y - STICK_RADIUS}px`;
      report(event);
    });
    zone.addEventListener('pointermove', (event) => {
      if (event.pointerId === state.pointer) report(event);
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      zone.addEventListener(type, (event) => {
        if (event.pointerId !== state.pointer) return;
        state.pointer = undefined;
        onRelease();
        this.resetStickVisual(stick);
      });
    }
  }

  private resetStickVisual(stick: HTMLElement): void {
    stick.classList.remove('is-live');
    stick.style.left = ''; stick.style.top = '';
  }

  /** setPointerCapture throws for pointers that are already gone (and for synthesized events in
   *  tests); capture is an enhancement — losing it only means the drag ends at the zone edge. */
  private static capture(element: HTMLElement, pointerId: number): void {
    try { element.setPointerCapture(pointerId); } catch { /* pointer already released */ }
  }

  private zone(className: string): HTMLElement {
    const element = document.createElement('div');
    element.className = `tc-zone ${className}`;
    return element;
  }

  private holdButton(className: string, label: string, set: (held: boolean) => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `tc-btn ${className}`; button.textContent = label; button.dataset.tc = className.replace('tc-', '');
    let pointer: number | undefined;
    button.addEventListener('pointerdown', (event) => {
      if (pointer !== undefined) return;
      pointer = event.pointerId; TouchControls.capture(button, event.pointerId);
      button.classList.add('is-on'); set(true);
    });
    for (const type of ['pointerup', 'pointercancel'] as const) {
      button.addEventListener(type, (event) => {
        if (event.pointerId !== pointer) return;
        pointer = undefined; button.classList.remove('is-on'); set(false);
      });
    }
    return button;
  }

  private tapButton(className: string, glyph: string, onTap: () => void, label?: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = `tc-btn ${className}`; button.textContent = glyph; button.dataset.tc = label?.toLowerCase() ?? className.replace('tc-', '');
    if (label) button.setAttribute('aria-label', label);
    button.addEventListener('click', onTap);
    return button;
  }

  /** Fullscreen + orientation lock, requested once on the first user gesture. Both are
   *  best-effort: iPhone Safari supports neither — there the rotate overlay (CSS, portrait
   *  only) and viewport-fit=cover carry the experience instead. */
  private requestImmersion(): void {
    if (this.immersed) return;
    this.immersed = true;
    void (async () => {
      try { await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* unsupported or denied */ }
      try {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (kind: string) => Promise<void> };
        await orientation.lock?.('landscape');
      } catch { /* iOS / unsupported: rotate overlay covers portrait */ }
    })();
  }
}
