import type { GraphicsState } from '../render/GraphicsRecovery';
import type { InputManager } from '../core/InputManager';

/** Kept independent of the ordinary menus so it can still show a reload action if a frame fails
 * inside the game's HUD/menu rendering. No scene work or saved-state writes happen in this view. */
export class GraphicsRecoveryView {
  private panel?: HTMLDivElement;
  private previousFocus?: HTMLElement;

  constructor(private resume: () => void) {}

  /** The ordinary menu is suspended with the world, so the recovery card owns controller focus. */
  update(input: Pick<InputManager, 'consume'>): void {
    if (!this.panel) return;
    const buttons = [...this.panel.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.hidden);
    const next = input.consume('ArrowDown') || input.consume('ArrowRight');
    const previous = input.consume('ArrowUp') || input.consume('ArrowLeft');
    if (next || previous) {
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(index + (previous ? -1 : 1) + buttons.length) % buttons.length]!.focus();
    }
    if (input.consume('Enter')) {
      const focused = buttons.find((button) => button === document.activeElement) ?? buttons[0];
      focused?.click();
    }
  }

  show(state: GraphicsState): void {
    if (state === 'running') {
      this.panel?.remove(); this.panel = undefined;
      if (this.previousFocus?.isConnected) this.previousFocus.focus();
      this.previousFocus = undefined;
      return;
    }
    const first = !this.panel;
    if (!this.panel) {
      this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      this.panel = document.createElement('div'); this.panel.className = 'graphics-recovery';
      this.panel.setAttribute('role', 'dialog'); this.panel.setAttribute('aria-modal', 'true');
      this.panel.setAttribute('aria-labelledby', 'graphics-recovery-title');
      this.panel.setAttribute('aria-describedby', 'graphics-recovery-message');
      this.panel.innerHTML = `<section class="graphics-recovery-card">
        <p class="graphics-recovery-kicker">City services · graphics</p>
        <h1 id="graphics-recovery-title"></h1>
        <p id="graphics-recovery-message" role="status" aria-live="polite"></p>
        <div class="graphics-recovery-actions">
          <button type="button" data-graphics-continue hidden>Continue</button>
          <button type="button" data-graphics-reload>Reload the city</button>
        </div>
      </section>`;
      this.panel.querySelector('[data-graphics-continue]')!.addEventListener('click', this.resume);
      this.panel.querySelector('[data-graphics-reload]')!.addEventListener('click', () => location.reload());
      this.panel.addEventListener('keydown', (event) => {
        if (event.key !== 'Tab') return;
        const buttons = [...this.panel!.querySelectorAll<HTMLButtonElement>('button')].filter((button) => !button.hidden);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus();
        event.preventDefault();
      });
      document.body.append(this.panel);
    }
    const ready = state === 'ready'; const failed = state === 'failed';
    this.panel.querySelector('h1')!.textContent = ready ? 'Graphics restored' : failed ? 'The city hit a problem' : 'Restarting the graphics';
    this.panel.querySelector('#graphics-recovery-message')!.textContent = ready
      ? 'Your game is ready. Continue when you are.'
      : failed ? 'The game has stopped. Reload to continue from your last save.'
      : state === 'restoring' ? 'Rebuilding the view. Your game is paused.'
      : 'The graphics were interrupted. Your game is paused while they restart. You can reload if they do not recover.';
    const proceed = this.panel.querySelector<HTMLButtonElement>('[data-graphics-continue]')!;
    proceed.hidden = !ready;
    if (ready) proceed.focus();
    else if (first || document.activeElement === proceed) this.panel.querySelector<HTMLButtonElement>('[data-graphics-reload]')!.focus();
  }
}
