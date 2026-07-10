export class AudioManager {
  private context?: AudioContext;
  private master?: GainNode;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  volume = 0.65;

  async resume(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
    }
    await this.context.resume();
  }

  setVolume(value: number): void {
    this.volume = value;
    this.master?.gain.setTargetAtTime(value, this.context?.currentTime ?? 0, 0.03);
  }

  tone(frequency: number, duration: number, volume = 0.08, type: OscillatorType = 'sine'): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type; oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.context.currentTime + duration);
    oscillator.connect(gain).connect(this.master); oscillator.start(); oscillator.stop(this.context.currentTime + duration);
  }

  gunshot(): void { this.tone(95, 0.12, 0.22, 'sawtooth'); this.tone(42, 0.2, 0.16, 'square'); }
  reload(): void { this.tone(650, 0.05, 0.08, 'square'); setTimeout(() => this.tone(820, 0.06, 0.07, 'square'), 190); }
  ui(success = true): void { this.tone(success ? 660 : 180, 0.12, 0.08, success ? 'sine' : 'square'); }
  collision(intensity: number): void { this.tone(55 + intensity * 2, 0.14, Math.min(0.18, intensity / 90), 'square'); }
  siren(): void { this.tone(780, 0.18, 0.035, 'sine'); }

  explosion(): void {
    if (!this.context || !this.master) return;
    const start = this.context.currentTime;
    const boom = this.context.createOscillator(); const boomGain = this.context.createGain();
    boom.type = 'sine'; boom.frequency.setValueAtTime(72, start); boom.frequency.exponentialRampToValueAtTime(27, start + 0.95);
    boomGain.gain.setValueAtTime(0.5, start); boomGain.gain.exponentialRampToValueAtTime(0.001, start + 1.15);
    boom.connect(boomGain).connect(this.master); boom.start(start); boom.stop(start + 1.2);
    for (const [freq, detune] of [[46, 0], [52, 16], [39, -11]] as const) {
      const rumble = this.context.createOscillator(); const gain = this.context.createGain();
      rumble.type = 'sawtooth'; rumble.frequency.value = freq; rumble.detune.value = detune;
      gain.gain.setValueAtTime(0.11, start); gain.gain.exponentialRampToValueAtTime(0.001, start + 0.85);
      rumble.connect(gain).connect(this.master); rumble.start(start); rumble.stop(start + 0.9);
    }
    this.tone(950, 0.03, 0.18, 'square');
  }

  setEngine(active: boolean, speed = 0): void {
    if (!this.context || !this.master) return;
    if (active && !this.engine) {
      this.engine = this.context.createOscillator(); this.engineGain = this.context.createGain();
      this.engine.type = 'sawtooth'; this.engineGain.gain.value = 0.025;
      this.engine.connect(this.engineGain).connect(this.master); this.engine.start();
    }
    if (this.engine && this.engineGain) {
      this.engine.frequency.setTargetAtTime(48 + speed * 3.4, this.context.currentTime, 0.08);
      this.engineGain.gain.setTargetAtTime(active ? 0.028 : 0.0001, this.context.currentTime, 0.1);
      if (!active) { const old = this.engine; setTimeout(() => { try { old.stop(); } catch { /* already stopped */ } }, 300); this.engine = undefined; this.engineGain = undefined; }
    }
  }
}
