import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { MissionDefinition } from './MissionSystem';
import { choiceFlag, DIARY_PAGE_COUNT, SIDE_QUEST_DELAY_S, StoryDirector } from './StoryDirector';

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

describe('side-quest pacing (owner: no instant re-offer at the contact you just worked for)', () => {
  const roster: MissionDefinition[] = [
    mission('main-a', { contact: 'Auntie P', act: 'hustle' }),
    mission('main-b', { contact: 'Auntie P', act: 'hustle', prerequisites: { missions: ['main-a'] } }),
    mission('other', { contact: 'Someone Else', act: 'payroll' }),
    mission('side-a', { contact: 'Auntie P', act: 'side', prerequisites: { missions: ['main-b'] } }),
  ];
  const side = roster[3]!;

  it('keeps a side quest cold while its giver still has mainline work', () => {
    const director = new StoryDirector();
    director.tickSideQuests(1, roster, new Set(['main-a']));
    expect(director.sideQuestReady(side)).toBe(false);
  });

  it('lights the side only SIDE_QUEST_DELAY_S of played time after the mainline exhausts', () => {
    const director = new StoryDirector();
    const completed = new Set(['main-a', 'main-b']);
    director.tickSideQuests(1, roster, completed); // the stamp lands, no time served yet
    expect(director.sideQuestReady(side)).toBe(false);
    director.tickSideQuests(SIDE_QUEST_DELAY_S - 2, roster, completed);
    expect(director.sideQuestReady(side)).toBe(false);
    director.tickSideQuests(2, roster, completed);
    expect(director.sideQuestReady(side)).toBe(true);
    // the other contact's mainline being incomplete never mattered — the gate is per-giver
    expect(completed.has('other')).toBe(false);
  });

  it('a reload mid-wait resumes the clock — never resets it, never skips it', () => {
    const director = new StoryDirector();
    const completed = new Set(['main-a', 'main-b']);
    director.tickSideQuests(1, roster, completed);
    director.tickSideQuests(SIDE_QUEST_DELAY_S / 2, roster, completed);
    const reloaded = new StoryDirector();
    reloaded.restore([], [], director.serializeSideWaits());
    expect(reloaded.sideQuestReady(side)).toBe(false); // did not skip
    reloaded.tickSideQuests(SIDE_QUEST_DELAY_S / 2, roster, completed);
    expect(reloaded.sideQuestReady(side)).toBe(true); // did not reset
  });

  it('mainline missions are never delayed, and a fresh game re-arms a spent wait', () => {
    const director = new StoryDirector();
    expect(director.sideQuestReady(roster[1]!)).toBe(true);
    const completed = new Set(['main-a', 'main-b']);
    director.tickSideQuests(1, roster, completed); // stamp lands first…
    director.tickSideQuests(SIDE_QUEST_DELAY_S + 1, roster, completed); // …then time serves
    expect(director.sideQuestReady(side)).toBe(true);
    director.tickSideQuests(1, roster, new Set()); // new game: the giver's mainline is pending again
    expect(director.sideQuestReady(side)).toBe(false);
  });

  it('serialize floors negatives to zero and restore drops junk', () => {
    const director = new StoryDirector();
    director.restore([], [], { 'side-a': -12, junk: Number.NaN });
    expect(director.sideQuestReady(side)).toBe(true); // -12 means the wait was already served
    expect(director.serializeSideWaits()).toEqual({ 'side-a': 0 });
  });
});
