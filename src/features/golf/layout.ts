/**
 * Where the golf is. Everything in this module is DERIVED from the landuse layer at runtime — not a
 * single world coordinate is typed, because the map has already moved once and will move again.
 *
 * Two steps:
 *  1. `chooseCourse()` picks the one playable course out of the ten golf polygons the crop kept.
 *  2. `routeCourse()` lays three holes down its long axis, entirely inside the boundary.
 *
 * Lazy: this file only ever loads with the rest of src/features/golf/.
 */
import { CBD_CENTER, GENERATED_ROADS, GREEN_POLYGONS, METRES_PER_UNIT, type MapPolygon } from '../../world/mapData';

export interface Pt { x: number; z: number }

export interface Bunker { x: number; z: number; rx: number; rz: number; rot: number }

export interface Hole {
  /** 1-based, as it reads on the card. */
  number: number;
  par: number;
  tee: Pt;
  pin: Pt;
  /** Tee-to-pin, in game units and in METRES — South African courses are measured in metres. */
  lengthU: number;
  lengthM: number;
  /** Tee height minus pin height, in units. Positive plays downhill. */
  dropU: number;
  greenR: number;
  teeR: number;
  fairwayHalf: number;
  bunkers: Bunker[];
}

export interface CourseLayout {
  polygon: MapPolygon;
  /** Display name; the bare OSM kind string is dressed up as a municipal course. */
  name: string;
  holes: Hole[];
  parTotal: number;
  clubhouse: Pt;
  /** Yaw the clubhouse faces — toward the nearest road, so the pro shop opens onto the driveway. */
  clubhouseHeading: number;
  /** Nearest public road to the clubhouse, for the "drive here" hint. */
  gateRoad: string;
}

/** A hole cannot cross the M1. Any golf polygon with a big road through it is off the list. */
const MAJOR_ROAD_KINDS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link']);

/** A three-hole loop needs room; smaller polygons are driving ranges and slivers. */
const MIN_AREA = 60_000;
const GOLF_NAME = /golf|country club/i;

const dist = (ax: number, az: number, bx: number, bz: number): number => Math.hypot(ax - bx, az - bz);

export function pointInPolygon(polygon: MapPolygon, x: number, z: number): boolean {
  const points = polygon.points;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!; const b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Distance from an interior point to the nearest boundary edge — the "how much room is there" field. */
export function insetAt(polygon: MapPolygon, x: number, z: number): number {
  const points = polygon.points;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!; const b = points[(i + 1) % points.length]!;
    const vx = b.x - a.x; const vz = b.z - a.z;
    const len = vx * vx + vz * vz;
    const t = len > 0 ? Math.min(1, Math.max(0, ((x - a.x) * vx + (z - a.z) * vz) / len)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * vx), z - (a.z + t * vz)));
  }
  return best;
}

function crossedByMajorRoad(polygon: MapPolygon): boolean {
  for (const road of GENERATED_ROADS) {
    if (!MAJOR_ROAD_KINDS.has(road.kind)) continue;
    for (const point of road.points) {
      if (point.x < polygon.minX || point.x > polygon.maxX || point.z < polygon.minZ || point.z > polygon.maxZ) continue;
      if (pointInPolygon(polygon, point.x, point.z)) return true;
    }
  }
  return false;
}

export interface CourseCandidate { polygon: MapPolygon; score: number; distanceToCbd: number; blocked: boolean }

/**
 * Rank the golf polygons: the most course per kilometre of travel, minus anything a freeway runs
 * through. Exported so a test can pin the ranking against the real map rather than a hand-typed name.
 */
export function rankCourses(): CourseCandidate[] {
  return GREEN_POLYGONS
    .filter((polygon) => polygon.manicured === true && polygon.area >= MIN_AREA && GOLF_NAME.test(polygon.name))
    .map((polygon) => {
      const distanceToCbd = Math.max(1, dist(polygon.cx, polygon.cz, CBD_CENTER.x, CBD_CENTER.z));
      return { polygon, distanceToCbd, score: polygon.area / distanceToCbd, blocked: crossedByMajorRoad(polygon) };
    })
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || b.score - a.score);
}

