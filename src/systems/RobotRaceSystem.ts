export interface RobotJunction {
  x: number;
  z: number;
  roadA?: string;
  roadB?: string;
}

export interface RacePoint {
  x: number;
  z: number;
  label: string;
}

export interface RobotCircuit {
  start: RacePoint;
  checkpoints: RacePoint[];
}

export type RaceTier = 'gold' | 'silver' | 'finished';
export interface RaceFinish {
  elapsed: number;
  tier: RaceTier;
  base: number;
  cleanBonus: number;
  total: number;
  personalBest: boolean;
  bestTime: number;
}

export interface RaceUpdate {
  checkpoint?: number;
  finished?: RaceFinish;
  failed?: string;
}

export const ROBOT_RACE_RADIUS = 22;
export const ROBOT_RACE_GOLD_SECONDS = 200;
export const ROBOT_RACE_SILVER_SECONDS = 260;
export const ROBOT_RACE_CLEAN_LOSS = 0.08;
export const ROBOT_RACE_REWARDS: Record<RaceTier, number> = { gold: 2400, silver: 1600, finished: 900 };
export const ROBOT_RACE_CLEAN_BONUS = 350;

/** A broad clockwise CBD loop: central start, north, east, south, west, then back to the start.
 * The nearest real signalised junction to each offset wins, so regenerated maps retain the shape
 * without hard-coded coordinates. */
const CIRCUIT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 60],
  [-30, -320],
  [860, -340],
  [900, 0],
  [-300, 530],
  [-670, 150],
];

function junctionLabel(junction: RobotJunction, index: number): string {
  const roads = [junction.roadA, junction.roadB].filter(Boolean).join(' / ');
  return index === 0 ? 'Robot Run start' : `Robot ${index}${roads ? ` · ${roads}` : ''}`;
}

/** Selects a deterministic, non-repeating circuit from actual robot junctions. */
export function buildRobotCircuit(junctions: readonly RobotJunction[], center: { x: number; z: number }): RobotCircuit | undefined {
  if (junctions.length < 2) return undefined;
  const remaining = new Set(junctions);
  const selected: RobotJunction[] = [];
  for (const [dx, dz] of CIRCUIT_OFFSETS) {
    let nearest: RobotJunction | undefined;
    let nearestSq = Infinity;
    for (const junction of remaining) {
      const distanceSq = (junction.x - (center.x + dx)) ** 2 + (junction.z - (center.z + dz)) ** 2;
      if (distanceSq < nearestSq) { nearest = junction; nearestSq = distanceSq; }
    }
    if (!nearest) break;
    selected.push(nearest); remaining.delete(nearest);
  }
  const startJunction = selected[0];
  if (!startJunction || selected.length < 2) return undefined;
  const start = { x: startJunction.x, z: startJunction.z, label: junctionLabel(startJunction, 0) };
  const checkpoints = selected.slice(1).map((junction, index) => ({ x: junction.x, z: junction.z, label: junctionLabel(junction, index + 1) }));
  checkpoints.push({ ...start, label: 'Finish · Robot Run start' });
  return { start, checkpoints };
}

export function raceTier(elapsed: number): RaceTier {
  if (elapsed <= ROBOT_RACE_GOLD_SECONDS) return 'gold';
  if (elapsed <= ROBOT_RACE_SILVER_SECONDS) return 'silver';
  return 'finished';
}

export function racePace(elapsed: number): { label: 'GOLD' | 'SILVER' | 'FINISH'; remaining?: number } {
  if (elapsed < ROBOT_RACE_GOLD_SECONDS) return { label: 'GOLD', remaining: ROBOT_RACE_GOLD_SECONDS - elapsed };
  if (elapsed < ROBOT_RACE_SILVER_SECONDS) return { label: 'SILVER', remaining: ROBOT_RACE_SILVER_SECONDS - elapsed };
  return { label: 'FINISH' };
}

/** Pure repeatable time trial. Game owns world markers/economy; this class owns only timing,
 * checkpoint order, vehicle-condition scoring and the in-session personal best. */
export class RobotRace {
  active = false;
  checkpointIndex = 0;
  elapsed = 0;
  bestTime?: number;
  private startingHealth = 1;

  constructor(readonly circuit: RobotCircuit) {}

  get target(): RacePoint { return this.active ? this.circuit.checkpoints[this.checkpointIndex] ?? this.circuit.start : this.circuit.start; }
  get progress(): number { return this.checkpointIndex; }
  get required(): number { return this.circuit.checkpoints.length; }

  start(vehicleHealthFraction: number): boolean {
    if (this.active || !Number.isFinite(vehicleHealthFraction) || vehicleHealthFraction <= 0) return false;
    this.active = true;
    this.checkpointIndex = 0;
    this.elapsed = 0;
    this.startingHealth = Math.max(0, Math.min(1, vehicleHealthFraction));
    return true;
  }

  update(dt: number, position: { x: number; z: number }, vehicleHealthFraction: number): RaceUpdate {
    if (!this.active) return {};
    if (!Number.isFinite(vehicleHealthFraction) || vehicleHealthFraction <= 0) return this.fail('Your ride is finished before the race is.');
    this.elapsed += Math.max(0, dt);
    const target = this.target;
    if ((target.x - position.x) ** 2 + (target.z - position.z) ** 2 > ROBOT_RACE_RADIUS ** 2) return {};
    this.checkpointIndex += 1;
    if (this.checkpointIndex < this.circuit.checkpoints.length) return { checkpoint: this.checkpointIndex };

    const elapsed = this.elapsed;
    const tier = raceTier(elapsed);
    const base = ROBOT_RACE_REWARDS[tier];
    const cleanBonus = this.startingHealth - Math.max(0, Math.min(1, vehicleHealthFraction)) <= ROBOT_RACE_CLEAN_LOSS
      ? ROBOT_RACE_CLEAN_BONUS : 0;
    const personalBest = this.bestTime === undefined || elapsed < this.bestTime;
    if (personalBest) this.bestTime = elapsed;
    const finish = { elapsed, tier, base, cleanBonus, total: base + cleanBonus, personalBest, bestTime: this.bestTime ?? elapsed };
    this.reset();
    return { finished: finish };
  }

  fail(reason: string): RaceUpdate {
    if (!this.active) return {};
    this.reset();
    return { failed: reason };
  }

  private reset(): void {
    this.active = false;
    this.checkpointIndex = 0;
    this.elapsed = 0;
    this.startingHealth = 1;
  }
}
