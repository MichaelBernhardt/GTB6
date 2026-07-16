/**
 * Railway thinning (owner: "The railways are very dense. Thin it out to just a few lines").
 *
 * The raw OSM extract carries every yard, siding, crossover and spur — 850+ ways, mostly the
 * Braamfontein/Germiston yard spaghetti. Real passenger lines are tagged usage=main/branch and
 * carry no service tag, so:
 *
 *   1. keep only service-free main/branch/untagged rail ways,
 *   2. chain them into continuous lines (shared endpoint node ids),
 *   3. drop short fragments and lines that mostly duplicate an already-kept parallel twin
 *      (double-track mainlines are mapped as two ways a few metres apart),
 *   4. keep the longest few and name them by heading.
 *
 * The synthetic airport spur is added separately in process.ts (it needs the coast graft).
 */
import { chainWays } from './coast';
import type { OsmNode, OsmWay, Pt } from './types';

export interface RailLine {
  name: string;
  points: Pt[];
}

export interface RailThinOptions {
  /** Chains shorter than this (m) are fragments, not lines. */
  minLength: number;
  /** Samples within this (m) of a kept line count as duplicated. */
  duplicateDistance: number;
  /** Fraction of duplicated samples above which the whole chain is dropped. */
  duplicateFraction: number;
  /** Keep at most this many lines (longest first). */
  maxLines: number;
}

export const RAIL_THIN_DEFAULTS: RailThinOptions = {
  minLength: 2500,
  duplicateDistance: 45,
  duplicateFraction: 0.55,
  maxLines: 6,
};

/** True for ways that are part of a real running line, not yard/siding/spur clutter. */
export function isMainlineRail(way: OsmWay): boolean {
  const tags = way.tags ?? {};
  if (tags.railway !== 'rail' || !way.nodes || way.nodes.length < 2) return false;
  if (tags.service !== undefined) return false;
  return tags.usage === undefined || tags.usage === 'main' || tags.usage === 'branch';
}

function polylineLength(points: Pt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
  return total;
}

function pointToPolylineDistance(p: Pt, line: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!; const b = line[i]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
  }
  return best;
}

/** Sample a polyline every ~step metres (vertices included). */
function samplePolyline(points: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(len / step));
    for (let s = 0; s < steps; s++) out.push({ x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps });
  }
  out.push({ ...points[points.length - 1]! });
  return out;
}

/** Compass-flavoured name from a line's endpoint bearing (deterministic, stable across runs). */
function nameLine(points: Pt[], index: number): string {
  const a = points[0]!; const b = points[points.length - 1]!;
  const dx = b.x - a.x; const dz = b.z - a.z;
  if (index === 0) return 'Metrorail Main Line';
  const heading = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'East' : 'West') : (dz > 0 ? 'South' : 'North');
  return `Metrorail ${heading} Line`;
}

export function thinRailways(
  ways: OsmWay[],
  nodes: Map<number, OsmNode>,
  project: (lat: number, lon: number) => Pt,
  inBbox: (lat: number, lon: number) => boolean,
  options: RailThinOptions = RAIL_THIN_DEFAULTS,
): { lines: RailLine[]; log: string } {
  const mainline = ways.filter(isMainlineRail);
  const chains = chainWays(mainline);
  const candidates = chains
    .map((chain) => chain
      .map((id) => nodes.get(id))
      .filter((node): node is OsmNode => node !== undefined && inBbox(node.lat, node.lon))
      .map((node) => project(node.lat, node.lon)))
    .filter((points) => points.length >= 2)
    .map((points) => ({ points, length: polylineLength(points) }))
    .filter((line) => line.length >= options.minLength)
    .sort((a, b) => b.length - a.length);

  const kept: Array<{ points: Pt[]; length: number }> = [];
  let duplicates = 0;
  for (const candidate of candidates) {
    if (kept.length >= options.maxLines) break;
    const samples = samplePolyline(candidate.points, 120);
    let covered = 0;
    for (const sample of samples) {
      if (kept.some((line) => pointToPolylineDistance(sample, line.points) <= options.duplicateDistance)) covered++;
    }
    if (kept.length > 0 && covered / samples.length >= options.duplicateFraction) { duplicates++; continue; }
    kept.push(candidate);
  }

  const lines = kept.map((line, index) => ({ name: nameLine(line.points, index), points: line.points }));
  const keptKm = kept.reduce((sum, line) => sum + line.length, 0) / 1000;
  const log = `railways: ${ways.filter((w) => w.tags?.railway === 'rail').length} raw ways -> ${chains.length} mainline chains -> ` +
    `${lines.length} lines kept (${keptKm.toFixed(1)} km), ${duplicates} parallel twins dropped`;
  return { lines, log };
}
