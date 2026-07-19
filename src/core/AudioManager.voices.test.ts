import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from './AudioManager';
import { RADIO_COOLDOWN, SPEAKER_COOLDOWN, voicePool, type VoiceClipId } from './VoicePools';

/**
 * Call-path tests for the recorded voice pools: a stubbed AudioContext + fetch let us assert which
 * clip a game event actually schedules (gendered pools, throttles, synth fallback) without real audio.
 */

class FakeParam {
  value = 0;
  setValueAtTime(): void { /* noop */ }
  exponentialRampToValueAtTime(): void { /* noop */ }
  linearRampToValueAtTime(): void { /* noop */ }
  setTargetAtTime(): void { /* noop */ }
}

interface TaggedBuffer { duration: number; clip?: VoiceClipId }

class FakeNode {
  gain = new FakeParam(); frequency = new FakeParam(); detune = new FakeParam(); Q = new FakeParam();
  pan = new FakeParam(); playbackRate = new FakeParam(); threshold = new FakeParam(); knee = new FakeParam();
  ratio = new FakeParam(); attack = new FakeParam(); release = new FakeParam(); delayTime = new FakeParam();
  type = ''; curve: unknown = null; buffer: TaggedBuffer | null = null; loop = false;
  constructor(private owner: FakeContext, private kind: string) {}
  connect(node: FakeNode): FakeNode { return node; }
  disconnect(): void { /* noop */ }
  start(): void { this.owner.started.push({ kind: this.kind, buffer: this.buffer }); }
  stop(): void { /* noop */ }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode(this, 'destination');
  started: Array<{ kind: string; buffer: TaggedBuffer | null }> = [];
  resume(): Promise<void> { return Promise.resolve(); }
  createBuffer(_channels: number, length: number, rate: number): { getChannelData(): Float32Array; duration: number } {
    return { getChannelData: () => new Float32Array(length), duration: length / rate };
  }
  decodeAudioData(data: unknown): Promise<TaggedBuffer> {
    return Promise.resolve({ duration: 1, clip: (data as { clip: VoiceClipId }).clip });
  }
  createGain(): FakeNode { return new FakeNode(this, 'gain'); }
  createDynamicsCompressor(): FakeNode { return new FakeNode(this, 'compressor'); }
  createBufferSource(): FakeNode { return new FakeNode(this, 'source'); }
  createOscillator(): FakeNode { return new FakeNode(this, 'oscillator'); }
  createBiquadFilter(): FakeNode { return new FakeNode(this, 'filter'); }
  createStereoPanner(): FakeNode { return new FakeNode(this, 'panner'); }
  createDelay(): FakeNode { return new FakeNode(this, 'delay'); }
  createWaveShaper(): FakeNode { return new FakeNode(this, 'shaper'); }
}

let context: FakeContext;
let fetchOk: boolean;

/** Clips started since the given index of context.started (recorded voices only — synth noise has no tag). */
const playedClips = (from = 0): VoiceClipId[] =>
  context.started.slice(from).map((s) => s.buffer?.clip).filter((clip): clip is VoiceClipId => Boolean(clip));

const makeAudio = async (): Promise<AudioManager> => {
  const audio = new AudioManager();
  await audio.resume();
  await (audio as unknown as { loadVoices(): Promise<void> }).loadVoices();
  context.currentTime = 1; // past the synth scream/grunt boot throttles so fallbacks are observable
  context.started = []; // discard boot-time ambience sources
  return audio;
};

