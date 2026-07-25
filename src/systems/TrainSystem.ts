import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { moveSpeed } from '../core/GameRules';
import { STATIONS } from '../world/mapData';
import type { City } from '../world/City';
import { cabAt, nearestArcOnSpan, stepAboard, stepDrive, stitchRailPaths } from './TrainRide';

/**
 * Passenger trains shuttling back and forth along the generated rail lines (City.railPaths).
 *
 * Purely scenic kinematics: each line ≥ MIN_LINE_LENGTH gets one Gautrain-styled consist
 * (gold flanks, full-height glazing on both sides, blue skirt) that accelerates out of its terminus, cruises,
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

const GOLD = 0xc7a13b; const NAVY = 0x24356b; const ROOF = 0x8e949a; const SKIRT = 0x2a2f36;

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
  /** The streamlined cab shells (nose + lamps) per end — hidden for the windscreen view in FP driving. */
  noseParts: { nose: THREE.Object3D[]; tail: THREE.Object3D[] };
}

export class TrainSystem {
  private trains: Train[] = [];
  private ride?: Ride;
  private stick = { side: 0, forward: 0, yaw: 0, sprint: false };
  private riderPoseValue?: RiderPose;

  constructor(scene: THREE.Scene, private city: City) {
    // End-to-end joints (e.g. the Main Line / airport spur junction) stitch into one drivable
    // line, so driving straight through a joint just works — no dead stop at a shared vertex.
    const lines = stitchRailPaths(this.city.railPaths)
      .map((points) => ({ points, cum: cumulativeArc(points) }))
      .filter((line) => line.cum[line.cum.length - 1]! >= MIN_LINE_LENGTH)
      .sort((a, b) => b.cum[b.cum.length - 1]! - a.cum[a.cum.length - 1]!)
      .slice(0, MAX_TRAINS);
    for (const [index, line] of lines.entries()) {
      const carCount = line.cum[line.cum.length - 1]! > 6000 ? 4 : 2;
      const cars: THREE.Group[] = [];
      const noseParts: Train['noseParts'] = { nose: [], tail: [] };
      for (let car = 0; car < carCount; car++) {
        const built = buildCar(car === 0, car === carCount - 1);
        scene.add(built.group);
        cars.push(built.group);
        if (car === 0) noseParts.nose = built.noses[1] ?? [];
        if (car === carCount - 1) noseParts.tail = built.noses[-1] ?? [];
      }
      const trainLength = carCount * CAR_LENGTH + (carCount - 1) * CAR_GAP;
      const total = line.cum[line.cum.length - 1]!;
      // Station stops on this consist's (possibly stitched) line: every generated station that lies
      // ON this path — matched by projection, not by name, so a stitched Main-Line+spur through-line
      // serves both legs' stations. Nose target = station arc + half the consist (centred on the
      // platform); termini fall out (the shuttle already stops there).
      const stops = [...new Set(STATIONS
        .map((station) => nearestArc(line.points, line.cum, station.x, station.z))
        .filter((s, index) => { const pose = poseAt(line.points, line.cum, s); const station = STATIONS[index]!; return Math.hypot(pose.x - station.x, pose.z - station.z) < 30; })
        .map((s) => Math.round(Math.min(total, Math.max(trainLength, s + trainLength / 2))))
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
        noseParts,
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

  /** Station the ridden train is currently stopped at (dwelling, or player-driven to a stand-still
   *  within platform reach), if any. Mission surface: "ride to X" objectives key on this. */
  get currentStationName(): string | undefined {
    const ride = this.ride; if (!ride) return undefined;
    const speed = Math.abs(ride.driving ? ride.v : ride.train.state.speed);
    if (speed > 0.5) return undefined;
    const nose = poseAt(ride.train.points, ride.train.cum, ride.train.state.s);
    const mid = poseAt(ride.train.points, ride.train.cum, ride.train.state.s - ride.train.trainLength / 2);
    let best: string | undefined; let bestDistance = 45; // a stopped consist spans the platform: accept either the nose or the midpoint being close
    for (const station of STATIONS) {
      const d = Math.min(Math.hypot(nose.x - station.x, nose.z - station.z), Math.hypot(mid.x - station.x, mid.z - station.z));
      if (d < bestDistance) { bestDistance = d; best = station.name; }
    }
    return best;
  }

  /** Rider guidance for a "ride to <station>" objective (owner: aboard a train the game gave no hint
   *  of what to do or which way it was going). Returns the next stop on this leg, how many stops to
   *  the destination, and whether the destination is NOT ahead in the current direction (wrong way). */
  rideGuidance(destName?: string): { next?: string; toDest?: number; wrong: boolean } | undefined {
    const ride = this.ride; if (!ride) return undefined;
    const train = ride.train; const { s, direction } = train.state;
    const ahead = (train.stops ?? [])
      .filter((stop) => (direction === 1 ? stop > s + 1 : stop < s - 1))
      .sort((a, b) => (direction === 1 ? a - b : b - a));
    const nameAt = (arc: number): string | undefined => {
      const mid = poseAt(train.points, train.cum, arc - train.trainLength / 2); // stop arc is nose-centred; station sits half a consist back
      let best: string | undefined; let bestDistance = 45;
      for (const station of STATIONS) { const d = Math.hypot(mid.x - station.x, mid.z - station.z); if (d < bestDistance) { bestDistance = d; best = station.name; } }
      return best;
    };
    const names = ahead.map(nameAt);
    const next = names.find(Boolean);
    if (!destName) return { next, wrong: false };
    const idx = names.findIndex((name) => name === destName);
    return idx >= 0 ? { next, toDest: idx + 1, wrong: false } : { next, wrong: true };
  }

  /** World heading the occupied cab faces (chase camera anchor); undefined off the controls. */
  get driveHeading(): number | undefined {
    const ride = this.ride; if (!ride?.driving) return undefined;
    const pose = poseAt(ride.train.points, ride.train.cum, ride.train.state.s - ride.s);
    const heading = Math.atan2(pose.dirX, pose.dirZ);
    return ride.cabSign === 1 ? heading : heading + Math.PI;
  }

  /** Windscreen view: in first-person driving the occupied cab's streamlined shell (nose + lamps)
   *  hides — the same trick the cars use for their cabin glass — and restores otherwise. */
  setDriveFirstPerson(firstPerson: boolean): void {
    const ride = this.ride;
    for (const train of this.trains) {
      const drivenEnd = ride?.train === train && ride.driving && firstPerson ? (ride.cabSign === 1 ? 'nose' : 'tail') : undefined;
      for (const end of ['nose', 'tail'] as const) {
        for (const part of train.noseParts[end]) part.visible = end !== drivenEnd;
      }
    }
  }

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

// ---- Carriage construction ------------------------------------------------------------------

const BODY_HALF = 1.5; // outer skin at x = ±1.5
const WALL = 0.06; // panel thickness
const SILL_Y = 1.90; // 0.90 above the floor: a SEATED passenger's eye (2.22) clears it by 0.32
const HEAD_Y = 3.05; // top of the glazed aperture
const ROOF_Y = 3.30; // where the flank meets the crown
const PILLAR = 0.30; // slim pillars between window bays
const DOOR_Z = 4.2; const DOOR_HALF = 0.65; // two double doors per side
const BODY_END = CAR_LENGTH / 2 - 0.2;
const BOGIE_Z = 4.6; const WHEEL_R = 0.42;

const LIGHT_GREY = 0xb9bec4; const FLOOR_C = 0x5a6068; const YELLOW = 0xe8b52a; const CEIL = 0xd9dde1;

/** Shared across every car: identical for all sixteen, never recoloured per consist. */
const CAR_MATS = {
  // A little emissive on the double-sided shell: the interior faces point outward, so with sun and
  // sky alone the panels above the windows and under the racks read as pure black from a seat.
  gold: new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.45, side: THREE.DoubleSide, emissive: GOLD, emissiveIntensity: 0.16 }),
  navy: new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.6, side: THREE.DoubleSide, emissive: NAVY, emissiveIntensity: 0.2 }),
  roof: new THREE.MeshStandardMaterial({ color: ROOF, roughness: 0.7, side: THREE.DoubleSide, emissive: ROOF, emissiveIntensity: 0.12 }),
  skirt: new THREE.MeshStandardMaterial({ color: SKIRT, roughness: 0.9, side: THREE.DoubleSide }),
  trim: new THREE.MeshStandardMaterial({ color: LIGHT_GREY, roughness: 0.4, metalness: 0.5, emissive: LIGHT_GREY, emissiveIntensity: 0.14 }),
  yellow: new THREE.MeshStandardMaterial({ color: YELLOW, roughness: 0.45 }),
  floor: new THREE.MeshStandardMaterial({ color: FLOOR_C, roughness: 0.85, emissive: FLOOR_C, emissiveIntensity: 0.18 }),
  ceiling: new THREE.MeshStandardMaterial({ color: CEIL, roughness: 0.9, emissive: 0x767c84, emissiveIntensity: 1, side: THREE.DoubleSide }),
  strip: new THREE.MeshStandardMaterial({ color: 0xfdf6e2, emissive: 0xfff3d0, emissiveIntensity: 1.6 }),
  // Real glazing: transparent both ways, so the corridor sees the city and the platform sees the
  // passengers. Depth-written so near panes occlude far ones instead of double-tinting.
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x9fc0cc, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.34,
    side: THREE.DoubleSide, clearcoat: 1, clearcoatRoughness: 0.04,
  }),
  lamp: new THREE.MeshStandardMaterial({ color: 0xfff2c0, emissive: 0xffe9a8, emissiveIntensity: 1.4 }),
} as const;