let chosen: MapPolygon | undefined | null = null;

/** The one course you can actually play. Memoised: the map does not change inside a session. */
export function chooseCourse(): MapPolygon | undefined {
  if (chosen === null) {
    const best = rankCourses().find((candidate) => !candidate.blocked);
    chosen = best?.polygon;
  }
  return chosen ?? undefined;
}

/** Test seam only — drops the memoised pick. */
export function resetCourseCache(): void { chosen = null; }

/** "golf_course" is what OSM leaves behind when a course has no name tag. Give it a municipal one. */
export function courseName(polygon: MapPolygon): string {
  return /^golf_course$/i.test(polygon.name) ? 'Municipal Golf Course' : polygon.name;
}

// ---- routing ----------------------------------------------------------------------------------

interface Cell { x: number; z: number; inset: number; u: number; y: number }

/** Tee/pin parameters along the course's long axis. Out, out again, and a long uphill walk home. */
const HOLE_STOPS: Array<[number, number]> = [[0.08, 0.20], [0.25, 0.52], [0.57, 0.86]];

function interiorCells(polygon: MapPolygon, minInset: number, step: number, groundAt: (x: number, z: number) => number): Cell[] {
  const cells: Cell[] = [];
  for (let x = polygon.minX; x <= polygon.maxX; x += step) {
    for (let z = polygon.minZ; z <= polygon.maxZ; z += step) {
      if (!pointInPolygon(polygon, x, z)) continue;
      const inset = insetAt(polygon, x, z);
      if (inset >= minInset) cells.push({ x, z, inset, u: 0, y: groundAt(x, z) });
    }
  }
  return cells;
}

/** Steepest tee-to-green gradient a golf hole may have. Parkview's polygon runs up a saturated
 *  escarpment at its southern tip; routing a green onto that face made the closing hole a wall the
 *  machine playthrough could not climb inside eight strokes. Golf is played on hills, not on cliffs. */
export const MAX_HOLE_GRADIENT = 0.13;

/** Par straight off the card: SA courses are metred, and a 3-hole municipal loop is short. */
export function parForLength(lengthM: number): number {
  if (lengthM < 205) return 3;
  if (lengthM < 390) return 4;
  return 5;
}

/**
 * Route three holes down the polygon's principal axis. Every tee and pin is an interior cell with a
 * real inset, so nothing lands in a hedge; the walk from one green to the next tee is the gap
 * between HOLE_STOPS.
 */
