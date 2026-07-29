/**
 * Rail/road deconfliction.
 *
 * THE BUG THIS EXISTS FOR. A road is not as wide as the map says it is. `map.roads[].width` is the
 * carriageway, but the build lays a kerb and a raised sidewalk outside it too, so a road declared 14 u
 * is 21 u of finished surface on the ground (see ROAD_BUILD_MARGIN in mapData). Every clearance rule
 * that trusted the declared width was therefore wrong by 3.5 u a side, and the railway had no clearance
 * rule at all: the thinned OSM mainline and the OSM arterials were emitted independently, so wherever
 * the two ran the same corridor — which in Johannesburg is most of the Main Reef alignment — the
 * ballast was drawn straight through the tar. Measured on the shipped map before this pass: 4.18 km of
 * the 22.5 km network had its ballast inside a carriageway, 4.90 km inside the built footprint, and the
 * Metrorail North Line was 56% buried.
 *
 * WHAT IT DOES. Rail and road are told apart by ANGLE, not by distance:
 *
 *   - Running TOGETHER (tangents within `parallelCos`): the two share a corridor and one of them has to
 *     give. The rail is pushed sideways until its ballast clears the BUILT road footprint. The push is
 *     smoothed over `smoothSpan` samples and tapered to zero at both line ends, so the line bends like
 *     track rather than kinking, and so a grafted end (the Lughawe Spur's airport halt) cannot drift.
 *   - CROSSING (tangents beyond `parallelCos`): the line genuinely has to get to the other side. Nothing
 *     moves — the crossing is recorded and the renderer lays a level crossing there, which is both the
 *     honest answer and better content than a nudge.
 *
 * The rail moves rather than the road because the rail is the cheaper object: five polylines, whose only
 * dependants are the station sites projected onto them and the train paths. The road network carries the
 * junctions, the signals, the vehicle nav graph and the map view.
 *
 * Deterministic: pure arithmetic over the map data, no randomness, no iteration order dependence.
 */

export interface RailPt { x: number; z: number }

/** What the caller must be able to answer about the built road surface nearest a point. */
export interface RailRoadProbe {
  /** Signed distance to the nearest BUILT road edge — negative inside the footprint. */
  clearance: number;
  /** Unit vector from the road centreline toward the probed point: the direction that gains room. */
  awayX: number;
  awayZ: number;
  /** Unit tangent of the offending road, for the parallel/crossing test. */
  dirX: number;
  dirZ: number;
  /** Half-width of that road as built, so a crossing can be marked across its full carriageway. */
  half: number;
}

export type RailRoadProbeFn = (x: number, z: number) => RailRoadProbe | undefined;

export interface RailDeconflictOptions {
  /** Half-width of the ballast bed that must end up clear. */
  corridorHalf: number;
  /** Extra room demanded beyond the ballast edge. */
  clearance: number;
  /** Arc-length pitch the line is resampled at before offsets are computed. */
  pitch: number;
  /** Lateral offsets are averaged over +/- this many samples so the line bends instead of kinking. */
  smoothSpan: number;
  /** Hard cap on how far any point may move. A conflict that cannot be solved inside this stays put. */
  maxShift: number;
  /** |cos(angle)| at or above which rail and road count as running together rather than crossing. */
  parallelCos: number;
  /** Arc length over which the shift ramps to zero at each end, pinning grafted endpoints. */
  endTaper: number;
  /** Clear samples tolerated inside one conflict run before it is treated as two separate runs. */
  runGap: number;
  /** Douglas-Peucker tolerance applied to the shifted line, to keep the vertex count sane. */
  simplifyTolerance: number;
}

export const RAIL_DECONFLICT_DEFAULTS: RailDeconflictOptions = {
  corridorHalf: 2.6,
  clearance: 2,
  pitch: 8,
  smoothSpan: 7,
  maxShift: 30,
  parallelCos: Math.cos((30 * Math.PI) / 180), // within 30 degrees of parallel = sharing a corridor
  endTaper: 120,
  runGap: 4,
  simplifyTolerance: 0.35,
};

/** A place where a rail line genuinely has to get across a carriageway. */
export interface RailCrossing {
  x: number;
  z: number;
  /** Unit tangent of the rail at the crossing. */
  dirX: number;
  dirZ: number;
  /** Unit tangent of the carriageway being crossed — the direction traffic approaches from. */
  roadDirX: number;
  roadDirZ: number;
  /** Half-width of the built road at the crossing, so markings can span it. */
  roadHalf: number;
}

