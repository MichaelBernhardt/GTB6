export class InputManager {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private wheel = 0;
  private suspended = false; // console open: keyboard belongs to the command line, mouse look frozen
  mouseDX = 0;
  mouseDY = 0;
  firing = false;
  firePressed = false;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (event) => {
      if (this.suspended) return;
      if (!this.held.has(event.code)) this.pressed.add(event.code);
      this.held.add(event.code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Tab'].includes(event.code)) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    window.addEventListener('blur', () => { this.held.clear(); this.firing = false; });
    window.addEventListener('mousemove', (event) => {
      if (!this.suspended && document.pointerLockElement === this.element) {
        this.mouseDX += event.movementX;
        this.mouseDY += event.movementY;
      }
    });
    window.addEventListener('mousedown', (event) => { if (!this.suspended && event.button === 0) { this.firing = true; this.firePressed = true; } });
    window.addEventListener('mouseup', (event) => { if (event.button === 0) this.firing = false; });
    window.addEventListener('wheel', (event) => { if (!this.suspended && document.pointerLockElement === this.element) this.wheel += Math.sign(event.deltaY); }, { passive: true });
    this.element.addEventListener('click', () => { if (!document.pointerLockElement) void this.element.requestPointerLock().catch(() => undefined); });
  }

  reset(): void { this.held.clear(); this.pressed.clear(); this.firing = false; this.firePressed = false; this.wheel = 0; this.mouseDX = 0; this.mouseDY = 0; }
  suspend(value: boolean): void { this.suspended = value; this.reset(); }
  down(code: string): boolean { return this.held.has(code); }
  consume(code: string): boolean { const value = this.pressed.has(code); this.pressed.delete(code); return value; }
  consumeWheel(): number { const value = this.wheel; this.wheel = 0; return value; }
  endFrame(): void { this.mouseDX = 0; this.mouseDY = 0; this.pressed.clear(); this.firePressed = false; this.wheel = 0; }
}
