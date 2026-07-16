/**
 * Jozi-by-the-Sea: grafts a Cape Town Atlantic-seaboard strip onto the west edge of the
 * Joburg crop, separated by a rural farmland corridor. Deliberately fantastical — real
 * coastline geometry (Sea Point -> Camps Bay), synthetic connections.
 *
 * Everything here works in the Joburg-projected METRES space of the road network; the
 * shared fit transform in process.ts turns it into game units afterwards.
 */
import {
  AIRPORT_ACCESS_ROAD_NAME,
  AIRPORT_NAME,
  AIRPORT_RUNWAY_BEARING_RAD,
  AIRPORT_RUNWAY_LENGTH_M,
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
  /** South-to-north shoreline (metres). */
  coastline: Pt[];
  /** Closed ocean polygon (metres). */
  ocean: Pt[];
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
export function graftCoastAndCorridor(net: RoadNetwork, cape: OsmResponse, joburgWestStubMargin = 420): CoastGraftResult {
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
  const coastWays = ways.filter((way) => way.tags?.natural === 'coastline');
  const beachWays = ways.filter((way) => way.tags?.natural === 'beach' && way.nodes && way.nodes[0] === way.nodes[way.nodes.length - 1]);

  const chains = chainWays(coastWays);
  const rawCoast = (chains[0] ?? [])
    .map((id) => nodes.get(id))
    .filter((node): node is OsmNode => Boolean(node))
    .map((node) => project(node.lat, node.lon));
  if (rawCoast.length < 10) throw new Error(`coast graft: coastline too short (${rawCoast.length} points)`);
  // Run south -> north (increasing -z in projected space means north; our z grows southward).
  if (rawCoast[0]!.z < rawCoast[rawCoast.length - 1]!.z) rawCoast.reverse();
  // Keep only the clean west-facing seaboard: at Mouille Point the peninsula tip hooks east
  // toward the V&A — cut the polyline where it swings that far inland, and again if it turns
  // back south. (An offset road over the hook turns into spaghetti otherwise.)
  const westmostX = Math.min(...rawCoast.map((point) => point.x));
  const cut: Pt[] = [];
  for (const point of rawCoast) {
    if (point.x > westmostX + 1200) break;
    if (cut.length > 5 && point.z > cut[cut.length - 1]!.z + 150) break; // wrapped back south
    cut.push(point);
  }
  const capeCoast = simplifyPolyline(cut, SIMPLIFY_TOLERANCE_M * 2);

  // ---- Transform into the composite frame -------------------------------------
  const corridorEastX = jb.minX;
  const corridorWestX = jb.minX - CORRIDOR_WIDTH_M;
  const capeBounds = boundsOf(capeCoast);
  const coastTargetX = corridorWestX - COAST_ROAD_SETBACK_M - 380; // sea strip clears the corridor even where the shore wobbles east
  const jbMidZ = (jb.minZ + jb.maxZ) / 2;
  const capeMidZ = ((capeBounds.minZ + capeBounds.maxZ) / 2) * COAST_STRETCH_Z;
  const toComposite = (p: Pt): Pt => ({
    x: p.x - (capeBounds.minX + capeBounds.maxX) / 2 + coastTargetX,
    z: p.z * COAST_STRETCH_Z - capeMidZ + jbMidZ,
  });
  let coastline = capeCoast.map(toComposite);

  // Extend the shoreline synthetically to just past the Joburg z extents. fBm wobble (tapered
  // in from the real-data seam) instead of a regular sine — a robotic wave reads instantly fake.
  const extendTo = (from: Pt, direction: 1 | -1, untilZ: number): Pt[] => {
    const output: Pt[] = [];
    const seed = nameSeed(COASTAL_ROAD_NAME) + (direction === 1 ? 11 : 23);
    let z = from.z; let step = 0;
    while (direction === 1 ? z < untilZ : z > untilZ) {
      z += direction * 380;
      step++;
      const blend = Math.min(1, step / 3); // ease away from the seam, no kink at the join
      output.push({ x: from.x + blend * fbm(seed, z / 1500, 3) * 340 - step * 12, z });
    }
    return output;
  };
  const south = coastline[0]!; const north = coastline[coastline.length - 1]!;
  coastline = [
    ...extendTo(south, 1, jb.maxZ + 650).reverse(),
    ...coastline,
    ...extendTo(north, -1, jb.minZ - 650),
  ];

  // ---- Coastal highway (offset inland = east of the shoreline) ------------------
  // The shoreline runs south -> north (decreasing z); a positive perpendicular offset of
  // that travel direction points east, i.e. inland. The offset base is smoothed hard first
  // so tight coves (Bantry Bay) don't fold the road back over itself.
  const highwayBase = simplifyPolyline(coastline, 60);
  const highwayPoints = simplifyPolyline(offsetPolyline(highwayBase, COAST_ROAD_SETBACK_M), SIMPLIFY_TOLERANCE_M * 2);

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
    const points = smoothCurve(controls, 110);
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
    const anchor = index < 2 ? farmRoadEnds[index]! : { x: frontageX - 500 - index * 300, z: jb.minZ + (jb.maxZ - jb.minZ) * (0.2 + index * 0.18) };
    const points = smoothCurve([
      anchor,
      { x: anchor.x - 500 - seeded(index, 1) * 500, z: anchor.z + (seeded(index, 2) - 0.5) * 1400 },
      { x: anchor.x - 1100 - seeded(index, 3) * 600, z: anchor.z + (seeded(index, 4) - 0.5) * 2200 },
    ], 120);
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
  const airCenter: Pt = { x: (corridorEastX + corridorWestX) / 2 + 300, z: jb.minZ + (jb.maxZ - jb.minZ) * 0.8 };
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
  for (let z = jb.minZ + 500; z < jb.maxZ - 900; z += 1450) {
    for (let lane = 0; lane < 2; lane++) {
      const cx = bandWest + (bandEast - bandWest) * (0.22 + lane * 0.52) + (seeded(z, lane) - 0.5) * 500;
      const cz = z + (seeded(lane, z) - 0.5) * 420;
      if (!clearOfCorridorRoads(cx, cz, 430)) { fieldIndex++; continue; }
      if (Math.hypot(cx - airCenter.x, cz - airCenter.z) < 1450) { fieldIndex++; continue; } // keep the aerodrome clear
      // Never let a field spill toward the shore (the coastline drifts around the corridor's west edge).
      const shoreX = coastline.reduce((best, point) => (Math.abs(point.z - cz) < Math.abs(best.z - cz) ? point : best), coastline[0]!).x;
      if (cx - 600 < shoreX + COAST_ROAD_SETBACK_M) { fieldIndex++; continue; }
      const w = 520 + seeded(cx, cz) * 480; const h = 420 + seeded(cz, cx) * 420;
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

  // ---- Ocean polygon ---------------------------------------------------------------------
  // The shore is extended a further ~2.5 km past the highway tips for the FILL only, so the
  // NW/SW world corners (behind the edge set-back) still read as sea, not bare void.
  const oceanShore: Pt[] = [
    ...extendTo(coastline[0]!, 1, jb.maxZ + 3200).reverse(),
    ...coastline,
    ...extendTo(coastline[coastline.length - 1]!, -1, jb.minZ - 3200),
  ];
  const oceanWestX = Math.min(...oceanShore.map((point) => point.x)) - OCEAN_EXTENT_M;
  const first = oceanShore[0]!; const last = oceanShore[oceanShore.length - 1]!;
  const ocean: Pt[] = [...oceanShore, { x: oceanWestX, z: last.z }, { x: oceanWestX, z: first.z }];

  // ---- Sea port / pier on the NW coast (north end of the shoreline) ---------------------
  const portShore = coastline[Math.floor(coastline.length * 0.86)] ?? coastline[coastline.length - 1]!;
  const pier: Pt[] = [
    { x: portShore.x + 60, z: portShore.z },
    { x: portShore.x - PORT_PIER_LENGTH_M, z: portShore.z - 60 },
  ];
  const portApronCenter = { x: portShore.x + 190, z: portShore.z };
  const portApron = rectPoly(portApronCenter.x, portApronCenter.z, 0, 1, 150, 120);
  const port: CoastPort = { name: PORT_NAME, pier, apron: portApron };
  // Access spur off Victoria Road down to the dockside apron (ends at the water, like the quay).
  const portAnchor = highwayNode(nearestHighwayIndex(portShore.z));
  addRoad(PORT_ACCESS_ROAD_NAME, 'tertiary', [portAnchor.p, { x: portApronCenter.x - 40, z: portApronCenter.z }], { startId: portAnchor.id });
  log.push(`coast: sea port '${PORT_NAME}' pier ${Math.round(PORT_PIER_LENGTH_M)} m into the ocean off the NW coast`);

  // ---- Reservoir / dam near the NE suburb edge -----------------------------------------
  const lakeCenter = { x: jb.maxX - 1700, z: jb.minZ + 1500 };
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
    coastline, ocean, beaches, farmland, tracks, farms, padstal, harbour, districts,
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
}): Array<{ name: string; points: Pt[] }> {
  const { world, coastline } = input;
  const seed = nameSeed(BORDER_VELD_NAME);
  const range = BORDER_VELD_DEPTH_MAX_M - BORDER_VELD_DEPTH_MIN_M;
  const depth = (t: number, salt: number): number =>
    BORDER_VELD_DEPTH_MIN_M + (fbm(seed + salt * 97, t / 1250, 3) * 0.5 + 0.5) * range;
  const coastXAt = (z: number): number =>
    coastline.reduce((best, point) => (Math.abs(point.z - z) < Math.abs(best.z - z) ? point : best), coastline[0]!).x;
  const step = 420;
  const bands: Array<{ name: string; points: Pt[] }> = [];
  // North and south bands run from just inland of the shoreline to the east corner.
  for (const side of [
    { zEdge: world.minZ, inland: 1, salt: 1 },
    { zEdge: world.maxZ, inland: -1, salt: 2 },
  ]) {
    const xStart = coastXAt(side.zEdge) + 650;
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

  // Coastline x by z (coarse lookup; the shoreline is monotone enough for this).
  const coastXAt = (z: number): number => {
    let best = coast.coastline[0]!; let bestDistance = Infinity;
    for (const point of coast.coastline) {
      const distance = Math.abs(point.z - z);
      if (distance < bestDistance) { bestDistance = distance; best = point; }
    }
    return best.x;
  };

  const data: number[] = [];
  const ridge: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const unit = { x: x0 + col * dx, z: z0 + row * dz };
      const m = fit.invert(unit);
      const coastX = coastXAt(m.z);
      let height: number;
      let mountain = 0;
      if (m.x >= coast.corridorEastX) {
        height = sampleSrtm(m);
      } else if (m.x <= coastX) {
        height = 0; // ocean — no mountain reaches the water (ridge.ts gates well east of here anyway)
      } else {
        // Rolling descent from the Joburg edge down to the shore.
        const t = (coast.corridorEastX - m.x) / (coast.corridorEastX - coastX);
        const cityEdge = sampleSrtm({ x: coast.corridorEastX + 200, z: m.z });
        const base = cityEdge * (1 - smoothstep(t)) + 6 * smoothstep(t);
        const hills = 110 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.55 + 0.45 * Math.sin(m.z / 1300 + m.x / 950));
        height = Math.max(2, base + hills * (t < 0.92 ? 1 : (1 - t) / 0.08));
      }
      if (m.x > coastX) mountain = Math.round(ridgeMetresAt(unit.x, unit.z)); // fractal northern range (ridge.ts), zero across most of the map
      data.push(Math.round(height) + mountain);
      ridge.push(mountain);
    }
  }
  return { cols, rows, x0, z0, dx, dz, data, ridge, source: `${srtm.source} + synthetic corridor/coast composite + northern fractal range` };
}
