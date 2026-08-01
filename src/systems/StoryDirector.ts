import { missionUnlocked, type MissionDefinition } from './MissionSystem';

/** Flag raised automatically when a `choice` objective resolves: `choice:<missionId>:<choiceId>`. */
export const choiceFlag = (missionId: string, choiceId: string): string => `choice:${missionId}:${choiceId}`;

export const DIARY_PAGE_COUNT = 12;

/** How long a side quest stays dark after its giver's last mainline mission completes (played-time
 *  seconds, counted on the sim clock — never wall time). Owner: "don't offer it immediately if you
 *  just finished a task at the person... it will unlock a few minutes of realtime later." */
export const SIDE_QUEST_DELAY_S = 180;

/**
 * Story bookkeeping above the mission engine: persistent flags, unlock gating,
 * the offered-mission handshake (intro dialogue must finish before a mission arms),
 * and the Grid Diary collectible registry. Pure — Game.ts only wires inputs/outputs.
 */
export class StoryDirector {
  flags = new Set<string>();
  diaryPages = new Set<number>();
  /** Mission whose intro dialogue is currently playing; armed only when the dialogue finishes. */
  pendingOffer?: string;
  /** Side-quest cooldowns: missionId → played-time seconds REMAINING before it lights up and
   *  offers (≤ 0 means ready). Stamped when the giver's mainline exhausts, counted down on the
   *  sim clock, persisted so a reload resumes the wait instead of resetting or skipping it. */
  private sideQuestWaits = new Map<string, number>();

  restore(flags: readonly string[], pages: readonly number[], sideWaits: Readonly<Record<string, number>> = {}): void {
    this.flags = new Set(flags);
    this.diaryPages = new Set(pages.filter((page) => Number.isInteger(page) && page >= 1 && page <= DIARY_PAGE_COUNT));
    this.pendingOffer = undefined;
    this.sideQuestWaits = new Map(Object.entries(sideWaits).filter(([, left]) => Number.isFinite(left)));
  }

  serializeFlags(): string[] { return [...this.flags].sort(); }
  serializeDiaryPages(): number[] { return [...this.diaryPages].sort((a, b) => a - b); }
  serializeSideWaits(): Record<string, number> {
    return Object.fromEntries([...this.sideQuestWaits].map(([id, left]) => [id, Math.max(0, left)]));
  }

  /** Advance the side-quest cooldowns by `dt` of played time. A side whose giver still has mainline
   *  work keeps NO stamp (a fresh game that un-completes the mainline re-arms the wait); the stamp
   *  lands the tick the giver's last mainline mission is complete and counts down from there. */
  tickSideQuests(dt: number, missions: readonly MissionDefinition[], completed: ReadonlySet<string>): void {
    for (const mission of missions) {
      if (mission.act !== 'side' || completed.has(mission.id)) continue;
      const mainlineDone = missions.every((other) =>
        other.act === 'side' || other.contact !== mission.contact || completed.has(other.id));
      if (!mainlineDone) { this.sideQuestWaits.delete(mission.id); continue; }
      const left = this.sideQuestWaits.get(mission.id);
      if (left === undefined) this.sideQuestWaits.set(mission.id, SIDE_QUEST_DELAY_S);
      else if (left > 0) this.sideQuestWaits.set(mission.id, Math.max(0, left - dt));
    }
  }

  /** Is this mission allowed to light its beam and offer? Mainline always; a side only once its
   *  post-mainline wait has fully run out. A cooling side has no beam and no offer — E at its giver
   *  does nothing mission-wise (never a prompt that declines). */
  sideQuestReady(mission: MissionDefinition): boolean {
    if (mission.act !== 'side') return true;
    const left = this.sideQuestWaits.get(mission.id);
    return left !== undefined && left <= 0;
  }

  /** Raise a flag; true if it was new. */
  raise(flag: string): boolean {
    if (this.flags.has(flag)) return false;
    this.flags.add(flag);
    return true;
  }

  unlocked(missions: readonly MissionDefinition[], completed: ReadonlySet<string>): MissionDefinition[] {
    return missions.filter((mission) => !completed.has(mission.id) && missionUnlocked(mission, completed, this.flags));
  }

  isUnlocked(mission: MissionDefinition, completed: ReadonlySet<string>): boolean {
    return missionUnlocked(mission, completed, this.flags);
  }

  /** Contact interaction begins an offer; the mission only starts when its intro dialogue finishes. */
  beginOffer(missionId: string): void { this.pendingOffer = missionId; }
  /** Dialogue finished: the offer converts into the armed mission (returns its id). */
  acceptOffer(): string | undefined { const id = this.pendingOffer; this.pendingOffer = undefined; return id; }
  /** Player walked away mid-intro: no mission. */
  abandonOffer(): void { this.pendingOffer = undefined; }

  /** Completion raises the mission's flags; returns the newly-raised ones (for toasts/tests). */
  onMissionCompleted(mission: MissionDefinition): string[] {
    return (mission.setFlags ?? []).filter((flag) => this.raise(flag));
  }

  onChoice(missionId: string, choiceId: string): string {
    const flag = choiceFlag(missionId, choiceId);
    this.raise(flag);
    return flag;
  }

  /** Testing/console (`mission <n>`): satisfy every prerequisite of `mission` — transitively
   *  complete prerequisite missions (raising their setFlags) and raise required flags directly,
   *  so a jump-start works cold from a fresh save exactly as natural progression would allow. */
  synthesizePrerequisites(mission: MissionDefinition, missions: readonly MissionDefinition[], completed: Set<string>): void {
    const need = [...(mission.prerequisites?.missions ?? [])];
    while (need.length) {
      const id = need.pop()!;
      if (completed.has(id)) continue;
      completed.add(id);
      const entry = missions.find((item) => item.id === id);
      for (const flag of entry?.setFlags ?? []) this.raise(flag);
      need.push(...(entry?.prerequisites?.missions ?? []));
    }
    for (const flag of mission.prerequisites?.flags ?? []) this.raise(flag);
  }

  /** Pick up a diary page; true if it was new. */
  collectDiaryPage(page: number): boolean {
    if (!Number.isInteger(page) || page < 1 || page > DIARY_PAGE_COUNT || this.diaryPages.has(page)) return false;
    this.diaryPages.add(page);
    return true;
  }

  get diaryComplete(): boolean { return this.diaryPages.size >= DIARY_PAGE_COUNT; }
}
