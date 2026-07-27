import { describe, expect, it } from 'vitest';
import { promptKey, resolveInteraction, sortInteractions } from './interactions';
import { FEATURES } from './registry';
import { parsePromptActions } from '../ui/TouchModels';
import type { InteractionCtx, InteractionDescriptor, InteractionOffer } from './types';

const ctx = (context: InteractionCtx['context'] = 'foot'): InteractionCtx =>
  ({ context, position: { x: 0, y: 0, z: 0 } as InteractionCtx['position'], vehicle: undefined, hour: 12 });

const rung = (id: string, order: number, offer?: InteractionOffer, context: InteractionCtx['context'] = 'foot'): InteractionDescriptor =>
  ({ id, order, context, test: () => offer });

const offer = (prompt: string, log?: string[]): InteractionOffer => ({ prompt, act: () => log?.push(prompt) });

describe('interaction ordering', () => {
  it('sorts by order, breaking ties on id so the ladder is stable across builds', () => {
    const list = [rung('zulu', 5), rung('alpha', 5), rung('first', 1)];
    expect(sortInteractions(list).map((entry) => entry.id)).toEqual(['first', 'alpha', 'zulu']);
  });

  it('does not mutate the caller’s array', () => {
    const list = [rung('b', 2), rung('a', 1)];
    sortInteractions(list);
    expect(list.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('returns the lowest-order descriptor that actually offers something', () => {
    const list = [rung('silent', 1), rung('winner', 2, offer('E  Tee off')), rung('later', 3, offer('E  Never'))];
    expect(resolveInteraction(list, ctx())?.descriptor.id).toBe('winner');
  });

  it('ignores descriptors registered for the other context', () => {
    const list = [rung('driving', 1, offer('E  Fill up'), 'vehicle'), rung('walking', 2, offer('E  Browse'), 'foot')];
    expect(resolveInteraction(list, ctx('foot'))?.offer.prompt).toBe('E  Browse');
    expect(resolveInteraction(list, ctx('vehicle'))?.offer.prompt).toBe('E  Fill up');
  });

  it('offers nothing when every descriptor declines — the caller falls through to its own ladder', () => {
    expect(resolveInteraction([rung('a', 1), rung('b', 2)], ctx())).toBeUndefined();
  });
});

describe('prompt grammar', () => {
  it('reads the key token out of a well-formed prompt', () => {
    expect(promptKey('E  Fill up · R200')).toBe('E');
    expect(promptKey('E  Exit vehicle  ·  F  Recover')).toBe('E');
  });

  it('rejects a prompt with no key or only one space — the mobile parser needs two', () => {
    expect(promptKey('Fill up')).toBeUndefined();
    expect(promptKey('E Fill up')).toBeUndefined();
  });

  it('every prompt promptKey accepts also yields a mobile pill, and vice versa', () => {
    // Prompt/key disagreement is a shipped bug class here; the two parsers must agree on the grammar.
    for (const prompt of ['E  Fill up · R200', 'E  Tee off', 'F  Mug / melee', 'Q  Take cover']) {
      expect(promptKey(prompt)).toBeDefined();
      expect(parsePromptActions(prompt)[0]?.key).toBe(promptKey(prompt));
    }
    for (const prompt of ['Drive a vehicle onto the marker', 'Safehouse locked · lose the heat first']) {
      expect(promptKey(prompt)).toBeUndefined();
      expect(parsePromptActions(prompt)).toEqual([]);
    }
  });
});

describe('every registered feature', () => {
  // These run against the live registry, so a feature landing a bad approach prompt fails CI rather
  // than shipping a HUD line the mobile context button can't turn into a tappable pill.
  it('declares a unique id and save key', () => {
    expect(new Set(FEATURES.map((feature) => feature.id)).size).toBe(FEATURES.length);
    expect(new Set(FEATURES.map((feature) => feature.saveKey)).size).toBe(FEATURES.length);
  });

  it('uses a lowercase slug id that the console and QA harness can address', () => {
    for (const feature of FEATURES) expect(feature.id, feature.id).toMatch(/^[a-z][a-z0-9-]{1,23}$/);
  });

  it('has an approach prompt that parses into a mobile context pill', () => {
    for (const feature of FEATURES) {
      if (!feature.approach) continue;
      const actions = parsePromptActions(feature.approach.prompt);
      expect(actions.length, `${feature.id}: "${feature.approach.prompt}" yields no mobile pill`).toBeGreaterThan(0);
      expect(actions[0]?.key).toBe(promptKey(feature.approach.prompt));
    }
  });
});
