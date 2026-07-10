import type { NavPoint } from './NavGraph';

/** Seconds between a civilian witnessing a crime and SCPD dispatch hearing about it. Tune freely. */
export const REPORT_DELAY = 30;
/** A sighting means the player is this close to an active unit (with line of sight). */
export const SIGHT_RADIUS = 55;
/** Default earshot for civilian witnesses when a crime has no fear broadcast to borrow a radius from. */
export const WITNESS_RADIUS = 40;
/** Roam destinations are picked within this range of the last known position once the trail runs cold. */
export const ROAM_RADIUS = 60;
/** A unit this close to the last known position without a sighting has arrived on scene. */
export const ARRIVE_RADIUS = 15;
/** Seconds a unit lingers at a cold last-known position before switching to roam. */
export const ARRIVE_DWELL = 3;

export interface KnownPosition { x: number; z: number; time: number; }
export interface CrimeReport<R = unknown> { x: number; z: number; heat: number; maturesAt: number; reporter?: R; }
export interface WitnessCandidate<T = unknown> { ref: T; x: number; z: number; alive: boolean; victim?: boolean; }

/** Picks who phones in a crime from live state at crime time: a surviving victim reports the attack
 *  themselves, otherwise the nearest living non-victim within radius. The dead can't call anyone. */
export function determineReporter<T>(crimeX: number, crimeZ: number, candidates: readonly WitnessCandidate<T>[], radius = WITNESS_RADIUS): T | undefined {
  const survivor = candidates.find((candidate) => candidate.victim && candidate.alive);
  if (survivor) return survivor.ref;
  let best: WitnessCandidate<T> | undefined; let bestSq = radius * radius;
  for (const candidate of candidates) {
    if (candidate.victim || !candidate.alive) continue;
    const distanceSq = (candidate.x - crimeX) ** 2 + (candidate.z - crimeZ) ** 2;
    if (distanceSq <= bestSq) { best = candidate; bestSq = distanceSq; }
  }
  return best?.ref;
}

/** Random nav node within radius of the last known position; falls back to the nearest node so a sparse
 *  graph still yields a roam destination. Returns -1 only on an empty graph. */
export function pickRoamGoal(nodes: readonly NavPoint[], center: { x: number; z: number }, radius = ROAM_RADIUS, random: () => number = Math.random): number {
  const candidates: number[] = []; let nearest = -1; let nearestSq = Infinity;
  const radiusSq = radius * radius;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]; if (!node) continue;
    const distanceSq = (node.x - center.x) ** 2 + (node.z - center.z) ** 2;
    if (distanceSq <= radiusSq) candidates.push(index);
    if (distanceSq < nearestSq) { nearestSq = distanceSq; nearest = index; }
  }
  return candidates.length ? candidates[Math.floor(random() * candidates.length)] ?? nearest : nearest;
}

/** What SCPD actually knows: the last place any officer saw the player, plus 911 reports still in the
 *  dispatch pipeline. Police plan on this state only — never on live game state. */
export class PoliceKnowledge<R = unknown> {
  lastKnown: KnownPosition | null = null;
  private reports: CrimeReport<R>[] = [];
  private now = 0;

  get pendingReports(): number { return this.reports.length; }

  /** Civilian report: matures after REPORT_DELAY, then its heat lands and lastKnown becomes the crime scene. */
  fileReport(x: number, z: number, heat: number, reporter?: R): void {
    this.reports.push({ x, z, heat, maturesAt: this.now + REPORT_DELAY, reporter });
  }

  /** Cop-witnessed crime: no dispatch lag — the officer's own eyes count as a sighting. */
  copWitness(x: number, z: number): void { this.sight(x, z); }

  /** An officer can currently see the player, so knowledge tracks the live position. */
  sight(x: number, z: number): void { this.lastKnown = { x, z, time: this.now }; }

  /** Advances the dispatch clock and returns matured reports (heat for the caller to apply) after moving
   *  lastKnown to the crime scene. Reports whose reporter died before maturing are dropped — no witness, no call. */
  update(dt: number, reporterAlive: (reporter: R) => boolean = () => true): CrimeReport<R>[] {
    this.now += dt;
    if (!this.reports.length) return [];
    const matured: CrimeReport<R>[] = [];
    this.reports = this.reports.filter((report) => {
      if (report.reporter !== undefined && !reporterAlive(report.reporter)) return false;
      if (report.maturesAt > this.now) return true;
      matured.push(report); return false;
    });
    for (const report of matured) this.lastKnown = { x: report.x, z: report.z, time: this.now };
    return matured;
  }

  reset(): void { this.lastKnown = null; this.reports = []; }
}
