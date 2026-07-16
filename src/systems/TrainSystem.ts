import * as THREE from 'three';
import type { City } from '../world/City';

/**
 * Passenger trains shuttling back and forth along the generated rail lines (City.railPaths).
 *
 * Purely scenic kinematics: each line ≥ MIN_LINE_LENGTH gets one Gautrain-styled consist
 * (gold flanks, dark window band, blue skirt) that accelerates out of its terminus, cruises,
 * brakes to a stop at the far end, dwells, and comes back. Cars are placed independently by
 * arc length so the train articulates around curves and pitches with the relief.
 *
 * No nav-graph, no collisions, no AI — the train is landscape that moves (step off the rails).
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
  /** Remaining dwell at a terminus (s of stillness). */
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
}

/**
 * Advance the shuttle: accelerate at `accel` toward `maxSpeed`, brake so speed hits ~0 at the
 * terminus, dwell, then reverse. The nose runs in [trainLength, lineLength].
 */
export function advanceShuttle(state: ShuttleState, dt: number, params: ShuttleParams): ShuttleState {
  if (state.dwell > 0) {
    const dwell = state.dwell - dt;
    if (dwell > 0) return { ...state, dwell, speed: 0 };
    return { s: state.s, direction: (state.direction * -1) as 1 | -1, dwell: 0, speed: 0 };
  }
  const nearEnd = params.trainLength; const farEnd = params.lineLength;
  const remaining = state.direction === 1 ? farEnd - state.s : state.s - nearEnd;
  // Brake to stop exactly at the terminus: v = sqrt(2·a·d); accelerate otherwise.
  const brakeCap = Math.sqrt(Math.max(0, 2 * params.accel * remaining));
  const speed = Math.min(params.maxSpeed, state.speed + params.accel * dt, Math.max(0.6, brakeCap));
  const s = state.s + state.direction * speed * dt;
  if (state.direction === 1 ? s >= farEnd : s <= nearEnd) {
    return { s: state.direction === 1 ? farEnd : nearEnd, direction: state.direction, dwell: params.dwellTime, speed: 0 };
  }
  return { s, direction: state.direction, dwell: 0, speed };
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
const DWELL_S = 24;

const GOLD = 0xc7a13b; const NAVY = 0x24356b; const GLASS = 0x141a20; const ROOF = 0x8e949a; const SKIRT = 0x2a2f36;

interface Train {
  points: RailPoint[];
  cum: number[];
  state: ShuttleState;
  cars: THREE.Group[];
  trainLength: number;
}

export class TrainSystem {
  private trains: Train[] = [];

  constructor(scene: THREE.Scene, private city: City) {
    const lines = [...this.city.railPaths]
      .map((points) => ({ points, cum: cumulativeArc(points) }))
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
      this.trains.push({
        points: line.points,
        cum: line.cum,
        // Stagger starts so the network doesn't move in lockstep.
        state: { s: trainLength + index * 400, direction: 1, dwell: 0, speed: 0 },
        cars,
        trainLength,
      });
      this.place(this.trains[this.trains.length - 1]!);
    }
  }

  update(dt: number): void {
    for (const train of this.trains) {
      const before = train.state;
      train.state = advanceShuttle(train.state, dt, {
        lineLength: train.cum[train.cum.length - 1]!,
        trainLength: train.trainLength,
        maxSpeed: MAX_SPEED,
        accel: ACCEL,
        dwellTime: DWELL_S,
      });
      if (train.state.s !== before.s || train.state.direction !== before.direction) this.place(train);
    }
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
  const gold = new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.35, metalness: 0.45 });
  const navy = new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: GLASS, roughness: 0.15, metalness: 0.2 });
  const roof = new THREE.MeshStandardMaterial({ color: ROOF, roughness: 0.7 });
  const skirt = new THREE.MeshStandardMaterial({ color: SKIRT, roughness: 0.9 });

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
