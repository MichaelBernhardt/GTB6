export class InputManager {
  private held = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  firing = false;

  constructor(private element: HTMLElement) {
    window.addEventListener('keydown', (event) => {
      if (!this.held.has(event.code)) this.pressed.add(event.code);
      this.held.add(event.code);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code)) event.preventDefault();
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    window.addEventListener('blur', () => { this.held.clear(); this.firing = false; });
    window.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement === this.element) {
        this.mouseDX += event.movementX;
        this.mouseDY += event.movementY;
      }
    });
    window.addEventListener('mousedown', (event) => { if (event.button === 0) this.firing = true; });
    window.addEventListener('mouseup', (event) => { if (event.button === 0) this.firing = false; });
    this.element.addEventListener('click', () => { if (!document.pointerLockElement) void this.element.requestPointerLock().catch(() => undefined); });
  }

  down(code: string): boolean { return this.held.has(code); }
  consume(code: string): boolean { const value = this.pressed.has(code); this.pressed.delete(code); return value; }
  endFrame(): void { this.mouseDX = 0; this.mouseDY = 0; this.pressed.clear(); }
}
