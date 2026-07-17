import type { GameSnapshot, WorldTarget } from '../types';
import { MISSIONS } from '../story/missions';

export type ObjectiveKind = 'reach' | 'enter-kind' | 'checkpoints' | 'lose-wanted' | 'defeat' | 'collect' | 'escape' | 'choice' | 'follow' | 'survive';
export interface MissionChoice { id: string; label: string; detail: string; reward: number; }

/** Extra predicates ANDed into an objective's completion check. Absent field = don't care. */
export interface ObjectiveConditions {
  onTrain?: boolean;
  drivingTrain?: boolean;
  inPlane?: boolean;
  onFoot?: boolean; // not in a vehicle, train, or plane
  parachuted?: boolean;
  atNight?: boolean;
  speedBelow?: number;
  altitudeAbove?: number;
  blackoutAbove?: number;
  undetected?: boolean;
  torchOff?: boolean;
  stationName?: string;
}

/** Per-objective failure triggers, checked every frame before completion. */
export type FailCondition =
  | { kind: 'vehicle-health-below'; value: number; reason: string }
  | { kind: 'detected'; reason: string }
  | { kind: 'wanted-above'; value: number; reason: string }
  | { kind: 'escort-down'; reason: string }
  | { kind: 'strayed'; value: number; reason: string };

export interface MissionObjective {
  text: string;
  kind: ObjectiveKind;
  target?: WorldTarget;
  vehicleKind?: string;
  vehicleColor?: number;
  required?: number;
  /** Countdown: expiry fails the objective — except `survive`, where outlasting it IS the objective. */
  timeLimit?: number;
  choices?: MissionChoice[];
  conditions?: ObjectiveConditions;
  failIf?: FailCondition[];
  /** Reach radius override (default 8; escapes 12; hidden riddles 20). Sky objectives need hundreds. */
  radius?: number;
  /** Riddle objectives: no blip, no breadcrumb — the text is the only guide. */
  hidden?: boolean;
  /** The conditions ARE the objective: a target (if any) is just the blip, not a reach check. */
  conditionsOnly?: boolean;
  /** Restarting a failed mission resumes from the latest reached objective marked as a checkpoint. */
  checkpoint?: boolean;
}

export interface MissionPrerequisites { missions?: string[]; flags?: string[]; }
export interface MissionDefinition {
  id: string;
  name: string;
  contact: string;
  intro: string;
  reward: number;
  start: WorldTarget;
  objectives: MissionObjective[];
  act?: string;
  prerequisites?: MissionPrerequisites;
  /** Story flags raised when the mission completes (or when a choice objective resolves: `flag:choiceId`). */
  setFlags?: string[];
}
export type MissionState = 'available' | 'active' | 'failed' | 'complete';

export { MISSIONS };

/** A mission's contact only appears once every prerequisite mission is done and every flag is raised. */
export function missionUnlocked(mission: MissionDefinition, completed: ReadonlySet<string>, flags: ReadonlySet<string>): boolean {
  return (mission.prerequisites?.missions ?? []).every((id) => completed.has(id))
    && (mission.prerequisites?.flags ?? []).every((flag) => flags.has(flag));
}

function conditionsMet(conditions: ObjectiveConditions | undefined, snapshot: GameSnapshot): boolean {
  if (!conditions) return true;
  if (conditions.onTrain !== undefined && Boolean(snapshot.onTrain) !== conditions.onTrain) return false;
  if (conditions.drivingTrain !== undefined && Boolean(snapshot.drivingTrain) !== conditions.drivingTrain) return false;
  if (conditions.inPlane !== undefined && Boolean(snapshot.inPlane) !== conditions.inPlane) return false;
  if (conditions.onFoot && (snapshot.inVehicle || snapshot.onTrain || snapshot.inPlane)) return false;
  if (conditions.parachuted !== undefined && Boolean(snapshot.parachuted) !== conditions.parachuted) return false;
  if (conditions.atNight !== undefined && Boolean(snapshot.isNight) !== conditions.atNight) return false;
  if (conditions.speedBelow !== undefined && (snapshot.playerSpeed ?? Infinity) >= conditions.speedBelow) return false;
  if (conditions.altitudeAbove !== undefined && (snapshot.altitude ?? 0) < conditions.altitudeAbove) return false;
  if (conditions.blackoutAbove !== undefined && (snapshot.blackout ?? 0) < conditions.blackoutAbove) return false;
  if (conditions.undetected && snapshot.detected) return false;
  if (conditions.torchOff && snapshot.torchOn) return false;
  if (conditions.stationName !== undefined && snapshot.stationName !== conditions.stationName) return false;
  return true;
}

function failedBy(objective: MissionObjective, snapshot: GameSnapshot): string | undefined {
  for (const rule of objective.failIf ?? []) {
    switch (rule.kind) {
      case 'vehicle-health-below': if ((snapshot.vehicleHealthPct ?? 1) < rule.value) return rule.reason; break;
      case 'detected': if (snapshot.detected) return rule.reason; break;
      case 'wanted-above': if (snapshot.wantedLevel > rule.value) return rule.reason; break;
      case 'escort-down': if (snapshot.escortAlive === false) return rule.reason; break;
      case 'strayed': if ((snapshot.followDistance ?? 0) > rule.value) return rule.reason; break;
    }
  }
  return undefined;
}

