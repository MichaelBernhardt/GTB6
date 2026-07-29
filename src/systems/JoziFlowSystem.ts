import type { VehicleKind } from '../config';
import type { FeatureHudEntry } from '../features/types';

/**
 * The tiny structural slice Jozi Flow needs from a vehicle. Keeping the scorer independent of the
 * heavyweight Vehicle class makes the geometry deterministic in tests and keeps this system honest:
 * it observes traffic, but never owns or mutates it.
 */
export interface FlowVehicle {
  readonly group: { readonly position: { x: number; y: number; z: number } };
  readonly spec: { readonly kind: VehicleKind; readonly size: readonly [number, number, number] };
  readonly heading: number;
  readonly speed: number;
  readonly disabled: boolean;
  readonly wrecked: boolean;
}

export interface NearMissProbe {
  /** Other vehicle in the driver's local frame. Positive is still ahead. */
  readonly ahead: number;
  readonly side: number;
  readonly centreGap: number;
  readonly visualClearance: number;
  readonly relativeSpeed: number;
  readonly directionDot: number;
  readonly playerSpeed: number;
  readonly heightGap: number;
}

export type JoziFlowEvent =
  | { readonly kind: 'near-miss'; readonly label: string; readonly award: number; readonly combo: number; readonly pot: number }
  | { readonly kind: 'bank'; readonly amount: number; readonly combo: number; readonly personalBest: boolean }
  | { readonly kind: 'lost'; readonly amount: number; readonly reason: string };

export const FLOW_MIN_SPEED = 16;
export const FLOW_MIN_CENTRE_GAP = 3.25;
export const FLOW_MAX_CENTRE_GAP = 5.2;
export const FLOW_COMBO_SECONDS = 4.5;
const FLOW_PASS_COOLDOWN = 12;
const FLOW_MAX_COMBO = 8;
const FLOW_MAX_HEIGHT_GAP = 2.4;
const FLOW_SCAN_DISTANCE_SQ = 7 * 7;

/** Half of an oriented rectangle projected onto an arbitrary horizontal axis. */
function projectedHalfExtent(vehicle: FlowVehicle, axisX: number, axisZ: number): number {
  const forwardX = Math.sin(vehicle.heading); const forwardZ = Math.cos(vehicle.heading);
  const rightX = Math.cos(vehicle.heading); const rightZ = -Math.sin(vehicle.heading);
  const halfWidth = vehicle.spec.size[0] / 2; const halfLength = vehicle.spec.size[2] / 2;
  return Math.abs(forwardX * axisX + forwardZ * axisZ) * halfLength
    + Math.abs(rightX * axisX + rightZ * axisZ) * halfWidth;
}

/** Exact local-frame sample used by both the live scorer and its geometry tests. */
export function nearMissProbe(driver: FlowVehicle, other: FlowVehicle): NearMissProbe {
  const dx = other.group.position.x - driver.group.position.x;
  const dz = other.group.position.z - driver.group.position.z;
  const forwardX = Math.sin(driver.heading); const forwardZ = Math.cos(driver.heading);
  const rightX = Math.cos(driver.heading); const rightZ = -Math.sin(driver.heading);
  const ahead = dx * forwardX + dz * forwardZ;
  const side = dx * rightX + dz * rightZ;
  const ownSide = driver.spec.size[0] / 2;
  const otherSide = projectedHalfExtent(other, rightX, rightZ);
  const otherForwardX = Math.sin(other.heading); const otherForwardZ = Math.cos(other.heading);
  const driverVx = forwardX * driver.speed; const driverVz = forwardZ * driver.speed;
  const otherVx = otherForwardX * other.speed; const otherVz = otherForwardZ * other.speed;
  return {
    ahead,
    side,
    centreGap: Math.abs(side),
    visualClearance: Math.abs(side) - ownSide - otherSide,
    relativeSpeed: Math.hypot(driverVx - otherVx, driverVz - otherVz),
    directionDot: forwardX * otherForwardX + forwardZ * otherForwardZ,
    playerSpeed: driver.speed,
    heightGap: Math.abs(other.group.position.y - driver.group.position.y),
  };
}

/** A pass only scores as the player moves from behind to ahead, through a close but non-contact gap. */
export function scorableNearMiss(previousAhead: number | undefined, probe: NearMissProbe, dt: number): boolean {
  if (previousAhead === undefined || previousAhead <= 0 || probe.ahead > 0 || dt <= 0) return false;
  const passSpeed = (previousAhead - probe.ahead) / dt;
  return probe.playerSpeed >= FLOW_MIN_SPEED
    && passSpeed >= 4
    && probe.relativeSpeed >= 4
    && probe.centreGap >= FLOW_MIN_CENTRE_GAP
    && probe.centreGap <= FLOW_MAX_CENTRE_GAP
    && probe.heightGap <= FLOW_MAX_HEIGHT_GAP;
}

export function nearMissLabel(driver: FlowVehicle, other: FlowVehicle, probe: NearMissProbe, wantedLevel: number): string {
  if (wantedLevel >= 3) return 'BLUE-LIGHT NEEDLE';
  if (other.spec.kind === 'taxi') return 'QUANTUM SQUEEZE';
  if (other.spec.kind === 'police') return 'JMPD PAPERWORK';
  if (driver.spec.kind === 'bicycle' || driver.spec.kind === 'motorbike' || driver.spec.kind === 'courier' || driver.spec.kind === 'superbike') return 'LANE-SPLIT';
  if (other.spec.kind === 'van') return 'BAKKIE BRUSH';
  if (probe.directionDot < -0.35) return 'WRONG-SIDE SPECIAL';
  if (probe.centreGap < 3.65) return 'MIRROR TAX';
  return 'JOZI GAP';
}