type MatKey = keyof typeof CAR_MATS;

/** Per-material geometry batching: a detailed carriage still lands in ~a dozen draw calls. */
class CarBatch {
  private buckets = new Map<MatKey, THREE.BufferGeometry[]>();

  add(geometry: THREE.BufferGeometry, key: MatKey): void {
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(geometry); else this.buckets.set(key, [geometry]);
  }

  /** Convenience: an axis-aligned box given its centre and size. */
  box(key: MatKey, cx: number, cy: number, cz: number, w: number, h: number, d: number): void {
    this.add(new THREE.BoxGeometry(w, h, d).translate(cx, cy, cz), key);
  }

  flush(group: THREE.Group, shadow = true): void {
    for (const [key, parts] of this.buckets) {
      const geometry = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false)!;
      const mesh = new THREE.Mesh(geometry, CAR_MATS[key]);
      mesh.name = `car_${key}`; mesh.castShadow = shadow && key !== 'glass'; mesh.receiveShadow = shadow;
      group.add(mesh);
    }
    this.buckets.clear();
  }
}

/** Split a run of side wall into window bays of roughly `target` metres separated by pillars. */
function windowBays(z0: number, z1: number, target: number): Array<[number, number]> {
  const span = z1 - z0;
  const count = Math.max(1, Math.round((span + PILLAR) / (target + PILLAR)));
  const width = (span - (count - 1) * PILLAR) / count;
  const bays: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) { const a = z0 + i * (width + PILLAR); bays.push([a, a + width]); }
  return bays;
}

