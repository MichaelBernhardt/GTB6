/**
 * Egoli Wal: grafts an inland DAM (Vaal-Dam character) plus a rural farmland corridor onto the
 * west edge of the Joburg crop. This used to be a Cape Town Atlantic-seaboard graft — the
 * ocean is gone because Johannesburg is landlocked and a sea on the west edge was the single
 * most immersion-breaking thing on the map. The Cape extract is still fetched and used, but
 * only for its beach polygons and its place-node district names (Sea Point, Green Point,
 * Bantry Bay, ...), which a dozen runtime anchors resolve against; its coastline GEOMETRY is
 * discarded in favour of the synthetic crenellated dam shore in dam.ts.
 *
 * Everything here works in the Joburg-projected METRES space of the road network; the
 * shared fit transform in process.ts turns it into game units afterwards.
 */
import {
  AIRPORT_ACCESS_ROAD_NAME,
  AIRPORT_NAME,
  AIRPORT_RUNWAY_BEARING_RAD,
  AIRPORT_RUNWAY_LENGTH_M,
  AIRPORT_Z_FRACTION,
  BORDER_VELD_DEPTH_MAX_M,
  BORDER_VELD_DEPTH_MIN_M,
  BORDER_VELD_NAME,
  CAPE_BBOX,
  COAST_LOOP_LINKS,
  COAST_ROAD_SETBACK_M,
  COAST_STRETCH_Z,
  COASTAL_ROAD_NAME,
  CORRIDOR_LINKS,
  CORRIDOR_WIDTH_M,
  DAM_LEVEL_M,
  DAM_NAME,
  DAM_ROAD_PRESMOOTH_M,
  DAM_SHORE_SETBACK_M,
  DAM_Z_END_FRACTION,
  DAM_Z_START_FRACTION,
  FRONTAGE_ROAD_NAME,
  HARBOUR_DISTRICT_NAME,
  LAKE_NAME,
  LAKE_RADIUS_M,
  LAKESIDE_TRACK_NAME,
  OCEAN_EXTENT_M,
  PADSTAL_NAME,
  PORT_ACCESS_ROAD_NAME,
  PORT_NAME,
  PORT_PIER_LENGTH_M,
  ROAD_WIDTHS,
  SIMPLIFY_TOLERANCE_M,
  TRACK_WIDTHS,
} from './config';
import { buildDamIsland, buildDamPolygon, buildDamShore, buildShoreRoad, damSampler, type DamShore } from './dam';
import { nodeDegrees, type RoadNetwork } from './graph';
import { fbm, nameSeed } from './meander';
import { boundsOf, makeProjector } from './projection';
import { ridgeMetresAt } from './ridge';
import { simplifyPolyline } from './simplify';
import type { MapRuralBuilding, OsmNode, OsmResponse, OsmWay, Pt, RoadKind } from './types';

/** Airport geometry in projected metres (turned into game units by the shared fit transform). */
export interface CoastAirport {
  name: string;
  runway: Pt[];
  taxiway: Pt[];
  apron: Pt[];
  buildings: Pt[][];
  boundary: Pt[];
  center: Pt;
}
/** Sea-port geometry in projected metres. */
export interface CoastPort {
  name: string;
  pier: Pt[];
  apron: Pt[];
}
/** Reservoir/dam geometry in projected metres. */
export interface CoastLake {
  name: string;
  polygon: Pt[];
}

export interface CoastGraftResult {
  /** South-to-north shoreline (metres). Single-valued in x per z — see dam.ts. */
  coastline: Pt[];
  /** Closed dam-water polygon (metres). Still keyed `ocean` so runtime consumers resolve. */
  ocean: Pt[];
  /** The dam's z-band and shore sampler: outside the band the west strip is dry veld. */
  dam: DamShore;
  /** The dam's island, emitted as a scrub polygon with a local elevation bump. */
  damIsland: { center: Pt; polygon: Pt[] };
  beaches: Array<{ name: string; points: Pt[] }>;
  farmland: Array<{ name: string; points: Pt[] }>;
  tracks: Array<{ name: string; kind: 'track'; width: number; points: Pt[] }>;
  farms: Array<{ p: Pt; kind: MapRuralBuilding['kind'] }>;
  padstal: { p: Pt; name: string };
  harbour: Pt;
  districts: Array<{ name: string; p: Pt }>;
  airport: CoastAirport;
  port: CoastPort;
  lake: CoastLake;
  /** Corridor band (metres, x extents). */
  corridorEastX: number;
  corridorWestX: number;
  /** Node ids of the coastal highway's two dangling tips (for the orbital loop links). */
  highwayEndIds: { south: number; north: number };
  log: string[];
}

const seeded = (a: number, b: number): number => {
  const value = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

/** Chain open coastline ways (shared endpoint node ids) into polylines; longest first. */
export function chainWays(ways: OsmWay[]): number[][] {
  const remaining = ways.filter((way) => way.nodes && way.nodes.length >= 2).map((way) => [...way.nodes]);
  const chains: number[][] = [];
  while (remaining.length > 0) {
    const chain = remaining.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      for (let index = 0; index < remaining.length; index++) {
        const candidate = remaining[index]!;
        if (candidate[0] === chain[chain.length - 1]) chain.push(...candidate.slice(1));
        else if (candidate[candidate.length - 1] === chain[chain.length - 1]) chain.push(...candidate.slice(0, -1).reverse());
        else if (candidate[candidate.length - 1] === chain[0]) chain.unshift(...candidate.slice(0, -1));
        else if (candidate[0] === chain[0]) chain.unshift(...candidate.slice(1).reverse());
        else continue;
        remaining.splice(index, 1);
        extended = true;
        break;
      }
    }
    chains.push(chain);
  }
  return chains.sort((a, b) => b.length - a.length);
}

/** Perpendicular offset of an open polyline (positive offset = to the right of travel). */
export function offsetPolyline(points: Pt[], offset: number): Pt[] {
  return points.map((point, index) => {
    const previous = points[Math.max(0, index - 1)]!;
    const next = points[Math.min(points.length - 1, index + 1)]!;
    const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
    return { x: point.x - (dz / length) * offset, z: point.z + (dx / length) * offset };
  });
}

