import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { MissionDefinition } from './MissionSystem';
import { choiceFlag, DIARY_PAGE_COUNT, StoryDirector } from './StoryDirector';

const mission = (id: string, extra: Partial<MissionDefinition> = {}): MissionDefinition => ({
  id, name: id, contact: 'X', intro: '', reward: 0,
  start: { position: new Vector3(), label: id },
  objectives: [{ kind: 'reach', text: 'go', target: { position: new Vector3(), label: 't' } }],
  ...extra,
});

describe('StoryDirector', () => {
  it('gates missions on prerequisite missions and flags', () => {
    const director = new StoryDirector();
    const open = mission('open');
    const needsMission = mission('later', { prerequisites: { missions: ['open'] } });
    const needsFlag = mission('act2-job', { prerequisites: { flags: ['act1'] } });
    const completed = new Set<string>();
    expect(director.unlocked([open, needsMission, needsFlag], completed).map((m) => m.id)).toEqual(['open']);
    completed.add('open');
    expect(director.unlocked([open, needsMission, needsFlag], completed).map((m) => m.id)).toEqual(['later']);
    director.raise('act1');
    expect(director.unlocked([open, needsMission, needsFlag], completed).map((m) => m.id)).toEqual(['later', 'act2-job']);
  });

  it('offer handshake: begin → accept, or begin → abandon', () => {
    const director = new StoryDirector();
    director.beginOffer('couch-run');
    expect(director.pendingOffer).toBe('couch-run');
    expect(director.acceptOffer()).toBe('couch-run');
    expect(director.pendingOffer).toBeUndefined();
    director.beginOffer('couch-run');
    director.abandonOffer();
    expect(director.acceptOffer()).toBeUndefined();
  });

  it('mission completion raises setFlags once; choices raise namespaced flags', () => {
    const director = new StoryDirector();
    const finale = mission('two-fires', { setFlags: ['act3'] });
    expect(director.onMissionCompleted(finale)).toEqual(['act3']);
    expect(director.onMissionCompleted(finale)).toEqual([]); // already raised
    expect(director.onChoice('two-fires', 'sindi')).toBe(choiceFlag('two-fires', 'sindi'));
    expect(director.flags.has('choice:two-fires:sindi')).toBe(true);
  });

  it('collects diary pages with bounds checking and completion', () => {
    const director = new StoryDirector();
    expect(director.collectDiaryPage(1)).toBe(true);
    expect(director.collectDiaryPage(1)).toBe(false); // duplicate
    expect(director.collectDiaryPage(0)).toBe(false);
    expect(director.collectDiaryPage(DIARY_PAGE_COUNT + 1)).toBe(false);
    expect(director.collectDiaryPage(1.5)).toBe(false);
    for (let page = 2; page <= DIARY_PAGE_COUNT; page++) director.collectDiaryPage(page);
    expect(director.diaryComplete).toBe(true);
  });

  it('round-trips flags and pages through serialize/restore', () => {
    const director = new StoryDirector();
    director.raise('act1'); director.onChoice('two-fires', 'solly');
    director.collectDiaryPage(3); director.collectDiaryPage(7);
    const next = new StoryDirector();
    next.restore(director.serializeFlags(), director.serializeDiaryPages());
    expect(next.flags).toEqual(director.flags);
    expect(next.diaryPages).toEqual(director.diaryPages);
    // restore drops junk pages
    next.restore(['act1'], [0, 99, 2.5, 4]);
    expect(next.serializeDiaryPages()).toEqual([4]);
  });
});
