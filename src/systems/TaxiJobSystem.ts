import { FLEE_THRESHOLD } from './FearSystem';
import type { NavPoint } from './NavGraph';

/** Player taxi job: calm wanderers hail an AVAILABLE cab from the curb; ride pays base fare plus a
 *  driving-quality tip. Pure fare/hail/ride logic lives here — the Game feeds it positions and events. */
export type TaxiPhase = 'idle' | 'hailed' | 'boarding' | 'riding';

export const FARE_BASE = 20; // R flag-drop
export const FARE_PER_100U = 8; // R per 100 units of A* route distance
export const TIP_RATIO = 0.25; // starting tip as a share of the fare…
export const TIP_MIN = 5; // …clamped to a polite floor
export const TIP_CAP = 40; // …and a generous ceiling
export const HAIL_RADIUS = 34; // peds this close to an available cab stick an arm out
export const REHAIL_COOLDOWN = 3; // beat between fares so a fresh drop-off doesn't instantly re-hail you
export const PICKUP_RADIUS = 6; // stop within this range of the hailer to start the pickup
export const BOARD_RADIUS = 2.6; // hailer reaches the door and climbs in
export const ABANDON_RADIUS = 15; // drive off further than this mid-pickup and the fare gives up
export const ARRIVE_RADIUS = 8;
export const STOP_SPEED = 1; // "stopped" for pickup/drop-off purposes
export const MIN_TRIP_DISTANCE = 110; // trips shorter than this are not worth the meter
export const SPEEDING_SPEED = 26; // u/s (~94 km/h); above this the tip drains
export const TIP_SPEED_DRAIN = 3; // R per second of speeding
export const CRASH_TIP_DIVISOR = 4; // crash tip penalty = impact / divisor (R)
export const BAIL_IMPACT = 20; // one hit this hard and the passenger is out
export const BAIL_FEAR = 60; // accumulated gunfire/violence fear that triggers a bail
export const GUNFIRE_FEAR_RADIUS = 40; // crimes this close to the cab frighten the passenger
export const GUNFIRE_FEAR_SCALE = 3; // heat -> passenger fear multiplier

export function isTaxiKind(kind: string): boolean { return kind === 'cab' || kind === 'taxi'; }

export function routeDistance(points: NavPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]; const point = points[index];
    if (previous && point) total += Math.hypot(point.x - previous.x, point.z - previous.z);
  }
  return total;
}

export function computeFare(distance: number): number { return Math.round(FARE_BASE + FARE_PER_100U * Math.max(0, distance) / 100); }
export function startingTip(fare: number): number { return Math.min(TIP_CAP, Math.max(TIP_MIN, Math.round(fare * TIP_RATIO))); }
export function crashTipPenalty(impact: number): number { return Math.max(1, Math.round(impact / CRASH_TIP_DIVISOR)); }

export interface HailCandidate { state: string; contact: boolean; hostile: boolean; police: boolean; carGuard: boolean; frozen: boolean; stumbling: boolean; fear: number; }

/** Calm civilians hail — walking with wanderlust or paused at the curb. No contacts, car guards, cops,
 *  hostiles, frightened peds, frozen far-cull agents or peds mid-stumble from a bump. */
export function canHail(ped: HailCandidate, distance: number): boolean {
  return (ped.state === 'walk' || ped.state === 'idle') && !ped.contact && !ped.hostile && !ped.police && !ped.carGuard
    && !ped.frozen && !ped.stumbling && ped.fear < FLEE_THRESHOLD && distance <= HAIL_RADIUS;
}

export function taxiHudText(phase: TaxiPhase, available: boolean, fare: number, tip: number): string {
  if (!available) return 'TAXI · OCCUPIED';
  if (phase === 'riding') return `FARE R${fare} · TIP R${Math.max(0, Math.round(tip))}`;
  if (phase === 'hailed' || phase === 'boarding') return 'TAXI · PICKING UP';
  return 'TAXI · AVAILABLE';
}

/** Ride state machine: idle -> hailed -> boarding -> riding -> (payout | bail) -> idle. No scene types. */
export class TaxiRide {
  phase: TaxiPhase = 'idle';
  fare = 0;
  tip = 0;
  distance = 0;
  passengerFear = 0;
  bailed = false;

  hail(): boolean { if (this.phase !== 'idle') return false; this.phase = 'hailed'; return true; }
  beginBoarding(): boolean { if (this.phase !== 'hailed') return false; this.phase = 'boarding'; return true; }

  /** Passenger is in the seat: prices the meter off the planned route distance and returns the fare. */
  board(distance: number): number {
    if (this.phase !== 'boarding') return 0;
    this.phase = 'riding'; this.distance = distance; this.fare = computeFare(distance); this.tip = startingTip(this.fare);
    this.passengerFear = 0; this.bailed = false;
    return this.fare;
  }

  recordSpeeding(dt: number, speed: number): void {
    if (this.phase === 'riding' && speed > SPEEDING_SPEED) this.tip = Math.max(0, this.tip - TIP_SPEED_DRAIN * dt);
  }

  recordCrash(impact: number): void {
    if (this.phase !== 'riding') return;
    this.tip = Math.max(0, this.tip - crashTipPenalty(impact));
    if (impact >= BAIL_IMPACT) this.bailed = true;
  }

  frighten(amount: number): void {
    if (this.phase !== 'riding' || amount <= 0) return;
    this.passengerFear = Math.min(100, this.passengerFear + amount);
    if (this.passengerFear >= BAIL_FEAR) this.bailed = true;
  }

  payout(): { fare: number; tip: number; total: number } {
    const tip = Math.max(0, Math.round(this.tip));
    return { fare: this.fare, tip, total: this.fare + tip };
  }

  reset(): void { this.phase = 'idle'; this.fare = 0; this.tip = 0; this.distance = 0; this.passengerFear = 0; this.bailed = false; }
}