/** Separating-axis overlap test for two convex quads (true when they intersect). */
export function quadsOverlap(a: Pt[], b: Pt[]): boolean {
  for (const [first, second] of [[a, b], [b, a]] as const) {
    for (let i = 0; i < first.length; i++) {
      const p = first[i]!; const q = first[(i + 1) % first.length]!;
      const axisX = -(q.z - p.z); const axisZ = q.x - p.x;
      let minA = Infinity; let maxA = -Infinity; let minB = Infinity; let maxB = -Infinity;
      for (const v of first) { const d = v.x * axisX + v.z * axisZ; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const v of second) { const d = v.x * axisX + v.z * axisZ; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA < minB || maxB < minA) return false; // separating axis found
    }
  }
  return true;
}

/** Catmull-Rom through control points, sampled ~every `step` metres — the "creative curves". */
export function smoothCurve(controls: Pt[], step = 90): Pt[] {
  if (controls.length < 3) return [...controls];
  const output: Pt[] = [];
  for (let index = 0; index < controls.length - 1; index++) {
    const p0 = controls[Math.max(0, index - 1)]!;
    const p1 = controls[index]!;
    const p2 = controls[index + 1]!;
    const p3 = controls[Math.min(controls.length - 1, index + 2)]!;
    const span = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(2, Math.round(span / step));
    for (let s = 0; s < steps; s++) {
      const t = s / steps; const t2 = t * t; const t3 = t2 * t;
      output.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        z: 0.5 * (2 * p1.z + (-p0.z + p2.z) * t + (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 + (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
      });
    }
  }
  output.push({ ...controls[controls.length - 1]! });
  return output;
}

/**
 * The whole graft: transforms the Cape strip into place west of the Joburg block, inserts
 * the coastal highway + corridor roads into the network, and returns all the side-channel
 * geometry (ocean, beaches, farmland, farms, padstal, harbour, districts).
 */
export function graftCoastAndCorridor(
  net: RoadNetwork,
  cape: OsmResponse,
  joburgWestStubMargin = 420,
  /** Golf courses / parks the synthetic reservoir must not be dropped on top of (metres). */
  avoidCircles: Array<{ x: number; z: number; r: number }> = [],
): CoastGraftResult {
  const log: string[] = [];
  const jb = boundsOf(net.nodes.values());
  const project = makeProjector({ lat: (CAPE_BBOX.south + CAPE_BBOX.north) / 2, lon: (CAPE_BBOX.west + CAPE_BBOX.east) / 2 });

  // ---- Parse the Cape extract ------------------------------------------------
  const nodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  const places: Array<{ name: string; p: Pt }> = [];
  for (const element of cape.elements) {
    if (element.type === 'node') {
      nodes.set(element.id, element);
      if (element.tags?.place && element.tags.name) places.push({ name: element.tags.name, p: project(element.lat, element.lon) });
    } else if (element.type === 'way') ways.push(element);
  }
  const beachWays = ways.filter((way) => way.tags?.natural === 'beach' && way.nodes && way.nodes[0] === way.nodes[way.nodes.length - 1]);

  // ---- The dam ------------------------------------------------------------------
  // The Cape coastline geometry is deliberately NOT used: Joburg is landlocked. What we keep
  // from the Cape extract is the beach polygons (they become dam-shore resort strips) and the
  // place-node district names, which several runtime anchors resolve against.
  const corridorEastX = jb.minX;
  const corridorWestX = jb.minX - CORRIDOR_WIDTH_M;
  // Cape geometry still defines the frame the beach polygons are transformed into.
  const coastTargetX = corridorWestX - DAM_SHORE_SETBACK_M;
  const jbSpanZ = jb.maxZ - jb.minZ;
  const dam = buildDamShore({
    meanX: coastTargetX,
    northZ: jb.minZ + jbSpanZ * DAM_Z_START_FRACTION,
    southZ: jb.minZ + jbSpanZ * DAM_Z_END_FRACTION,
  });
  const coastline = dam.points;
  const damIsland = buildDamIsland(dam);
  // Nothing synthetic may be generated in the water. Every graft polyline that wanders west
  // (corridor links, farm lanes, dirt tracks) runs through this — smoothCurve is Catmull-Rom
  // and overshoots its controls, which is how 'Rooibos Route' put a vertex in the dam.
  const damSample = damSampler(dam);
  const clampToLand = (p: Pt): Pt => {
    const limit = damSample.inBand(p.z) ? damSample.xAt(p.z) + 120 : corridorWestX - 900;
    return { x: Math.max(p.x, limit), z: p.z };
  };
  const capeBounds = boundsOf(
    beachWays.flatMap((way) => way.nodes.map((id) => nodes.get(id)).filter((n): n is OsmNode => Boolean(n)).map((n) => project(n.lat, n.lon))),
  );
  const beachMidZ = Number.isFinite(capeBounds.minZ) ? (capeBounds.minZ + capeBounds.maxZ) / 2 : 0;
  const beachMidX = Number.isFinite(capeBounds.minX) ? (capeBounds.minX + capeBounds.maxX) / 2 : 0;
  // Beaches (now dam-shore resort strips) land on the dam's own z-band, not the old sea strip.
  const toComposite = (p: Pt): Pt => ({
    x: p.x - beachMidX + coastTargetX,
    z: (p.z - beachMidZ) * COAST_STRETCH_Z + (dam.northZ + dam.southZ) / 2,
  });
  log.push(
    `dam: '${DAM_NAME}' ${coastline.length}-pt crenellated shore, mean x~${Math.round(coastTargetX)} m, ` +
      `z ${Math.round(dam.northZ)}..${Math.round(dam.southZ)} m (${Math.round(dam.southZ - dam.northZ)} m long), ` +
      `shore x ${Math.round(dam.minX)}..${Math.round(dam.maxX)} (${Math.round(dam.maxX - dam.minX)} m of crenellation)`,
  );

  // ---- Dam-shore road (offset inland = east of the shoreline) --------------------
  // The shoreline runs south -> north (decreasing z); a positive perpendicular offset of
  // that travel direction points east, i.e. inland. The offset base is smoothed HARD first
  // (DAM_ROAD_PRESMOOTH_M, much coarser than the shore itself) so the 900 m drowned-valley
  // arms don't fold the road back over itself — the road crosses the bay mouths on causeways,
  // which is exactly what a real dam-shore road does, while the raw crenellated polyline
  // still drives the water polygon and the terrain.
  const highwayPoints = simplifyPolyline(
    buildShoreRoad(dam, COAST_ROAD_SETBACK_M, DAM_ROAD_PRESMOOTH_M * 4),
    SIMPLIFY_TOLERANCE_M * 3,
  );

  let nextId = 0;
  for (const id of net.nodes.keys()) if (id >= nextId) nextId = id + 1;
  const addNode = (point: Pt): number => { const id = nextId++; net.nodes.set(id, point); return id; };
  const addRoad = (name: string, kind: RoadKind, points: Pt[], endpoints?: { startId?: number; endId?: number }): number[] => {
    const ids = points.map((point, index) => {
      if (index === 0 && endpoints?.startId !== undefined) return endpoints.startId;
      if (index === points.length - 1 && endpoints?.endId !== undefined) return endpoints.endId;
      return addNode(point);
    });
    net.roads.push({ name, kind, width: ROAD_WIDTHS[kind] ?? 11, nodeIds: ids });
    return ids;
  };

  const highwayIds = addRoad(COASTAL_ROAD_NAME, 'primary', highwayPoints);
  const highwayNode = (index: number): { id: number; p: Pt } => {
    const id = highwayIds[Math.max(0, Math.min(highwayIds.length - 1, index))]!;
    return { id, p: net.nodes.get(id)! };
  };
  const nearestHighwayIndex = (z: number): number => {
    let best = 0; let bestDistance = Infinity;
    highwayIds.forEach((id, index) => {
      const point = net.nodes.get(id)!;
      const distance = Math.abs(point.z - z);
      if (distance < bestDistance) { bestDistance = distance; best = index; }
    });
    return best;
  };
  log.push(`coast: shoreline ${(coastline.length)} pts, coastal highway '${COASTAL_ROAD_NAME}' ${highwayIds.length} pts at x~${Math.round(coastTargetX)}`);

  // ---- Frontage road collecting the Joburg west stubs ---------------------------
  const degree = nodeDegrees(net);
  const westStubs: Array<{ id: number; p: Pt }> = [];
  for (const road of net.roads) {
    for (const end of [road.nodeIds[0]!, road.nodeIds[road.nodeIds.length - 1]!]) {
      if ((degree.get(end) ?? 0) !== 1) continue;
      const point = net.nodes.get(end)!;
      // Only CITY-edge stubs: without the lower bound the coastal highway's own dangling
      // tips (3 km west) qualified, and Plaaspad grew spurs to the extreme map corners.
      const nearWestEdge = point.x >= jb.minX - 60 && point.x - jb.minX < joburgWestStubMargin;
      if (nearWestEdge && !westStubs.some((stub) => stub.id === end)) westStubs.push({ id: end, p: point });
    }
  }
  westStubs.sort((a, b) => a.p.z - b.p.z);
  const frontageX = jb.minX - 320;
  const frontageSeed = nameSeed(FRONTAGE_ROAD_NAME);
  const frontageIds: number[] = [];
  for (const stub of westStubs) {
    // Low-frequency organic wander of the frontage line (the projection nodes are shared with the
    // spurs, so moving them keeps the network connected while Plaaspad stops being a straight edge).
    const projectionId = addNode({ x: frontageX + fbm(frontageSeed, stub.p.z / 1800, 3) * 340 - 120, z: stub.p.z });
    frontageIds.push(projectionId);
    net.roads.push({ name: FRONTAGE_ROAD_NAME, kind: 'tertiary', width: ROAD_WIDTHS.tertiary ?? 9, nodeIds: [projectionId, stub.id] });
  }
  if (frontageIds.length >= 2) {
    net.roads.push({ name: FRONTAGE_ROAD_NAME, kind: 'tertiary', width: ROAD_WIDTHS.tertiary ?? 9, nodeIds: frontageIds });
  }
  log.push(`corridor: frontage '${FRONTAGE_ROAD_NAME}' joins ${westStubs.length} west stubs`);

  // ---- Corridor links (creative highways across the farmland) --------------------
  const linkZs = [jb.minZ + (jb.maxZ - jb.minZ) * 0.34, jb.minZ + (jb.maxZ - jb.minZ) * 0.68];
  const linkEndpoints: Array<{ startId: number; start: Pt; endIndex: number }> = [];
  linkZs.forEach((z, index) => {
    // Anchor on the frontage road (or directly on a west stub when the frontage is missing).
    let startId: number | undefined; let bestDistance = Infinity;
    for (const id of frontageIds.length ? frontageIds : westStubs.map((stub) => stub.id)) {
      const point = net.nodes.get(id)!;
      const distance = Math.abs(point.z - z);
      if (distance < bestDistance) { bestDistance = distance; startId = id; }
    }
    if (startId === undefined) startId = addNode({ x: frontageX, z });
    linkEndpoints.push({ startId, start: net.nodes.get(startId)!, endIndex: nearestHighwayIndex(z + (index === 0 ? -400 : 500)) });
  });
  CORRIDOR_LINKS.forEach((link, index) => {
    const { startId, start, endIndex } = linkEndpoints[index]!;
    const end = highwayNode(endIndex);
    const wobble = index === 0 ? 620 : -540;
    const controls: Pt[] = [
      start,
      { x: start.x - CORRIDOR_WIDTH_M * 0.33, z: start.z + wobble },
      { x: start.x - CORRIDOR_WIDTH_M * 0.66, z: (start.z + end.p.z) / 2 },
      { x: end.p.x + 620, z: end.p.z + wobble * 0.08 }, // straight, near-perpendicular approach to the coast road
      end.p,
    ];
    const points = smoothCurve(controls, 110).map(clampToLand);
    addRoad(link.name, link.kind as RoadKind, points, { startId, endId: end.id });
  });
  log.push(`corridor: links ${CORRIDOR_LINKS.map((link) => `'${link.name}'`).join(' + ')} across ${Math.round(CORRIDOR_WIDTH_M)} m`);

  // ---- Rural side roads + dirt tracks ---------------------------------------------
  const rRoadMidId = (() => { // a point along the Rooibos Route to hang things off
    const road = net.roads.find((entry) => entry.name === CORRIDOR_LINKS[1].name);
    return road ? road.nodeIds[Math.floor(road.nodeIds.length * 0.45)]! : highwayIds[Math.floor(highwayIds.length / 2)]!;
  })();
  const rMid = net.nodes.get(rRoadMidId)!;
  const farmRoadEnds: Pt[] = [];
  [{ dz: -1500, dx: -260 }, { dz: 1750, dx: 420 }].forEach((offset, index) => {
    const endPoint = { x: rMid.x + offset.dx, z: rMid.z + offset.dz };
    const points = smoothCurve([rMid, { x: rMid.x + offset.dx * 0.4, z: rMid.z + offset.dz * 0.45 }, endPoint], 100);
    addRoad(index === 0 ? 'Melkweg' : 'Kraal Close', 'residential', points, { startId: rRoadMidId });
    farmRoadEnds.push(endPoint);
  });

  const tracks: CoastGraftResult['tracks'] = [];
  for (let index = 0; index < 4; index++) {
    const anchor = index < 2 ? farmRoadEnds[index]! : { x: frontageX - 400 - index * 220, z: jb.minZ + (jb.maxZ - jb.minZ) * (0.2 + index * 0.18) };
    const points = smoothCurve([
      anchor,
      { x: anchor.x - 380 - seeded(index, 1) * 380, z: anchor.z + (seeded(index, 2) - 0.5) * 1400 },
      { x: anchor.x - 820 - seeded(index, 3) * 460, z: anchor.z + (seeded(index, 4) - 0.5) * 2200 },
    ], 120).map(clampToLand);
    tracks.push({ name: 'Plaas track', kind: 'track', width: TRACK_WIDTHS.track ?? 5, points });
  }

  // ---- Airport in the southern farmland ----------------------------------------------
  // A rotated rectangle: dir (dx,dz) is the long axis; perpendicular is (-dz, dx).
  const rectPoly = (cx: number, cz: number, dx: number, dz: number, halfLen: number, halfWid: number): Pt[] => {
    const px = -dz; const pz = dx;
    return [
      { x: cx + dx * halfLen + px * halfWid, z: cz + dz * halfLen + pz * halfWid },
      { x: cx + dx * halfLen - px * halfWid, z: cz + dz * halfLen - pz * halfWid },
      { x: cx - dx * halfLen - px * halfWid, z: cz - dz * halfLen - pz * halfWid },
      { x: cx - dx * halfLen + px * halfWid, z: cz - dz * halfLen + pz * halfWid },
    ];
  };
  const airCenter: Pt = { x: (corridorEastX + corridorWestX) / 2 + 300, z: jb.minZ + (jb.maxZ - jb.minZ) * AIRPORT_Z_FRACTION };
  const airDx = Math.cos(AIRPORT_RUNWAY_BEARING_RAD); const airDz = Math.sin(AIRPORT_RUNWAY_BEARING_RAD);
  const airPx = -airDz; const airPz = airDx;
  const runwayHalf = AIRPORT_RUNWAY_LENGTH_M / 2;
  const runway: Pt[] = [
    { x: airCenter.x - airDx * runwayHalf, z: airCenter.z - airDz * runwayHalf },
    { x: airCenter.x + airDx * runwayHalf, z: airCenter.z + airDz * runwayHalf },
  ];
  const taxiCenter: Pt = { x: airCenter.x + airPx * 150, z: airCenter.z + airPz * 150 };
  const taxiway: Pt[] = [
    { x: taxiCenter.x - airDx * runwayHalf * 0.82, z: taxiCenter.z - airDz * runwayHalf * 0.82 },
    { x: taxiCenter.x + airDx * runwayHalf * 0.82, z: taxiCenter.z + airDz * runwayHalf * 0.82 },
  ];
  const apronCenter: Pt = { x: airCenter.x + airPx * 320, z: airCenter.z + airPz * 320 };
  const airportApron = rectPoly(apronCenter.x, apronCenter.z, airDx, airDz, 240, 150);
  const airportBuildings: Pt[][] = [0, 1, 2].map((i) => {
    const bc = { x: apronCenter.x + airDx * (i - 1) * 150 + airPx * 190, z: apronCenter.z + airDz * (i - 1) * 150 + airPz * 190 };
    return rectPoly(bc.x, bc.z, airDx, airDz, i === 1 ? 70 : 45, 40);
  });
  // Organic airfield boundary (owner: the perfect rectangle over the farmland "really looks out
  // of place"): an fBm-wobbled ellipse around the runway axis instead of a hard rectPoly.
  const airportBoundary: Pt[] = (() => {
    const cx = airCenter.x + airPx * 160; const cz = airCenter.z + airPz * 160;
    const seed = nameSeed(AIRPORT_NAME);
    const along = runwayHalf + 320; const across = 520;
    const points: Pt[] = [];
    for (let i = 0; i < 30; i++) {
      const angle = (i / 30) * Math.PI * 2;
      // Periodic noise (sampled on the unit circle) so the outline closes without a seam.
      const wobble = 1 + 0.11 * (fbm(seed, Math.cos(angle) * 1.9 + 4.2, 3) + fbm(seed + 9, Math.sin(angle) * 1.9 + 7.6, 3));
      const u = Math.cos(angle) * along * wobble; const v = Math.sin(angle) * across * wobble;
      points.push({ x: cx + airDx * u + airPx * v, z: cz + airDz * u + airPz * v });
    }
    return points;
  })();
  const airport: CoastAirport = { name: AIRPORT_NAME, runway, taxiway, apron: airportApron, buildings: airportBuildings, boundary: airportBoundary, center: airCenter };
  // Access road from the apron out to the nearest Plaaspad frontage node (stays in the road graph).
  if (frontageIds.length > 0) {
    let airAccessStartId = frontageIds[0]!;
    let bestD = Infinity;
    for (const id of frontageIds) {
      const p = net.nodes.get(id)!; const d = Math.abs(p.z - airCenter.z);
      if (d < bestD) { bestD = d; airAccessStartId = id; }
    }
    const anchor = net.nodes.get(airAccessStartId)!;
    const apronDoor = { x: apronCenter.x + airPx * 160, z: apronCenter.z + airPz * 160 };
    addRoad(AIRPORT_ACCESS_ROAD_NAME, 'tertiary', [
      apronDoor,
      { x: (apronDoor.x + anchor.x) / 2, z: (apronDoor.z + anchor.z) / 2 + 140 },
      anchor,
    ], { endId: airAccessStartId });
  }
  log.push(`airport: '${AIRPORT_NAME}' runway ${Math.round(AIRPORT_RUNWAY_LENGTH_M)} m + parallel taxiway/apron in the southern farmland`);

  // ---- Farmland polygons + farm clusters --------------------------------------------
  // Keep fields clear of the corridor roads so the preview (and later the game) reads cleanly.
  const corridorRoadPoints: Pt[] = [];
  for (const road of net.roads) {
    if (road.name === FRONTAGE_ROAD_NAME || CORRIDOR_LINKS.some((link) => link.name === road.name) || road.name === 'Melkweg' || road.name === 'Kraal Close') {
      for (const id of road.nodeIds) { const point = net.nodes.get(id); if (point) corridorRoadPoints.push(point); }
    }
  }
  const clearOfCorridorRoads = (x: number, z: number, radius: number): boolean =>
    corridorRoadPoints.every((point) => (point.x - x) ** 2 + (point.z - z) ** 2 > radius * radius);

  const farmland: CoastGraftResult['farmland'] = [];
  const farms: CoastGraftResult['farms'] = [];
  const fieldKinds: MapRuralBuilding['kind'][] = ['farmhouse', 'barn', 'silo', 'windmill'];
  const bandWest = corridorWestX + 380; const bandEast = corridorEastX - 420;
  let fieldIndex = 0;
  // Tighter row pitch and lane separation than the pre-crop layout: the corridor narrowed
  // from 2700 m to 2000 m, so the old spacing left most candidates overlapping and rejected.
  for (let z = jb.minZ + 400; z < jb.maxZ - 700; z += 1080) {
    for (let lane = 0; lane < 2; lane++) {
      const cx = bandWest + (bandEast - bandWest) * (0.24 + lane * 0.54) + (seeded(z, lane) - 0.5) * 300;
      const cz = z + (seeded(lane, z) - 0.5) * 420;
      if (!clearOfCorridorRoads(cx, cz, 330)) { fieldIndex++; continue; }
      if (Math.hypot(cx - airCenter.x, cz - airCenter.z) < 1450) { fieldIndex++; continue; } // keep the aerodrome clear
      // Never let a field spill into the dam — but only where the dam actually IS. The old test
      // used the nearest shore vertex at any z, which after the dam replaced the full-height
      // ocean rejected every field in the corridor (the pinched dam ends sit far east).
      if (cz >= dam.northZ && cz <= dam.southZ) {
        const shoreX = coastline.reduce((best, point) => (Math.abs(point.z - cz) < Math.abs(best.z - cz) ? point : best), coastline[0]!).x;
        if (cx - 380 < shoreX + COAST_ROAD_SETBACK_M) { fieldIndex++; continue; }
      }
      // Fields are sized to the corridor, which is now 2000 m rather than 2700 m wide.
      const w = 360 + seeded(cx, cz) * 300; const h = 320 + seeded(cz, cx) * 300;
      const tilt = (seeded(cx + cz, 7) - 0.5) * 0.35;
      const cos = Math.cos(tilt); const sin = Math.sin(tilt);
      const corner = (sx: number, sz: number): Pt => ({ x: cx + (sx * w * cos - sz * h * sin) / 2, z: cz + (sx * w * sin + sz * h * cos) / 2 });
      const quad = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      // Fields must not overlap their neighbours (owner: overlapping farm regions make no sense).
      if (farmland.some((field) => quadsOverlap(quad, field.points))) { fieldIndex++; continue; }
      farmland.push({ name: fieldIndex % 3 === 0 ? 'Mielie land' : 'Weiveld', points: quad });
      if (fieldIndex % 2 === 0 && farms.length < 14) {
        const base = corner(-0.62, -0.55);
        farms.push({ p: base, kind: 'farmhouse' });
        farms.push({ p: { x: base.x + 90, z: base.z + 55 }, kind: fieldKinds[(fieldIndex / 2 + 1) % 3 + 1] ?? 'barn' });
        if (fieldIndex % 4 === 0) farms.push({ p: { x: base.x - 70, z: base.z + 110 }, kind: 'windmill' });
      }
      fieldIndex++;
    }
  }
  log.push(`corridor: ${farmland.length} farmland fields, ${farms.length} farm buildings, 4 dirt tracks`);

  // ---- Padstal on the R-road -----------------------------------------------------------
  const padstal = { p: { x: rMid.x + 90, z: rMid.z - 120 }, name: PADSTAL_NAME };

  // ---- Harbour: where the coast faces the CBD-most edge ---------------------------------
  // The projector is centred on the CBD, so the CBD sits at z=0 in this space.
  const cbdZ = Math.max(jb.minZ, Math.min(jb.maxZ, 0));
  const harbourIndex = nearestHighwayIndex(cbdZ);
  const harbourAnchor = highwayNode(harbourIndex);
  const quayEnd = { x: harbourAnchor.p.x - COAST_ROAD_SETBACK_M * 0.72, z: harbourAnchor.p.z + 60 };
  addRoad('Kaapstad Quay', 'secondary', [harbourAnchor.p, quayEnd], { startId: harbourAnchor.id });
  const harbour = quayEnd;
  log.push(`coast: harbour '${HARBOUR_DISTRICT_NAME}' at z~${Math.round(harbourAnchor.p.z)}`);

  // ---- Dam water polygon --------------------------------------------------------------
  // Closed by running WEST past the world edge, so there is no visible far shore — the same
  // "runs off the map edge" trick the ocean used, but on ONE edge instead of three. North and
  // south of the dam's band the west strip stays dry veld and farmland.
  const damWestX = dam.minX - OCEAN_EXTENT_M;
  const ocean: Pt[] = buildDamPolygon(dam, damWestX);

  // ---- Yacht club / slipway on the dam's northern arm ------------------------------------
  // Was a sea port with a pier reaching into the Atlantic. A dam has a jetty, a slipway and a
  // clubhouse instead; the KEY and the NAME stay so runtime placements keep resolving.
  const portShore = coastline[Math.floor(coastline.length * 0.86)] ?? coastline[coastline.length - 1]!;
  const pier: Pt[] = [
    { x: portShore.x + 60, z: portShore.z },
    { x: portShore.x - PORT_PIER_LENGTH_M, z: portShore.z - 60 },
  ];
  const portApronCenter = { x: portShore.x + 190, z: portShore.z };
  const portApron = rectPoly(portApronCenter.x, portApronCenter.z, 0, 1, 150, 120);
  const port: CoastPort = { name: PORT_NAME, pier, apron: portApron };
  // Access spur off the shore road down to the slipway (ends at the water, like the quay).
  const portAnchor = highwayNode(nearestHighwayIndex(portShore.z));
  addRoad(PORT_ACCESS_ROAD_NAME, 'tertiary', [portAnchor.p, { x: portApronCenter.x - 40, z: portApronCenter.z }], { startId: portAnchor.id });
  log.push(`dam: yacht club '${PORT_NAME}' jetty ${Math.round(PORT_PIER_LENGTH_M)} m into the dam off the northern arm`);

  // ---- Reservoir / dam near the NE suburb edge -----------------------------------------
  // The old hard-coded anchor (maxX-1700, minZ+1500) was tuned to the pre-crop bounds; at the
  // new bounds every fixed offset I tried dropped the reservoir onto the M1 or into a Killarney
  // fairway. Search instead: a deterministic scan of the north-east quadrant for the point
  // furthest from any existing road, which is by definition open ground.
  const lakeCenter = (() => {
    // Densify: clearance must be measured against road SEGMENTS, not just their vertices —
    // thinned roads carry very sparse nodes and a node-only test walked the lake onto Melrose
    // Street, whose vertices happened to straddle it.
    const roadPts: Pt[] = [];
    for (const road of net.roads) {
      const pts = road.nodeIds.map((id) => net.nodes.get(id)).filter((p): p is Pt => Boolean(p));
      for (let i = 0; i < pts.length; i++) {
        roadPts.push(pts[i]!);
        const next = pts[i + 1];
        if (!next) continue;
        const len = Math.hypot(next.x - pts[i]!.x, next.z - pts[i]!.z);
        const n = Math.floor(len / 60);
        for (let k = 1; k < n; k++) {
          roadPts.push({ x: pts[i]!.x + ((next.x - pts[i]!.x) * k) / n, z: pts[i]!.z + ((next.z - pts[i]!.z) * k) / n });
        }
      }
    }
    const clearance = (p: Pt): number => {
      let best = Infinity;
      for (const q of roadPts) {
        const d = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (d < best) best = d;
      }
      best = Math.sqrt(best);
      // Golf courses and parks are protected too: a reservoir dropped on a fairway is worse
      // than one slightly off the ideal corner.
      for (const c of avoidCircles) best = Math.min(best, Math.max(0, Math.hypot(c.x - p.x, c.z - p.z) - c.r));
      return best;
    };
    // North-east quadrant of the city block, inset so the shore never touches the crop edge.
    const inset = LAKE_RADIUS_M * 1.6;
    const x0 = (jb.minX + jb.maxX) / 2 + inset; const x1 = jb.maxX - inset;
    const z0 = jb.minZ + inset; const z1 = (jb.minZ + jb.maxZ) / 2 - inset;
    // HARD constraint first (the reservoir must not sit on a road or a fairway), THEN prefer
    // the north-east corner among the candidates that qualify. Scoring the two together lets
    // the corner term buy its way onto a motorway, which is exactly what happened first try.
    const required = LAKE_RADIUS_M * 1.18;
    let best = { x: jb.maxX - inset, z: jb.minZ + inset };
    let bestCorner = Infinity; let bestClear = -Infinity; let found = false;
    const steps = 36;
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        const p = { x: x0 + ((x1 - x0) * i) / steps, z: z0 + ((z1 - z0) * j) / steps };
        const clear = clearance(p);
        const corner = Math.hypot(p.x - jb.maxX, p.z - jb.minZ);
        if (clear >= required) {
          if (!found || corner < bestCorner) { found = true; bestCorner = corner; best = p; }
        } else if (!found && clear > bestClear) { bestClear = clear; best = p; }
      }
    }
    return best;
  })();
  const lakeSeed = nameSeed(LAKE_NAME);
  const lakeSteps = 40;
  const lakePolygon: Pt[] = [];
  for (let i = 0; i < lakeSteps; i++) {
    const angle = (i / lakeSteps) * Math.PI * 2;
    const r = LAKE_RADIUS_M * (0.74 + 0.4 * (fbm(lakeSeed, (i / lakeSteps) * 6, 3) * 0.5 + 0.5));
    lakePolygon.push({ x: lakeCenter.x + Math.cos(angle) * r, z: lakeCenter.z + Math.sin(angle) * r * 0.82 });
  }
  const lake: CoastLake = { name: LAKE_NAME, polygon: lakePolygon };
  // Optional lakeside dirt track hugging the shore.
  const lakeTrackPts: Pt[] = [];
  for (let i = 6; i <= 24; i++) {
    const angle = (i / lakeSteps) * Math.PI * 2;
    const r = LAKE_RADIUS_M * 1.18;
    lakeTrackPts.push({ x: lakeCenter.x + Math.cos(angle) * r, z: lakeCenter.z + Math.sin(angle) * r * 0.82 });
  }
  tracks.push({ name: LAKESIDE_TRACK_NAME, kind: 'track', width: TRACK_WIDTHS.track ?? 5, points: lakeTrackPts });
  log.push(`lake: '${LAKE_NAME}' reservoir (${lakePolygon.length}-pt organic shoreline) near the NE suburb edge`);

  // ---- Beaches (real polygons, transformed) + districts -----------------------------------
  const beaches = beachWays
    .map((way) => ({
      name: way.tags?.name ?? 'Beach',
      points: way.nodes.slice(0, -1)
        .map((id) => nodes.get(id))
        .filter((node): node is OsmNode => Boolean(node))
        .map((node) => toComposite(project(node.lat, node.lon))),
    }))
    .filter((beach) => beach.points.length >= 4);
  const districts: CoastGraftResult['districts'] = [
    ...places.map((place) => ({ name: place.name, p: toComposite(place.p) })),
    { name: HARBOUR_DISTRICT_NAME, p: { x: harbour.x + 120, z: harbour.z } },
  ];
  log.push(`coast: ${beaches.length} beaches, ${districts.length - 1} seaboard place nodes grafted`);

  return {
    coastline, ocean, dam, damIsland, beaches, farmland, tracks, farms, padstal, harbour, districts,
    airport, port, lake,
    corridorEastX, corridorWestX,
    highwayEndIds: { south: highwayIds[0]!, north: highwayIds[highwayIds.length - 1]! },
    log,
  };
}

