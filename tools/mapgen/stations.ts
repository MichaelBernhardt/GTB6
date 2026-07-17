/**
 * Station planning for the thinned rail lines (owner: "we need stations, along with models, that
 * the trains stop at. The names/locations may be in the OSM data already? Otherwise add your own.
 * Put a station at track ends as well.").
 *
 * Pure geometry over the FINAL railway polylines (post-thin, post-spur, pre-fit, metres):
 *   1. snap OSM railway=station/halt nodes onto each kept line (within `snapDistance`),
 *   2. guarantee a station at BOTH ends of every line (an OSM stop near an end becomes the end),
 *   3. fill any arc gap over `maxGap` with synthesized stops so spacing lands in the 2.5–5 km band,
 *   4. name synthesized stops after the nearest district with SA-flavour compass suffixes on repeats.
 * The Lughawe Spur is special-cased: its airport end is the existing 'Lughawe Halt' (the 3D halt
 * already stands beside the apron) and its mainline end reads as a junction station.
 * Deterministic throughout — no randomness, stable across runs.
 */
import type { Pt } from './types';

export interface StationCandidate { name: string; x: number; z: number; }

export interface PlannedStation {
  name: string;
  /** Owning rail line (matches the railway's emitted name). */
  line: string;
  /** Arc position along the line polyline, metres from points[0] (kept for ordering/tests). */
  s: number;
  x: number;
  z: number;
  source: 'osm' | 'synthetic';
}

export interface StationPlanOptions {
  /** OSM stations further than this (m) from a line's polyline don't belong to it. */
  snapDistance: number;
  /** An OSM stop within this arc (m) of a line end IS the end station (no doubling up). */
  endMergeArc: number;
  /** Snapped stops closer together than this (m) collapse to the one nearest the rails. */
  minSpacing: number;
  /** Arc gaps above this (m) get evenly-spaced synthetic infill stops (gap target 2.5–5 km). */
  maxGap: number;
}

export const STATION_PLAN_DEFAULTS: StationPlanOptions = {
  snapDistance: 120,
  endMergeArc: 600,
  minSpacing: 1000,
  maxGap: 5000,
};

/** Total arc length of a polyline (m). */
export function polylineArc(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  return total;
}

/** Closest point of a polyline to (px, pz): its arc position and the offline distance. */
export function projectOntoPolyline(points: Pt[], px: number, pz: number): { s: number; dist: number } {
  let bestS = 0; let bestD = Infinity; let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const len = Math.hypot(dx, dz);
    if (len < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / (len * len)));
    const d = Math.hypot(px - (a.x + dx * t), pz - (a.z + dz * t));
    if (d < bestD) { bestD = d; bestS = acc + t * len; }
    acc += len;
  }
  return { s: bestS, dist: bestD };
}

/** Point on a polyline at arc position s (clamped to the ends). */
export function pointAtArc(points: Pt[], s: number): Pt {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (acc + len >= s && len > 1e-9) {
      const t = Math.max(0, (s - acc) / len);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    acc += len;
  }
  return { ...points[points.length - 1]! };
}

/** Afrikaans compass suffix for a repeat-name tiebreak, from the offset off the district centre. */
const compass = (dx: number, dz: number): string =>
  Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'Oos' : 'Wes') : (dz > 0 ? 'Suid' : 'Noord');

/** OSM names keep their own flavour; bare names get ' Station' so the sign reads as one. */
export function normalizeOsmName(name: string): string {
  return /\b(station|halt|stasie|junction|halte)\b/i.test(name) ? name : `${name} Station`;
}

/** One stop along a line before naming/materialisation. */
interface StopEntry { s: number; osmName?: string; }

/**
 * Plan the stop arc positions for one line: snapped OSM stops (deduped along the arc), both ends
 * always covered (merging a near-end OSM stop into the end), and synthetic infill so no gap
 * exceeds `maxGap` (evenly split, so infill spacing stays >= maxGap/2 = the 2.5 km floor).
 */
