export class WantedSystem {
  heat = 0;
  unseenTime = 0;
  private recentlySeen = false;

  get level(): number { return Math.min(5, Math.ceil(this.heat / 20)); }
  get isWanted(): boolean { return this.heat > 0; }

  addCrime(severity: number): void {
    this.heat = Math.min(100, this.heat + Math.max(0, severity));
    this.unseenTime = 0;
  }

  reportSeen(): void {
    this.recentlySeen = true;
    this.unseenTime = 0;
  }

  update(dt: number): boolean {
    if (this.recentlySeen) {
      this.recentlySeen = false;
      return false;
    }
    if (!this.isWanted) return false;
    this.unseenTime += dt;
    const grace = Math.max(7, 17 - this.level * 2);
    if (this.unseenTime < grace) return false;
    const previousLevel = this.level;
    this.heat = Math.max(0, this.heat - dt * (2.2 + this.unseenTime * 0.025));
    return this.level < previousLevel;
  }

  clear(): void { this.heat = 0; this.unseenTime = 0; }
  setMinimumLevel(level: number): void { this.heat = Math.max(this.heat, Math.max(0, Math.min(5, level)) * 20 - 1); }
}
