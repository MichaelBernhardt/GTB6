/**
 * Pure selection/throttling logic for the recorded voice clips (art/audio-source → public/audio).
 * Everything here is deterministic given an injected rng/clock so it unit-tests without an AudioContext;
 * AudioManager owns the actual decoding and playback.
 */

/** Sex of the speaker as far as audio cares: rigged NPCs carry one from the catalog, procedural peds don't. */
export type VoiceSex = 'male' | 'female' | 'neutral';
/** What happened to the speaker: hit = took damage, death = the hit killed them, fear = fleeing/panicking, bump = shoulder bump. */
export type VoiceKind = 'hit' | 'death' | 'fear' | 'bump';

export type VoiceClipId =
  | 'hit-argh-male' | 'annoyed-hey-female' | 'oof-neutral' | 'scream-male'
  | 'fear-arrggh-male' | 'aargh-neutral' | 'arrrgh-female' | 'bump-voetsek-male'
  | 'police-radio-1' | 'police-radio-2' | 'police-radio-3';

export const VOICE_CLIP_IDS: readonly VoiceClipId[] = [
  'hit-argh-male', 'annoyed-hey-female', 'oof-neutral', 'scream-male',
  'fear-arrggh-male', 'aargh-neutral', 'arrrgh-female', 'bump-voetsek-male',
  'police-radio-1', 'police-radio-2', 'police-radio-3',
];

export const POLICE_RADIO_CLIPS: readonly VoiceClipId[] = ['police-radio-1', 'police-radio-2', 'police-radio-3'];

/** Owner's casting sheet. Where several clips fit an event, one is chosen at random (no immediate repeats). */
const POOLS: Record<VoiceKind, Record<VoiceSex, readonly VoiceClipId[]>> = {
  hit: {
    male: ['hit-argh-male', 'oof-neutral', 'aargh-neutral'],
    female: ['annoyed-hey-female', 'arrrgh-female', 'oof-neutral', 'aargh-neutral'],
    neutral: ['oof-neutral', 'aargh-neutral', 'hit-argh-male', 'arrrgh-female'],
  },
  death: {
    male: ['oof-neutral', 'aargh-neutral', 'hit-argh-male'],
    female: ['oof-neutral', 'aargh-neutral', 'arrrgh-female'],
    neutral: ['oof-neutral', 'aargh-neutral'],
  },
  fear: {
    male: ['scream-male', 'fear-arrggh-male'],
    female: ['arrrgh-female'],
    neutral: ['aargh-neutral'],
  },
  // Light walk-bump annoyance (owner: "hey!"/"voetsek!" are for bumps, not pain).
  // Procedural peds have no sex, so either bark at random — an angry noise reads as an angry noise.
  bump: {
    male: ['bump-voetsek-male'],
    female: ['annoyed-hey-female'],
    neutral: ['annoyed-hey-female', 'bump-voetsek-male'],
  },
};

export function voicePool(kind: VoiceKind, sex: VoiceSex): readonly VoiceClipId[] {
  return POOLS[kind][sex];
}

/**
 * Loudness trims so every clip lands at roughly the same perceived level (measured mean volume,
 * equalized toward −11 dB): most recordings peak near 0 dB, but oof-neutral was captured ~18 dB
 * quieter and needs a real boost (capped so its −11 dB peak stays under full scale).
 */
export const CLIP_TRIM: Record<VoiceClipId, number> = {
  'hit-argh-male': 1.3,
  'bump-voetsek-male': 1.3,
  'annoyed-hey-female': 0.95,
  'oof-neutral': 3.5,
  'scream-male': 0.9,
  'fear-arrggh-male': 1.0,
  'aargh-neutral': 0.7,
  'arrrgh-female': 0.75,
  'police-radio-1': 1.0,
  'police-radio-2': 1.8,
  'police-radio-3': 1.0,
};

/** Per-utterance base level for ped/player voices before distance falloff. The recordings are normalised
 *  hot (peaks ~0 dB), so this starts deliberately low — about half of what a fresh ear would pick — and
 *  should be tuned down rather than up (owner's instruction). */
export const VOICE_LEVEL = 0.15;
/** Non-positional level for the police-radio clips: chatter from a nearby cruiser, well under the
 *  music/effects bed — not an announcement in your skull. (The old synth ANI burst peaked ~0.05.) */
export const RADIO_LEVEL = 0.08;
/** A ped may utter at most once per this many seconds. */
export const SPEAKER_COOLDOWN = 1.5;
/** At most this many recorded vocals may overlap — a massacre must not become a choir. */
export const MAX_CONCURRENT_VOICES = 3;
/** Minimum gap between police-radio clips so a crime spree doesn't machine-gun static. */
export const RADIO_COOLDOWN = 6;

/** Random pick that never returns the same clip twice in a row per pool (single-clip pools excepted). */
export class ClipPicker {
  private last = new Map<string, VoiceClipId>();

  pick(pool: readonly VoiceClipId[], rng: () => number = Math.random): VoiceClipId | undefined {
    if (pool.length === 0) return undefined;
    const key = pool.join('|');
    const previous = this.last.get(key);
    const candidates = pool.length > 1 && previous ? pool.filter((clip) => clip !== previous) : pool;
    const clip = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))]!;
    this.last.set(key, clip);
    return clip;
  }
}

/**
 * Rate limiting for utterances: a per-speaker cooldown plus a global cap on overlapping vocals.
 * Speakers are held weakly so despawned peds don't pin memory.
 */
export class VoiceGate {
  private bySpeaker = new WeakMap<object, number>();
  private endTimes: number[] = [];

  /** True (and books the slot) when `speaker` may utter a clip lasting `duration` at time `now`. */
  tryUtter(now: number, duration: number, speaker?: object): boolean {
    this.endTimes = this.endTimes.filter((end) => end > now);
    if (this.endTimes.length >= MAX_CONCURRENT_VOICES) return false;
    if (speaker) {
      const readyAt = this.bySpeaker.get(speaker) ?? -Infinity;
      if (now < readyAt) return false;
      this.bySpeaker.set(speaker, now + SPEAKER_COOLDOWN);
    }
    this.endTimes.push(now + duration);
    return true;
  }

  activeCount(now: number): number {
    return this.endTimes.filter((end) => end > now).length;
  }
}

/** Police-radio limiter: at most one clip per RADIO_COOLDOWN seconds, whatever prompted the dispatch. */
export class RadioGate {
  private readyAt = -Infinity;

  tryDispatch(now: number): boolean {
    if (now < this.readyAt) return false;
    this.readyAt = now + RADIO_COOLDOWN;
    return true;
  }
}
