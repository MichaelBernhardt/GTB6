import { describe, expect, it } from 'vitest';
import { DEFAULT_GOLF_STATE, GOLF_MIN_AREA, golfPolygons, inGolfPolygon, nearGolfCourse, sanitizeGolfState } from './golf.state';
import { FEATURES } from './registry';
import { promptKey } from './interactions';

describe('golf save slice', () => {
  it('gives a fresh player a hire set and no card', () => {
    expect(sanitizeGolfState(undefined)).toEqual(DEFAULT_GOLF_STATE);
    expect(sanitizeGolfState('nonsense')).toEqual(DEFAULT_GOLF_STATE);
    expect(sanitizeGolfState([1, 2, 3])).toEqual(DEFAULT_GOLF_STATE);
  });

  it('keeps only real gear ids, de-duplicated', () => {
    const state = sanitizeGolfState({ owned: ['glove', 'glove', 'jetpack', 7, null, 'irons'] });
    expect(state.owned).toEqual(['glove', 'irons']);
  });

  it('clamps counters and refuses a nonsense best card', () => {
    expect(sanitizeGolfState({ best: 0 }).best).toBeNull();
    expect(sanitizeGolfState({ best: -4 }).best).toBeNull();
    expect(sanitizeGolfState({ best: Number.NaN }).best).toBeNull();
    expect(sanitizeGolfState({ best: 900 }).best).toBe(99);
    expect(sanitizeGolfState({ best: 9.6 }).best).toBe(10);
    expect(sanitizeGolfState({ rounds: -3, balls: 4000 })).toMatchObject({ rounds: 0, balls: 99 });
  });

  it('drops a settled or forged lay-by but keeps a live one', () => {
    expect(sanitizeGolfState({ layby: { item: 'irons', owing: 0 } }).layby).toBeNull();
    expect(sanitizeGolfState({ layby: { item: 'spaceship', owing: 500 } }).layby).toBeNull();
    expect(sanitizeGolfState({ layby: { item: 'driver', owing: 5599.4 } }).layby).toEqual({ item: 'driver', owing: 5599 });
  });

  it('round-trips a played save', () => {
    const played = { best: 10, rounds: 4, owned: ['shirt', 'glove'], balls: 2, layby: { item: 'irons', owing: 11199 } };
    expect(sanitizeGolfState(played)).toEqual(played);
  });
});

describe('golf approach', () => {
  it('finds golf polygons in the real map, all big enough to route three holes on', () => {
    const courses = golfPolygons();
    expect(courses.length).toBeGreaterThanOrEqual(3);
    for (const course of courses) {
      expect(course.area).toBeGreaterThanOrEqual(GOLF_MIN_AREA);
      expect(course.manicured).toBe(true);
      expect(course.name.toLowerCase()).toMatch(/golf|country club/);
    }
    // Biggest first, so the ordering is stable across builds.
    expect([...courses].sort((a, b) => b.area - a.area)).toEqual(courses);
  });

  it('says yes on a course and no in the middle of the CBD', () => {
    const course = golfPolygons()[0]!;
    expect(nearGolfCourse(course.cx, course.cz)).toBe(true);
    expect(inGolfPolygon(course, course.cx, course.cz)).toBe(true);
    expect(nearGolfCourse(course.maxX + 4000, course.maxZ + 4000)).toBe(false);
  });

  it('is registered with a prompt the mobile pill parser understands', () => {
    const golf = FEATURES.find((feature) => feature.id === 'golf');
    expect(golf).toBeDefined();
    expect(golf!.saveKey).toBe('golf');
    expect(golf!.sanitize).toBe(sanitizeGolfState);
    expect(promptKey(golf!.approach!.prompt)).toBe('E');
  });
});