/**
 * Close the orbital's open C onto the coastal highway: one organic connector per corner
 * (ring end -> Victoria Road tip), bowed inland so neither connector hugs the world edge.
 * With these two links the whole map is wrapped in a single drivable outer loop.
 */
export function closeCoastalLoop(
  net: RoadNetwork,
  ringEndIds: [number, number],
  highwayEndIds: { south: number; north: number },
): string[] {
  const log: string[] = [];
  let nextId = 0;
  for (const id of net.nodes.keys()) if (id >= nextId) nextId = id + 1;
  const a = net.nodes.get(ringEndIds[0])!; const b = net.nodes.get(ringEndIds[1])!;
  const northRingId = a.z < b.z ? ringEndIds[0] : ringEndIds[1];
  const southRingId = a.z < b.z ? ringEndIds[1] : ringEndIds[0];
  for (const link of COAST_LOOP_LINKS) {
    const startId = link.end === 'north' ? northRingId : southRingId;
    const endId = link.end === 'north' ? highwayEndIds.north : highwayEndIds.south;
    const start = net.nodes.get(startId); const end = net.nodes.get(endId);
    if (!start || !end) continue;
    const inland = link.end === 'north' ? 1 : -1; // +z is south: bow away from the edge
    const controls: Pt[] = [
      start,
      { x: start.x + (end.x - start.x) * 0.34, z: start.z + inland * 340 + (end.z - start.z) * 0.18 },
      { x: start.x + (end.x - start.x) * 0.72, z: end.z + inland * 220 },
      end,
    ];
    const points = smoothCurve(controls, 110);
    const nodeIds = points.map((point, index) => {
      if (index === 0) return startId;
      if (index === points.length - 1) return endId;
      const id = nextId++; net.nodes.set(id, point); return id;
    });
    net.roads.push({ name: link.name, kind: link.kind, width: ROAD_WIDTHS[link.kind] ?? 14, nodeIds });
    log.push(`loop: '${link.name}' closes the ${link.end} corner (ring -> coastal highway)`);
  }
  return log;
}

