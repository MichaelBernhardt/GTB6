/** A blackout must leave enough room for Dark House's first-time stealth route, not end halfway
 *  around Kelvin's fence. It remains a pressured window: power can return during a slow breach. */
export const OUTAGE_MIN_SECONDS = 75;
export const OUTAGE_JITTER_SECONDS = 20;

export class LoadSheddingSystem {
  active = false;
  private timer: number;

  constructor(initialDelay = 110 + Math.random() * 60) { this.timer = initialDelay; }

  update(dt: number): 'start' | 'end' | undefined {
    this.timer -= dt;
    if (this.timer > 0) return undefined;
    return this.flip();
  }

  /** Console/cheat override: force the outage to start or end right now; the schedule continues from there. */
  force(): 'start' | 'end' { return this.flip(); }

  /** Preserve at least this much of an outage already under way. Dark House calls this when the
   *  player cases Kelvin mid-slot, so arriving late does not make the stealth route unknowingly
   *  impossible. It never starts an outage or changes the normal off-grid schedule. */
  guaranteeActiveWindow(seconds: number): boolean {
    if (!this.active) return false;
    this.timer = Math.max(this.timer, Math.max(0, seconds));
    return true;
  }

  private flip(): 'start' | 'end' {
    this.active = !this.active;
    this.timer = this.active ? OUTAGE_MIN_SECONDS + Math.random() * OUTAGE_JITTER_SECONDS : 130 + Math.random() * 60;
    return this.active ? 'start' : 'end';
  }
}