export interface RailDeconflictResult {
  points: RailPt[];
  crossings: RailCrossing[];
  /** Largest lateral movement applied, in world units. */
  maxShift: number;
  /** Arc length that had to move at all. */
  shiftedLength: number;
}

/** Arc-length resample: vertices are replaced by evenly spaced samples, endpoints preserved exactly. */
export function resampleRail(points: readonly RailPt[], pitch: number): RailPt[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const out: RailPt[] = [{ ...points[0]! }];
  let carry = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!; const b = points[index]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-9) continue;
    let travelled = pitch - carry;
    while (travelled < length) {
      const t = travelled / length;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      travelled += pitch;
    }
    carry = (carry + length) % pitch;
  }
  const last = points[points.length - 1]!;
  const tail = out[out.length - 1]!;
  if (Math.hypot(tail.x - last.x, tail.z - last.z) > 1e-6) out.push({ ...last });
  return out;
}

/** Unit tangent at each sample (central difference; one-sided at the ends). */
function tangents(points: readonly RailPt[]): Array<{ x: number; z: number }> {
  return points.map((_, index) => {
    const a = points[Math.max(0, index - 1)]!;
    const b = points[Math.min(points.length - 1, index + 1)]!;
    const dx = b.x - a.x; const dz = b.z - a.z;
    const length = Math.hypot(dx, dz) || 1;
    return { x: dx / length, z: dz / length };
  });
}

/**
 * Widen a signed offset profile to the largest magnitude within +/- span samples.
 *
 * Smoothing alone loses the guarantee it was added for: averaging a demand spike against its clear
 * neighbours pulls the middle of the run back under the clearance it just asked for. Dilating first
 * turns each run into a plateau at its own peak, so the subsequent average leaves the interior at that
 * peak and only rounds the shoulders — which is exactly the shape wanted, a lead-in and a lead-out.
 */
function dilate(values: readonly number[], span: number): number[] {
  if (span <= 0) return values.slice();
  return values.map((_, index) => {
    let best = 0;
    for (let k = Math.max(0, index - span); k <= Math.min(values.length - 1, index + span); k++) {
      if (Math.abs(values[k]!) > Math.abs(best)) best = values[k]!;
    }
    return best;
  });
}

/** Box-smooth a signed offset profile over +/- span samples. */
function smooth(values: readonly number[], span: number): number[] {
  if (span <= 0) return values.slice();
  return values.map((_, index) => {
    let sum = 0; let count = 0;
    for (let k = index - span; k <= index + span; k++) {
      if (k < 0 || k >= values.length) continue;
      sum += values[k]!; count++;
    }
    return count > 0 ? sum / count : 0;
  });
}

/** Douglas-Peucker. Only ever deletes vertices, so the shifted alignment is preserved to `tolerance`. */
export function simplifyRail(points: readonly RailPt[], tolerance: number): RailPt[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true; keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first]!; const b = points[last]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz;
    let worst = 0; let at = -1;
    for (let index = first + 1; index < last; index++) {
      const p = points[index]!;
      const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / lengthSq)) : 0;
      const distance = Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
      if (distance > worst) { worst = distance; at = index; }
    }
    if (at !== -1 && worst > tolerance) { keep[at] = true; stack.push([first, at], [at, last]); }
  }
  return points.filter((_, index) => keep[index]).map((point) => ({ ...point }));
}

/**
 * Push a rail line clear of every built road it runs alongside, leaving genuine crossings alone.
 * `probe` is asked about the BUILT footprint (carriageway + kerb + sidewalk), never the declared width.
 */
