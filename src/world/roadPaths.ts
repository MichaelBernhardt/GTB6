/**
 * ROAD PATH PRIMITIVES — one definition of where a street's tar, kerb, pavement and walk line run.
 *
 * These lived inside City.ts. City is the composition root of the world build and imports
 * ModelScatter (scattered models stream as part of City's chunk build), so ModelScatter can never
 * import City back: that edge is a chunk cycle, and a chunk cycle is a shipped crash (see the
 * layering note above manualChunk() in vite.config.ts). The practical consequence was that the
 * scatter pass could not see the pedestrian walk polylines at all. It approximated the pavement from
 * the road SURFACE instead — FOLIAGE_ROAD_CLEARANCE over a sampled distance grid — and that
 * approximation is wrong in exactly one place, which is where it shipped a solid trunk.
 *
 * The walk line is NOT the kerb offset. buildCityNavPaths samples the centreline at
 * ROAD_SAMPLE_SPACING, offsets it to the pavement centre, and then keeps every SECOND point, so on a
 * bend the polyline CHORDS across the curve and leaves the kerb by several units. A scattered pine
 * at (3084.7, 699.5) measured 5.91 u clear of the built road edge — comfortably legal by every
 * surface test the scatter had — and 1.33 u from the segment peds are actually routed along, which
 * is inside one trunk radius plus a body. Rebuilding the offset from GENERATED_ROADS inside
 * ModelScatter does not reproduce that: the resampling and the decimation ARE the geometry.
 *
 * So the primitives moved DOWN here instead of the consumer reaching up. This module is a leaf: its
 * only runtime import is the generated map (plus three's lerp, kept byte-identical so no placement
 * shifts). City re-exports every name unchanged, so nothing else in the tree moved, and the runtime
 * nav graph, the scatter generator and tools/qa/tree-clearance now measure the same polylines.
 */
import * as THREE from 'three';
import { GENERATED_ROADS, METRES_PER_UNIT, ROAD_BUILD_MARGIN } from './mapData';
import type { NavPath } from '../systems/NavGraph';

export interface RoadPoint { x: number; z: number; }
export interface RoadDefinition { name: string; width: number; closed?: boolean; points: RoadPoint[]; }

/** The driveable road network — straight from the generated OSM map. */
export const ROAD_NETWORK: RoadDefinition[] = GENERATED_ROADS.map((road) => ({ name: road.name, width: road.width, points: road.points }));

/** Pavement begins just behind the kerb and ends exactly at the walkable-band query boundary. */
export const SIDEWALK_INNER_EDGE = 0.38;
/** Derived from ROAD_BUILD_MARGIN, not declared beside it, so the pavement the renderer LAYS and the
 *  road footprint every clearance rule MEASURES can never disagree. Widening the pavement now widens
 *  the footprint that rail, station platforms and roadside placement are all held clear of. */
export const SIDEWALK_WIDTH = ROAD_BUILD_MARGIN - SIDEWALK_INNER_EDGE;
export const SIDEWALK_CENTER = SIDEWALK_INNER_EDGE + SIDEWALK_WIDTH / 2;

/**
 * Unit-denominated layout spacings were authored against the 2.94 m/unit (6000u) map. They must
 * track the map footprint so real-world density stays constant at any TARGET_SIZE: without this,
 * a scale-up would sample more nav nodes / sidewalk points per road (squaring the nav-graph build
 * cost) and space roadside buildings closer in real terms. LAYOUT_SCALE is 1.0 at the old scale
 * and 3.0 at the 18000u parity scale, so ROAD_SAMPLE_SPACING/NAV joins hold the same *real* pitch.
 */
export const LAYOUT_SCALE = 2.94 / METRES_PER_UNIT;
export const ROAD_SAMPLE_SPACING = Math.round(12 * LAYOUT_SCALE);

export function sampleRoadPath(points: RoadPoint[], closed: boolean, spacing: number): RoadPoint[] {
  const source = closed ? [...points, points[0]].filter((point): point is RoadPoint => Boolean(point)) : points;
  const output: RoadPoint[] = [];
  for (let segment = 0; segment < source.length - 1; segment++) {
    const start = source[segment]; const end = source[segment + 1]; if (!start || !end) continue;
    const distance = Math.hypot(end.x - start.x, end.z - start.z); const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 0; step < steps; step++) { const t = step / steps; output.push({ x: THREE.MathUtils.lerp(start.x, end.x, t), z: THREE.MathUtils.lerp(start.z, end.z, t) }); }
  }
  if (!closed && source.at(-1)) output.push({ ...source.at(-1)! });
  return output;
}

export function offsetRoadPath(points: RoadPoint[], offset: number, closed: boolean): RoadPoint[] {
  return points.map((point, index) => {
    const previous = points[index === 0 ? (closed ? points.length - 1 : 0) : index - 1] ?? point;
    const next = points[index === points.length - 1 ? (closed ? 0 : points.length - 1) : index + 1] ?? point;
    const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
    return { x: point.x - dz / length * offset, z: point.z + dx / length * offset };
  });
}

/** Pure builder for the nav-graph source polylines: one lane pair and one sidewalk pair per road,
 *  sampled exactly like the rendered geometry so waypoints sit on the drawn lanes and sidewalks.
 *  The walk pair is DECIMATED to every second point — half the ped nodes for the same routes — which
 *  is why a walk segment is not parallel to its kerb through a bend and why anything that must stay
 *  off a pavement has to measure against these polylines rather than against the tar. */
export function buildCityNavPaths(network: RoadDefinition[] = ROAD_NETWORK): { lanes: NavPath[]; walks: NavPath[] } {
  const lanes: NavPath[] = []; const walks: NavPath[] = [];
  for (const definition of network) {
    const closed = definition.closed ?? false;
    const sampled = sampleRoadPath(definition.points, closed, ROAD_SAMPLE_SPACING);
    lanes.push({ points: offsetRoadPath(sampled, -definition.width * 0.23, closed), closed });
    lanes.push({ points: offsetRoadPath(sampled, definition.width * 0.23, closed).reverse(), closed });
    for (const side of [-1, 1]) walks.push({ points: offsetRoadPath(sampled, side * (definition.width / 2 + SIDEWALK_CENTER), closed).filter((_, index) => index % 2 === 0), closed });
  }
  return { lanes, walks };
}