/**
 * One Gautrain-flavoured EMU car out of primitive geometry (no external assets).
 *
 * The flank is built as separate panels — sill strip, slim pillars, header — so the glazing is a
 * genuine hole in the wall on BOTH sides rather than a dark stripe bolted to a solid tube. The sill
 * sits 0.90 m above the interior floor, which is below both the seated eye (car-local 2.22) and the
 * standing first-person eye (2.62), so a rider actually sees Johannesburg go past from either.
 */
export function buildCar(leading: boolean, trailing: boolean): { group: THREE.Group; noses: Partial<Record<1 | -1, THREE.Object3D[]>> } {
  const group = new THREE.Group();
  const B = new CarBatch();

  // ---- Underframe, floor, bogies ----
  B.box('skirt', 0, 0.55, 0, 2.6, 0.9, CAR_LENGTH - 0.8);
  B.box('floor', 0, 0.96, 0, 2 * BODY_HALF - 0.12, 0.08, 2 * BODY_END - 0.1);
  for (const sign of [1, -1]) {
    B.box('skirt', 0, 0.72, sign * BOGIE_Z, 2.0, 0.34, 0.8); // bolster
    for (const side of [1, -1]) {
      B.box('skirt', side * 0.98, 0.62, sign * BOGIE_Z, 0.14, 0.36, 2.5); // sideframe
      for (const axle of [1, -1]) B.box('trim', side * 0.98, WHEEL_R, sign * BOGIE_Z + axle * 0.95, 0.2, 0.24, 0.24); // axlebox
    }
  }
  // Eight wheels on the railhead — without them the consist visibly hovers over the sleepers.
  const wheel = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.14, 16);
  wheel.rotateZ(Math.PI / 2);
  const wheels = new THREE.InstancedMesh(wheel, CAR_MATS.skirt, 8);
  const place = new THREE.Matrix4(); let index = 0;
  for (const sign of [1, -1]) for (const side of [1, -1]) for (const axle of [1, -1]) {
    place.makeTranslation(side * 0.82, WHEEL_R, sign * BOGIE_Z + axle * 0.95);
    wheels.setMatrixAt(index++, place);
  }
  wheels.instanceMatrix.needsUpdate = true; wheels.castShadow = true; wheels.name = 'car_wheels';
  group.add(wheels);

  // ---- Flanks: sill strip, pillars, header, doors ----
  const sections: Array<[number, number]> = [
    [-BODY_END + 0.15, -DOOR_Z - DOOR_HALF],
    [-DOOR_Z + DOOR_HALF, DOOR_Z - DOOR_HALF],
    [DOOR_Z + DOOR_HALF, BODY_END - 0.15],
  ];
  const panes: Array<[number, number]> = [];
  for (const [z0, z1] of sections) for (const bay of windowBays(z0, z1, 2.2)) panes.push(bay);

  for (const side of [1, -1]) {
    const x = side * (BODY_HALF - WALL / 2);
    B.box('gold', x, (1.0 + SILL_Y) / 2, 0, WALL, SILL_Y - 1.0, 2 * BODY_END); // sill strip, floor to sill
    B.box('gold', x, (HEAD_Y + ROOF_Y) / 2, 0, WALL, ROOF_Y - HEAD_Y, 2 * BODY_END); // header, above the glass
    B.box('navy', side * BODY_HALF, 1.12, 0, 0.04, 0.42, 2 * BODY_END); // waist band
    B.box('gold', side * BODY_HALF, 1.80, 0, 0.03, 0.10, 2 * BODY_END); // sill highlight stripe
    // Pillars: one at each aperture edge and one at each body end.
    const edges = new Set<number>([-BODY_END + 0.075, BODY_END - 0.075]);
    for (const [a, b] of panes) { edges.add(a - PILLAR / 2); edges.add(b + PILLAR / 2); }
    for (const z of edges) B.box('gold', x, (SILL_Y + HEAD_Y) / 2, z, WALL, HEAD_Y - SILL_Y, PILLAR);
    // Glazing: one pane per bay, inset so the pillars read as a frame.
    for (const [a, b] of panes) B.box('glass', side * (BODY_HALF - 0.045), (SILL_Y + HEAD_Y) / 2 + 0.01, (a + b) / 2, 0.02, HEAD_Y - SILL_Y - 0.06, b - a);
    // Doors: two leaves, a glazed upper half and a yellow surround you can spot from the platform.
    for (const sign of [1, -1]) {
      const cz = sign * DOOR_Z;
      B.box('yellow', side * (BODY_HALF + 0.012), (1.0 + HEAD_Y) / 2, cz, 0.03, HEAD_Y - 1.0, 2 * DOOR_HALF + 0.09); // surround
      B.box('navy', x, 1.28, cz, WALL, 0.56, 2 * DOOR_HALF); // door lower panel
      B.box('gold', x, 2.98, cz, WALL, 0.14, 2 * DOOR_HALF); // door header
      B.box('trim', x, 2.0, cz, WALL + 0.01, 1.9, 0.05); // centre split between the leaves
      for (const leaf of [1, -1]) {
        B.box('glass', side * (BODY_HALF - 0.045), 2.28, cz + leaf * DOOR_HALF / 2, 0.02, 1.30, DOOR_HALF - 0.1);
        B.box('gold', x, 1.62, cz + leaf * DOOR_HALF / 2, WALL, 0.12, DOOR_HALF - 0.06);
      }
    }
  }

  // ---- Ends: bulkheads with a gangway wide enough for the corridor clamp (±1.05) ----
  for (const sign of [1, -1]) {
    for (const side of [1, -1]) B.box('gold', side * 1.27, 2.15, sign * BODY_END, 0.44, 2.3, WALL);
    B.box('gold', 0, 3.10, sign * BODY_END, 2.6, 0.4, WALL); // gangway header
  }

  // ---- Roof: a shallow crown, plus equipment and the cable duct ----
  const crownR = 3.6; const crownY = ROOF_Y - Math.sqrt(crownR * crownR - BODY_HALF * BODY_HALF);
  const half = Math.asin(BODY_HALF / crownR);
  const crown = new THREE.CylinderGeometry(crownR, crownR, 2 * BODY_END, 20, 1, true, Math.PI / 2 - half, 2 * half);
  crown.rotateX(Math.PI / 2); crown.translate(0, crownY, 0);
  B.add(crown, 'roof');
  for (const z of [-4.6, 0.6, 4.2]) B.box('roof', 0, ROOF_Y + 0.30, z, 1.5, 0.24, 1.9); // HVAC blisters
  for (const side of [1, -1]) B.box('trim', side * 0.95, ROOF_Y + 0.30, 0, 0.14, 0.12, 2 * BODY_END - 1); // cable duct

  // ---- Interior: ceiling, strip lights, poles, racks ----
  B.box('ceiling', 0, 3.22, 0, 2.86, 0.05, 2 * BODY_END - 0.2);
  for (const side of [1, -1]) {
    B.box('strip', side * 0.56, 3.16, 0, 0.16, 0.05, 2 * BODY_END - 1.2);
    B.box('trim', side * 1.22, 2.86, 0, 0.42, 0.04, 2 * BODY_END - 1.6); // luggage rack
    B.box('trim', side * 0.80, 3.06, 0, 0.05, 0.05, 2 * BODY_END - 1.2); // longitudinal grab rail
    for (let z = -4.15; z <= 4.2; z += 1.9) {
      B.box('trim', side * 1.12, (1.0 + 3.19) / 2, z, 0.05, 2.19, 0.05); // floor-to-ceiling pole
      B.box('trim', side * 0.80, 2.96, z + 0.9, 0.03, 0.16, 0.03); // hanging strap, clear of a standing head
    }
  }
  B.flush(group);
  addSeating(group);

  // ---- Cab noses (hidden for the driver's windscreen view) ----
  const noses: Partial<Record<1 | -1, THREE.Object3D[]>> = {};
  for (const [isNose, sign] of [[leading, 1], [trailing, -1]] as Array<[boolean, 1 | -1]>) {
    if (!isNose) continue;
    const parts: THREE.Object3D[] = [];
    const cab = new THREE.Group(); cab.name = 'cab';
    const C = new CarBatch();
    const nose = new THREE.CylinderGeometry(1.5, 1.5, 3.0, 14, 1, false, 0, Math.PI);
    nose.rotateZ(Math.PI / 2); if (sign < 0) nose.rotateY(Math.PI);
    nose.scale(1, 1.2, 1.66); nose.translate(0, 2.1, sign * (CAR_LENGTH / 2 - 0.4));
    C.add(nose, 'gold');
    C.box('glass', 0, 2.62, sign * (CAR_LENGTH / 2 + 1.0), 2.0, 0.86, 0.06); // cab windscreen
    C.box('navy', 0, 1.32, sign * (CAR_LENGTH / 2 + 1.05), 2.3, 0.5, 0.1); // cab skirt flash
    C.flush(cab);
    for (const side of [-0.7, 0.7]) {
      const lampGeometry = new THREE.SphereGeometry(0.16, 10, 7).translate(side, 1.5, sign * (CAR_LENGTH / 2 + 1.7));
      const lamp = new THREE.Mesh(lampGeometry, CAR_MATS.lamp); lamp.name = 'cablamp';
      cab.add(lamp);
    }
    group.add(cab); parts.push(cab);
    noses[sign] = parts;
  }
  return { group, noses };
}