/**
 * Border veld: organic scrub polygons filling the set-back band between the outermost roads
 * and the world edge (north, east and south sides — the west edge is ocean). `world` is the
 * full world square in projected metres (fit.invert of the TARGET_SIZE corners). The inner
 * boundary is fBm-wavy so the band reads as natural veld, not a picture frame.
 */
export function buildBorderVeld(input: {
  world: { minX: number; maxX: number; minZ: number; maxZ: number };
  coastline: Pt[];
  /** Dam band: outside it the WEST strip is dry land too, so it gets veld cover as well. */
  dam?: { northZ: number; southZ: number };
}): Array<{ name: string; points: Pt[] }> {
  const { world, coastline, dam } = input;
  const seed = nameSeed(BORDER_VELD_NAME);
  const range = BORDER_VELD_DEPTH_MAX_M - BORDER_VELD_DEPTH_MIN_M;
  const depth = (t: number, salt: number): number =>
    BORDER_VELD_DEPTH_MIN_M + (fbm(seed + salt * 97, t / 1250, 3) * 0.5 + 0.5) * range;
  const coastXAt = (z: number): number =>
    coastline.reduce((best, point) => (Math.abs(point.z - z) < Math.abs(best.z - z) ? point : best), coastline[0]!).x;
  // Where the dam does not reach, the veld may run all the way to the west world edge.
  const inDam = (z: number): boolean => (dam ? z >= dam.northZ && z <= dam.southZ : true);
  const landStartX = (z: number): number => (inDam(z) ? coastXAt(z) + 650 : world.minX);
  const step = 420;
  const bands: Array<{ name: string; points: Pt[] }> = [];
  // North and south bands run from the western land edge to the east corner.
  for (const side of [
    { zEdge: world.minZ, inland: 1, salt: 1 },
    { zEdge: world.maxZ, inland: -1, salt: 2 },
  ]) {
    const xStart = landStartX(side.zEdge);
    const points: Pt[] = [{ x: xStart, z: side.zEdge }, { x: world.maxX, z: side.zEdge }];
    for (let x = world.maxX; x >= xStart; x -= step) {
      // Pinch the band to a point toward the shore — a full-depth stop reads as a hard seam.
      const fade = Math.min(1, (x - xStart) / 1700);
      points.push({ x, z: side.zEdge + side.inland * depth(x, side.salt) * fade });
    }
    bands.push({ name: BORDER_VELD_NAME, points });
  }
  // East band spans the full height (its corners tuck under the N/S bands — fine, it's veld).
  const east: Pt[] = [{ x: world.maxX, z: world.minZ }, { x: world.maxX, z: world.maxZ }];
  for (let z = world.maxZ; z >= world.minZ; z -= step) east.push({ x: world.maxX - depth(z, 3), z });
  bands.push({ name: BORDER_VELD_NAME, points: east });
  // West band: the strip beyond the corridor that the dam does NOT cover — dry veld between
  // the farmland and the west world edge, north of the dam and south of it.
  if (dam) {
    for (const seg of [
      { z0: world.minZ, z1: Math.min(dam.northZ, world.maxZ), salt: 4 },
      { z0: Math.max(dam.southZ, world.minZ), z1: world.maxZ, salt: 5 },
    ]) {
      if (seg.z1 - seg.z0 < 600) continue;
      const points: Pt[] = [{ x: world.minX, z: seg.z0 }, { x: world.minX, z: seg.z1 }];
      for (let z = seg.z1; z >= seg.z0; z -= step) {
        // Fade the inner edge to nothing at the dam end so the veld doesn't stop in a straight line.
        const fadeEnd = Math.min(1, Math.abs(z - (seg.salt === 4 ? seg.z1 : seg.z0)) / 900);
        points.push({ x: world.minX + depth(z, seg.salt) * 2.2 * fadeEnd, z });
      }
      bands.push({ name: BORDER_VELD_NAME, points });
    }
  }
  return bands;
}

