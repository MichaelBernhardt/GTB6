import {
  BBOX,
  BRIDGE_DISTANCE_M,
  CBD_CENTER,
  CUL_DE_SAC_NAMES,
  DEADEND_CONNECT_M,
  DEADEND_JOIN_M,
  DEADEND_PRUNE_M,
  DEADEND_PRUNE_MAJOR_M,
  DISTRICT_RADIUS_M,
  EDGE_MARGIN_UNITS,
  LANDMARK_CANONICAL,
  MIN_LANDUSE_AREA_M2,
  MEANDER_MIN_VERTICES,
  MEANDER_SPECS,
  MIN_ROAD_LENGTH_M,
  MIN_WATER_AREA_M2,
  PROTECTED_ROAD_NAMES,
  RING_BOUNDARY_MARGIN_M,
  RING_CORNER_CHAMFER_M,
  RING_KIND,
  RING_NAME,
  RING_OFFSET_M,
  ROAD_WIDTHS,
  SIMPLIFY_TOLERANCE_M,
  SNAP_DISTANCE_M,
  STUB_PRUNE_LENGTH_M,
  TARGET_SIZE,
  THIN_COVERAGE_DISTANCE_M,
  THIN_COVERAGE_FRACTION,
  THIN_MAX_RANK,
  THIN_PARALLEL_COS,
  THIN_SAMPLE_STEP_M,
  TRACK_WIDTHS,
} from './config';
import { buildBorderVeld, closeCoastalLoop, compositeElevation, graftCoastAndCorridor, smoothCurve, type CoastGraftResult } from './coast';
import { resolveDeadEnds } from './deadends';
import { thinRailways } from './railways';
import { buildOrbitalRing, pruneShortStubs, thinParallelRoads } from './thin';
import { flatGrid, type ElevationSamples } from './elevation';
import {
  bridgeIslands,
  connectedComponents,
  findJunctions,
  roadLength,
  snapEndpointsToSegments,
  snapNodes,
  type GraphRoad,
  type RoadNetwork,
} from './graph';
import { fbm, meanderPolyline, nameSeed } from './meander';
import { boundsOf, makeFitTransform, makeProjector, polylineLength } from './projection';
import { simplifyPolyline, simplifyWithPins } from './simplify';
import type {
  JoburgMap,
  MapArea,
  OsmNode,
  OsmRelation,
  OsmResponse,
  OsmWay,
  Pt,
  RoadKind,
} from './types';

const CLIP_MARGIN_DEG = 0.003; // ~300 m of slack around the bbox

function inBbox(lat: number, lon: number): boolean {
  return (
    lat >= BBOX.south - CLIP_MARGIN_DEG &&
    lat <= BBOX.north + CLIP_MARGIN_DEG &&
    lon >= BBOX.west - CLIP_MARGIN_DEG &&
    lon <= BBOX.east + CLIP_MARGIN_DEG
  );
}

function roadName(tags: Record<string, string>, kind: RoadKind): string {
  return tags.name ?? tags.ref ?? `Unnamed ${kind.replace('_', ' ')}`;
}

function landmarkKind(tags: Record<string, string>): string {
  if (tags.railway === 'station' || tags.station) return 'station';
  if (tags.leisure === 'stadium' || tags.building === 'stadium') return 'stadium';
  if (tags.man_made === 'tower' || tags.tower) return 'tower';
  if (tags.tourism || tags.historic) return 'heritage';
  return 'landmark';
}