export function routeCourse(polygon: MapPolygon, groundAt: (x: number, z: number) => number): CourseLayout {
  const step = Math.max(6, Math.min(14, Math.sqrt(polygon.area) / 30));
  // Back off the inset requirement rather than fail: a narrow course still gets three holes.
  let cells = interiorCells(polygon, 18, step, groundAt);
  if (cells.length < 40) cells = interiorCells(polygon, 9, step, groundAt);
  if (cells.length < 12) cells = interiorCells(polygon, 2, step, groundAt);
  if (cells.length === 0) cells = [{ x: polygon.cx, z: polygon.cz, inset: 1, u: 0, y: groundAt(polygon.cx, polygon.cz) }];

  // Principal axis by covariance — the direction the course is longest in, whatever shape it is.
  let mx = 0; let mz = 0;
  for (const cell of cells) { mx += cell.x; mz += cell.z; }
  mx /= cells.length; mz /= cells.length;
  let sxx = 0; let sxz = 0; let szz = 0;
  for (const cell of cells) { const dx = cell.x - mx; const dz = cell.z - mz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ax = Math.cos(theta); const az = Math.sin(theta);
  let lo = Infinity; let hi = -Infinity;
  for (const cell of cells) { cell.u = (cell.x - mx) * ax + (cell.z - mz) * az; lo = Math.min(lo, cell.u); hi = Math.max(hi, cell.u); }
  const span = Math.max(1, hi - lo);

  /** The cell near a given fraction of the axis, trading closeness to that mark against elbow room.
   *  Pins weight room far more heavily: a green whose edge touches the boundary fence turns every
   *  missed putt into an out-of-bounds, which is exactly the loop the machine playthrough caught. */
  const at = (fraction: number, roomy = false, levelWith?: number): Cell => {
    const target = lo + span * fraction;
    let best = cells[0]!; let bestScore = Infinity;
    for (const cell of cells) {
      let score = Math.abs(cell.u - target) * (roomy ? 1.1 : 2) - cell.inset * (roomy ? 2.2 : 1);
      if (levelWith !== undefined) score += Math.abs(cell.y - levelWith) * 2.5;
      if (score < bestScore) { bestScore = score; best = cell; }
    }
    return best;
  };

  const holes: Hole[] = HOLE_STOPS.map(([teeF, pinF], index) => {
    const teeCell = at(teeF);
    // Pin: roomy AND close to the tee's height. Without the level term the closer climbed a 60%
    // face; with it the hole still rolls, it just does not go up a wall.
    let pinCell = at(pinF, true, teeCell.y);
    if (Math.abs(pinCell.y - teeCell.y) > MAX_HOLE_GRADIENT * Math.hypot(pinCell.x - teeCell.x, pinCell.z - teeCell.z)) {
      pinCell = at(pinF, true, teeCell.y); // one flatter retry, then take what the ground gives
    }
    const tee: Pt = { x: teeCell.x, z: teeCell.z };
    const pin: Pt = { x: pinCell.x, z: pinCell.z };
    const lengthU = Math.max(20, dist(tee.x, tee.z, pin.x, pin.z));
    const lengthM = lengthU * METRES_PER_UNIT;
    // Never wider than half the room the pin has: the green keeps a collar of rough between it
    // and the boundary, so a putt that runs on is a chip back, not an out-of-bounds.
    const greenR = Math.min(14, Math.max(8, Math.min(pinCell.inset * 0.45, lengthU * 0.09)));
    const bearing = Math.atan2(pin.x - tee.x, pin.z - tee.z);
    const bunkers: Bunker[] = [1, -1].map((side, order) => {
      const angle = bearing + side * 1.15 + Math.PI; // short-left and short-right of the green, guarding the approach
      const reach = greenR + 6 + order * 2;
      return { x: pin.x + Math.sin(angle) * reach, z: pin.z + Math.cos(angle) * reach, rx: 7 + order, rz: 4.5, rot: angle };
    }).filter((bunker) => pointInPolygon(polygon, bunker.x, bunker.z));
    return {
      number: index + 1,
      par: parForLength(lengthM),
      tee, pin, lengthU, lengthM,
      dropU: groundAt(tee.x, tee.z) - groundAt(pin.x, pin.z),
      greenR, teeR: 4.5,
      // ~43 m across at the widest, which is a generous but recognisable parkland fairway.
      fairwayHalf: Math.min(16, Math.max(10, Math.min(teeCell.inset, pinCell.inset) * 0.75)),
      bunkers,
    };
  });

  // The clubhouse sits behind the first tee, shoved toward whichever road comes closest.
  const anchor = at(0.015);
  let gate = { name: 'the gate', x: anchor.x, z: anchor.z, d: Infinity };
  for (const road of GENERATED_ROADS) {
    for (const point of road.points) {
      const d = dist(point.x, point.z, anchor.x, anchor.z);
      if (d < gate.d) gate = { name: road.name, x: point.x, z: point.z, d };
    }
  }
  const toGate = Math.atan2(gate.x - anchor.x, gate.z - anchor.z);
  // Nudge toward the road but stay inside the boundary — the pro shop is on the course, not the verge.
  let clubhouse: Pt = { x: anchor.x, z: anchor.z };
  for (let push = 6; push <= 34; push += 4) {
    const probe = { x: anchor.x + Math.sin(toGate) * push, z: anchor.z + Math.cos(toGate) * push };
    if (!pointInPolygon(polygon, probe.x, probe.z) || insetAt(polygon, probe.x, probe.z) < 7) break;
    clubhouse = probe;
  }

  return {
    polygon,
    name: courseName(polygon),
    holes,
    parTotal: holes.reduce((total, hole) => total + hole.par, 0),
    clubhouse,
    clubhouseHeading: toGate,
    gateRoad: gate.name,
  };
}

// ---- surfaces ----------------------------------------------------------------------------------

export type Lie = 'tee' | 'green' | 'fairway' | 'rough' | 'bunker' | 'out';

/** Perpendicular distance from the tee→pin line, and how far along it, for the fairway corridor. */
function alongLine(hole: Hole, x: number, z: number): { along: number; side: number } {
  const vx = hole.pin.x - hole.tee.x; const vz = hole.pin.z - hole.tee.z;
  const len = Math.max(1e-6, vx * vx + vz * vz);
  const t = ((x - hole.tee.x) * vx + (z - hole.tee.z) * vz) / len;
  const cx = hole.tee.x + vx * Math.min(1, Math.max(0, t));
  const cz = hole.tee.z + vz * Math.min(1, Math.max(0, t));
  return { along: t, side: Math.hypot(x - cx, z - cz) };
}

export function lieAt(layout: CourseLayout, hole: Hole, x: number, z: number): Lie {
  if (!pointInPolygon(layout.polygon, x, z)) return 'out';
  if (dist(x, z, hole.pin.x, hole.pin.z) <= hole.greenR) return 'green';
  if (dist(x, z, hole.tee.x, hole.tee.z) <= hole.teeR) return 'tee';
  for (const bunker of hole.bunkers) {
    const dx = x - bunker.x; const dz = z - bunker.z;
    const lx = dx * Math.cos(bunker.rot) - dz * Math.sin(bunker.rot);
    const lz = dx * Math.sin(bunker.rot) + dz * Math.cos(bunker.rot);
    if ((lx / bunker.rx) ** 2 + (lz / bunker.rz) ** 2 <= 1) return 'bunker';
  }
  const { along, side } = alongLine(hole, x, z);
  return along > -0.08 && along < 1.08 && side <= hole.fairwayHalf ? 'fairway' : 'rough';
}

/**
 * Where the ball-hunters put your ball back. Always on the tee→pin line, so the drop is a playable
 * fairway lie rather than the boundary hedge, and always at or short of the green — a ball that runs
 * through the back gets handed back a chip away, which both converges and reads as generous.
 */
export function dropZone(polygon: MapPolygon, hole: Hole, x: number, z: number): Pt {
  const vx = hole.pin.x - hole.tee.x; const vz = hole.pin.z - hole.tee.z;
  const len = Math.max(1e-6, vx * vx + vz * vz);
  const t = Math.min(1, Math.max(0.05, ((x - hole.tee.x) * vx + (z - hole.tee.z) * vz) / len));
  const dirX = vx / Math.sqrt(len); const dirZ = vz / Math.sqrt(len);
  const spot: Pt = t >= 0.995
    ? { x: hole.pin.x - dirX * hole.greenR * 0.8, z: hole.pin.z - dirZ * hole.greenR * 0.8 }
    : { x: hole.tee.x + vx * t, z: hole.tee.z + vz * t };
  return pointInPolygon(polygon, spot.x, spot.z) ? spot : nearestInside(polygon, spot.x, spot.z);
}

/** Nearest point back inside the boundary — the fallback when even the fairway line is outside. */
export function nearestInside(polygon: MapPolygon, x: number, z: number): Pt {
  const points = polygon.points;
  let best: Pt = { x: polygon.cx, z: polygon.cz };
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!; const b = points[(i + 1) % points.length]!;
    const vx = b.x - a.x; const vz = b.z - a.z;
    const len = vx * vx + vz * vz;
    const t = len > 0 ? Math.min(1, Math.max(0, ((x - a.x) * vx + (z - a.z) * vz) / len)) : 0;
    const px = a.x + vx * t; const pz = a.z + vz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
  }
  // Step 6 units inward off the fence so the drop is playable, not stuck in the boundary hedge.
  const inward = Math.atan2(polygon.cx - best.x, polygon.cz - best.z);
  return { x: best.x + Math.sin(inward) * 6, z: best.z + Math.cos(inward) * 6 };
}
