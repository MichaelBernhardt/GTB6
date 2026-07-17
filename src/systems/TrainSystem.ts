import * as THREE from 'three';
import { moveSpeed } from '../core/GameRules';
import { STATIONS } from '../world/mapData';
import type { City } from '../world/City';
import { cabAt, nearestArcOnSpan, stepAboard, stepDrive } from './TrainRide';

/**
 * Passenger trains shuttling back and forth along the generated rail lines (City.railPaths).
 *
 * Purely scenic kinematics: each line ≥ MIN_LINE_LENGTH gets one Gautrain-styled consist
 * (gold flanks, dark window band, blue skirt) that accelerates out of its terminus, cruises,
 * brakes into every station along the line (mapData.STATIONS), dwells DWELL_S with the boarding
 * countdown showing, and reverses at the far end. Cars are placed independently by arc length
 * so the train articulates around curves and pitches with the relief.
 *
 * No nav-graph, no collisions, no AI — the train is landscape that moves (step off the rails).
 *
 * The player can also board a slow/stopped consist, walk its corridor while it runs (the ride
 * is a nose-offset + lateral point composed against the line pose every frame — moving-platform
 * physics without a physics engine), and take the controls from either cab. See TrainRide.ts.
 */

// ---- Pure path/shuttle math (unit-tested) ------------------------------------------------

export interface RailPoint { x: number; z: number }

/** Cumulative arc length at every path vertex (cum[0] = 0). */
export function cumulativeArc(points: RailPoint[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  }
  return cum;
}

/** Point + unit direction at arc position s (clamped to the path ends). */
export function poseAt(points: RailPoint[], cum: number[], s: number): { x: number; z: number; dirX: number; dirZ: number } {
  const total = cum[cum.length - 1]!;
  const target = Math.max(0, Math.min(total, s));
  let lo = 0; let hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid]! <= target) lo = mid; else hi = mid; }
  const a = points[lo]!; const b = points[Math.min(lo + 1, points.length - 1)]!;
  const span = cum[Math.min(lo + 1, cum.length - 1)]! - cum[lo]! || 1;
  const t = (target - cum[lo]!) / span;
  const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * t, z: a.z + dz * t, dirX: dx / len, dirZ: dz / len };
}

export interface ShuttleState {
  /** Arc position of the train NOSE along the line. */
  s: number;
  /** +1 toward the far end, -1 back toward the start. */
  direction: 1 | -1;
  /** Remaining dwell at a station stop or terminus (s of stillness). */
  dwell: number;
  speed: number;
}

export interface ShuttleParams {
  lineLength: number;
  /** Consist length: the tail must stay on the rails at the near terminus. */
  trainLength: number;
  maxSpeed: number;
  accel: number;
  dwellTime: number;
  /** Nose arc positions of intermediate station stops, sorted ascending and strictly inside
   *  (trainLength, lineLength). Omit/empty for the plain end-to-end shuttle. */
  stops?: number[];
}

/** The next stop the nose brakes for from `s` travelling `direction` — the nearest stop STRICTLY
 *  ahead, else the terminus. Arrival clamps s exactly onto the stop, so the platform being dwelt
 *  at (or just departed) is excluded by the strict comparison alone. */
export function nextStop(s: number, direction: 1 | -1, params: ShuttleParams): number {
  const EPS = 1e-6;
  let target = direction === 1 ? params.lineLength : params.trainLength;
  for (const stop of params.stops ?? []) {
    if (direction === 1) { if (stop > s + EPS && stop < target) target = stop; }
    else if (stop < s - EPS && stop > target) target = stop;
  }
  return target;
}

/**
 * Advance the shuttle: accelerate at `accel` toward `maxSpeed`, brake so speed hits ~0 at the next
 * station stop (v = sqrt(2·a·d)), dwell there, continue; reverse only at the line ends. The nose
 * runs in [trainLength, lineLength].
 */
