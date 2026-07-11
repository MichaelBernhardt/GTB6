import type { WeaponSound } from '../config';
import { distanceGain, engineCutoff, engineFrequency, engineLevel, engineProfile, engineState, engineThrob, shiftGlide, stereoPan, trafficEngineGain, type EngineProfile } from './AudioMath';

interface BurstOptions { duration: number; type: BiquadFilterType; frequency: number; q?: number; peak: number; decay: number; at?: number; pan?: number; echo?: number; rate?: number; rateTo?: number; }
interface BlipOptions { type?: OscillatorType; slide?: number; at?: number; pan?: number; attack?: number; }
interface EngineVoice { fund: OscillatorNode; sub: OscillatorNode; harm: OscillatorNode; throb: OscillatorNode; intake: AudioBufferSourceNode; rumble: AudioBufferSourceNode; throbDepth: GainNode; drive: GainNode; intakeGain: GainNode; rumbleGain: GainNode; filter: BiquadFilterNode; gain: GainNode; gear: number; }
interface TrafficEngine { voice: EngineVoice; pan: StereoPannerNode; }
interface BicycleVoice { wind: AudioBufferSourceNode; windGain: GainNode; nextTick: number; }
interface SirenVoice { oscillators: OscillatorNode[]; gain: GainNode; pan: StereoPannerNode; }
interface FireVoice { sources: AudioBufferSourceNode[]; lfo: OscillatorNode; gain: GainNode; pan: StereoPannerNode; nextPop: number; }
interface Ambience { traffic: GainNode; wind: GainNode; windLfo: OscillatorNode; nextEvent: number; }

export class AudioManager {
  private context?: AudioContext;
  private master?: GainNode;
  private echoIn?: GainNode;
  private noise?: AudioBuffer;
  private rumble?: AudioBuffer;
  private engineVoice?: EngineVoice;
  private trafficEngine?: TrafficEngine;
  private bicycleVoice?: BicycleVoice;
  private sirenVoice?: SirenVoice;
  private fireVoice?: FireVoice;
  private ambience?: Ambience;
  private listener = { x: 0, z: 0, yaw: 0 };
  private lastScream = 0;
  private lastGrunt = 0;
  private radioTimer?: ReturnType<typeof setInterval>;
  private radioGain?: GainNode;
  private radioNextBeat = 0;
  volume = 0.65;

