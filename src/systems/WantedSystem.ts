export class WantedSystem {
  heat = 0;
  unseenTime = 0;
  private recentlySeen = false;
  private teflonOn = false;

  get level(): number { return Math.min(5, Math.ceil(this.heat / 20)); }
  get isWanted(): boolean { return this.heat > 0; }

  /** `teflon` cheat, as an INPUT to this system rather than a special case in every caller: while it is set,
   *  no path can raise heat — witnessed crimes, cop-witnessed crimes, matured 911 reports and mission-forced
   *  stars all funnel through addCrime/setMinimumLevel, so one flag covers the lot.
   *  Switching it on also wipes the heat already banked: "police never interested" means the chase you are
   *  in ends, rather than freezing at four stars until the cheat comes off again. Idempotent — re-asserting
   *  the same value (every restore path does) never clears heat a second time. */
  get teflon(): boolean { return this.teflonOn; }
  set teflon(on: boolean) {
    if (on === this.teflonOn) return;
    this.teflonOn = on;
    if (on) this.clear();
  }

  addCrime(severity: number): void {
    if (this.teflonOn) return; // nothing sticks
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
  setMinimumLevel(level: number): void {
    if (this.teflonOn) return; // mission-forced stars are still stars
    this.heat = Math.max(this.heat, Math.max(0, Math.min(5, level)) * 20 - 1);
  }
}