/** Cash is danger-weighted, then gently multiplied by the chain. It cannot explode the economy. */
export function nearMissAward(probe: NearMissProbe, wantedLevel: number, combo: number): number {
  const closeness = 1 - Math.min(1, Math.max(0, (probe.centreGap - FLOW_MIN_CENTRE_GAP) / (FLOW_MAX_CENTRE_GAP - FLOW_MIN_CENTRE_GAP)));
  const oncoming = probe.directionDot < -0.35 ? 10 : 0;
  const base = 14 + probe.playerSpeed * 0.62 + probe.relativeSpeed * 0.34 + closeness * 22 + oncoming + wantedLevel * 7;
  const chained = base * (1 + Math.max(0, combo - 1) * 0.22);
  return Math.max(25, Math.round(chained / 5) * 5);
}

/**
 * Free-roam risk/reward with no scene objects and no draw calls. The common frame does scalar
 * broad-phase work only; a NearMissProbe is allocated solely when a car actually crosses beside the
 * player. WeakMaps let lifecycle-despawned traffic disappear without a bookkeeping leak.
 */
export class JoziFlowSystem {
  private driver?: FlowVehicle;
  private previousAhead = new WeakMap<FlowVehicle, number>();
  private scoredAt = new WeakMap<FlowVehicle, number>();
  private elapsed = 0;
  private pot = 0;
  private combo = 0;
  private comboRemaining = 0;
  bestBank: number;

  constructor(bestBank = 0) {
    this.bestBank = Number.isFinite(bestBank) && bestBank > 0 ? Math.round(bestBank) : 0;
  }

  update(
    dt: number,
    driver: FlowVehicle | undefined,
    traffic: readonly FlowVehicle[],
    police: readonly FlowVehicle[],
    enabled: boolean,
    wantedLevel: number,
  ): JoziFlowEvent[] | undefined {
    this.elapsed += dt;
    let events: JoziFlowEvent[] | undefined;
    if (this.pot > 0) {
      this.comboRemaining -= dt;
      if (this.comboRemaining <= 0) {
        const amount = this.pot; const combo = this.combo;
        const personalBest = amount > this.bestBank;
        if (personalBest) this.bestBank = amount;
        this.clearChain();
        events = [{ kind: 'bank', amount, combo, personalBest }];
      }
    }

    if (driver !== this.driver) {
      this.driver = driver;
      this.previousAhead = new WeakMap();
    }
    if (!driver || driver.disabled || driver.wrecked) return events;

    const scan = (other: FlowVehicle): void => {
      if (other === driver || other.disabled || other.wrecked) return;
      const dx = other.group.position.x - driver.group.position.x;
      const dz = other.group.position.z - driver.group.position.z;
      const ahead = dx * Math.sin(driver.heading) + dz * Math.cos(driver.heading);
      const previous = this.previousAhead.get(other);
      this.previousAhead.set(other, ahead);
      // The sign-crossing is the event. Everything else stays allocation-free, including the vast
      // majority of traffic that is nowhere near the player's doors.
      if (!enabled || previous === undefined || previous <= 0 || ahead > 0 || dx * dx + dz * dz > FLOW_SCAN_DISTANCE_SQ) return;
      if (this.elapsed - (this.scoredAt.get(other) ?? -Infinity) < FLOW_PASS_COOLDOWN) return;
      const probe = nearMissProbe(driver, other);
      if (!scorableNearMiss(previous, probe, dt)) return;
      this.scoredAt.set(other, this.elapsed);
      this.combo = Math.min(FLOW_MAX_COMBO, this.combo + 1);
      const award = nearMissAward(probe, Math.max(0, wantedLevel), this.combo);
      this.pot += award; this.comboRemaining = FLOW_COMBO_SECONDS;
      const event: JoziFlowEvent = {
        kind: 'near-miss',
        label: nearMissLabel(driver, other, probe, wantedLevel),
        award,
        combo: this.combo,
        pot: this.pot,
      };
      (events ??= []).push(event);
    };
    for (const vehicle of traffic) scan(vehicle);
    for (const vehicle of police) scan(vehicle);
    return events;
  }

  fail(reason: string): JoziFlowEvent | undefined {
    if (this.pot <= 0) return undefined;
    const amount = this.pot;
    this.clearChain();
    return { kind: 'lost', amount, reason };
  }

  hud(): FeatureHudEntry | undefined {
    if (this.pot <= 0) return undefined;
    return {
      id: 'jozi-flow',
      label: 'JOZI FLOW',
      value: `×${this.combo} · R${this.pot}`,
      fill: this.comboRemaining / FLOW_COMBO_SECONDS * 100,
    };
  }

  reset(bestBank = this.bestBank): void {
    this.driver = undefined;
    this.previousAhead = new WeakMap();
    this.scoredAt = new WeakMap();
    this.elapsed = 0;
    this.clearChain();
    this.bestBank = Number.isFinite(bestBank) && bestBank > 0 ? Math.round(bestBank) : 0;
  }

  private clearChain(): void {
    this.pot = 0; this.combo = 0; this.comboRemaining = 0;
  }
}