export function advanceShuttle(state: ShuttleState, dt: number, params: ShuttleParams): ShuttleState {
  const nearEnd = params.trainLength; const farEnd = params.lineLength;
  if (state.dwell > 0) {
    const dwell = state.dwell - dt;
    if (dwell > 0) return { ...state, dwell, speed: 0 };
    // Doors closed: an intermediate stop continues the same way; a terminus turns the train around.
    const atEnd = state.direction === 1 ? state.s >= farEnd - 1e-6 : state.s <= nearEnd + 1e-6;
    return { s: state.s, direction: atEnd ? (state.direction * -1) as 1 | -1 : state.direction, dwell: 0, speed: 0 };
  }
  const target = nextStop(state.s, state.direction, params);
  const remaining = state.direction === 1 ? target - state.s : state.s - target;
  const brakeCap = Math.sqrt(Math.max(0, 2 * params.accel * remaining));
  const speed = Math.min(params.maxSpeed, state.speed + params.accel * dt, Math.max(0.6, brakeCap));
  const s = state.s + state.direction * speed * dt;
  if (state.direction === 1 ? s >= target : s <= target) {
    return { s: target, direction: state.direction, dwell: params.dwellTime, speed: 0 };
  }
  return { s, direction: state.direction, dwell: 0, speed };
}

/** Live "departs in m:ss" text for the boarding prompt (ceil, so it never reads 0:00 while held). */
export function formatCountdown(seconds: number): string {
  const t = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** Arc position on a sampled path closest to (x, z) — projects onto every segment; O(n), load-time only. */
export function nearestArc(points: RailPoint[], cum: number[], x: number, z: number): number {
  let bestS = 0; let bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) { bestD = d; bestS = cum[i - 1]! + Math.sqrt(lengthSq) * t; }
  }
  return bestS;
}

// ---- Scene-side system --------------------------------------------------------------------

/** Lines shorter than this don't get a train (the airport spur still qualifies as a shuttle). */
const MIN_LINE_LENGTH = 1200;
const MAX_TRAINS = 4; // the three metro lines + the short airport shuttle
const CAR_LENGTH = 15;
const CAR_GAP = 1.1;
const RAIL_TOP_Y = 0.32;
const MAX_SPEED = 21; // ~75 km/h at 1 u ≈ 1 m
const ACCEL = 1.35;
const DWELL_S = 30; // station + terminus dwell: matches the owner's "departs in 00:30" boarding window

const GOLD = 0xc7a13b; const NAVY = 0x24356b; const GLASS = 0x141a20; const ROOF = 0x8e949a; const SKIRT = 0x2a2f36;

// ---- Riding & driving (see TrainRide.ts for the pure math) --------------------------------
const RIDE_MARGIN = 0.8; // rider's stop short of the very nose/tail
const AISLE_HALF = 1.05; // corridor half-width inside the 3.0-wide body
const FLOOR_Y = 1.0; // car floor above the car origin (top of the underframe skirt)
const BOARD_REACH = 4.6; // from the track centreline: half a car width plus an arm's reach
const BOARD_MAX_SPEED = 3; // board a dwelling or crawling train only
const BOARD_MAX_CLIMB = 3.5; // no boarding from a bridge above or a cutting below
const CAB_ZONE = 3; // within this of either end counts as standing at the controls
const EXIT_SIDE = 3.2; // step-off distance from the centreline (clear of the body)
const TUMBLE_EXIT_SPEED = 6; // jumping off faster than this ends in a tumble
const DRIVE = { maxSpeed: 26, accel: 1.6, brake: 3.4, coast: 0.5 };

/** World-space rider placement for the frame, computed after the shuttles advance. */
export interface RiderPose { x: number; y: number; z: number; heading: number; walkSpeed: number; side: number; forward: number }

interface Ride { train: Train; s: number; lateral: number; heading: number; driving: boolean; cabSign: 1 | -1; v: number }

interface Train {
  points: RailPoint[];
  cum: number[];
  state: ShuttleState;
  cars: THREE.Group[];
  trainLength: number;
  /** Nose arc positions of the line's intermediate station stops (sorted; termini excluded). */
  stops: number[];
}

export class TrainSystem {
  private trains: Train[] = [];
  private ride?: Ride;
  private stick = { side: 0, forward: 0, yaw: 0, sprint: false };
  private riderPoseValue?: RiderPose;