// ---- Composite elevation ---------------------------------------------------------

export interface CompositeElevationInput {
  /** Fetched SRTM samples over the Joburg BBOX (row-major from the NW corner). */
  srtm: { cols: number; rows: number; data: number[]; source: string };
  /** Joburg BBOX corners in projected metres (NW and SE). */
  joburgNW: Pt;
  joburgSE: Pt;
  coast: CoastGraftResult;
  /** Game-units-per-metre fit: needed to lay the grid over the final square. */
  fit: { apply: (p: Pt) => Pt; invert: (p: Pt) => Pt };
  targetSize: number;
}

export interface CompositeElevationGrid {
  cols: number; rows: number;
  x0: number; z0: number; dx: number; dz: number;
  data: number[];
  /** Metres of synthetic mountain range included in `data` per cell (see ridge.ts) — shipped
   *  alongside so the runtime can exempt the range from detrending and keep it TALL in-game. */
  ridge: number[];
  source: string;
}

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/**
 * Height grid over the WHOLE composite square (game units): real SRTM over the Joburg
 * block, a synthetic rolling descent through the rural corridor (Phase 3 gets its hills
 * for free) and sea level west of the coastline. Deliberately fantastical: Joburg sits at
 * ~1700 m, the coast at 0, and the corridor rolls its way down.
 */