/** Rows of paired commuter seats down both walls — the aisle (±AISLE_HALF) stays clear, so the
 *  rider corridor never needs seat collision. Instanced: two draws per car. */
function addSeating(group: THREE.Group): void {
  const cushion = new THREE.MeshStandardMaterial({ color: 0x33456a, roughness: 0.85 });
  const frame = new THREE.MeshStandardMaterial({ color: 0x2c3238, roughness: 0.6, metalness: 0.35 });
  const rows: Array<{ z: number; side: 1 | -1; facing: 1 | -1 }> = [];
  for (let z = -(CAR_LENGTH / 2 - 2.4); z <= CAR_LENGTH / 2 - 2.4; z += 1.9) {
    for (const side of [-1, 1] as const) rows.push({ z, side, facing: z < 0 ? 1 : -1 }); // bays face the middle doors
  }
  const seatX = (AISLE_HALF + 1.5) / 2; // centred between the aisle edge and the wall
  const cushions = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.1, 0.48), cushion, rows.length);
  const backs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.42, 0.52, 0.09), cushion, rows.length);
  const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.32, 0.34), frame, rows.length);
  const matrix = new THREE.Matrix4();
  rows.forEach((row, index) => {
    const x = row.side * seatX;
    matrix.makeTranslation(x, FLOOR_Y + 0.42, row.z); cushions.setMatrixAt(index, matrix);
    matrix.makeTranslation(x, FLOOR_Y + 0.72, row.z - row.facing * 0.24); backs.setMatrixAt(index, matrix);
    matrix.makeTranslation(x, FLOOR_Y + 0.16, row.z); legs.setMatrixAt(index, matrix);
  });
  for (const mesh of [cushions, backs, legs]) { mesh.instanceMatrix.needsUpdate = true; group.add(mesh); }
}