  constructor(scene: THREE.Scene, private city: City) {
    const lines = [...this.city.railPaths]
      .map((line) => ({ name: line.name, points: line.points, cum: cumulativeArc(line.points) }))
      .filter((line) => line.cum[line.cum.length - 1]! >= MIN_LINE_LENGTH)
      .sort((a, b) => b.cum[b.cum.length - 1]! - a.cum[a.cum.length - 1]!)
      .slice(0, MAX_TRAINS);
    for (const [index, line] of lines.entries()) {
      const carCount = line.cum[line.cum.length - 1]! > 6000 ? 4 : 2;
      const cars: THREE.Group[] = [];
      for (let car = 0; car < carCount; car++) {
        const mesh = buildCar(car === 0, car === carCount - 1);
        scene.add(mesh);
        cars.push(mesh);
      }
      const trainLength = carCount * CAR_LENGTH + (carCount - 1) * CAR_GAP;
      const total = line.cum[line.cum.length - 1]!;
      // Station stops on this line: nose target = station arc + half the consist, so the train
      // centres on the platform. Termini fall out (the shuttle already stops there).
      const stops = [...new Set(STATIONS
        .filter((station) => station.line === line.name)
        .map((station) => Math.round(Math.min(total, Math.max(trainLength, nearestArc(line.points, line.cum, station.x, station.z) + trainLength / 2))))
        .filter((s) => s > trainLength + 1 && s < total - 1))]
        .sort((a, b) => a - b);
      this.trains.push({
        points: line.points,
        cum: line.cum,
        // Stagger starts so the network doesn't move in lockstep.
        state: { s: trainLength + index * 400, direction: 1, dwell: 0, speed: 0 },
        cars,
        trainLength,
        stops,
      });
      this.place(this.trains[this.trains.length - 1]!);
    }
  }

  update(dt: number): void {
    for (const train of this.trains) {
      const ride = this.ride?.train === train ? this.ride : undefined;
      const before = train.state;
      if (ride?.driving) {
        // Player at the controls: the shuttle schedule is suspended; W/S integrate the drive step.
        const next = stepDrive({ s: train.state.s, v: ride.v }, this.stick.forward, ride.cabSign, dt, { minS: train.trainLength, maxS: train.cum[train.cum.length - 1]!, ...DRIVE });
        ride.v = next.v;
        train.state = { s: next.s, direction: next.v > 0.01 ? 1 : next.v < -0.01 ? -1 : train.state.direction, dwell: 0, speed: Math.abs(next.v) };
      } else {
        train.state = advanceShuttle(train.state, dt, {
          lineLength: train.cum[train.cum.length - 1]!,
          trainLength: train.trainLength,
          maxSpeed: MAX_SPEED,
          accel: ACCEL,
          dwellTime: DWELL_S,
          stops: train.stops,
        });
      }
      if (train.state.s !== before.s || train.state.direction !== before.direction) this.place(train);
    }
    this.updateRider(dt);
  }

  // ---- Rider API (single-player only: Game's offline update is the sole caller) ----------

  get riding(): boolean { return Boolean(this.ride); }
  get driving(): boolean { return Boolean(this.ride?.driving); }
  get atCab(): boolean { const ride = this.ride; return Boolean(ride && !ride.driving && cabAt(ride.s, ride.train.trainLength, CAB_ZONE) !== 0); }
  get rideSpeedKph(): number { const ride = this.ride; return ride ? Math.abs(ride.driving ? ride.v : ride.train.state.speed * ride.train.state.direction) * 3.6 : 0; }

  /** Camera-relative stick + yaw for this sim step, sampled by Game before update() runs. */
  setRideStick(side: number, forward: number, yaw: number, sprint: boolean): void { this.stick = { side, forward, yaw, sprint }; }

  boardable(position: THREE.Vector3): boolean { return Boolean(this.boardTarget(position)); }

  /** Remaining dwell (s) of the nearest boardable DWELLING consist — the "departs in" countdown.
   *  Undefined while it is merely crawling (no schedule to quote) or the player holds the controls. */
  boardCountdown(position: THREE.Vector3): number | undefined {
    const hit = this.boardTarget(position);
    return hit && hit.train.state.dwell > 0 && this.ride?.train !== hit.train ? hit.train.state.dwell : undefined;
  }

  /** Step aboard the nearest slow/stopped consist within reach; the schedule keeps running. */
  tryBoard(position: THREE.Vector3): boolean {
    const hit = this.boardTarget(position);
    if (!hit) return false;
    const pose = poseAt(hit.train.points, hit.train.cum, hit.train.state.s - hit.s);
    this.ride = { train: hit.train, s: hit.s, lateral: hit.lateral, heading: Math.atan2(pose.dirX, pose.dirZ), driving: false, cabSign: 1, v: 0 };
    return true;
  }