beforeEach(() => {
  context = undefined as unknown as FakeContext;
  fetchOk = true;
  vi.stubGlobal('AudioContext', class { constructor() { context = new FakeContext(); return context as unknown as AudioContext; } });
  vi.stubGlobal('fetch', (url: string) => Promise.resolve({
    ok: fetchOk,
    arrayBuffer: () => Promise.resolve({ clip: /audio\/(.+)\.mp3$/.exec(url)?.[1] }),
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('recorded ped voices', () => {
  it('a hit female ped voices a clip from the female hit pool', async () => {
    const audio = await makeAudio();
    audio.scream('pain', 1, 1, 'female', {});
    const clips = playedClips();
    expect(clips).toHaveLength(1);
    expect(voicePool('hit', 'female')).toContain(clips[0]);
  });

  it('a killed male ped voices from the male death pool', async () => {
    const audio = await makeAudio();
    audio.scream('pain', 1, 1, 'male', {}, true);
    const clips = playedClips();
    expect(clips).toHaveLength(1);
    expect(voicePool('death', 'male')).toContain(clips[0]);
  });

  it('a fleeing procedural ped uses the neutral fear clip', async () => {
    const audio = await makeAudio();
    audio.scream('panic', 1, 1, 'neutral', {});
    expect(playedClips()).toEqual(['aargh-neutral']);
  });

  it('bumping a female plays the annoyed hey, a male the voetsek, a procedural ped either', async () => {
    const audio = await makeAudio();
    audio.grunt(1, 1, 'female', {});
    expect(playedClips()).toEqual(['annoyed-hey-female']);
    audio.grunt(1, 1, 'male', {});
    expect(playedClips()).toEqual(['annoyed-hey-female', 'bump-voetsek-male']);
    const before = context.started.length;
    audio.grunt(1, 1, 'neutral', {});
    const neutral = playedClips(before);
    expect(neutral).toHaveLength(1);
    expect(['annoyed-hey-female', 'bump-voetsek-male']).toContain(neutral[0]);
  });

  it('falls back to the synth grunt only while the bump clips are missing', async () => {
    fetchOk = false;
    const audio = await makeAudio();
    audio.grunt(1, 1, 'male', {});
    expect(playedClips()).toEqual([]);
    expect(context.started.some((s) => s.kind === 'oscillator')).toBe(true);
  });

  it('one ped cannot utter twice inside the cooldown, and never repeats a clip back-to-back', async () => {
    const audio = await makeAudio();
    const ped = {};
    audio.scream('pain', 1, 1, 'female', ped);
    audio.scream('pain', 1, 1, 'female', ped);
    expect(playedClips()).toHaveLength(1);
    const clips: VoiceClipId[] = [...playedClips()];
    for (let i = 1; i <= 12; i++) {
      context.currentTime = 1 + i * (SPEAKER_COOLDOWN + 0.1);
      audio.scream('pain', 1, 1, 'female', ped);
    }
    const all = playedClips();
    expect(all.length).toBe(13);
    for (let i = 1; i < all.length; i++) expect(all[i]).not.toBe(all[i - 1]);
    expect(clips[0]).toBe(all[0]);
  });

  it('caps the crowd at three simultaneous vocals', async () => {
    const audio = await makeAudio();
    for (let i = 0; i < 5; i++) audio.scream('pain', 1, 1, 'female', {});
    expect(playedClips()).toHaveLength(3);
  });

  it('an out-of-earshot scream neither plays nor falls back to synth', async () => {
    const audio = await makeAudio();
    audio.scream('pain', 500, 500, 'female', {});
    expect(context.started).toHaveLength(0);
  });

  it('hot vocals still carry at mid distance but are gone past the 90m window', async () => {
    const audio = await makeAudio();
    audio.scream('pain', 40, 0, 'female', {});
    expect(playedClips()).toHaveLength(1);
    audio.scream('pain', 95, 0, 'female', {});
    expect(playedClips()).toHaveLength(1); // the far scream scheduled nothing
  });

  it('falls back to the synthesized scream when the recordings never arrived', async () => {
    fetchOk = false;
    const audio = await makeAudio();
    audio.scream('pain', 1, 1, 'female', {});
    expect(playedClips()).toEqual([]);
    expect(context.started.some((s) => s.kind === 'oscillator')).toBe(true);
  });

  it('the player hit reaction voices the male pool non-positionally', async () => {
    const audio = await makeAudio();
    audio.voice('hit', 'male', undefined, undefined, {});
    const clips = playedClips();
    expect(clips).toHaveLength(1);
    expect(voicePool('hit', 'male')).toContain(clips[0]);
  });
});

describe('police radio clips', () => {
  it('a dispatch plays one radio clip and holds the channel for the cooldown', async () => {
    const audio = await makeAudio();
    audio.policeRadio();
    expect(playedClips()).toHaveLength(1);
    expect(playedClips()[0]).toMatch(/^police-radio-/);
    audio.policeRadio(); // crime spree: still inside the cooldown
    expect(playedClips()).toHaveLength(1);
    context.currentTime = 1 + RADIO_COOLDOWN + 0.5;
    audio.policeRadio();
    const clips = playedClips();
    expect(clips).toHaveLength(2);
    expect(clips[1]).not.toBe(clips[0]); // never the same chatter twice running
  });

  it('radio clips do not count against the ped crowd cap', async () => {
    const audio = await makeAudio();
    audio.policeRadio();
    for (let i = 0; i < 3; i++) audio.scream('pain', 1, 1, 'female', {});
    expect(playedClips()).toHaveLength(4);
  });
});
