import { describe, expect, it } from 'vitest';
import {
  CLIP_TRIM, ClipPicker, MAX_CONCURRENT_VOICES, PLAYER_VOICE_RATE, POLICE_RADIO_CLIPS, RADIO_COOLDOWN,
  RADIO_RATE_JITTER, RadioGate, radioRate, SPEAKER_COOLDOWN, utteranceRate, VOICE_CLIP_IDS,
  VOICE_RATE_MAX, VOICE_RATE_MIN, VOICE_RATE_SPREAD, VoiceCasting, VoiceGate, voicePool,
} from './VoicePools';

describe('voicePool', () => {
  it('casts hit reactions by sex per the owner sheet', () => {
    expect(voicePool('hit', 'male')).toEqual(['hit-argh-male', 'oof-neutral', 'aargh-neutral']);
    expect(voicePool('hit', 'female')).toEqual(['annoyed-hey-female', 'arrrgh-female', 'oof-neutral', 'aargh-neutral']);
    expect(voicePool('hit', 'neutral')).toContain('oof-neutral');
  });

  it('keeps fear pools gendered and never crosses sexes', () => {
    expect(voicePool('fear', 'male')).toEqual(['scream-male', 'fear-arrggh-male']);
    expect(voicePool('fear', 'female')).toEqual(['arrrgh-female']);
    expect(voicePool('fear', 'neutral')).toEqual(['aargh-neutral']);
    for (const sex of ['male', 'neutral'] as const) expect(voicePool('fear', sex)).not.toContain('arrrgh-female');
    for (const sex of ['female', 'neutral'] as const) {
      expect(voicePool('fear', sex)).not.toContain('scream-male');
      expect(voicePool('fear', sex)).not.toContain('fear-arrggh-male');
    }
  });

  it('death pools center on oof/aargh with only own-sex color', () => {
    for (const sex of ['male', 'female', 'neutral'] as const) {
      const pool = voicePool('death', sex);
      expect(pool).toContain('oof-neutral');
      expect(pool).toContain('aargh-neutral');
    }
    expect(voicePool('death', 'male')).not.toContain('arrrgh-female');
    expect(voicePool('death', 'female')).not.toContain('hit-argh-male');
  });

  it('bump barks are gendered; procedural peds draw either at random', () => {
    expect(voicePool('bump', 'female')).toEqual(['annoyed-hey-female']);
    expect(voicePool('bump', 'male')).toEqual(['bump-voetsek-male']);
    expect(voicePool('bump', 'neutral')).toEqual(['annoyed-hey-female', 'bump-voetsek-male']);
  });

  it('never puts police radio chatter in a ped mouth', () => {
    for (const kind of ['hit', 'death', 'fear', 'bump'] as const)
      for (const sex of ['male', 'female', 'neutral'] as const)
        for (const radio of POLICE_RADIO_CLIPS) expect(voicePool(kind, sex)).not.toContain(radio);
  });

  it('has a loudness trim for every clip', () => {
    for (const id of VOICE_CLIP_IDS) expect(CLIP_TRIM[id]).toBeGreaterThan(0);
  });
});

describe('ClipPicker', () => {
  it('never repeats the same clip twice in a row for multi-clip pools', () => {
    const picker = new ClipPicker();
    const pool = voicePool('hit', 'female');
    let previous = picker.pick(pool);
    for (let i = 0; i < 200; i++) {
      const clip = picker.pick(pool);
      expect(clip).not.toBe(previous);
      previous = clip;
    }
  });

  it('tracks repeats per pool, not globally', () => {
    const picker = new ClipPicker();
    const fear = picker.pick(voicePool('fear', 'female'), () => 0); // arrrgh-female
    const hit = picker.pick(['arrrgh-female', 'oof-neutral'], () => 0);
    expect(fear).toBe('arrrgh-female');
    expect(hit).toBe('arrrgh-female'); // a different pool may open with the clip another pool just used
  });

  it('allows repeats from a single-clip pool and returns undefined for an empty one', () => {
    const picker = new ClipPicker();
    expect(picker.pick(voicePool('fear', 'female'))).toBe('arrrgh-female');
    expect(picker.pick(voicePool('fear', 'female'))).toBe('arrrgh-female');
    expect(picker.pick([])).toBeUndefined();
  });

  it('covers the whole pool over many picks', () => {
    const picker = new ClipPicker();
    const pool = voicePool('hit', 'male');
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(picker.pick(pool)!);
    expect(seen.size).toBe(pool.length);
  });
});