function shoelaceArea(points: Pt[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.z - b.x * a.z;
  }
  return Math.abs(area / 2);
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

export interface ProcessResult {
  map: JoburgMap;
  log: string[];
}

/**
 * Bend the synthetic roads (owner: "far too straight ... more meandering and organic").
 * Only the long spine/ring polylines are curved (short spurs stay straight); every vertex
 * shared with another road — junction attachment points — is pinned, so connectivity and the
 * boundary orbital are untouched while private interior vertices become gentle noise curves.
 */
function meanderSyntheticRoads(net: RoadNetwork): number {
  const refCount = new Map<number, number>();
  for (const road of net.roads) for (const id of new Set(road.nodeIds)) refCount.set(id, (refCount.get(id) ?? 0) + 1);
  let nextId = 0;
  for (const id of net.nodes.keys()) if (id >= nextId) nextId = id + 1;
  const addNode = (p: Pt): number => { const id = nextId++; net.nodes.set(id, p); return id; };
  let curved = 0;
  for (const road of net.roads) {
    const spec = MEANDER_SPECS[road.name];
    if (!spec || road.nodeIds.length < MEANDER_MIN_VERTICES) continue;
    const points = road.nodeIds.map((id) => net.nodes.get(id)!);
    const pins: number[] = [];
    road.nodeIds.forEach((id, index) => {
      if (index === 0 || index === road.nodeIds.length - 1 || (refCount.get(id) ?? 0) > 1) pins.push(index);
    });
    const vertices = meanderPolyline(points, pins, { ...spec, seed: nameSeed(road.name) });
    const lastIndex = road.nodeIds.length - 1;
    const newIds = vertices.map((v) => {
      if (v.pin === null) return addNode(v.p);
      const id = road.nodeIds[v.pin]!;
      // movePins: interior junctions ride the meander — update the shared node in place so
      // the spur roads attached to it follow along.
      if (spec.movePins && v.pin !== 0 && v.pin !== lastIndex) net.nodes.set(id, v.p);
      return id;
    });
    road.nodeIds = newIds.filter((id, index) => index === 0 || id !== newIds[index - 1]);
    curved++;
  }
  return curved;
}

/** District place nodes in a stable order (also used to key building counts). */
export function extractDistrictNodes(data: OsmResponse): Array<{ name: string; lat: number; lon: number }> {
  const districts: Array<{ name: string; lat: number; lon: number }> = [];
  for (const element of data.elements) {
    if (element.type !== 'node' || !element.tags?.place || !element.tags.name) continue;
    if (!['suburb', 'quarter', 'neighbourhood'].includes(element.tags.place)) continue;
    districts.push({ name: element.tags.name, lat: element.lat, lon: element.lon });
  }
  return districts;
}

export interface ProcessExtras {
  elevation?: ElevationSamples;
  /** Building counts per district, aligned with extractDistrictNodes order. */
  buildingCounts?: number[] | null;
  /** Real OSM road names that must survive density thinning (names-overrides keys). */
  protectedNames?: Iterable<string>;
  /** Cape Town seaboard extract: enables the Jozi-by-the-Sea coast + rural corridor graft. */
  cape?: OsmResponse;
}

function landuseKind(tags: Record<string, string>): MapArea['kind'] | null {
  if (tags.leisure === 'park') return 'park';
  if (tags.leisure === 'golf_course') return 'golf_course';
  if (tags.leisure === 'nature_reserve') return 'nature_reserve';
  if (tags.landuse === 'quarry' || tags.man_made === 'spoil_heap') return 'mine_dump';
  if (tags.landuse === 'grass') return 'grass';
  if (tags.landuse === 'forest') return 'forest';
  if (tags.landuse === 'brownfield') return 'brownfield';
  if (tags.natural === 'wood') return 'wood';
  if (tags.natural === 'scrub') return 'scrub';
  return null;
}

export function processOsm(data: OsmResponse, extras: ProcessExtras = {}): ProcessResult {
  const log: string[] = [];
  const project = makeProjector(CBD_CENTER);

  const osmNodes = new Map<number, OsmNode>();
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const landmarkElements: Array<OsmNode | OsmWay | OsmRelation> = [];
  for (const element of data.elements) {
    if (element.type === 'node') {
      osmNodes.set(element.id, element);
      if (element.tags?.place) continue;
      if (element.tags && (element.tags.railway === 'station' || element.tags.name)) landmarkElements.push(element);
    } else if (element.type === 'way') {
      ways.push(element);
      if (element.center) landmarkElements.push(element);
    } else {
      relations.push(element);
      if (element.center) landmarkElements.push(element);
    }
  }

  // ---- Roads -------------------------------------------------------------
  const net: RoadNetwork = { nodes: new Map(), roads: [] };
  const nodeUsage = new Map<number, number>();
  const roadWays = ways.filter((way) => way.tags?.highway && ROAD_WIDTHS[way.tags.highway] !== undefined && way.nodes);
  for (const way of roadWays) {
    for (const id of way.nodes) nodeUsage.set(id, (nodeUsage.get(id) ?? 0) + 1);
  }
  let clippedRuns = 0;
  for (const way of roadWays) {
    const kind = way.tags!.highway as RoadKind;
    const name = roadName(way.tags!, kind);
    const width = ROAD_WIDTHS[kind];
    // Split the way into runs of nodes inside the (slightly padded) bbox.
    let run: number[] = [];
    const runs: number[][] = [];
    for (const id of way.nodes) {
      const node = osmNodes.get(id);
      if (node && inBbox(node.lat, node.lon)) {
        run.push(id);
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
        clippedRuns++;
      }
    }
    if (run.length > 0) runs.push(run);
    for (const nodeIds of runs) {
      const deduped = nodeIds.filter((id, i) => i === 0 || id !== nodeIds[i - 1]);
      if (deduped.length < 2) continue;
      for (const id of deduped) {
        if (!net.nodes.has(id)) {
          const node = osmNodes.get(id)!;
          net.nodes.set(id, project(node.lat, node.lon));
        }
      }
      const road: GraphRoad = { name, kind, width, nodeIds: deduped };
      // Filter free-floating stubs (share no node with any other road).
      const isolated = deduped.every((id) => (nodeUsage.get(id) ?? 0) < 2);
      if (isolated && roadLength(net, road) < MIN_ROAD_LENGTH_M) continue;
      net.roads.push(road);
    }
  }
  log.push(`roads: ${net.roads.length} polylines from ${roadWays.length} OSM ways (${clippedRuns} clipped at bbox edge)`);

  // ---- Topology repair ---------------------------------------------------
  const mergedNodes = snapNodes(net, SNAP_DISTANCE_M);
  net.roads = net.roads.filter((road) => road.nodeIds.length >= 2); // fully-collapsed stubs
  const endpointSnaps = snapEndpointsToSegments(net, SNAP_DISTANCE_M);
  log.push(`snapping: merged ${mergedNodes} junction nodes, snapped ${endpointSnaps} dangling endpoints (<= ${SNAP_DISTANCE_M} m)`);

  // ---- Density thinning ("guided by life") ---------------------------------
  const protectedNames = new Set<string>([...(extras.protectedNames ?? []), ...PROTECTED_ROAD_NAMES]);
  const thinReport = thinParallelRoads(net, {
    coverageDistance: THIN_COVERAGE_DISTANCE_M,
    coverageFraction: THIN_COVERAGE_FRACTION,
    sampleStep: THIN_SAMPLE_STEP_M,
    parallelCos: THIN_PARALLEL_COS,
    maxRank: THIN_MAX_RANK,
    protectedNames,
  });
  const prunedStubs = pruneShortStubs(net, STUB_PRUNE_LENGTH_M, protectedNames);
  log.push(
    `thinning: dropped ${thinReport.dropped} parallel minor roads (${thinReport.droppedKm.toFixed(1)} km) within ` +
      `${THIN_COVERAGE_DISTANCE_M} m of retained roads; pruned ${prunedStubs} dangling spurs < ${STUB_PRUNE_LENGTH_M} m`,
  );

  // ---- Jozi-by-the-Sea: coastal strip + rural corridor graft -----------------
  // City-block bounds BEFORE the graft: the ring must wrap the city, not the stretched
  // composite (otherwise it runs along the far corners and city-edge stubs miss its margin).
  const cityBounds = boundsOf(net.nodes.values());
  let coast: CoastGraftResult | undefined;
  if (extras.cape) {
    coast = graftCoastAndCorridor(net, extras.cape);
    for (const line of coast.log) log.push(line);
  }

  // ---- Boundary orbital (no dead ends at the crop edge) ---------------------
  // With a coast the west side is the coastal highway, so the orbital opens into a C.
  const ring = buildOrbitalRing(net, {
    boundaryMargin: RING_BOUNDARY_MARGIN_M,
    ringOffset: RING_OFFSET_M,
    cornerChamfer: RING_CORNER_CHAMFER_M,
    name: RING_NAME,
    kind: RING_KIND,
    width: ROAD_WIDTHS[RING_KIND] ?? 18,
    openAcrossWest: Boolean(coast),
    bounds: cityBounds,
  });
  log.push(`orbital: joined ${ring.stubs} boundary stubs into '${RING_NAME}'${ring.built ? '' : ' (not built)'}${coast ? ' (open west: coastal highway)' : ''}`);

  // Close the orbital's open ends onto the coastal highway — one drivable outer loop.
  if (coast && ring.endNodeIds) {
    for (const line of closeCoastalLoop(net, ring.endNodeIds, coast.highwayEndIds)) log.push(line);
  }

  const componentsBefore = connectedComponents(net).length;
  const islands = bridgeIslands(net, BRIDGE_DISTANCE_M);
  log.push(
    `connectivity: ${componentsBefore} components -> bridged ${islands.bridged} island joins (<= ${BRIDGE_DISTANCE_M} m), ` +
      `dropped ${islands.droppedIslands} islands totalling ${islands.droppedKm.toFixed(1)} km`,
  );
  if (islands.droppedSamples.length > 0) log.push(`dropped island samples: ${islands.droppedSamples.join(', ')}`);
  const componentsAfter = connectedComponents(net).length;
  log.push(`connectivity: final graph has ${componentsAfter} component(s)`);

  // ---- Dead-end resolution (join loops / connect / truncate) ----------------
  const deadEnds = resolveDeadEnds(net, {
    joinDistance: DEADEND_JOIN_M,
    connectDistance: DEADEND_CONNECT_M,
    pruneLength: DEADEND_PRUNE_M,
    pruneLengthMajor: DEADEND_PRUNE_MAJOR_M,
    culDeSacNames: new Set(CUL_DE_SAC_NAMES),
  });
  log.push(
    `dead ends: joined ${deadEnds.joined} pairs into loops, tied ${deadEnds.connected} into nearby roads, ` +
      `truncated ${deadEnds.truncated} tails (dropped ${deadEnds.droppedRoads} spurs); ${deadEnds.remaining} legit dead ends remain`,
  );

  // ---- Organic curvature for the synthetic roads --------------------------
  const curvedRoads = meanderSyntheticRoads(net);
  log.push(`meander: curved ${curvedRoads} synthetic spine road(s) with perpendicular fBm noise + Chaikin smoothing`);

  // ---- Junctions + simplification (junction vertices pinned) --------------
  const junctionInfos = findJunctions(net);
  const junctionNodeIds = new Set(junctionInfos.map((j) => j.nodeId));
  let pointsBefore = 0;
  let pointsAfter = 0;
  const simplifiedRoads: Array<{ road: GraphRoad; points: Pt[] }> = [];
  for (const road of net.roads) {
    const points = road.nodeIds.map((id) => net.nodes.get(id)!);
    const pins = new Set<number>();
    road.nodeIds.forEach((id, index) => {
      if (junctionNodeIds.has(id)) pins.add(index);
    });
    const simplified = simplifyWithPins(points, pins, SIMPLIFY_TOLERANCE_M);
    pointsBefore += points.length;
    pointsAfter += simplified.length;
    simplifiedRoads.push({ road, points: simplified });
  }
  log.push(`simplify: ${pointsBefore} -> ${pointsAfter} road vertices (Douglas-Peucker ${SIMPLIFY_TOLERANCE_M} m, junctions pinned)`);

  const totalRoadKm = simplifiedRoads.reduce((sum, r) => sum + polylineLength(r.points), 0) / 1000;

  // ---- Water -------------------------------------------------------------
  const water: Array<{ name: string; points: Pt[] }> = [];
  const waterWayIds = new Set<number>();
  for (const relation of relations) {
    if (relation.tags?.natural !== 'water') continue;
    const outers = relation.members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''));
    const rings = assembleRings(outers.map((m) => ways.find((w) => w.id === m.ref)).filter((w): w is OsmWay => Boolean(w)));
    for (const ring of rings) {
      const points = ring.map((id) => osmNodes.get(id)).filter((n): n is OsmNode => Boolean(n)).map((n) => project(n.lat, n.lon));
      if (points.length >= 4 && shoelaceArea(points) >= MIN_WATER_AREA_M2) {
        water.push({ name: relation.tags?.name ?? 'Water', points: simplifyPolyline(points, SIMPLIFY_TOLERANCE_M) });
      }
    }
    for (const m of outers) waterWayIds.add(m.ref);
  }
  for (const way of ways) {
    const isWater = way.tags?.natural === 'water' || (way.tags?.water !== undefined && !way.tags?.highway);
    if (!isWater || waterWayIds.has(way.id) || !way.nodes || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const points = way.nodes.slice(0, -1).map((id) => osmNodes.get(id)).filter((n): n is OsmNode => Boolean(n)).map((n) => project(n.lat, n.lon));
    if (points.length >= 4 && shoelaceArea(points) >= MIN_WATER_AREA_M2) {
      water.push({ name: way.tags?.name ?? 'Water', points: simplifyPolyline(points, SIMPLIFY_TOLERANCE_M) });
    }
  }
  if (coast) water.push({ name: coast.lake.name, points: coast.lake.polygon });
  log.push(`water: ${water.length} polygons >= ${MIN_WATER_AREA_M2} m2 (${water.filter((w) => w.name !== 'Water').map((w) => w.name).slice(0, 8).join(', ')})`);

  // ---- Railways (thinned to a few real lines; the yards are 600+ ways of spaghetti) -------
  const thinned = thinRailways(ways, osmNodes, project, inBbox);
  log.push(thinned.log);
  const railways: Array<{ name: string; points: Pt[] }> = thinned.lines
    .map((line) => ({ name: line.name, points: simplifyPolyline(line.points, SIMPLIFY_TOLERANCE_M) }));
  // Synthetic spur across the corridor to the airport: branch off the nearest mainline point
  // and swing to a halt beside the apron.
  if (coast && railways.length > 0) {
    const apron = coast.airport.apron;
    const halt: Pt = {
      x: apron.reduce((sum, p) => sum + p.x, 0) / apron.length,
      z: apron.reduce((sum, p) => sum + p.z, 0) / apron.length + 340,
    };
    let branch: Pt | null = null; let bestDistance = Infinity;
    for (const line of railways) {
      for (const p of line.points) {
        const d = Math.hypot(p.x - halt.x, p.z - halt.z);
        if (d < bestDistance) { bestDistance = d; branch = p; }
      }
    }
    if (branch) {
      const spurSeed = nameSeed('Lughawe Spur');
      const controls: Pt[] = [branch];
      for (const t of [0.3, 0.62]) {
        controls.push({
          x: branch.x + (halt.x - branch.x) * t + fbm(spurSeed, t * 4, 2) * 260,
          z: branch.z + (halt.z - branch.z) * t + fbm(spurSeed + 7, t * 4, 2) * 260,
        });
      }
      controls.push({ x: halt.x + 260, z: halt.z + 60 }, halt);
      railways.push({ name: 'Lughawe Spur', points: simplifyPolyline(smoothCurve(controls, 130), SIMPLIFY_TOLERANCE_M) });
      log.push(`railways: 'Lughawe Spur' branches ${Math.round(bestDistance / 1000)} km to the airport halt`);
    }
  }

  // ---- Tracks / trails (off-road; kept out of the connected road graph) ---
  const tracks: Array<{ name: string; kind: 'track' | 'path'; width: number; points: Pt[] }> = [];
  for (const way of ways) {
    const kind = way.tags?.highway;
    if ((kind !== 'track' && kind !== 'path') || !way.nodes) continue;
    const points = way.nodes
      .map((id) => osmNodes.get(id))
      .filter((n): n is OsmNode => n !== undefined && inBbox(n.lat, n.lon))
      .map((n) => project(n.lat, n.lon));
    if (points.length < 2 || polylineLength(points) < MIN_ROAD_LENGTH_M) continue;
    tracks.push({ name: way.tags?.name ?? (kind === 'track' ? 'Dirt track' : 'Trail'), kind, width: TRACK_WIDTHS[kind], points: simplifyPolyline(points, SIMPLIFY_TOLERANCE_M) });
  }
  if (coast) for (const track of coast.tracks) tracks.push({ name: track.name, kind: track.kind, width: track.width, points: track.points });
  const trackKm = tracks.reduce((sum, t) => sum + polylineLength(t.points), 0) / 1000;
  log.push(`tracks: ${tracks.length} off-road track/path polylines, ${trackKm.toFixed(1)} km`);

  // ---- Landuse / green / mining polygons ----------------------------------
  const landuse: Array<{ name: string; kind: MapArea['kind']; points: Pt[] }> = [];
  const landuseWayIds = new Set<number>();
  for (const relation of relations) {
    const kind = relation.tags ? landuseKind(relation.tags) : null;
    if (!kind) continue;
    const outers = relation.members.filter((m) => m.type === 'way' && (m.role === 'outer' || m.role === ''));
    const rings = assembleRings(outers.map((m) => ways.find((w) => w.id === m.ref)).filter((w): w is OsmWay => Boolean(w)));
    for (const ring of rings) {
      const points = ring.map((id) => osmNodes.get(id)).filter((n): n is OsmNode => Boolean(n)).map((n) => project(n.lat, n.lon));
      if (points.length >= 4 && shoelaceArea(points) >= MIN_LANDUSE_AREA_M2) {
        landuse.push({ name: relation.tags?.name ?? kind, kind, points: simplifyPolyline(points, SIMPLIFY_TOLERANCE_M) });
      }
    }
    for (const m of outers) landuseWayIds.add(m.ref);
  }
  for (const way of ways) {
    const kind = way.tags ? landuseKind(way.tags) : null;
    if (!kind || landuseWayIds.has(way.id) || !way.nodes || way.nodes[0] !== way.nodes[way.nodes.length - 1]) continue;
    const points = way.nodes.slice(0, -1).map((id) => osmNodes.get(id)).filter((n): n is OsmNode => Boolean(n)).map((n) => project(n.lat, n.lon));
    if (points.length >= 4 && shoelaceArea(points) >= MIN_LANDUSE_AREA_M2) {
      landuse.push({ name: way.tags?.name ?? kind, kind, points: simplifyPolyline(points, SIMPLIFY_TOLERANCE_M) });
    }
  }
  if (coast) for (const field of coast.farmland) landuse.push({ name: field.name, kind: 'farmland', points: field.points });
  if (coast) landuse.push({ name: coast.airport.name, kind: 'aerodrome', points: coast.airport.boundary });
  const mineDumps = landuse.filter((a) => a.kind === 'mine_dump').length;
  log.push(`landuse: ${landuse.length} polygons (${mineDumps} mine dumps/quarries, ${coast?.farmland.length ?? 0} farmland fields)`);

  // ---- Districts ---------------------------------------------------------
  const districtNodes = extractDistrictNodes(data);
  const districts = districtNodes.map(({ name, lat, lon }) => ({ name, p: project(lat, lon) }));
  if (coast) districts.push(...coast.districts);
  const buildingCounts = extras.buildingCounts ?? null;
  log.push(`districts: ${districts.length} place nodes${buildingCounts ? ' (with building densities)' : ' (building densities unavailable)'}`);

  // ---- Landmarks ---------------------------------------------------------
  const landmarks: Array<{ name: string; p: Pt; kind: string }> = [];
  const seenLandmarks = new Set<string>();
  for (const element of landmarkElements) {
    const tags = element.tags ?? {};
    const name = tags.name;
    if (!name) continue;
    const kind = landmarkKind(tags);
    // Stations come from the Gautrain query; everything else must be an exact
    // canonical match so "Soccer City ticket office" & co. stay out.
    if (kind !== 'station' && !LANDMARK_CANONICAL.test(name)) continue;
    const key = name.toLowerCase();
    if (seenLandmarks.has(key)) continue;
    const lat = element.type === 'node' ? element.lat : element.center?.lat;
    const lon = element.type === 'node' ? element.lon : element.center?.lon;
    if (lat === undefined || lon === undefined || !inBbox(lat, lon)) continue;
    seenLandmarks.add(key);
    landmarks.push({ name, p: project(lat, lon), kind });
  }
  if (coast) landmarks.push({ name: coast.padstal.name, p: coast.padstal.p, kind: 'padstal' });
  if (coast) {
    landmarks.push({ name: coast.airport.name, p: coast.airport.center, kind: 'airport' });
    const portMid = { x: (coast.port.apron[0]!.x + coast.port.apron[2]!.x) / 2, z: (coast.port.apron[0]!.z + coast.port.apron[2]!.z) / 2 };
    landmarks.push({ name: coast.port.name, p: portMid, kind: 'port' });
  }
  // The stadium sometimes appears under both names; keep "FNB Stadium".
  if (landmarks.some((l) => /fnb stadium/i.test(l.name))) {
    const index = landmarks.findIndex((l) => /^soccer city$/i.test(l.name));
    if (index !== -1) landmarks.splice(index, 1);
  }
  log.push(`landmarks: ${landmarks.length} (${landmarks.map((l) => l.name).slice(0, 10).join(', ')}${landmarks.length > 10 ? ', ...' : ''})`);

  // ---- Fit to target footprint --------------------------------------------
  // Roads keep the true-parity TARGET_SIZE fit (1 unit ~= 1 m); the declared world square
  // grows by the edge margin instead, so no road runs along the very world edge — the
  // set-back band gets border veld below, so the rim is cover, not void.
  const worldSize = TARGET_SIZE + 2 * EDGE_MARGIN_UNITS;
  const allRoadPoints: Pt[] = simplifiedRoads.flatMap((r) => r.points);
  const bounds = boundsOf(allRoadPoints);
  const fit = makeFitTransform(bounds, TARGET_SIZE);
  log.push(
    `fit: road bbox ${(bounds.maxX - bounds.minX).toFixed(0)} x ${(bounds.maxZ - bounds.minZ).toFixed(0)} m -> ` +
      `${TARGET_SIZE} unit fit in a ${worldSize} unit world (${EDGE_MARGIN_UNITS} u edge set-back), ` +
      `1 unit = ${fit.metresPerUnit.toFixed(2)} m`,
  );

  // ---- Border veld: scrub cover between the outer roads and the world edge ---
  if (coast) {
    const worldNW = fit.invert({ x: -worldSize / 2, z: -worldSize / 2 });
    const worldSE = fit.invert({ x: worldSize / 2, z: worldSize / 2 });
    const veld = buildBorderVeld({
      world: { minX: worldNW.x, minZ: worldNW.z, maxX: worldSE.x, maxZ: worldSE.z },
      coastline: coast.coastline,
    });
    for (const band of veld) landuse.push({ name: band.name, kind: 'scrub', points: band.points });
    log.push(`border: ${veld.length} veld bands along the N/E/S world edges (${EDGE_MARGIN_UNITS} u set-back cover)`);
  }
  const toUnits = (p: Pt): [number, number] => {
    const q = fit.apply(p);
    return [round2(q.x), round2(q.z)];
  };

  // ---- Elevation grid -> game units ---------------------------------------
  const elevation = extras.elevation ?? flatGrid('no elevation samples supplied');
  // Cell centres are uniform in lat/lon; the projection+fit is affine, so the
  // grid stays uniform in game units. Derive origin/spacing from two samples.
  const nw = fit.apply(project(
    BBOX.north - (0.5 * (BBOX.north - BBOX.south)) / elevation.rows,
    BBOX.west + (0.5 * (BBOX.east - BBOX.west)) / elevation.cols,
  ));
  const next = fit.apply(project(
    BBOX.north - (1.5 * (BBOX.north - BBOX.south)) / elevation.rows,
    BBOX.west + (1.5 * (BBOX.east - BBOX.west)) / elevation.cols,
  ));
  // With a coast the grid is rebuilt over the whole composite square: SRTM over the city,
  // synthetic rolling corridor + sea level over the graft (Phase 3 terrain gets it for free).
  const composite = coast ? compositeElevation({
    srtm: elevation,
    joburgNW: project(BBOX.north, BBOX.west),
    joburgSE: project(BBOX.south, BBOX.east),
    coast,
    fit,
    targetSize: worldSize,
  }) : undefined;
  const heightData = composite ? composite.data : elevation.data;
  const minElevation = Math.min(...heightData);
  const maxElevation = Math.max(...heightData);
  log.push(`elevation: ${composite ? composite.cols : elevation.cols}x${composite ? composite.rows : elevation.rows} grid, ${minElevation}..${maxElevation} m (${composite ? composite.source : elevation.source})`);

  // ---- Land/ocean split (composite stats for the preview) --------------------
  let oceanKm2: number | undefined; let landKm2: number | undefined;
  if (coast) {
    const oceanUnits = coast.ocean.map((p) => fit.apply(p));
    let minOX = Infinity; let maxOX = -Infinity; let minOZ = Infinity; let maxOZ = -Infinity;
    for (const p of oceanUnits) { minOX = Math.min(minOX, p.x); maxOX = Math.max(maxOX, p.x); minOZ = Math.min(minOZ, p.z); maxOZ = Math.max(maxOZ, p.z); }
    const inOcean = (x: number, z: number): boolean => {
      if (x < minOX || x > maxOX || z < minOZ || z > maxOZ) return false;
      let inside = false;
      for (let i = 0, j = oceanUnits.length - 1; i < oceanUnits.length; j = i++) {
        const a = oceanUnits[i]!; const b = oceanUnits[j]!;
        if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      return inside;
    };
    const samples = 160;
    let oceanHits = 0;
    for (let row = 0; row < samples; row++) for (let col = 0; col < samples; col++) {
      const x = -worldSize / 2 + ((col + 0.5) * worldSize) / samples;
      const z = -worldSize / 2 + ((row + 0.5) * worldSize) / samples;
      if (inOcean(x, z)) oceanHits++;
    }
    const totalKm2 = (worldSize * fit.metresPerUnit / 1000) ** 2;
    oceanKm2 = Math.round(totalKm2 * (oceanHits / (samples * samples)) * 10) / 10;
    landKm2 = Math.round((totalKm2 - oceanKm2) * 10) / 10;
    log.push(`coast: ocean covers ~${oceanKm2} km2 of the ${Math.round(totalKm2)} km2 square`);
  }

  const map: JoburgMap = {
    meta: {
      source: 'OpenStreetMap via Overpass API',
      attribution: 'Map data © OpenStreetMap contributors, ODbL 1.0',
      generatedBy: 'tools/mapgen (npm run map:build)',
      coordinateSystem: `game units, +x east, +z south, origin at map centre; 1 unit = ${fit.metresPerUnit.toFixed(3)} m`,
    },
    stats: {
      totalRoadKm: Math.round(totalRoadKm * 10) / 10,
      roadCount: simplifiedRoads.length,
      junctionCount: junctionInfos.length,
      districtCount: districts.length,
      waterCount: water.length,
      landmarkCount: landmarks.length,
      trackKm: Math.round(trackKm * 10) / 10,
      trackCount: tracks.length,
      landuseCount: landuse.length,
      bridgedIslands: islands.bridged,
      droppedIslands: islands.droppedIslands,
      droppedIslandKm: Math.round(islands.droppedKm * 10) / 10,
      minElevation,
      maxElevation,
      bbox: { ...BBOX },
      targetSize: worldSize,
      metresPerUnit: Math.round(fit.metresPerUnit * 1000) / 1000,
      ...(coast ? {
        oceanKm2,
        landKm2,
        corridorWidthUnits: Math.round((coast.corridorEastX - coast.corridorWestX) * fit.scale),
      } : {}),
    },
    roads: simplifiedRoads.map(({ road, points }) => ({
      name: road.name,
      width: road.width,
      kind: road.kind,
      points: points.map(toUnits),
    })),
    junctions: junctionInfos.map((junction) => {
      const [x, z] = toUnits(net.nodes.get(junction.nodeId)!);
      return { x, z, roads: junction.roads };
    }),
    districts: districts.map(({ name, p }, index) => {
      const [x, z] = toUnits(p);
      const count = buildingCounts?.[index];
      const areaKm2 = Math.PI * (DISTRICT_RADIUS_M / 1000) ** 2;
      return {
        name,
        x,
        z,
        radius: round2(DISTRICT_RADIUS_M * fit.scale),
        ...(count !== undefined ? { buildingDensity: Math.round(count / areaKm2) } : {}),
      };
    }),
    water: water.map(({ name, points }) => ({ name, points: points.map(toUnits) })),
    railways: railways.map(({ name, points }) => ({ name, points: points.map(toUnits) })),
    landmarks: landmarks.map(({ name, p, kind }) => {
      const [x, z] = toUnits(p);
      return { name, x, z, kind };
    }),
    tracks: tracks.map(({ name, kind, width, points }) => ({
      name,
      width,
      kind,
      unpaved: true as const,
      points: points.map(toUnits),
    })),
    landuse: landuse.map(({ name, kind, points }) => ({ name, kind, points: points.map(toUnits) })),
    elevation: composite ? {
      cols: composite.cols,
      rows: composite.rows,
      x0: round2(composite.x0),
      z0: round2(composite.z0),
      dx: round2(composite.dx),
      dz: round2(composite.dz),
      source: composite.source,
      data: composite.data,
    } : {
      cols: elevation.cols,
      rows: elevation.rows,
      x0: round2(nw.x),
      z0: round2(nw.z),
      dx: round2(next.x - nw.x),
      dz: round2(next.z - nw.z),
      source: elevation.source,
      data: elevation.data,
    },
    ...(coast ? {
      coast: {
        coastline: coast.coastline.map(toUnits),
        ocean: coast.ocean.map(toUnits),
        beaches: coast.beaches.map((beach) => ({ name: beach.name, points: beach.points.map(toUnits) })),
        harbour: (() => { const [x, z] = toUnits(coast.harbour); return { x, z }; })(),
        corridor: {
          eastX: round2(fit.apply({ x: coast.corridorEastX, z: 0 }).x),
          westX: round2(fit.apply({ x: coast.corridorWestX, z: 0 }).x),
          northZ: round2(fit.apply({ x: 0, z: cityBounds.minZ }).z),
          southZ: round2(fit.apply({ x: 0, z: cityBounds.maxZ }).z),
        },
      },
      rural: {
        farms: coast.farms.map((farm) => { const [x, z] = toUnits(farm.p); return { x, z, kind: farm.kind }; }),
        padstal: (() => { const [x, z] = toUnits(coast.padstal.p); return { x, z, name: coast.padstal.name }; })(),
      },
      airport: {
        name: coast.airport.name,
        runway: { kind: 'runway' as const, width: 14, points: coast.airport.runway.map(toUnits) },
        taxiway: { kind: 'taxiway' as const, width: 6, points: coast.airport.taxiway.map(toUnits) },
        apron: coast.airport.apron.map(toUnits),
        buildings: coast.airport.buildings.map((b) => b.map(toUnits)),
      },
      port: {
        name: coast.port.name,
        pier: { kind: 'pier' as const, width: 5, points: coast.port.pier.map(toUnits) },
        apron: coast.port.apron.map(toUnits),
      },
    } : {}),
  };
  return { map, log };
}

/** Stitch outer member ways of a multipolygon into closed node-id rings. */
export function assembleRings(memberWays: OsmWay[]): number[][] {
  const remaining = memberWays.filter((w) => w.nodes && w.nodes.length >= 2).map((w) => [...w.nodes]);
  const rings: number[][] = [];
  while (remaining.length > 0) {
    const ring = remaining.shift()!;
    let extended = true;
    while (extended && ring[0] !== ring[ring.length - 1]) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const tail = ring[ring.length - 1];
        if (candidate[0] === tail) {
          ring.push(...candidate.slice(1));
        } else if (candidate[candidate.length - 1] === tail) {
          ring.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1] && ring.length >= 4) rings.push(ring.slice(0, -1));
  }
  return rings;
}
