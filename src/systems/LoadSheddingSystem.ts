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

  private flip(): 'start' | 'end' {
    this.active = !this.active;
    this.timer = this.active ? 32 + Math.random() * 12 : 130 + Math.random() * 60;
    return this.active ? 'start' : 'end';
  }
}