describe('VoiceGate', () => {
  it('holds each speaker to one utterance per cooldown window', () => {
    const gate = new VoiceGate();
    const ped = {};
    expect(gate.tryUtter(0, 1, ped)).toBe(true);
    expect(gate.tryUtter(SPEAKER_COOLDOWN - 0.01, 1, ped)).toBe(false);
    expect(gate.tryUtter(SPEAKER_COOLDOWN + 0.01, 1, ped)).toBe(true);
  });

  it('caps overlapping vocals so a massacre is not a choir', () => {
    const gate = new VoiceGate();
    for (let i = 0; i < MAX_CONCURRENT_VOICES; i++) expect(gate.tryUtter(0, 2, {})).toBe(true);
    expect(gate.tryUtter(0.5, 2, {})).toBe(false);
    expect(gate.activeCount(0.5)).toBe(MAX_CONCURRENT_VOICES);
    expect(gate.tryUtter(2.5, 2, {})).toBe(true); // earlier clips ended: a slot is free again
  });

  it('a blocked speaker does not consume a crowd slot', () => {
    const gate = new VoiceGate();
    const ped = {};
    expect(gate.tryUtter(0, 0.5, ped)).toBe(true);
    expect(gate.tryUtter(1, 0.5, ped)).toBe(false); // ped still cooling down
    expect(gate.activeCount(1)).toBe(0); // ...and no phantom vocal was booked
  });

  it('anonymous utterances only face the crowd cap', () => {
    const gate = new VoiceGate();
    expect(gate.tryUtter(0, 1)).toBe(true);
    expect(gate.tryUtter(0.1, 1)).toBe(true);
  });
});

describe('voice pitch casting', () => {
  it('gives each speaker a persistent voice: same ped always, different peds differ', () => {
    const casting = new VoiceCasting();
    const lerato = {}; const thabo = {};
    let roll = 0.1;
    const rng = (): number => (roll = roll === 0.1 ? 0.9 : 0.1);
    const leratoVoice = casting.baseRate(lerato, rng);
    expect(casting.baseRate(lerato, rng)).toBe(leratoVoice); // stable across utterances
    expect(casting.baseRate(lerato, rng)).toBe(leratoVoice);
    expect(casting.baseRate(thabo, rng)).not.toBe(leratoVoice); // a different person sounds different
  });

  it('draws voices across the full ±spread and the player pin is honoured', () => {
    const casting = new VoiceCasting();
    expect(casting.baseRate({}, () => 0)).toBeCloseTo(1 - VOICE_RATE_SPREAD, 8);
    expect(casting.baseRate({}, () => 1)).toBeCloseTo(1 + VOICE_RATE_SPREAD, 8);
    const player = {};
    casting.pin(player, PLAYER_VOICE_RATE);
    expect(casting.baseRate(player, () => 0)).toBe(PLAYER_VOICE_RATE); // pinned, never re-rolled
  });

  it('per-play jitter varies repeats but the clamp keeps every rate non-comedic', () => {
    const casting = new VoiceCasting();
    for (let i = 0; i < 500; i++) {
      const rate = utteranceRate(casting.baseRate({}));
      expect(rate).toBeGreaterThanOrEqual(VOICE_RATE_MIN);
      expect(rate).toBeLessThanOrEqual(VOICE_RATE_MAX);
    }
    // Extremes genuinely need the clamp: deepest voice + downward jitter would undershoot 0.85.
    expect(utteranceRate(1 - VOICE_RATE_SPREAD, () => 0)).toBe(VOICE_RATE_MIN);
    expect(utteranceRate(1 + VOICE_RATE_SPREAD, () => 1)).toBe(VOICE_RATE_MAX);
    const base = 1;
    expect(utteranceRate(base, () => 0)).not.toBe(utteranceRate(base, () => 1)); // repeats still vary
  });

  it('radio chatter stays within its narrow band — static must not chipmunk', () => {
    expect(radioRate(() => 0)).toBeCloseTo(1 - RADIO_RATE_JITTER, 8);
    expect(radioRate(() => 1)).toBeCloseTo(1 + RADIO_RATE_JITTER, 8);
    for (let i = 0; i < 200; i++) {
      const rate = radioRate();
      expect(rate).toBeGreaterThanOrEqual(1 - RADIO_RATE_JITTER);
      expect(rate).toBeLessThanOrEqual(1 + RADIO_RATE_JITTER);
    }
  });
});

describe('RadioGate', () => {
  it('spaces police radio clips by the cooldown whatever prompted them', () => {
    const gate = new RadioGate();
    expect(gate.tryDispatch(0)).toBe(true);
    expect(gate.tryDispatch(1)).toBe(false);
    expect(gate.tryDispatch(RADIO_COOLDOWN - 0.1)).toBe(false);
    expect(gate.tryDispatch(RADIO_COOLDOWN + 0.1)).toBe(true);
    expect(gate.tryDispatch(RADIO_COOLDOWN + 1)).toBe(false); // denied attempts must not push the window out
  });
});