  /** From a cab: suspend the shuttle and hand the player the current momentum. */
  takeControls(): void {
    const ride = this.ride; if (!ride || ride.driving) return;
    const sign = cabAt(ride.s, ride.train.trainLength, CAB_ZONE); if (!sign) return;
    ride.driving = true; ride.cabSign = sign;
    ride.v = ride.train.state.dwell > 0 ? 0 : ride.train.state.speed * ride.train.state.direction;
  }

  /** Hand the train back to the schedule from wherever (and however fast) the player left it. */
  releaseControls(): void {
    const ride = this.ride; if (!ride?.driving) return;
    ride.driving = false;
    const train = ride.train;
    train.state = { s: train.state.s, direction: ride.v > 0.01 ? 1 : ride.v < -0.01 ? -1 : train.state.direction, dwell: 0, speed: Math.abs(ride.v) };
  }

  /** Step off beside the track (lateral-facing side first); undefined when both sides are blocked. */
  dismount(): { x: number; y: number; z: number; tumble: boolean } | undefined {
    const ride = this.ride; if (!ride) return undefined;
    const train = ride.train;
    const pose = poseAt(train.points, train.cum, train.state.s - ride.s);
    const facing = (Math.sign(ride.lateral) || 1) as 1 | -1;
    for (const side of [facing, -facing]) {
      const x = pose.x + pose.dirZ * EXIT_SIDE * side; const z = pose.z - pose.dirX * EXIT_SIDE * side;
      if (this.city.collides(x, z, 0.7)) continue;
      this.ride = undefined; this.riderPoseValue = undefined;
      return { x, y: this.city.surfaceHeightAt(x, z), z, tumble: train.state.speed > TUMBLE_EXIT_SPEED };
    }
    return undefined;
  }

  /** Hard reset (respawn, teleport, going online): any driven train reverts to its schedule. */
  endRide(): void {
    if (!this.ride) return;
    if (this.ride.driving) this.releaseControls();
    this.ride = undefined; this.riderPoseValue = undefined;
  }

  riderPose(): RiderPose | undefined { return this.ride ? this.riderPoseValue : undefined; }

  /** Corridor walk + world composition for the frame — runs after the shuttles have advanced. */
  private updateRider(dt: number): void {
    const ride = this.ride; if (!ride) return;
    const train = ride.train;
    let walkSpeed = 0;
    if (!ride.driving) {
      const dir = poseAt(train.points, train.cum, train.state.s - ride.s);
      const speed = moveSpeed(this.stick.sprint, false, false);
      const step = stepAboard({ s: ride.s, lateral: ride.lateral }, this.stick.side, this.stick.forward, this.stick.yaw, speed, dt, dir, { length: train.trainLength, margin: RIDE_MARGIN, halfWidth: AISLE_HALF });
      ride.s = step.s; ride.lateral = step.lateral;
      if (step.moving) { ride.heading = step.heading; walkSpeed = speed; }
    }
    const pose = poseAt(train.points, train.cum, train.state.s - ride.s);
    if (ride.driving) ride.heading = Math.atan2(ride.cabSign * pose.dirX, ride.cabSign * pose.dirZ); // at the controls: face out the cab window
    this.riderPoseValue = {
      x: pose.x + pose.dirZ * ride.lateral, z: pose.z - pose.dirX * ride.lateral,
      y: this.city.terrainHeightAt(pose.x, pose.z) + RAIL_TOP_Y + FLOOR_Y,
      heading: ride.heading, walkSpeed, side: this.stick.side, forward: this.stick.forward,
    };
  }

  /** Nearest boardable consist: slow enough, within reach, and roughly at the player's level. */
  private boardTarget(position: THREE.Vector3): { train: Train; s: number; lateral: number } | undefined {
    for (const train of this.trains) {
      if (train.state.speed >= BOARD_MAX_SPEED) continue;
      const near = nearestArcOnSpan((s) => poseAt(train.points, train.cum, s), train.state.s - train.trainLength, train.state.s, position.x, position.z);
      if (near.dist > BOARD_REACH) continue;
      const pose = poseAt(train.points, train.cum, near.s);
      if (Math.abs(position.y - (this.city.terrainHeightAt(pose.x, pose.z) + RAIL_TOP_Y + FLOOR_Y)) > BOARD_MAX_CLIMB) continue;
      const lateral = (position.x - pose.x) * pose.dirZ - (position.z - pose.z) * pose.dirX;
      return {
        train,
        s: Math.min(train.trainLength - RIDE_MARGIN, Math.max(RIDE_MARGIN, train.state.s - near.s)),
        lateral: Math.min(AISLE_HALF, Math.max(-AISLE_HALF, lateral)),
      };
    }
    return undefined;
  }