export function planLineStops(points: Pt[], osm: StationCandidate[], options: StationPlanOptions = STATION_PLAN_DEFAULTS): StopEntry[] {
  const total = polylineArc(points);
  const snapped = osm
    .map((station) => ({ name: station.name, ...projectOntoPolyline(points, station.x, station.z) }))
    .filter((station) => station.dist <= options.snapDistance)
    .sort((a, b) => a.s - b.s || a.dist - b.dist);
  const deduped: Array<{ name: string; s: number; dist: number }> = [];
  for (const station of snapped) {
    const prev = deduped[deduped.length - 1];
    if (prev && station.s - prev.s < options.minSpacing) { if (station.dist < prev.dist) deduped[deduped.length - 1] = station; continue; }
    deduped.push(station);
  }
  const interior = deduped.filter((station) => station.s > options.endMergeArc && station.s < total - options.endMergeArc);
  const startOsm = deduped.find((station) => station.s <= options.endMergeArc);
  const endOsm = [...deduped].reverse().find((station) => station.s >= total - options.endMergeArc);
  const entries: StopEntry[] = [
    { s: 0, osmName: startOsm?.name },
    ...interior.map((station) => ({ s: station.s, osmName: station.name })),
    { s: total, osmName: endOsm?.name },
  ];
  const filled: StopEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    filled.push(entries[i]!);
    const next = entries[i + 1];
    if (!next) break;
    const gap = next.s - entries[i]!.s;
    const inserts = Math.ceil(gap / options.maxGap) - 1;
    for (let k = 1; k <= inserts; k++) filled.push({ s: entries[i]!.s + (gap * k) / (inserts + 1) });
  }
  return filled;
}

/**
 * Plan every line's stations and name them. Names are globally unique unless two lines share the
 * same physical stop (within 250 m — a legit interchange keeps one name).
 */
export function buildStations(
  lines: Array<{ name: string; points: Pt[] }>,
  osmStations: StationCandidate[],
  districts: Array<{ name: string; x: number; z: number }>,
  options: StationPlanOptions = STATION_PLAN_DEFAULTS,
): { stations: PlannedStation[]; log: string } {
  const used = new Map<string, Pt>();
  const claim = (candidates: string[], x: number, z: number): string => {
    for (const name of candidates) {
      const prior = used.get(name);
      if (!prior) { used.set(name, { x, z }); return name; }
      if (Math.hypot(prior.x - x, prior.z - z) < 250) return name; // same physical stop on another line
    }
    const base = candidates[0]!;
    for (let n = 2; ; n++) { const name = `${base} ${n}`; if (!used.has(name)) { used.set(name, { x, z }); return name; } }
  };
  const nearestDistrict = (x: number, z: number): { name: string; x: number; z: number } => {
    let best = districts[0] ?? { name: 'Veld', x: 0, z: 0 }; let bestD = Infinity;
    for (const district of districts) {
      const d = (district.x - x) ** 2 + (district.z - z) ** 2;
      if (d < bestD) { bestD = d; best = district; }
    }
    return best;
  };
  const synthNames = (x: number, z: number, kind: 'Station' | 'Junction'): string[] => {
    const district = nearestDistrict(x, z);
    const wind = compass(x - district.x, z - district.z);
    return [`${district.name} ${kind}`, `${district.name}-${wind} ${kind}`, `${district.name} Halt`];
  };

  /** A synthetic stop this close to an already-planned station is the same interchange — reuse its name. */
  const INTERCHANGE = 400;
  const stations: PlannedStation[] = [];
  let fromOsm = 0; let synthesized = 0;
  for (const line of lines) {
    if (line.points.length < 2) continue;
    const spur = /lughawe/i.test(line.name);
    const total = polylineArc(line.points);
    for (const stop of planLineStops(line.points, osmStations, options)) {
      const p = pointAtArc(line.points, stop.s);
      let name: string;
      if (spur && stop.s >= total - 1) name = claim(['Lughawe Halt'], p.x, p.z); // the airport's existing halt
      else if (stop.osmName) name = claim([normalizeOsmName(stop.osmName)], p.x, p.z);
      else {
        const shared = stations.find((existing) => existing.line !== line.name && Math.hypot(existing.x - p.x, existing.z - p.z) < INTERCHANGE);
        name = shared ? shared.name : claim(synthNames(p.x, p.z, spur && stop.s <= 1 ? 'Junction' : 'Station'), p.x, p.z);
      }
      stations.push({ name, line: line.name, s: stop.s, x: p.x, z: p.z, source: stop.osmName ? 'osm' : 'synthetic' });
      if (stop.osmName) fromOsm++; else synthesized++;
    }
  }
  const log = `stations: ${stations.length} across ${lines.length} lines (${fromOsm} snapped from OSM, ${synthesized} synthesized)`;
  return { stations, log };
}