export interface MissionChoiceResult { missionId: string; choice: MissionChoice; }
export interface MissionUpdate { advanced?: boolean; completed?: MissionDefinition; failed?: string; choice?: MissionChoiceResult; }

export class MissionSystem {
  active?: MissionDefinition;
  objectiveIndex = 0;
  progress = 0;
  remainingTime = 0;
  completed = new Set<string>();
  state: MissionState = 'available';
  /** Why the mission failed — retained for the persistent HUD failure card until restart. */
  failReason?: string;
  /** Objective index a failed-mission restart resumes from (latest reached `checkpoint: true`). */
  checkpointIndex = 0;

  constructor(readonly missions: MissionDefinition[] = MISSIONS) {}

  get objective(): MissionObjective | undefined { return this.active?.objectives[this.objectiveIndex]; }

  start(id: string): boolean {
    const mission = this.missions.find((item) => item.id === id);
    if (!mission || this.active) return false;
    this.active = mission; this.objectiveIndex = 0; this.progress = 0; this.state = 'active'; this.checkpointIndex = 0; this.failReason = undefined;
    this.remainingTime = mission.objectives[0]?.timeLimit ?? 0;
    return true;
  }

  restart(): boolean {
    if (!this.active || this.state !== 'failed') return false;
    this.objectiveIndex = this.checkpointIndex; this.progress = 0; this.state = 'active'; this.failReason = undefined;
    this.remainingTime = this.objective?.timeLimit ?? 0;
    return true;
  }

  /** Console/testing: arm mission #index (1-based, catalogue order) unconditionally — abandons any
   *  active mission and un-completes the target so it can be replayed and iterated on. */
  forceStart(index: number): MissionDefinition | undefined {
    const mission = this.missions[index - 1];
    if (!mission) return undefined;
    this.active = undefined; this.state = 'available'; this.completed.delete(mission.id);
    return this.start(mission.id) ? mission : undefined;
  }

  fail(reason: string): MissionUpdate { this.state = 'failed'; this.failReason = reason; return { failed: reason }; }

  update(dt: number, snapshot: GameSnapshot, reachedTarget: boolean): MissionUpdate {
    const objective = this.objective;
    if (!this.active || !objective || this.state !== 'active') return {};
    const failure = failedBy(objective, snapshot);
    if (failure) return this.fail(failure);
    if (this.remainingTime > 0) {
      this.remainingTime -= dt;
      if (this.remainingTime <= 0) return objective.kind === 'survive' ? this.advance() : this.fail('Time expired');
    }
    let done = false;
    switch (objective.kind) {
      case 'reach': case 'escape': done = (objective.conditionsOnly ? true : reachedTarget) && (!objective.vehicleKind || (snapshot.inVehicle && snapshot.vehicleKind === objective.vehicleKind && (!objective.vehicleColor || snapshot.vehicleColor === objective.vehicleColor))); break;
      case 'enter-kind': done = snapshot.inVehicle && snapshot.vehicleKind === objective.vehicleKind && (!objective.vehicleColor || snapshot.vehicleColor === objective.vehicleColor); break;
      case 'lose-wanted': done = snapshot.wantedLevel === 0; break;
      case 'defeat': this.progress = snapshot.hostileDefeated; done = this.progress >= (objective.required ?? 1); break;
      case 'collect': done = snapshot.collectedItem && reachedTarget; break;
      case 'checkpoints': done = this.progress >= (objective.required ?? 1); break;
      case 'follow': done = snapshot.followArrived === true; break;
      case 'survive': done = false; break; // completes only by outlasting timeLimit above
      case 'choice': done = false; break;
    }
    if (!done || !conditionsMet(objective.conditions, snapshot)) return {};
    return this.advance();
  }

  registerCheckpoint(): MissionUpdate {
    if (this.objective?.kind !== 'checkpoints' || this.state !== 'active') return {};
    this.progress += 1;
    return this.progress >= (this.objective.required ?? 1) ? this.advance() : { advanced: true };
  }

  choose(id: string): MissionUpdate {
    const objective = this.objective;
    if (!this.active || this.state !== 'active' || objective?.kind !== 'choice') return {};
    const choice = objective.choices?.find((option) => option.id === id);
    if (!choice) return {};
    const missionId = this.active.id; const update = this.advance();
    return { ...update, choice: { missionId, choice } };
  }

  private advance(): MissionUpdate {
    if (!this.active) return {};
    this.objectiveIndex += 1; this.progress = 0;
    if (this.objectiveIndex >= this.active.objectives.length) {
      const completed = this.active; this.completed.add(completed.id); this.state = 'complete'; this.active = undefined;
      return { completed };
    }
    if (this.objective?.checkpoint) this.checkpointIndex = this.objectiveIndex;
    this.remainingTime = this.objective?.timeLimit ?? 0;
    return { advanced: true };
  }
}