  async resume(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -20; compressor.knee.value = 18; compressor.ratio.value = 5; compressor.attack.value = 0.004; compressor.release.value = 0.24;
      this.master.connect(compressor).connect(this.context.destination);
      this.noise = this.buildNoise(1, () => Math.random() * 2 - 1);
      let brown = 0;
      this.rumble = this.buildNoise(2, () => (brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02) * 3.5);
      this.buildEcho(); this.buildAmbience();
    }
    await this.context.resume();
  }

  setVolume(value: number): void {
    this.volume = value;
    this.master?.gain.setTargetAtTime(value, this.now(), 0.03);
  }

  updateListener(x: number, z: number, yaw: number, inPark = false): void {
    this.listener.x = x; this.listener.z = z; this.listener.yaw = yaw;
    if (!this.context || !this.ambience) return;
    const t = this.now();
    this.ambience.traffic.gain.setTargetAtTime(inPark ? 0.007 : 0.017, t, 0.8);
    this.ambience.wind.gain.setTargetAtTime(inPark ? 0.012 : 0.006, t, 0.8);
    if (t >= this.ambience.nextEvent) {
      this.ambience.nextEvent = t + 7 + Math.random() * 14;
      const pan = Math.random() * 1.6 - 0.8;
      if (inPark || Math.random() < 0.3) this.bird(pan); else this.horn(pan);
    }
  }

  taxiHoot(pan = 0): void { this.horn(pan); setTimeout(() => this.horn(pan), 210); }
  beep(): void { this.blip(1245, 0.09, 0.09); }

  /** Positional driver hooter (held-up traffic leaning on the horn): level and pan from the listener;
   *  minibus taxis fire their signature double-tap instead of a single blast. */
  hornAt(x: number, z: number, hoot = false): void {
    const level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 14, 120);
    if (level < 0.02) return;
    const pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    this.horn(pan, 0.05 * level);
    if (hoot) setTimeout(() => this.horn(pan, 0.05 * level), 210);
  }

  /** JMPD dispatch coming over the air: a squelch crackle opens the channel, two Motorola-ish ANI
   *  alert tones, a static bed under the "transmission", then a squelch tail closes it. ~1s, desk-radio level. */
  policeRadio(): void {
    this.burst({ duration: 0.14, type: 'bandpass', frequency: 2100, q: 1.1, peak: 0.05, decay: 0.12, rate: 1.5 });
    this.blip(950, 0.15, 0.042, { at: 0.13, attack: 0.012 });
    this.blip(1400, 0.15, 0.036, { at: 0.31, attack: 0.012 });
    this.burst({ duration: 0.32, type: 'bandpass', frequency: 1750, q: 0.8, peak: 0.028, decay: 0.28, at: 0.48, rate: 1.3 });
    this.burst({ duration: 0.07, type: 'highpass', frequency: 3000, peak: 0.05, decay: 0.045, at: 0.82 });
  }

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

  gunshot(kind: WeaponSound = 'pistol'): void {
    if (kind === 'punch') { this.melee(); return; }
    const jitter = 0.85 + Math.random() * 0.3;
    if (kind === 'smg') {
      this.burst({ duration: 0.16, type: 'bandpass', frequency: 1150 * jitter, q: 0.9, peak: 0.34, decay: 0.06 + Math.random() * 0.02, echo: 0.22 });
      this.blip(190 * jitter, 0.09, 0.3, { slide: 70 });
    } else if (kind === 'shotgun') {
      this.burst({ duration: 0.4, type: 'bandpass', frequency: 430 * jitter, q: 0.6, peak: 0.55, decay: 0.2 + Math.random() * 0.05, echo: 0.6 });
      this.burst({ duration: 0.25, type: 'lowpass', frequency: 250, peak: 0.5, decay: 0.16 });
      this.blip(110 * jitter, 0.26, 0.55, { slide: 36 });
    } else if (kind === 'sniper') { // deeper crack than the pistol with a long rolling echo — it carries across blocks
      this.burst({ duration: 0.6, type: 'bandpass', frequency: 480 * jitter, q: 0.55, peak: 0.62, decay: 0.3 + Math.random() * 0.06, echo: 0.9 });
      this.burst({ duration: 0.22, type: 'lowpass', frequency: 200, peak: 0.55, decay: 0.16 });
      this.blip(90 * jitter, 0.45, 0.6, { slide: 26 });
    } else if (kind === 'launcher') {
      this.burst({ duration: 0.55, type: 'bandpass', frequency: 850, q: 1, peak: 0.3, decay: 0.45, rate: 0.5, rateTo: 2.4, echo: 0.3 });
      this.burst({ duration: 0.12, type: 'lowpass', frequency: 500, peak: 0.3, decay: 0.09 });
      this.blip(140, 0.3, 0.22, { slide: 88 });
    } else {
      this.burst({ duration: 0.3, type: 'bandpass', frequency: 760 * jitter, q: 0.7, peak: 0.5, decay: 0.13 + Math.random() * 0.05, echo: 0.5 });
      this.burst({ duration: 0.12, type: 'lowpass', frequency: 330, peak: 0.42, decay: 0.09 });
      this.blip(155 * jitter, 0.15, 0.5, { slide: 44 });
    }
  }

  explosion(x?: number, z?: number): void {
    let level = 1; let pan = 0;
    if (x !== undefined && z !== undefined) {
      level = Math.max(0.2, distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 20, 320));
      pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.55;
    }
    this.blip(85, 1.1, 0.6 * level, { slide: 25, attack: 0.008, pan });
    this.burst({ duration: 0.5, type: 'lowpass', frequency: 900, peak: 0.55 * level, decay: 0.38, rate: 1.3, rateTo: 0.4, echo: 0.7, pan });
    this.burst({ duration: 1.5, type: 'lowpass', frequency: 170, peak: 0.32 * level, decay: 1.25, pan });
    for (let i = 0; i < 9; i++)
      this.burst({ duration: 0.05, type: 'bandpass', frequency: 800 + Math.random() * 2800, q: 6, peak: (0.02 + Math.random() * 0.045) * level, decay: 0.04 + Math.random() * 0.03, at: 0.12 + Math.random() * 0.85, pan: Math.max(-1, Math.min(1, pan + Math.random() * 0.7 - 0.35)) });
  }

  weaponSelect(): void { this.burst({ duration: 0.05, type: 'bandpass', frequency: 1600, q: 2.2, peak: 0.08, decay: 0.04 }); }

  whiff(): void { this.burst({ duration: 0.12, type: 'bandpass', frequency: 520, q: 1, peak: 0.05, decay: 0.1, rate: 1.6, rateTo: 0.7 }); }

  reload(): void {
    this.burst({ duration: 0.05, type: 'highpass', frequency: 2400, peak: 0.11, decay: 0.032 });
    this.burst({ duration: 0.06, type: 'bandpass', frequency: 1350, q: 3, peak: 0.13, decay: 0.05, at: 0.62 });
    this.blip(185, 0.08, 0.11, { type: 'triangle', at: 0.62, slide: 115 });
  }

  emptyClick(): void { this.burst({ duration: 0.04, type: 'highpass', frequency: 2800, peak: 0.07, decay: 0.028 }); }

  ui(success = true): void {
    if (success) { this.blip(680, 0.14, 0.05); this.blip(1020, 0.18, 0.04, { at: 0.08 }); }
    else this.blip(250, 0.22, 0.06, { slide: 165 });
  }

  pickup(): void {
    this.burst({ duration: 0.04, type: 'bandpass', frequency: 1900, q: 2.5, peak: 0.06, decay: 0.03 });
    this.blip(880, 0.09, 0.035); this.blip(1318, 0.12, 0.03, { at: 0.06 });
  }

  melee(): void {
    this.burst({ duration: 0.1, type: 'lowpass', frequency: 420, peak: 0.24, decay: 0.075 });
    this.blip(120, 0.1, 0.16, { slide: 58 });
  }

  collision(intensity: number): void {
    const power = Math.min(1, Math.abs(intensity) / 34);
    if (power < 0.06) return;
    this.burst({ duration: 0.26, type: 'lowpass', frequency: 240 + power * 420, peak: 0.1 + power * 0.38, decay: 0.11 + power * 0.13, echo: 0.2 });
    const ring = 0.88 + Math.random() * 0.28;
    for (const [frequency, level] of [[327, 0.055], [521, 0.038], [842, 0.022]] as const)
      this.blip(frequency * ring, 0.28 + power * 0.28, level * (0.4 + power), { type: 'triangle', attack: 0.003 });
    if (Math.abs(intensity) > 15) this.crash(Math.min(1, (Math.abs(intensity) - 15) / 25));
  }

  propKnock(intensity: number, x?: number, z?: number): void {
    const power = Math.min(1, Math.abs(intensity) / 30);
    let level = 1; let pan = 0;
    if (x !== undefined && z !== undefined) {
      level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 12, 110);
      if (level < 0.02) return;
      pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    }
    this.burst({ duration: 0.2, type: 'bandpass', frequency: 640 + power * 320, q: 1.3, peak: (0.12 + power * 0.2) * level, decay: 0.09 + power * 0.07, echo: 0.24, pan });
    const ring = 0.9 + Math.random() * 0.22;
    for (const [frequency, peak] of [[416, 0.055], [902, 0.036], [1394, 0.024]] as const)
      this.blip(frequency * ring, 0.26 + power * 0.2, peak * (0.5 + power) * level, { type: 'triangle', attack: 0.002, pan });
    this.blip(112, 0.12, 0.13 * (0.4 + power) * level, { slide: 55, pan });
  }

  hydrantHiss(x: number, z: number, duration = 10): void {
    const context = this.context; const master = this.master;
    if (!context || !master || !this.noise) return;
    const level = 0.055 * distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 10, 130);
    if (level < 0.002) return;
    const t = this.now();
    const source = context.createBufferSource(); source.buffer = this.noise; source.loop = true; source.playbackRate.value = 1.15;
    const filter = context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 2600; filter.Q.value = 0.6;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.18);
    gain.gain.setValueAtTime(level, t + duration - 1.6); gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    const panner = context.createStereoPanner(); panner.pan.value = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    source.connect(filter).connect(gain).connect(panner).connect(master);
    source.start(t); source.stop(t + duration + 0.1);
  }

  splat(intensity = 1, x?: number, z?: number): void {
    const power = Math.min(1, Math.abs(intensity) / 1.6);
    let level = 1; let pan = 0;
    if (x !== undefined && z !== undefined) {
      level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 10, 95);
      if (level < 0.02) return;
      pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    }
    this.burst({ duration: 0.13, type: 'lowpass', frequency: 640, peak: (0.12 + power * 0.2) * level, decay: 0.08 + power * 0.05, rate: 1.5, rateTo: 0.45, pan });
    this.blip(145, 0.09, 0.13 * (0.4 + power) * level, { slide: 55, pan });
    this.blip(95, 0.14, 0.11 * (0.4 + power) * level, { slide: 40, at: 0.035, pan });
  }

  scream(kind: 'panic' | 'pain' = 'panic', x?: number, z?: number): void {
    const context = this.context; const master = this.master;
    if (!context || !master) return;
    const t = this.now();
    if (t < this.lastScream + 0.45) return;
    let level = 0.12; let pan = 0;
    if (x !== undefined && z !== undefined) {
      level *= distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 10, 125);
      if (level < 0.005) return;
      pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.7;
    }
    this.lastScream = t;
    const register = Math.random() < 0.5 ? 1 : 1.5;
    const f0 = (165 + Math.random() * 75) * register;
    const duration = kind === 'pain' ? 0.16 + Math.random() * 0.14 : 0.45 + Math.random() * 0.4;
    const osc = context.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * (kind === 'pain' ? 1.35 : 1.25), t + duration * 0.18);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.55, t + duration);
    const vibrato = context.createOscillator(); vibrato.frequency.value = 5.5 + Math.random() * 2.5;
    const vibratoDepth = context.createGain(); vibratoDepth.gain.value = f0 * 0.06;
    vibrato.connect(vibratoDepth).connect(osc.frequency);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.03);
    gain.gain.setValueAtTime(level, t + duration * 0.6); gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    const panner = context.createStereoPanner(); panner.pan.value = pan;
    for (const [frequency, q, amount] of [[820 * register, 5, 1], [1250 * register, 6, 0.7], [2800, 8, 0.35]] as const) {
      const formant = context.createBiquadFilter(); formant.type = 'bandpass'; formant.frequency.value = frequency; formant.Q.value = q;
      const mix = context.createGain(); mix.gain.value = amount;
      osc.connect(formant).connect(mix).connect(gain);
    }
    gain.connect(panner).connect(master);
    osc.start(t); vibrato.start(t); osc.stop(t + duration + 0.05); vibrato.stop(t + duration + 0.05);
  }

  /** Two-syllable megaphone bark from an arrest scene — the synthesized stand-in for "FREEZE!". */
  policeShout(x: number, z: number): void {
    const level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 12, 150);
    if (level < 0.01) return;
    const pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    this.blip(330, 0.18, 0.11 * level, { type: 'square', slide: 240, pan, attack: 0.004 });
    this.blip(262, 0.3, 0.09 * level, { type: 'square', slide: 155, at: 0.2, pan, attack: 0.004 });
    this.burst({ duration: 0.42, type: 'bandpass', frequency: 1750, q: 2.4, peak: 0.05 * level, decay: 0.34, pan, echo: 0.35 });
  }

  /** Positional service-pistol crack for JMPD fire (the player's own weapons use gunshot()). */
  copGunshot(x: number, z: number): void {
    const level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 12, 170);
    if (level < 0.01) return;
    const pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6;
    const jitter = 0.85 + Math.random() * 0.3;
    this.burst({ duration: 0.28, type: 'bandpass', frequency: 780 * jitter, q: 0.7, peak: 0.4 * level, decay: 0.12 + Math.random() * 0.04, echo: 0.45, pan });
    this.blip(150 * jitter, 0.13, 0.35 * level, { slide: 42, pan });
  }

  /** Short "hey!"-style vocal bark for a shoulder bump: a formant-filtered falling saw. */
  grunt(x?: number, z?: number): void {
    const context = this.context; const master = this.master;
    if (!context || !master) return;
    const t = this.now();
    if (t < this.lastGrunt + 0.22) return;
    let level = 0.09; let pan = 0;
    if (x !== undefined && z !== undefined) {
      level *= distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 6, 42);
      if (level < 0.004) return;
      pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.7;
    }
    this.lastGrunt = t;
    const f0 = 125 + Math.random() * 95;
    const duration = 0.13 + Math.random() * 0.09;
    const osc = context.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0 * 1.35, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.78, t + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(level, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    const panner = context.createStereoPanner(); panner.pan.value = pan;
    for (const [frequency, q, amount] of [[540, 4, 1], [1150, 5, 0.55]] as const) {
      const formant = context.createBiquadFilter(); formant.type = 'bandpass'; formant.frequency.value = frequency; formant.Q.value = q;
      const mix = context.createGain(); mix.gain.value = amount;
      osc.connect(formant).connect(mix).connect(gain);
    }
    gain.connect(panner).connect(master);
    osc.start(t); osc.stop(t + duration + 0.05);
  }

  private crash(power: number): void {
    this.blip(88, 0.32, 0.28 + power * 0.22, { slide: 34 });
    this.burst({ duration: 0.36, type: 'lowpass', frequency: 210, peak: 0.18 + power * 0.24, decay: 0.24, echo: 0.35 });
    const crunches = 4 + Math.round(power * 5);
    for (let i = 0; i < crunches; i++)
      this.blip(170 + Math.random() * 720, 0.05 + Math.random() * 0.06, (0.045 + power * 0.06) * (0.6 + Math.random() * 0.6), { type: Math.random() < 0.5 ? 'square' : 'triangle', at: Math.random() * 0.22, attack: 0.002 });
    const shards = 6 + Math.round(power * 8);
    for (let i = 0; i < shards; i++)
      this.burst({ duration: 0.06, type: 'bandpass', frequency: 2600 + Math.random() * 3400, q: 9, peak: (0.018 + Math.random() * 0.028) * (0.5 + power), decay: 0.035 + Math.random() * 0.03, at: 0.02 + Math.random() * 0.3, pan: Math.random() * 0.8 - 0.4 });
  }

  footstep(running = false, grass = false): void {
    const peak = (running ? 0.075 : 0.05) * (0.85 + Math.random() * 0.3);
    if (grass) this.burst({ duration: 0.09, type: 'lowpass', frequency: 470 + Math.random() * 90, peak, decay: 0.07 });
    else {
      this.burst({ duration: 0.07, type: 'bandpass', frequency: 1050 + Math.random() * 450, q: 1.4, peak: peak * 0.66, decay: 0.045 });
      this.burst({ duration: 0.06, type: 'lowpass', frequency: 310, peak, decay: 0.05 });
    }
  }

  setEngine(active: boolean, speed = 0, throttle = 0, maxSpeed = 40, kind?: string): void {
    if (!this.context || !this.master) return;
    const t = this.now();
    const pedalPowered = active && kind === 'bicycle'; // bicycles have no engine profile: freewheel tick + wind only
    if (this.engineVoice && (!active || pedalPowered)) { this.stopEngine(this.engineVoice, t); this.engineVoice = undefined; }
    if (this.bicycleVoice && !pedalPowered) this.stopBicycleVoice(t);
    if (!active) return;
    if (pedalPowered) { this.updateBicycle(t, speed, maxSpeed); return; }
    if (!this.engineVoice) this.engineVoice = this.buildEngine(this.master);
    this.updateEngine(this.engineVoice, t, speed, throttle, maxSpeed, engineProfile(kind), 1);
  }

  /** Bicycle: no engine at all — just a freewheel tick and wind that rises with speed. Near-silent to the world (and the JMPD). */
  private updateBicycle(t: number, speed: number, maxSpeed: number): void {
    if (!this.bicycleVoice) this.bicycleVoice = this.buildBicycle();
    const voice = this.bicycleVoice;
    const ratio = Math.min(1, Math.abs(speed) / Math.max(1, maxSpeed));
    voice.windGain.gain.setTargetAtTime(0.0008 + ratio * ratio * 0.028, t, 0.12);
    if (Math.abs(speed) > 1.5 && t >= voice.nextTick) {
      voice.nextTick = t + Math.min(0.4, 1.15 / Math.abs(speed));
      this.burst({ duration: 0.02, type: 'highpass', frequency: 5200, peak: 0.011 + ratio * 0.008, decay: 0.014 });
    }
  }

  private stopBicycleVoice(t: number): void {
    const voice = this.bicycleVoice; if (!voice) return;
    voice.windGain.gain.setTargetAtTime(0.0001, t, 0.1);
    try { voice.wind.stop(t + 0.5); } catch { /* already stopped */ }
    this.bicycleVoice = undefined;
  }

  /** One shared positional voice for the nearest NPC vehicle; falls off fast with distance. */
  setTrafficEngine(active: boolean, x = 0, z = 0, speed = 0, maxSpeed = 40, kind?: string): void {
    if (!this.context || !this.master) return;
    const t = this.now();
    if (active && !this.trafficEngine) {
      const pan = this.context.createStereoPanner(); pan.connect(this.master);
      this.trafficEngine = { voice: this.buildEngine(pan), pan };
    }
    const traffic = this.trafficEngine; if (!traffic) return;
    if (!active) { this.stopEngine(traffic.voice, t); this.trafficEngine = undefined; return; }
    const level = 0.6 * trafficEngineGain(Math.hypot(x - this.listener.x, z - this.listener.z));
    traffic.pan.pan.setTargetAtTime(stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.6, t, 0.15);
    this.updateEngine(traffic.voice, t, speed, 0.3, maxSpeed, engineProfile(kind), level);
  }

  private updateEngine(voice: EngineVoice, t: number, speed: number, throttle: number, maxSpeed: number, profile: EngineProfile, levelScale: number): void {
    const { gear, rpm } = engineState(speed, maxSpeed);
    const glide = shiftGlide(gear === voice.gear); voice.gear = gear;
    const frequency = engineFrequency(rpm, profile.basePitch);
    voice.fund.frequency.setTargetAtTime(frequency, t, glide);
    voice.harm.frequency.setTargetAtTime(frequency, t, glide);
    voice.sub.frequency.setTargetAtTime(frequency * 0.5, t, glide);
    voice.filter.frequency.setTargetAtTime(engineCutoff(rpm, throttle, profile.brightness), t, 0.1);
    const throb = engineThrob(rpm, profile.throbRate);
    voice.throb.frequency.setTargetAtTime(throb.rate, t, glide);
    const level = engineLevel(rpm, throttle, profile.level) * levelScale;
    voice.gain.gain.setTargetAtTime(level, t, 0.09);
    voice.throbDepth.gain.setTargetAtTime(level * throb.depth, t, 0.12);
    voice.drive.gain.setTargetAtTime(0.4 + throttle * profile.growl * 1.2, t, 0.08);
    voice.intakeGain.gain.setTargetAtTime(0.08 + throttle * 0.4 + rpm * 0.1, t, 0.1);
    voice.rumbleGain.gain.setTargetAtTime(0.45 + rpm * 0.25, t, 0.12);
  }

  private stopEngine(voice: EngineVoice, t: number): void {
    voice.gain.gain.setTargetAtTime(0.0001, t, 0.08);
    voice.throbDepth.gain.setTargetAtTime(0, t, 0.08);
    for (const node of [voice.fund, voice.sub, voice.harm, voice.throb, voice.intake, voice.rumble]) { try { node.stop(t + 0.6); } catch { /* already stopped */ } }
  }

  sirensMuted = false; // 'nomoresirens' cheat: emergency sirens silenced (lightbars unaffected)

  setSiren(active: boolean, x = 0, z = 0): void {
    if (!this.context || !this.master) return;
    if (this.sirensMuted) active = false;
    const t = this.now();
    if (active && !this.sirenVoice) this.sirenVoice = this.buildSiren();
    const voice = this.sirenVoice; if (!voice) return;
    if (!active) {
      voice.gain.gain.setTargetAtTime(0.0001, t, 0.25);
      for (const osc of voice.oscillators) { try { osc.stop(t + 1.2); } catch { /* already stopped */ } }
      this.sirenVoice = undefined; return;
    }
    const distance = Math.hypot(x - this.listener.x, z - this.listener.z);
    voice.gain.gain.setTargetAtTime(0.05 * distanceGain(distance, 14, 175), t, 0.12);
    voice.pan.pan.setTargetAtTime(stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.7, t, 0.12);
  }

  setFire(active: boolean, x = 0, z = 0): void {
    if (!this.context || !this.master) return;
    const t = this.now();
    if (active && !this.fireVoice) this.fireVoice = this.buildFire();
    const voice = this.fireVoice; if (!voice) return;
    if (!active) {
      voice.gain.gain.setTargetAtTime(0.0001, t, 0.3);
      for (const source of [...voice.sources, voice.lfo]) { try { source.stop(t + 1.4); } catch { /* already stopped */ } }
      this.fireVoice = undefined; return;
    }
    const level = distanceGain(Math.hypot(x - this.listener.x, z - this.listener.z), 11, 120);
    const pan = stereoPan(this.listener.x, this.listener.z, this.listener.yaw, x, z) * 0.65;
    voice.gain.gain.setTargetAtTime(0.12 * level, t, 0.14);
    voice.pan.pan.setTargetAtTime(pan, t, 0.14);
    if (t >= voice.nextPop && level > 0.02) {
      voice.nextPop = t + 0.06 + Math.random() * 0.34;
      this.burst({ duration: 0.05, type: 'bandpass', frequency: 700 + Math.random() * 2600, q: 6, peak: (0.015 + Math.random() * 0.05) * level, decay: 0.03 + Math.random() * 0.045, pan: Math.max(-1, Math.min(1, pan + Math.random() * 0.5 - 0.25)) });
    }
  }

  private now(): number { return this.context?.currentTime ?? 0; }

  private buildNoise(seconds: number, sample: () => number): AudioBuffer {
    const context = this.context as AudioContext;
    const buffer = context.createBuffer(1, Math.floor(context.sampleRate * seconds), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = sample();
    return buffer;
  }

  private buildEcho(): void {
    const context = this.context as AudioContext; const master = this.master as GainNode;
    this.echoIn = context.createGain(); this.echoIn.gain.value = 1;
    const delay = context.createDelay(0.4); delay.delayTime.value = 0.11;
    const feedback = context.createGain(); feedback.gain.value = 0.28;
    const color = context.createBiquadFilter(); color.type = 'lowpass'; color.frequency.value = 1300;
    this.echoIn.connect(delay); delay.connect(feedback).connect(delay); delay.connect(color).connect(master);
  }

  private buildAmbience(): void {
    const context = this.context as AudioContext; const master = this.master as GainNode;
    const traffic = context.createGain(); traffic.gain.value = 0.017;
    const trafficFilter = context.createBiquadFilter(); trafficFilter.type = 'lowpass'; trafficFilter.frequency.value = 360;
    const trafficSource = context.createBufferSource(); trafficSource.buffer = this.rumble as AudioBuffer; trafficSource.loop = true;
    trafficSource.connect(trafficFilter).connect(traffic).connect(master); trafficSource.start();
    const wind = context.createGain(); wind.gain.value = 0.006;
    const windFilter = context.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.frequency.value = 620; windFilter.Q.value = 0.4;
    const windSource = context.createBufferSource(); windSource.buffer = this.noise as AudioBuffer; windSource.loop = true;
    windSource.connect(windFilter).connect(wind).connect(master); windSource.start();
    const windLfo = context.createOscillator(); windLfo.frequency.value = 0.06;
    const windDepth = context.createGain(); windDepth.gain.value = 0.0035;
    windLfo.connect(windDepth).connect(wind.gain); windLfo.start();
    this.ambience = { traffic, wind, windLfo, nextEvent: this.now() + 5 };
  }

  private buildBicycle(): BicycleVoice {
    const context = this.context as AudioContext; const master = this.master as GainNode;
    const wind = context.createBufferSource(); wind.buffer = this.noise as AudioBuffer; wind.loop = true; wind.playbackRate.value = 0.9;
    const filter = context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 880; filter.Q.value = 0.4;
    const windGain = context.createGain(); windGain.gain.value = 0.0001;
    wind.connect(filter).connect(windGain).connect(master); wind.start();
    return { wind, windGain, nextTick: this.now() };
  }

  private buildEngine(destination: AudioNode): EngineVoice {
    const context = this.context as AudioContext;
    // Tonal core: triangle fundamental + quiet detuned saw layer through a soft waveshaper (growl),
    // plus a sine sub-octave for weight. Everything tonal goes through a low-capped lowpass.
    const fund = context.createOscillator(); fund.type = 'triangle'; fund.frequency.value = 54;
    const sub = context.createOscillator(); sub.type = 'sine'; sub.frequency.value = 27;
    const harm = context.createOscillator(); harm.type = 'sawtooth'; harm.frequency.value = 54; harm.detune.value = 6;
    const harmGain = context.createGain(); harmGain.gain.value = 0.3;
    const drive = context.createGain(); drive.gain.value = 0.4;
    const shaper = context.createWaveShaper();
    const curve = new Float32Array(257);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(1.6 * (i / 128 - 1));
    shaper.curve = curve;
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 220; filter.Q.value = 0.5;
    const shelf = context.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1600; shelf.gain.value = -9;
    const gain = context.createGain(); gain.gain.value = 0.0001;
    // Noise body: intake hiss (bandpass white) + exhaust/road rumble (lowpassed brown noise).
    const intake = context.createBufferSource(); intake.buffer = this.noise as AudioBuffer; intake.loop = true;
    const intakeFilter = context.createBiquadFilter(); intakeFilter.type = 'bandpass'; intakeFilter.frequency.value = 900; intakeFilter.Q.value = 0.5;
    const intakeGain = context.createGain(); intakeGain.gain.value = 0.0001;
    const rumble = context.createBufferSource(); rumble.buffer = this.rumble as AudioBuffer; rumble.loop = true;
    const rumbleFilter = context.createBiquadFilter(); rumbleFilter.type = 'lowpass'; rumbleFilter.frequency.value = 190;
    const rumbleGain = context.createGain(); rumbleGain.gain.value = 0.0001;
    // Firing-order throb: one LFO amplitude-modulates the whole voice and flutters pitch a few cents.
    const throb = context.createOscillator(); throb.frequency.value = 13;
    const throbDepth = context.createGain(); throbDepth.gain.value = 0;
    throb.connect(throbDepth).connect(gain.gain);
    const flutter = context.createGain(); flutter.gain.value = 4;
    throb.connect(flutter); flutter.connect(fund.detune); flutter.connect(harm.detune);
    fund.connect(drive); harm.connect(harmGain).connect(drive);
    drive.connect(shaper).connect(filter); sub.connect(filter);
    filter.connect(shelf).connect(gain);
    intake.connect(intakeFilter).connect(intakeGain).connect(gain);
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(gain);
    gain.connect(destination);
    fund.start(); sub.start(); harm.start(); throb.start(); intake.start(); rumble.start();
    return { fund, sub, harm, throb, intake, rumble, throbDepth, drive, intakeGain, rumbleGain, filter, gain, gear: 0 };
  }

  private buildSiren(): SirenVoice {
    const context = this.context as AudioContext; const master = this.master as GainNode;
    const osc = context.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 940;
    const high = context.createOscillator(); high.type = 'sine'; high.frequency.value = 1410;
    const lfo = context.createOscillator(); lfo.frequency.value = 0.42;
    const depth = context.createGain(); depth.gain.value = 330;
    const highDepth = context.createGain(); highDepth.gain.value = 495;
    lfo.connect(depth).connect(osc.frequency); lfo.connect(highDepth).connect(high.frequency);
    const filter = context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 1100; filter.Q.value = 1.1;
    const gain = context.createGain(); gain.gain.value = 0.0001;
    const pan = context.createStereoPanner();
    osc.connect(filter); high.connect(filter); filter.connect(gain).connect(pan).connect(master);
    osc.start(); high.start(); lfo.start();
    return { oscillators: [osc, high, lfo], gain, pan };
  }

  private buildFire(): FireVoice {
    const context = this.context as AudioContext; const master = this.master as GainNode;
    const crackle = context.createBufferSource(); crackle.buffer = this.noise as AudioBuffer; crackle.loop = true; crackle.playbackRate.value = 0.72;
    const crackleFilter = context.createBiquadFilter(); crackleFilter.type = 'bandpass'; crackleFilter.frequency.value = 640; crackleFilter.Q.value = 0.5;
    const crackleGain = context.createGain(); crackleGain.gain.value = 0.6;
    const bed = context.createBufferSource(); bed.buffer = this.rumble as AudioBuffer; bed.loop = true;
    const bedFilter = context.createBiquadFilter(); bedFilter.type = 'lowpass'; bedFilter.frequency.value = 210;
    const bedGain = context.createGain(); bedGain.gain.value = 0.85;
    const gain = context.createGain(); gain.gain.value = 0.0001;
    const lfo = context.createOscillator(); lfo.frequency.value = 8.3;
    const lfoDepth = context.createGain(); lfoDepth.gain.value = 0.03;
    lfo.connect(lfoDepth).connect(gain.gain);
    const pan = context.createStereoPanner();
    crackle.connect(crackleFilter).connect(crackleGain).connect(gain);
    bed.connect(bedFilter).connect(bedGain).connect(gain);
    gain.connect(pan).connect(master);
    crackle.start(); bed.start(); lfo.start();
    return { sources: [crackle, bed], lfo, gain, pan, nextPop: this.now() };
  }

  private horn(pan: number, peak = 0.014): void {
    const context = this.context; const master = this.master;
    if (!context || !master) return;
    const t = this.now(); const base = [352, 380, 442][Math.floor(Math.random() * 3)];
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(peak, t + 0.03); gain.gain.setValueAtTime(peak, t + 0.32); gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 900;
    const panner = context.createStereoPanner(); panner.pan.value = pan;
    for (const detune of [0, 9]) {
      const osc = context.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = base; osc.detune.value = detune;
      osc.connect(filter); osc.start(t); osc.stop(t + 0.46);
    }
    filter.connect(gain).connect(panner).connect(master);
  }

  private bird(pan: number): void {
    let at = 0;
    for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
      const start = 2900 + Math.random() * 900;
      this.blip(start, 0.06, 0.011, { slide: start * 0.78, at, pan });
      at += 0.09 + Math.random() * 0.1;
    }
  }

  private burst(options: BurstOptions): void {
    const context = this.context; const master = this.master;
    if (!context || !master || !this.noise) return;
    const t = this.now() + (options.at ?? 0);
    const source = context.createBufferSource(); source.buffer = this.noise;
    source.playbackRate.setValueAtTime(options.rate ?? 0.85 + Math.random() * 0.3, t);
    if (options.rateTo) source.playbackRate.exponentialRampToValueAtTime(options.rateTo, t + options.duration);
    const filter = context.createBiquadFilter(); filter.type = options.type; filter.frequency.value = options.frequency; filter.Q.value = options.q ?? 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(options.peak, t + 0.004); gain.gain.exponentialRampToValueAtTime(0.0001, t + options.decay);
    let tail: AudioNode = gain;
    if (options.pan) { const panner = context.createStereoPanner(); panner.pan.value = options.pan; gain.connect(panner); tail = panner; }
    source.connect(filter).connect(gain); tail.connect(master);
    if (options.echo && this.echoIn) { const send = context.createGain(); send.gain.value = options.echo; tail.connect(send).connect(this.echoIn); }
    source.start(t); source.stop(t + options.duration);
  }

  private blip(frequency: number, duration: number, peak: number, options: BlipOptions = {}): void {
    const context = this.context; const master = this.master;
    if (!context || !master) return;
    const t = this.now() + (options.at ?? 0);
    const osc = context.createOscillator(); osc.type = options.type ?? 'sine'; osc.frequency.setValueAtTime(frequency, t);
    if (options.slide) osc.frequency.exponentialRampToValueAtTime(options.slide, t + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, t); gain.gain.exponentialRampToValueAtTime(peak, t + (options.attack ?? 0.006)); gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    let tail: AudioNode = gain;
    if (options.pan) { const panner = context.createStereoPanner(); panner.pan.value = options.pan; gain.connect(panner); tail = panner; }
    osc.connect(gain); tail.connect(master);
    osc.start(t); osc.stop(t + duration + 0.02);
  }
}