export function compositeElevation(input: CompositeElevationInput): CompositeElevationGrid {
  const { srtm, joburgNW, joburgSE, coast, fit, targetSize } = input;
  const cols = 128; const rows = 128;
  const dx = targetSize / cols; const dz = targetSize / rows;
  const x0 = -targetSize / 2 + dx / 2; const z0 = -targetSize / 2 + dz / 2;

  const sampleSrtm = (m: Pt): number => {
    const fx = Math.max(0, Math.min(1, (m.x - joburgNW.x) / (joburgSE.x - joburgNW.x)));
    const fz = Math.max(0, Math.min(1, (m.z - joburgNW.z) / (joburgSE.z - joburgNW.z)));
    const gx = fx * (srtm.cols - 1); const gz = fz * (srtm.rows - 1);
    const col = Math.floor(gx); const row = Math.floor(gz);
    const tx = gx - col; const tz = gz - row;
    const at = (c: number, r: number): number => srtm.data[Math.min(srtm.rows - 1, r) * srtm.cols + Math.min(srtm.cols - 1, c)] ?? 0;
    return (at(col, row) * (1 - tx) + at(col + 1, row) * tx) * (1 - tz)
      + (at(col, row + 1) * (1 - tx) + at(col + 1, row + 1) * tx) * tz;
  };

  // Shore x by z, and whether z is inside the dam's band at all. The band test is essential:
  // the dam covers only part of the west edge, so "west of the nearest shore point" alone
  // would flood the dry veld north and south of it.
  const { xAt: shoreXAt, inBand: inDamBand } = damSampler(coast.dam);

  // The island stands out of the water: a local bump around its centre.
  const island = coast.damIsland;
  const islandBump = (m: Pt): number => {
    const dxi = (m.x - island.center.x) / 520;
    const dzi = (m.z - island.center.z) / 330;
    const r = Math.hypot(dxi, dzi);
    return r >= 1 ? 0 : 14 * (1 - smoothstep(r));
  };

  const data: number[] = [];
  const ridge: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const unit = { x: x0 + col * dx, z: z0 + row * dz };
      const m = fit.invert(unit);
      const shoreX = shoreXAt(m.z);
      const inWater = inDamBand(m.z) && m.x <= shoreX;
      let height: number;
      let mountain = 0;
      if (m.x >= coast.corridorEastX) {
        height = sampleSrtm(m);
      } else if (inWater) {
        // Dam surface. An inland reservoir on the Highveld sits at ~1480 m ASL, not 0 —
        // keeping the old sea-level 0 here would read as a mile-deep hole beside the city and
        // would leave a 1700 m synthetic escarpment across the corridor.
        height = DAM_LEVEL_M + islandBump(m);
      } else {
        // Rolling descent from the Joburg plateau edge down to the dam / the western veld.
        const target = inDamBand(m.z) ? shoreX : coast.corridorWestX - 1200;
        const t = Math.max(0, Math.min(1, (coast.corridorEastX - m.x) / Math.max(1, coast.corridorEastX - target)));
        const cityEdge = sampleSrtm({ x: coast.corridorEastX + 200, z: m.z });
        const base = cityEdge * (1 - smoothstep(t)) + DAM_LEVEL_M * smoothstep(t);
        const hills = 110 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.55 + 0.45 * Math.sin(m.z / 1300 + m.x / 950));
        height = Math.max(DAM_LEVEL_M, base + hills * (t < 0.92 ? 1 : (1 - t) / 0.08)) + islandBump(m);
      }
      // The mountain field is evaluated in PROJECTED METRES (see ridge.ts) so the range is
      // immune to TARGET_SIZE and to future re-crops; it is zero over the water by gating.
      if (!inWater) mountain = Math.round(ridgeMetresAt(m.x, m.z));
      data.push(Math.round(height) + mountain);
      ridge.push(mountain);
    }
  }
  return { cols, rows, x0, z0, dx, dz, data, ridge, source: `${srtm.source} + synthetic corridor/dam composite + Witwatersrand fractal range` };
}