  /** Pose every car by its own arc window so the consist bends through curves and dips. */
  private place(train: Train): void {
    for (let index = 0; index < train.cars.length; index++) {
      const noseS = train.state.s - index * (CAR_LENGTH + CAR_GAP);
      const front = poseAt(train.points, train.cum, noseS);
      const rear = poseAt(train.points, train.cum, noseS - CAR_LENGTH);
      const cx = (front.x + rear.x) / 2; const cz = (front.z + rear.z) / 2;
      const frontY = this.city.terrainHeightAt(front.x, front.z) + RAIL_TOP_Y;
      const rearY = this.city.terrainHeightAt(rear.x, rear.z) + RAIL_TOP_Y;
      const car = train.cars[index]!;
      car.position.set(cx, (frontY + rearY) / 2, cz);
      const heading = Math.atan2(front.x - rear.x, front.z - rear.z);
      const pitch = Math.atan2(frontY - rearY, CAR_LENGTH);
      // Cars keep their +s orientation: the consist has a cab at each end (leading nose forward,
      // trailing nose backward), so on the return leg the tail cab simply leads — no flipping.
      car.rotation.set(0, 0, 0);
      car.rotateY(heading);
      car.rotateX(-pitch);
    }
  }
}

/** One Gautrain-flavoured EMU car out of primitive geometry (no external assets, ~40 tris). */
function buildCar(leading: boolean, trailing: boolean): THREE.Group {
  const group = new THREE.Group();
  // Opaque shell renders double-sided so the interior reads as walls/roof/floor for a rider walking
  // the corridor; the glass band stays front-side only, so from inside it is an open view strip.
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.45, side: THREE.DoubleSide });
  const navy = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.6, side: THREE.DoubleSide });
  const glass = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.15, metalness: 0.2 });
  const roof = new THREE.MeshStandardMaterial({ color: ROOF, roughness: 0.7, side: THREE.DoubleSide });
  const skirt = new THREE.MeshStandardMaterial({ color: SKIRT, roughness: 0.9, side: THREE.DoubleSide });

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.0, 2.5, CAR_LENGTH - 0.4), gold);
  body.position.y = 2.15; body.castShadow = true; group.add(body);
  const windows = new THREE.Mesh(new THREE.BoxGeometry(3.06, 0.85, CAR_LENGTH - 2.2), glass);
  windows.position.y = 2.7; group.add(windows);
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.5, CAR_LENGTH - 1.2), roof);
  top.position.y = 3.55; group.add(top);
  const under = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, CAR_LENGTH - 0.8), skirt);
  under.position.y = 0.55; group.add(under);
  const band = new THREE.Mesh(new THREE.BoxGeometry(3.04, 0.42, CAR_LENGTH - 0.4), navy);
  band.position.y = 1.12; group.add(band);

  // Sloped nose cone + headlights on the leading car (and the mirrored tail on the last).
  for (const [isNose, sign] of [[leading, 1], [trailing, -1]] as Array<[boolean, number]>) {
    if (!isNose) continue;
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3.0, 12, 1, false, 0, Math.PI), gold);
    nose.rotation.z = Math.PI / 2; nose.rotation.y = sign > 0 ? 0 : Math.PI;
    nose.scale.set(1, 1.2, 1.66); // stretched half-cylinder reads as a streamlined cab
    nose.position.set(0, 2.1, sign * (CAR_LENGTH / 2 - 0.4));
    nose.castShadow = true; group.add(nose);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a8, emissiveIntensity: 1.4 }));
    for (const side of [-0.7, 0.7]) {
      const lamp = light.clone();
      lamp.position.set(side, 1.5, sign * (CAR_LENGTH / 2 + 1.7));
      group.add(lamp);
    }
  }
  return group;
}
