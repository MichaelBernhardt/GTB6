export class AudioManager {
  private context?: AudioContext;
  private master?: GainNode;
  private engine?: OscillatorNode;
  private engineGain?: GainNode;
  private radioTimer?: ReturnType<typeof setInterval>;
  private radioGain?: GainNode;
  private radioNextBeat = 0;
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
  horn(): void { this.tone(392, 0.16, 0.07, 'square'); setTimeout(() => this.tone(392, 0.14, 0.06, 'square'), 210); }

  startRadio(): void {
    if (!this.context || !this.master || this.radioTimer) return;
    const context = this.context;
    this.radioGain = context.createGain(); this.radioGain.gain.value = 1; this.radioGain.connect(this.master);
    const eighth = 60 / 112 / 2;
    this.radioNextBeat = context.currentTime + 0.1;
    let step = 0;
    this.radioTimer = setInterval(() => {
      while (this.radioNextBeat < context.currentTime + 0.5) {
        const inBar = step % 8;
        if (inBar === 0 || inBar === 3 || inBar === 6 || inBar === 7) this.logDrum(this.radioNextBeat, inBar === 0 ? 168 : 148);
        this.shaker(this.radioNextBeat);
        step++; this.radioNextBeat += eighth;
      }
    }, 200);
  }

  stopRadio(): void {
    if (this.radioTimer) { clearInterval(this.radioTimer); this.radioTimer = undefined; }
    this.radioGain?.disconnect(); this.radioGain = undefined;
  }

  private logDrum(time: number, startFrequency: number): void {
    if (!this.context || !this.radioGain) return;
    const oscillator = this.context.createOscillator(); const gain = this.context.createGain();
    oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(startFrequency, time);
    oscillator.frequency.exponentialRampToValueAtTime(62, time + 0.16);
    gain.gain.setValueAtTime(0.055, time); gain.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
    oscillator.connect(gain).connect(this.radioGain); oscillator.start(time); oscillator.stop(time + 0.24);
  }

  private shaker(time: number): void {
    if (!this.context || !this.radioGain) return;
    const oscillator = this.context.createOscillator(); const gain = this.context.createGain();
    oscillator.type = 'triangle'; oscillator.frequency.value = 6200;
    gain.gain.setValueAtTime(0.008, time); gain.gain.exponentialRampToValueAtTime(0.0008, time + 0.03);
    oscillator.connect(gain).connect(this.radioGain); oscillator.start(time); oscillator.stop(time + 0.04);
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