export function deconflictRailway(
  points: readonly RailPt[],
  probe: RailRoadProbeFn,
  options: RailDeconflictOptions = RAIL_DECONFLICT_DEFAULTS,
): RailDeconflictResult {
  if (points.length < 2) {
    return { points: points.map((point) => ({ ...point })), crossings: [], maxShift: 0, shiftedLength: 0 };
  }
  const samples = resampleRail(points, options.pitch);
  const required = options.corridorHalf + options.clearance;
  const crossings: RailCrossing[] = [];
  let offsets = new Array<number>(samples.length).fill(0);

  // Three passes: a push can bring a sample alongside a DIFFERENT road, so the demand is re-measured at
  // the already-shifted positions and topped up.
  for (let pass = 0; pass < 3; pass++) {
    const frames = tangents(samples);
    /** Per-sample room wanted, and which way the nearest road says is open. */
    const need = new Array<number>(samples.length).fill(0);
    const openSide = new Array<number>(samples.length).fill(0);
    for (let index = 0; index < samples.length; index++) {
      const base = samples[index]!; const tangent = frames[index]!;
      const at = probe(base.x + -tangent.z * offsets[index]!, base.z + tangent.x * offsets[index]!);
      if (at === undefined || at.clearance >= required) continue;
      const alignment = Math.abs(tangent.x * at.dirX + tangent.z * at.dirZ);
      if (alignment < options.parallelCos) {
        // Genuinely crossing: the line has to get to the other side, so nothing moves here.
        if (pass === 0) {
          crossings.push({
            x: base.x, z: base.z, dirX: tangent.x, dirZ: tangent.z,
            roadDirX: at.dirX, roadDirZ: at.dirZ, roadHalf: at.half,
          });
        }
        continue;
      }
      need[index] = required - at.clearance;
      // A sample is displaced along the rail's LEFT normal (-tz, tx); `away` is the direction that
      // gains room. Move along the normal whichever way agrees with it.
      openSide[index] = tangent.x * at.awayZ - tangent.z * at.awayX >= 0 ? 1 : -1;
    }

    // Side is decided PER CONFLICT RUN, not per sample. A line lying inside a road crosses that road's
    // centreline as it weaves, which flips the per-sample "open" direction from one sample to the next;
    // smoothing those against each other cancels to nothing and the line never leaves the tar. Each
    // contiguous run instead commits to the side its samples want on balance, and moves as one piece.
    const demand = new Array<number>(samples.length).fill(0);
    for (let start = 0; start < samples.length;) {
      if (need[start] === 0) { start++; continue; }
      let end = start;
      let gap = 0;
      for (let index = start + 1; index < samples.length; index++) {
        if (need[index] > 0) { end = index; gap = 0; continue; }
        if (++gap > options.runGap) break;
      }
      let vote = 0;
      for (let index = start; index <= end; index++) vote += openSide[index]! * need[index]!;
      const side = vote >= 0 ? 1 : -1;
      for (let index = start; index <= end; index++) if (need[index]! > 0) demand[index] = offsets[index]! + side * need[index]!;
      start = end + 1;
    }

    // A sample that came out clear keeps the offset that made it clear; the rest top theirs up. Then
    // dilate and smooth, so the line bends like track instead of stepping sideways and no sample is
    // averaged back below the room it asked for.
    const merged = demand.map((value, index) => (value === 0 ? offsets[index]! : value));
    offsets = smooth(dilate(merged, options.smoothSpan), options.smoothSpan);
  }

  // Taper to zero at both ends so grafted endpoints (the airport spur's halt) never drift, and cap
  // the movement so an unsolvable pocket stays put instead of flinging the line across the city.
  let arc = 0;
  const cumulative = samples.map((point, index) => {
    if (index > 0) arc += Math.hypot(point.x - samples[index - 1]!.x, point.z - samples[index - 1]!.z);
    return arc;
  });
  const total = arc;
  const frames = tangents(samples);
  let maxShift = 0; let shiftedLength = 0;
  const shifted = samples.map((point, index) => {
    const fromStart = cumulative[index]!;
    const taper = options.endTaper > 0
      ? Math.min(1, Math.min(fromStart, total - fromStart) / options.endTaper)
      : 1;
    const capped = Math.max(-options.maxShift, Math.min(options.maxShift, offsets[index]!)) * taper;
    const tangent = frames[index]!;
    maxShift = Math.max(maxShift, Math.abs(capped));
    if (Math.abs(capped) > 0.01 && index > 0) {
      shiftedLength += Math.hypot(point.x - samples[index - 1]!.x, point.z - samples[index - 1]!.z);
    }
    return { x: point.x + -tangent.z * capped, z: point.z + tangent.x * capped };
  });

  return {
    points: simplifyRail(shifted, options.simplifyTolerance),
    crossings: dedupeCrossings(crossings, options.pitch * 3),
    maxShift,
    shiftedLength,
  };
}

/** One crossing per contiguous run of crossing samples. */
function dedupeCrossings(crossings: readonly RailCrossing[], minSpacing: number): RailCrossing[] {
  const out: RailCrossing[] = [];
  for (const crossing of crossings) {
    if (out.some((prior) => Math.hypot(prior.x - crossing.x, prior.z - crossing.z) < minSpacing)) continue;
    out.push(crossing);
  }
  return out;
}
