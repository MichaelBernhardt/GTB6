/**
 * Data-driven world anchors for the generated OSM map: player spawn, shops, safehouse,
 * mission targets, parked vehicles, gantries, ranks and roadside signs. Everything here is
 * computed from named roads / district centres / water polygons in joburg-map.json, so a
 * map rebuild re-anchors the whole game instead of leaving stale hand-authored coordinates.
 *
 * Placement is claims-aware: each anchor searches along its road for a kerbside spot that is
 * clear of every other road (the CBD grid is dense) and of every previously placed anchor.
 * Pure data (plain {x,z} points) — no three.js — so systems and tests can consume it freely.
 */
import {
  CBD_CENTER,
  STATIONS,
  computeSignalJunctions,
  districtCenter,
  distanceToRoadEdge,
  GENERATED_ROADS,
  landmark,
  METRES_PER_UNIT,
  SIGNAL_JUNCTIONS,
  WATER_POLYGONS,
  DIRT_POLYGONS,
  type GeneratedRoad,
  type MapPt,
  type SignalJunctionDef,
} from './mapData';
import { BEACHFRONT_PADS } from './beachfront';
import { toNewWorld } from './coordTransform';

export interface PlacedSite {
  x: number;
  z: number;
  /** Yaw facing the street — the true kerb angle (oriented-box colliders follow it, no quarter snap). */
  heading: number;
}

export interface ShopSite {
  /** Interaction pad (marker disc) between the road and the storefront. */
  pad: MapPt;
  /** Building/stand centre. */
  building: PlacedSite;
}

export interface ReservedPad { x: number; z: number; radius: number; }

/**
 * The block-away "near" nudges and search radii below were authored against the 2.94 m/unit
 * (6000u) layout. P tracks the map footprint (1.0 at the old scale, ~6.0 at 36000u) so anchors
 * land on the same real block and the named-road search still reaches it after the 6x scale-up.
 * Small kerb clearances (clearance/ownRadius/minEdge) are real geometry and stay unscaled.
 */
const P = 2.94 / METRES_PER_UNIT;

/**
 * SEARCH SEEDS AUTHORED IN THE OLD 19,200-UNIT WORLD.
 *
 * Everything else in this file is CBD/district/landmark-relative and follows a re-crop for free.
 * These five are raw coordinates, and after the 2/3 crop + 0.75x rescale the raw literals point at
 * empty veld: three fell outside the world square altogether and the nearest carriageway to any of
 * them was 100–1,060 u away, so `bestKerbSpot` silently fell through to its last-resort "nearest
 * vertex of the named road" branch and dumped the site wherever that happened to be.
 *
 * `toNewWorld` is the exact old->new similarity (src/world/coordTransform.ts), so wrapping the
 * literal keeps its provenance, re-derives it against whatever map is committed, and — because the
 * transform is a projection change, not a resize — preserves REAL-WORLD METRES exactly
 * (k = 0.74997 units, metres-per-unit rises by 1/k). Every mission-tier distance these seeds imply
 * is therefore the same drive it always was.
 */
const authored = toNewWorld;

// ---- Claims-aware kerbside search ------------------------------------------------

const claimed: ReservedPad[] = [];

function clearOfClaims(x: number, z: number, radius: number): boolean {
  return !claimed.some((pad) => (pad.x - x) ** 2 + (pad.z - z) ** 2 < (pad.radius + radius) ** 2);
}

function claim(x: number, z: number, radius: number): void {
  claimed.push({ x, z, radius });
}

interface KerbSpot {
  x: number;
  z: number;
  /** Centreline point the spot was offset from. */
  roadX: number;
  roadZ: number;
  /** Unit direction of the road at the spot. */
  dirX: number;
  dirZ: number;
  side: 1 | -1;
  road: GeneratedRoad;
}

interface SpotQuery {
  /** Restrict to this in-game road name (post-override); omit for "any road". */
  name?: string;
  near: MapPt;
  /** Offset beyond the road edge for the spot centre. */
  clearance: number;
  /** Keep-out radius against previously claimed anchors. */
  ownRadius: number;
  /** Required clearance from every OTHER road surface. */
  minEdge: number;
  searchRadius?: number;
  minRoadWidth?: number;
}

/**
 * Roads whose name an anchor asked for and the map does not have. A named-road anchor used to
 * THROW here, which meant a re-crop that dropped one street took down this whole module — and
 * with it src/world/City.ts and 38 test files — at import time. A missing street is a content
 * problem, not a structural one: warn once, drop the name constraint and place the site on
 * whatever road is nearest its intended point. Only a map with no usable road at all still
 * throws, because that really is a broken map.
 */
const missingRoads = new Set<string>();
export function missingAnchorRoads(): string[] { return [...missingRoads].sort(); }

const ROAD_NAMES = new Set(GENERATED_ROADS.map((road) => road.name));

/** Walks the matching polylines around `near` (samples every ~8u) and returns the clearest kerbside spot. */
function bestKerbSpot(request: SpotQuery): KerbSpot {
  let query = request;
  if (query.name !== undefined && !ROAD_NAMES.has(query.name)) {
    if (!missingRoads.has(query.name)) {
      missingRoads.add(query.name);
      console.warn(`[placements] no road named "${query.name}" in this map — anchoring to the nearest road instead`);
    }
    // Widen the reach too: the intended point was authored beside a street that is gone, so the
    // nearest surviving carriageway can be a block or three away.
    const rest: SpotQuery = { ...query };
    delete rest.name;
    query = { ...rest, searchRadius: (query.searchRadius ?? 200) * 3 };
  }
  const { near, clearance, ownRadius, searchRadius = 200 } = query;
  const effRadius = searchRadius * P; // reach scales with the footprint so named roads stay findable
  const searchSq = effRadius * effRadius;
  let best: KerbSpot | undefined; let bestScore = -Infinity;
  const consider = (px: number, pz: number, dirX: number, dirZ: number, road: GeneratedRoad, minEdge: number): void => {
    for (const side of [1, -1] as const) {
      const offset = side * (road.width / 2 + clearance);
      const x = px - dirZ * offset; const z = pz + dirX * offset;
      const edge = distanceToRoadEdge(x, z);
      if (edge < minEdge || !clearOfClaims(x, z, ownRadius)) continue;
      // The FOOTPRINT must clear the tar too, not just the centre: at an intersection a spot beside
      // the named road can hang its building into the CROSSING carriageway (the Sip ’n Save bug).
      // Probe the claim circle, clamped inside the own-road clearance so the road-side probe passes
      // by construction (kerb-hugging vehicle spots keep working) — a failing probe therefore means
      // a FOREIGN road runs under the footprint.
      const reach = Math.min(ownRadius * 0.8, Math.max(0.4, clearance - 0.4));
      if ([[reach, 0], [-reach, 0], [0, reach], [0, -reach]]
        .some(([ox, oz]) => distanceToRoadEdge(x + ox!, z + oz!) < 0.3)) continue;
      const score = Math.min(edge, 6) * 2 - Math.hypot(x - near.x, z - near.z) * 0.06;
      if (score > bestScore) { bestScore = score; best = { x, z, roadX: px, roadZ: pz, dirX, dirZ, side, road }; }
    }
  };
  const scan = (minEdge: number, ignoreClaims: boolean): void => {
    for (const road of GENERATED_ROADS) {
      if (query.name !== undefined && road.name !== query.name) continue;
      if (query.minRoadWidth !== undefined && road.width < query.minRoadWidth) continue;
      for (let index = 0; index < road.points.length - 1; index++) {
        const a = road.points[index]!; const b = road.points[index + 1]!;
        if ((a.x - near.x) ** 2 + (a.z - near.z) ** 2 > searchSq && (b.x - near.x) ** 2 + (b.z - near.z) ** 2 > searchSq) continue;
        const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz) || 1;
        const dirX = dx / length; const dirZ = dz / length;
        const steps = Math.max(1, Math.round(length / 8));
        for (let step = 0; step <= steps; step++) {
          const t = step / steps;
          const px = a.x + dx * t; const pz = a.z + dz * t;
          if (ignoreClaims) consider(px, pz, dirX, dirZ, road, minEdge); else consider(px, pz, dirX, dirZ, road, minEdge);
        }
      }
    }
  };
  scan(query.minEdge, false);
  if (!best) scan(Math.min(query.minEdge, 0.2), false); // relax edge clearance
  if (!best) { // last resort: nearest vertex of the matching road, claims ignored — but simplification
    // pins surviving vertices AT junctions, so prefer one whose spot doesn't sit in a crossing road
    // (the Sip ’n Save landed dead-centre in the Dam Wal Road / Madiba Meander intersection this way).
    let bestAny: KerbSpot | undefined; let bestAnyD = Infinity; let bestCleanD = Infinity;
    for (const road of GENERATED_ROADS) {
      if (query.name !== undefined && road.name !== query.name) continue;
      for (let index = 0; index < road.points.length; index++) {
        const point = road.points[index]!;
        const distance = (point.x - near.x) ** 2 + (point.z - near.z) ** 2;
        if (distance >= bestAnyD && distance >= bestCleanD) continue;
        const previous = road.points[Math.max(0, index - 1)]!; const next = road.points[Math.min(road.points.length - 1, index + 1)]!;
        const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
        const offset = road.width / 2 + query.clearance;
        const spot: KerbSpot = { x: point.x - (dz / length) * offset, z: point.z + (dx / length) * offset, roadX: point.x, roadZ: point.z, dirX: dx / length, dirZ: dz / length, side: 1, road };
        if (distance < bestAnyD) { bestAny = spot; bestAnyD = distance; }
        if (distance < bestCleanD && distanceToRoadEdge(spot.x, spot.z) >= 0.3) { best = spot; bestCleanD = distance; }
      }
    }
    best ??= bestAny;
  }
  // Reachable only when GENERATED_ROADS itself is empty or degenerate — every named lookup has
  // already fallen back to "any road" above.
  if (!best) throw new Error(`placements: the map has no usable road for an anchor near (${near.x.toFixed(0)}, ${near.z.toFixed(0)})`);
  claim(best.x, best.z, ownRadius);
  return best;
}

/**
 * Search seed taken from a district centre, so anchors follow the map through a re-crop instead
 * of being frozen at coordinates authored against an older footprint. The literal is only the
 * fallback for a district the current map does not carry.
 */
function near(district: string, fallback: MapPt): MapPt {
  const centre = districtCenter(district as Parameters<typeof districtCenter>[0]);
  return centre ? { x: centre.x, z: centre.z } : fallback;
}

/** Storefront site: pad near the kerb, building behind it, door facing the road. */
function shopSite(roadName: string, near: MapPt, buildingClearance: number, padClearance: number, buildingRadius: number, minEdge: number, searchRadius?: number): ShopSite {
  const spot = bestKerbSpot({ name: roadName, near, clearance: buildingClearance, ownRadius: buildingRadius, minEdge, searchRadius });
  const toRoadX = spot.roadX - spot.x; const toRoadZ = spot.roadZ - spot.z;
  const toRoadLength = Math.hypot(toRoadX, toRoadZ) || 1;
  const pad = {
    x: spot.roadX - (toRoadX / toRoadLength) * (spot.road.width / 2 + padClearance),
    z: spot.roadZ - (toRoadZ / toRoadLength) * (spot.road.width / 2 + padClearance),
  };
  // Face the street at the true kerb angle (oriented-box colliders now follow it — no quarter snap).
  const heading = Math.atan2(toRoadX, toRoadZ);
  return { pad, building: { x: spot.x, z: spot.z, heading } };
}

/** Kerbside vehicle spot: parked just off the carriageway, nose along the road. */
function kerbVehicleSpot(roadName: string | undefined, near: MapPt, clearance = 1.6): PlacedSite {
  const spot = bestKerbSpot({ ...(roadName ? { name: roadName } : {}), near, clearance, ownRadius: 3.4, minEdge: 0.1 });
  return { x: spot.x, z: spot.z, heading: Math.atan2(spot.dirX, spot.dirZ) };
}

/** Sidewalk point beside the named road. */
function walkSpot(roadName: string, near: MapPt, clearance = 2.6, ownRadius = 4): MapPt {
  const spot = bestKerbSpot({ name: roadName, near, clearance, ownRadius, minEdge: 0.5 });
  return { x: spot.x, z: spot.z };
}

/** Sidewalk point near an arbitrary location, whatever road is closest. */
function walkSpotNear(near: MapPt, clearance = 2.6, ownRadius = 4, minRoadWidth = 7): MapPt {
  const spot = bestKerbSpot({ near, clearance, ownRadius, minEdge: 0.5, minRoadWidth });
  return { x: spot.x, z: spot.z };
}

// ---- Player spawn (Risk-It Street, CBD core) ---------------------------------

const spawnPoint = (() => {
  const spot = bestKerbSpot({ name: 'Risk-It Street', near: { x: CBD_CENTER.x, z: CBD_CENTER.z }, clearance: 2.6, ownRadius: 6, minEdge: 0.8, searchRadius: 120 });
  return { x: spot.x, z: spot.z };
})();
export const PLAYER_SPAWN: [number, number, number] = [spawnPoint.x, 1, spawnPoint.z];
export const SPAWN_POINT: MapPt = spawnPoint;

// ---- JMPD lock-up (bust release point) ---------------------------------------

/** Where JMPD dumps you on the kerb after a bust — a fixed CBD spot on Commissioner Street (the John-Vorster
 *  Square of Joburg lore), a couple of blocks off spawn so you're not released right where you started. */
const policeStationSpot = (() => {
  const spot = bestKerbSpot({ name: 'Commissioner Street', near: { x: CBD_CENTER.x - 24 * P, z: CBD_CENTER.z + 66 * P }, clearance: 2.6, ownRadius: 6, minEdge: 0.8, searchRadius: 140 });
  return { x: spot.x, z: spot.z };
})();
export const POLICE_STATION: [number, number, number] = [policeStationSpot.x, 1, policeStationSpot.z];

// ---- Shops --------------------------------------------------------------------

// The story anchors used to be forced into one tight cluster by the old small map; on the 1:1 CBD (1u ≈ 1m)
// they now sit a real drive apart — one to each far quarter, the boerie stand near the central plaza.
/** Jozi Arms: Simmonds Street, deep south-west. */
export const ARMS_SITE = shopSite('Simmonds Street', { x: CBD_CENTER.x - 80 * P, z: CBD_CENTER.z + 32 * P }, 8.2, 3.8, 8, 3);
/** Pik-'n'-Spray: Kruis Street, far north-east (drive-in). */
export const SPRAY_SITE = shopSite('Kruis Street', { x: CBD_CENTER.x + 114 * P, z: CBD_CENTER.z - 42 * P }, 9.6, 3.4, 9, 4);
/** Garage: Albertina Sisulu Road, far north-west (drive-in storage, wide carriageway). */
export const GARAGE_SITE = shopSite('Albertina Sisulu Road', { x: CBD_CENTER.x - 41 * P, z: CBD_CENTER.z - 102 * P }, 8, 3.4, 7.5, 3.5);
/** Boerie Stand: Anderson Street, near the central plaza a block off spawn. */
export const HOTDOG_SITE = shopSite('Anderson Street', { x: CBD_CENTER.x + 5 * P, z: CBD_CENTER.z + 22 * P }, 3, 1.9, 3, 0.8);
/** Bottle stores are dotted across the whole map — a couple around the CBD, a few in the outlying towns, and
 *  two along the coast promenade. Each is a kerbside storefront with its own tacky sign (kept short so it fits
 *  the board). Adding an entry here auto-registers it with the shop system, the map blips, the teleport list,
 *  and the reserved-pad carve-outs below — so a procedural building can never squat on the plot. */
export interface BottleStore { name: string; sign: string; site: ShopSite; }
export const BOTTLE_STORES: BottleStore[] = [
  // CBD & inner ring
  { name: 'Tops-ish Bottle Store', sign: 'TOPS-ISH', site: shopSite('Commissioner Street', { x: CBD_CENTER.x + 58 * P, z: CBD_CENTER.z + 14 * P }, 8, 3.6, 7.5, 3) },
  { name: 'Maboneng Dop Shop', sign: 'DOP SHOP', site: shopSite('Maritzburg Street', authored({ x: 4838, z: 5010 }), 8, 3.6, 7.5, 3) },
  { name: 'Melville Bottle Bar', sign: 'DRANK', site: shopSite('Main Road', authored({ x: -1150, z: 1870 }), 8, 3.6, 7.5, 3) },
  // Northern suburbs. These two were pinned to South Road (Sandton) and Republic Road
  // (Randburg) at hard-coded points 2,700 units past the north world edge; the 2/3 crop removed
  // both streets and bestKerbSpot threw at module import, which took down this file, City.ts and
  // 38 test files with it. Anchored on district centres now, so a re-crop moves them with the
  // map instead of stranding them — the brands keep their suburb names, which is how a bottle
  // store off the Randburg road is named anyway.
  { name: 'Rivonia Cellars', sign: 'CELLARS', site: shopSite('Oxfraud Road', near('Dunkeld', { x: 1824, z: -3997 }), 8, 3.6, 7.5, 3) },
  { name: 'Randburg Drankwinkel', sign: 'LIQUORS', site: shopSite('Beyers Naudé Drive', near('Montgomery Park', { x: -2220, z: -2086 }), 8, 3.6, 7.5, 3) },
  // Dam promenade (inland side of the shore road so they sit on land, not in the water). The two
  // fallbacks are the districts' own measured centres on the committed map: the previous literals
  // were left over from the synthetic sea shoreline and put Groenpunt 4.4 km away on the WRONG side
  // of the map, which would have been invisible until the day a re-crop dropped the district.
  // Dam Wal Road is a 14 km hull along the whole dam shore and the Vaalpunt district centre now
  // sits on the widest part of the reach, where the road's own nodes are 600 u apart and every kerb
  // spot within the default 200 u reach lands in a junction. A wider search finds real kerb.
  { name: 'Vaalpunt Sip ’n Save', sign: 'SIP N SAVE', site: shopSite('Dam Wal Road', near('Vaalpunt', { x: -3209, z: 40 }), 8, 3.6, 7.5, 3, 900) },
  { name: 'Groenpunt Grog', sign: 'GROG', site: shopSite('Madiba Meander', near('Groenpunt', { x: -4234, z: 2042 }), 8, 3.6, 7.5, 3) },
];

/** Stored vehicle pose inside the garage, nose pointing out the door. */
export const GARAGE_PARK: PlacedSite = {
  x: GARAGE_SITE.building.x, z: GARAGE_SITE.building.z,
  heading: GARAGE_SITE.building.heading,
};
/** Where the player steps after storing a vehicle: between pad and door. */
export const GARAGE_EXIT: MapPt = {
  x: (GARAGE_SITE.pad.x + GARAGE_SITE.building.x) / 2 + 3,
  z: (GARAGE_SITE.pad.z + GARAGE_SITE.building.z) / 2,
};

// ---- Safehouse ------------------------------------------------------------------

/** Salisbury Court: a flat on Salisbury Street, deep south-east. */
export const SAFEHOUSE_SITE = shopSite('Salisbury Street', { x: CBD_CENTER.x + 92 * P, z: CBD_CENTER.z + 92 * P }, 9.4, 3.6, 9, 3.5);

// ---- Side-job depots ---------------------------------------------------------------

/** Sixty-Sekonds dispatch: a kerbside grocery hatch in the CBD. Riders return here for every new basket. */
export const COURIER_DEPOT = walkSpot('Commissioner Street', { x: CBD_CENTER.x + 25 * P, z: CBD_CENTER.z - 18 * P }, 4.2, 6);

// ---- Districts / landmarks used by missions --------------------------------------

const braamfontein = districtCenter('Braamfontein') ?? CBD_CENTER;
const newtown = districtCenter('Newtown') ?? CBD_CENTER;
const hillbrow = districtCenter('Hillbrow') ?? CBD_CENTER;
// The 2/3 crop cut Sandton and Sandhurst off the top of the map. Dunkeld is the northernmost
// surviving northern-suburbs district, so it inherits the "far north, moneyed" role Sandton played
// as a fallback anchor. Falling through to CBD_CENTER instead would have quietly parked the padstal
// in the middle of town.
const northernSuburbs = districtCenter('Dunkeld') ?? districtCenter('Parktown') ?? CBD_CENTER;
const zooLake = WATER_POLYGONS.find((water) => /zoo/i.test(water.name));
const zooLakeCenter: MapPt = zooLake ? { x: zooLake.cx, z: zooLake.cz } : { x: braamfontein.x, z: braamfontein.z };

// ---- Missions ---------------------------------------------------------------------

/** Auntie Portia (Couch Run): You-Bet Street, around the corner from spawn. */
export const PORTIA_START = walkSpot('You-Bet Street', { x: CBD_CENTER.x + 30 * P, z: CBD_CENTER.z + 25 * P }, 3, 5);
/** The couch drops. Round 4 (owner): the old pair sat 631/916 m out — "too close again" — so both
 *  moved to ~double the road distance (harness-measured 1,475 m and 1,665 m legs, return 1,711 m; the
 *  mission re-tiered favour → standard to match). Drop 2 deliberately leaves Newtown alone: it used
 *  to land 15 u from where Candice permanently stands, which made "go meet Candice" a non-trip. */
export const DELIVERY_STOPS: MapPt[] = [
  walkSpot('Commissioner Street', { x: CBD_CENTER.x - 119 * P, z: CBD_CENTER.z - 61 * P }, 3, 5), // CBD west end
  walkSpot('Sophie de Bruyn Street', { x: CBD_CENTER.x + 142 * P, z: CBD_CENTER.z - 356 * P }, 3, 5), // Doornfontein/Hillbrow edge
];

/** Bra Vusi (Hot Copper): Pothole Street block. */
export const VUSI_START = walkSpot('Pothole Street', { x: CBD_CENTER.x + 30 * P, z: CBD_CENTER.z - 75 * P }, 3, 5);
/** Vusi's lock-up: his Braamfontein garage (~1.8km, SUBSTANTIAL tier — the GTI run is a real
 *  cross-town delivery, and the JMPD pursuit is the event en route). */
export const LOCKUP_SPOT = walkSpotNear({ x: braamfontein.x - 18 * P, z: braamfontein.z + 22 * P }, 4.5, 6);

/** Candice's NEWTOWN RANK: a real taxi-rank set piece on Ntemi Piliso Street at the Newtown
 *  centre — shade port, benches, name board, minibus taxis on the kerb. Built as a live scripted
 *  prop (world/MissionRanks.ts); the reserved pad below keeps procedural buildings and scatter off
 *  the plot (RESERVED_PADS feeds CityGen/ModelScatter, so changing this forces a re-bake).
 *  Every "Newtown rank" reference in the story points HERE, and Candice stands at the rank mouth
 *  (owner: "she should be located at some taxi rank (Newtown Rank) … a protected mission object" —
 *  protection = her contact-ped invulnerability + this structure + its reserved pad). */
const newtownRankKerb = bestKerbSpot({ name: 'Ntemi Piliso Street', near: { x: newtown.x + 6 * P, z: newtown.z - 4 * P }, clearance: 9, ownRadius: 13, minEdge: 3 });
export const NEWTOWN_RANK_SITE: PlacedSite = {
  x: newtownRankKerb.x, z: newtownRankKerb.z,
  heading: Math.atan2(newtownRankKerb.roadX - newtownRankKerb.x, newtownRankKerb.roadZ - newtownRankKerb.z),
};
/** Candice from Boksburg holds court at the mouth of her rank, between the shade port and the kerb. */
export const CANDICE_START: MapPt = {
  x: NEWTOWN_RANK_SITE.x + Math.sin(NEWTOWN_RANK_SITE.heading) * 6.5,
  z: NEWTOWN_RANK_SITE.z + Math.cos(NEWTOWN_RANK_SITE.heading) * 6.5,
};
/** The rival Wemmer crew's LONG-DISTANCE TERMINAL: a second rank structure further out the
 *  industrial belt. Round 4 moved it ~340u east — it used to sit 76u from the Kelvin Yard gate,
 *  which parked the rival terminal on the cartel's own doorstep and stacked seven story locations
 *  onto ~90u of one road. The thugs the mission promises now defend an actual rank. */
const terminalKerb = bestKerbSpot({ name: 'Wemmer Jubilee Road', near: { x: CBD_CENTER.x + 227 * P, z: CBD_CENTER.z + 151 * P }, clearance: 9, ownRadius: 13, minEdge: 5 });
export const WEMMER_RANK_SITE: PlacedSite = {
  x: terminalKerb.x, z: terminalKerb.z,
  heading: Math.atan2(terminalKerb.roadX - terminalKerb.x, terminalKerb.roadZ - terminalKerb.z),
};
/** The terminal reach point: the rank mouth, kerbside of the structure. */
export const TERMINAL_SPOT: MapPt = {
  x: WEMMER_RANK_SITE.x + Math.sin(WEMMER_RANK_SITE.heading) * 6.5,
  z: WEMMER_RANK_SITE.z + Math.cos(WEMMER_RANK_SITE.heading) * 6.5,
};
/** The stolen route permit: stashed behind the terminal canopy, away from the road. */
export const PERMIT_SPOT: MapPt = {
  x: WEMMER_RANK_SITE.x - Math.sin(WEMMER_RANK_SITE.heading) * 9.5,
  z: WEMMER_RANK_SITE.z - Math.cos(WEMMER_RANK_SITE.heading) * 9.5,
};
/** Candice's braai kiosk on the rank's south approach. */
export const KIOSK_SPOT = walkSpotNear({ x: NEWTOWN_RANK_SITE.x - 2, z: NEWTOWN_RANK_SITE.z + 26 }, 3.4, 5);

/** Rank enforcer spawn spots around the terminal. */
export const HOSTILE_SPOTS: MapPt[] = [
  { x: TERMINAL_SPOT.x + 7, z: TERMINAL_SPOT.z + 5 },
  { x: PERMIT_SPOT.x - 5, z: PERMIT_SPOT.z + 4 },
  { x: PERMIT_SPOT.x + 6, z: PERMIT_SPOT.z - 4 },
];

/** Thandi (The Arms Deal): at the Jozi Arms pad. */
export const THANDI_START: MapPt = { x: ARMS_SITE.pad.x + 2.5, z: ARMS_SITE.pad.z + 2 };

// ---- Story arc (Act 1): stations, riddle streets, the cartel yard ------------------

/** Station lookup, optionally pinned to a LINE: several stations exist twice under one name on
 *  different lines (Crown East/West, Park Main/North), and "first match wins" made mission anchors
 *  depend on the map pipeline's emission order. A line pin makes the choice explicit. */
const stationPoint = (name: string, line?: string): MapPt => {
  const station = STATIONS.find((entry) => entry.name === name && (line === undefined || entry.line === line));
  return station ? { x: station.x, z: station.z } : { x: CBD_CENTER.x, z: CBD_CENTER.z };
};

/** Oupa Jakes holds court outside Park Station, where he announced trains for thirty years. */
export const PARK_STATION_SPOT = walkSpotNear(stationPoint('Johannesburg Park Station', 'Metrorail Main Line'), 3, 5);
/** The nephew left the rent bag on the platform at Park Station — a short train hop from Portia
 *  (standard tier; the TRAIN is the mission's verb, restored after the re-anchor gutted it). */
export const RENT_BAG_PLATFORM: MapPt = stationPoint('Johannesburg Park Station', 'Metrorail Main Line');
/** Where Last Coach Home actually boards: Doornfontein, one Main Line stop OUT from Park. The old
 *  single objective pointed the marker at Park itself, where the on-train verb gate then refused
 *  the player who had walked there (round 4: the marker must lead to the boarding point). */
export const BOARDING_STATION_NAME = 'Doornfontein Station';
export const BOARDING_STATION: MapPt = stationPoint(BOARDING_STATION_NAME, 'Metrorail Main Line');
export const RENT_BAG_SPOT = walkSpotNear({ x: RENT_BAG_PLATFORM.x + 7, z: RENT_BAG_PLATFORM.z + 9 }, 3, 5);

/** Riddle chain targets — real named streets with in-world street signs (no map markers). */
export const RIDDLE_SPOTS: MapPt[] = [
  walkSpot('Pothole Street', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z - 78 * P }, 3, 5),
  walkSpot('Loadshed Lane', { x: CBD_CENTER.x - 25 * P, z: CBD_CENTER.z - 90 * P }, 3, 5),
  walkSpot('Fax Street', { x: CBD_CENTER.x + 60 * P, z: CBD_CENTER.z - 35 * P }, 3, 5),
];

/** Kelvin Yard: the cartel's fenced depot in the Crown industrial belt. */
// Kelvin Yard + Solly on the CBD's south-east industrial edge (was Crown, ~3.6km — the whole
// cartel cluster must sit close, act 1 pattern, or every Solly mission is a cross-city haul).
const kelvinKerb = bestKerbSpot({ near: { x: CBD_CENTER.x + 70 * P, z: CBD_CENTER.z + 165 * P }, clearance: 8, ownRadius: 16, minEdge: 6 });
export const KELVIN_GATE_SPOT: MapPt = { x: kelvinKerb.x, z: kelvinKerb.z };

/** The cable buyer's bakkie idles up the block from Bra Vusi (Copper Wire Blues tail). */
export const QUARRY_SPAWN = kerbVehicleSpot('Pothole Street', { x: VUSI_START.x + 8 * P, z: VUSI_START.z });

/** Candice's bottle-green route van, parked on the Newtown Rank kerb where she can see it
 *  (round 4: it drifted to a Commissioner Street kerb 469u from her — a 1.2km fetch before
 *  Rank Cold War even started; her own route van belongs at her own rank). */
export const CANDICE_VAN_SPOT = kerbVehicleSpot('Ntemi Piliso Street', { x: NEWTOWN_RANK_SITE.x, z: NEWTOWN_RANK_SITE.z });
/** The two contested ranks on her route — both CBD-local (were Hillbrow/Newtown district centres). */
export const RANK_STOPS: MapPt[] = [
  walkSpot('Risk-It Street', { x: CBD_CENTER.x + 30 * P, z: CBD_CENTER.z + 55 * P }, 3.4, 5),
  walkSpot('Anderson Street', { x: CBD_CENTER.x - 60 * P, z: CBD_CENTER.z + 10 * P }, 3.4, 5),
];

// ---- Story arc (Acts 2-3): the cartel, the engineer, the sky, the yard ----------------

/** A point a fraction `f` of the way from the CBD toward `to` — for dialing a mission's tier distance. */
const toward = (to: MapPt, f: number): MapPt => ({ x: CBD_CENTER.x + (to.x - CBD_CENTER.x) * f, z: CBD_CENTER.z + (to.z - CBD_CENTER.z) * f });
const landmarkPoint = (name: string, fallback: MapPt): MapPt => {
  const entry = landmark(name);
  return entry ? { x: entry.x, z: entry.z } : fallback;
};

/** Solly holds court at a plastic table by the Kelvin Yard gate. */
export const SOLLY_START = walkSpotNear(KELVIN_GATE_SPOT, 3.4, 5);
/** Kelvin Yard interior: gate kerb extended away from the road (records office at the back).
 *  The ring must NOT reach the road: centre sits 30u in, radius 26, so the gate kerb (and the
 *  casing objective) stay safely outside the fence while the office sits deep behind it. */
const kelvinIn = (() => { const dx = kelvinKerb.x - kelvinKerb.roadX; const dz = kelvinKerb.z - kelvinKerb.roadZ; const len = Math.hypot(dx, dz) || 1; return { x: dx / len, z: dz / len }; })();
export const KELVIN_YARD_CENTER: MapPt = { x: kelvinKerb.x + kelvinIn.x * 30, z: kelvinKerb.z + kelvinIn.z * 30 };
export const KELVIN_OFFICE_SPOT: MapPt = { x: kelvinKerb.x + kelvinIn.x * 42, z: kelvinKerb.z + kelvinIn.z * 42 };
/** Crossing this ring around the yard centre counts as being inside the fence. */
export const KELVIN_FENCE_RADIUS = 26;
/** The one honest way through Kelvin's fence: just outside the rear gap, opposite the road gate. */
export const KELVIN_BREACH_SPOT: MapPt = {
  x: KELVIN_YARD_CENTER.x + kelvinIn.x * (KELVIN_FENCE_RADIUS + 4),
  z: KELVIN_YARD_CENTER.z + kelvinIn.z * (KELVIN_FENCE_RADIUS + 4),
};

/** Copper Wire Blues' payoff: the tail ends at FIRST SIGHT of the buyer's yard — a vantage kerb up
 *  the road from the Kelvin gate, safely outside the fence ring (canon: the player clocks the yard
 *  here in act 1 and only learns whose it is when The Audition takes them through the gate). Round 4:
 *  the old CABLE_YARD_SPOT was a bare CBD corner with no yard, fence or gate in sight, and the
 *  mission ended silently at nothing — the owner's "waypoint goal with no purpose". */
export const CABLE_YARD_SPOT: MapPt = (() => {
  const spot = bestKerbSpot({
    near: { x: kelvinKerb.roadX + kelvinKerb.dirX * 52 - kelvinIn.x * 2, z: kelvinKerb.roadZ + kelvinKerb.dirZ * 52 - kelvinIn.z * 2 },
    clearance: 2.8, ownRadius: 5, minEdge: 0.5,
  });
  return { x: spot.x, z: spot.z };
})();

/** The Ophirton feeder substation Sindi works (Pull the Plug, Catch Them Cutting, The Switch all key
 *  off it) — IN OPHIRTON now. Round 4: the old authored seed pre-dated the crop and dumped the pin on
 *  a Maclaren Street kerb in the CBD-west, 2km from the district its own copy names, beside a spaza
 *  shop and with the breaker marker overhanging the carriageway. The feeder is now a real substation
 *  set piece (world/MissionRanks.ts) on Booysens Road inside the Ophirton district circle, sited on
 *  the district's city side so the Sindi legs stay inside the substantial band. */
const ophirtonFeederKerb = bestKerbSpot({
  name: 'Booysens Road',
  // Seed picked by directed-road probe IN BOTH DIRECTIONS (not straight-line, and not outbound-only:
  // the one-way graph makes return legs longer — the first pick measured Sindi's drive OUT at 2.3km
  // and never measured the drive BACK, which routed 3.0km, over the substantial ceiling). This is the
  // Booysens Road kerb where every feeder leg fits the 1,400–2,800m band with real slack, measured
  // with the grain of the graph and against it: Solly out 2.16km, Sindi out 2.59km, Sindi back 2.65km.
  near: { x: 1579, z: 3128 },
  clearance: 10, ownRadius: 13, minEdge: 3, searchRadius: 300,
});
export const SUBSTATION_SITE: PlacedSite = {
  x: ophirtonFeederKerb.x, z: ophirtonFeederKerb.z,
  heading: Math.atan2(ophirtonFeederKerb.roadX - ophirtonFeederKerb.x, ophirtonFeederKerb.roadZ - ophirtonFeederKerb.z),
};
/** The mission pin: the feeder's road-side apron, kerbside of the palisade. */
export const SUBSTATION_SPOT: MapPt = {
  x: SUBSTATION_SITE.x + Math.sin(SUBSTATION_SITE.heading) * 8.5,
  z: SUBSTATION_SITE.z + Math.cos(SUBSTATION_SITE.heading) * 8.5,
};
/** The main breaker: an external switchgear cabinet on the apron beside the palisade gate — the yard
 *  itself is fenced solid (the set piece's palisade colliders are real), so the throwable breaker
 *  lives on the OUTSIDE where a hand can reach it. */
export const SUBSTATION_BREAKER: MapPt = {
  x: SUBSTATION_SITE.x + Math.sin(SUBSTATION_SITE.heading) * 6 + Math.cos(SUBSTATION_SITE.heading) * 4,
  z: SUBSTATION_SITE.z + Math.cos(SUBSTATION_SITE.heading) * 6 - Math.sin(SUBSTATION_SITE.heading) * 4,
};
/** Sindi's flat on the Braamfontein edge (~0.7km, central to her three jobs: the Park Station drop,
 *  the Ophirton feeder, and the Constitution Hill handover). */
export const SINDI_START = walkSpotNear(toward(braamfontein, 0.4), 3, 5);

/** Generator-subscription collections: three CBD businesses behind on payments. Round 4 re-picked:
 *  the first "collection" used to be 169m up Solly's own street (trivial) and the whole round shaved
 *  its 700m tier floor — the route now opens with a real cross-CBD drive and closes with the holdout
 *  nearest the yard (muscle right under Solly's nose reads as the point, not an accident). */
export const GENNY_ROUND_STOPS: MapPt[] = [
  walkSpot('Albertina Sisulu Road', { x: CBD_CENTER.x - 67 * P, z: CBD_CENTER.z - 98 * P }, 3, 5), // west on the Albertina Sisulu artery: the long first leg (~1.6km routed — inside the standard band, which the old Lilian Ngoyi pick busted at 2.0km)
  walkSpot('Martial Street', { x: CBD_CENTER.x + 40 * P, z: CBD_CENTER.z + 8 * P }, 3, 5),        // mid-CBD (off Anderson — the old pick funnelled to 31u from a Rank Cold War stop)
  walkSpot('Eish-loff Street', { x: CBD_CENTER.x + 48 * P, z: CBD_CENTER.z + 105 * P }, 3, 5),    // the holdout, closest to the yard
];

/** Crown Station: where the misplaced diesel consist must stop (The Wrong Train). */
export const CROWN_STATION = stationPoint('Crown Station', 'Metrorail East Line'); // two Crowns exist — the consist boards at Booysens (East Line), so it must stop at the East Line one
/** Board the stolen consist at Booysens: unlike Park Station, this stop shares Crown's east line.
 *  Sending the player to Park produced an impossible job — that train physically has no route to Crown. */
export const WRONG_TRAIN_START = stationPoint('Booysens Station');

/** Sindi's dead drop: a platform locker at Park Station — the central rail hub, a landmark a
 *  stranger can find from the station board (the old airport-name pun needed map knowledge). */
export const PAPER_DROP: MapPt = walkSpotNear({ x: RENT_BAG_PLATFORM.x - 8, z: RENT_BAG_PLATFORM.z + 12 }, 3, 5);
/** Skywise Sipho runs his booking "office" (a plastic table and a clipboard) on the CBD's industrial
 *  edge near the yard; the Kite itself is out at O.R. Tambourine — the train to Lughawe Halt is the
 *  sane way there, and the mission copy now says so (the flight is the one earned journey). */
export const SIPHO_START: MapPt = walkSpotNear({ x: CBD_CENTER.x + 55 * P, z: CBD_CENTER.z + 145 * P }, 3, 5);
export const AIRPORT_APRON: MapPt = stationPoint('Lughawe Halt'); // where the Kite sits (journey target)

/** Ponte Tower forecourt: Crosswinds' drop after the skydive. */
export const PONTE_POINT = landmarkPoint('Ponte Tower', { x: CBD_CENTER.x, z: CBD_CENTER.z });
export const PONTE_FORECOURT = walkSpotNear(PONTE_POINT, 3, 5);

/** Constitution Hill handover (Carcass) and the dam slipway (Pier Pressure). */
export const CON_HILL_SPOT = walkSpotNear(landmarkPoint('Constitution Hill', { x: hillbrow.x, z: hillbrow.z }), 3, 5);
export const PIER_POINT = landmarkPoint('Vaalpunt Slipway', { x: CBD_CENTER.x, z: CBD_CENTER.z });
/** The slipway kerb itself: Sloepbaai Road dead-ends at the REAL Vaalpunt Slipway landmark on the
 *  dam (round 4: the mission pin used to sit on a Wemmer Jubilee kerb in the CBD — 7,039u / 9.6km
 *  from the place its own copy names; diary page 9 was already waiting at the real one). */
export const PIER_SPOT: MapPt = walkSpot('Sloepbaai Road', PIER_POINT, 3, 5);
/** Ouma se Padstal — the REAL landmark, far out west on the Rooibos Route (round 4: the mission pin
 *  sat on Houghton Drive in the NE suburbs, 7,149u / 9.7km from the landmark its own copy names, and
 *  even the landmark had no stall on it). The farm-stall run is the arc's one sanctioned SCENIC
 *  JOURNEY (optional side piece): ~9km of real driving each way, west past Paarlshoop toward the dam.
 *  The stall itself is a built set piece at the landmark (world/MissionRanks.ts); Grid Diary page 8
 *  was already waiting here. */
export const PADSTAL_POINT = landmarkPoint('Ouma se Padstal', { x: northernSuburbs.x, z: northernSuburbs.z });
export const PADSTAL_SITE = shopSite('Rooibos Route', PADSTAL_POINT, 7.5, 3.2, 7, 2.5);
export const PADSTAL_SPOT: MapPt = PADSTAL_SITE.pad;

/** Sindi's evidence van, parked on a CBD-north side street just below Braamfontein (~0.9km from
 *  Solly). Road-agnostic kerb anchored in the dense grid: a named road detoured to 3.3km, and a
 *  raw Braamfontein-edge point sat in a road-sparse block that snapped 1.4km off-target. */
export const EVIDENCE_VAN_SPOT = kerbVehicleSpot(undefined, { x: CBD_CENTER.x - 10 * P, z: CBD_CENTER.z - 45 * P });
/** The cartel's diesel bakkie on De Villiers Street (The Audition). Round 4: nudged ~170u west along
 *  the street — the drive leg used to measure EXACTLY the substantial floor (1,400m) with zero slack;
 *  the careful haul home is the audition, so it gets real margin over its band's bottom edge. */
export const TANKER_SPOT = kerbVehicleSpot('De Villiers Street', authored({ x: 2757, z: 4403 }));

/** Cartel stash sweep (Carcass): three lock-ups across the belt. */
export const STASH_SPOTS: MapPt[] = [
  walkSpot('Wemmer Jubilee Road', { x: CBD_CENTER.x + 35 * P, z: CBD_CENTER.z + 120 * P }, 3, 5), // the industrial belt
  walkSpot('Fax Street', { x: CBD_CENTER.x + 55 * P, z: CBD_CENTER.z - 30 * P }, 3, 5),           // a north-CBD lock-up (moved off Risk-It — the old spot funnelled to 20u from RANK_STOPS[0])
  walkSpot('Commissioner Street', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z + 55 * P }, 3, 5),  // west-side yard
];

/** Grid Diary pages 3-12 scattered at the city's proudest places (pages 1-2 are mission rewards). */
export const DIARY_SPOTS: Array<{ page: number; x: number; z: number }> = (() => {
  const tower = landmarkPoint('Hillbrow tower', { x: hillbrow.x, z: hillbrow.z });
  const conHill = landmarkPoint('Constitution Hill', { x: hillbrow.x, z: hillbrow.z });
  const parkStation = landmarkPoint('Park Station', { x: CBD_CENTER.x, z: CBD_CENTER.z });
  const airportPt = landmarkPoint('O.R. Tambourine Regional', AIRPORT_APRON);
  // Sandton Station went with Sandton in the crop, and stationPoint() falls back to CBD_CENTER —
  // which would have stacked page 11 on top of the CBD (and inside a building) instead of sending
  // the player to the far end of a rail line. Dunkeld Station is the surviving northern terminus.
  const northStation = stationPoint('Dunkeld Station');
  return [
    { page: 3, x: tower.x + 8, z: tower.z + 5 },
    { page: 4, x: conHill.x - 7, z: conHill.z + 6 },
    { page: 5, x: PONTE_POINT.x - 9, z: PONTE_POINT.z - 4 },
    { page: 6, x: parkStation.x + 12, z: parkStation.z - 8 },
    { page: 7, x: KIOSK_SPOT.x + 5, z: KIOSK_SPOT.z + 4 },
    { page: 8, x: PADSTAL_POINT.x - 5, z: PADSTAL_POINT.z + 7 },
    { page: 9, x: PIER_POINT.x + 4, z: PIER_POINT.z - 6 },
    { page: 10, x: airportPt.x + 15, z: airportPt.z + 10 },
    { page: 11, x: northStation.x - 10, z: northStation.z + 7 },
    { page: 12, x: KELVIN_GATE_SPOT.x - 8, z: KELVIN_GATE_SPOT.z + 10 },
  ];
})();

// ---- Parked vehicles ----------------------------------------------------------------

export interface ParkedVehicleSpot { kind: string; x: number; z: number; heading: number; color?: number;
  /** Multiplier on the spec's health pool — for mission-critical cars that must survive their own
   *  scripted event (the Hot Copper GTI died to its forced pursuit in honest play). */
  healthScale?: number; }

const parkedEntry = (kind: string, site: PlacedSite, color?: number): ParkedVehicleSpot =>
  ({ kind, x: site.x, z: site.z, heading: site.heading, ...(color !== undefined ? { color } : {}) });

/** Auntie Portia's mustard bakkie — mission-critical, and genuinely GONE: dumped on a Salisbury
 *  Street kerb ~340u SOUTH-EAST of her stoep, the opposite direction to her first drop (owner:
 *  the old spot was 12u away — "make it gone somewhere in the opposite direction of the first
 *  goal by at least 300u"). placements.test.ts pins both the distance and the direction. */
export const PORTIA_CAR_SPOT = kerbVehicleSpot('Salisbury Street', { x: CBD_CENTER.x + 162 * P, z: CBD_CENTER.z + 143 * P });
/** The hot red GTI — mission-critical, Commissioner Street kerb. */
export const GTI_SPOT = kerbVehicleSpot('Commissioner Street', { x: CBD_CENTER.x + 55 * P, z: CBD_CENTER.z - 55 * P });

export const PARKED_VEHICLES: ParkedVehicleSpot[] = [
  parkedEntry('van', PORTIA_CAR_SPOT, 0xd9a53b), // Portia's mustard bakkie (Couch Run) — colour must stay unique among vans (PORTIA_BAKKIE_COLOR in story/scripts.ts)
  parkedEntry('van', CANDICE_VAN_SPOT, 0x2e8b57), // Candice's route van (Rank Cold War)
  parkedEntry('van', TANKER_SPOT, 0xb8621b), // the diesel bakkie (The Audition)
  parkedEntry('van', EVIDENCE_VAN_SPOT, 0xdfe3e6), // Sindi's evidence van (Paper Fire)
  // The Hot Copper GTI: the boot full of municipal cable is honest ballast — the weakest spec in the
  // fleet has to live through the mission's own forced 2-star pursuit (it burned in 1 of 2 honest runs).
  { ...parkedEntry('sport', GTI_SPOT, 0xd83a40), healthScale: 1.7 },
  parkedEntry('van', kerbVehicleSpot('Albertina Sisulu Road', { x: CBD_CENTER.x - 150 * P, z: CBD_CENTER.z - 45 * P })),
  parkedEntry('compact', kerbVehicleSpot('Hairyson Street', { x: CBD_CENTER.x - 35 * P, z: CBD_CENTER.z - 60 * P })),
  parkedEntry('sport', kerbVehicleSpot('Eish-loff Street', { x: CBD_CENTER.x + 48 * P, z: CBD_CENTER.z + 110 * P }), 0x3f6faa),
  parkedEntry('van', kerbVehicleSpot('Wemmer Jubilee Road', { x: CBD_CENTER.x + 80 * P, z: CBD_CENTER.z + 140 * P })),
  parkedEntry('compact', kerbVehicleSpot('Loadshed Lane', { x: CBD_CENTER.x - 25 * P, z: CBD_CENTER.z - 90 * P })),
  parkedEntry('taxi', kerbVehicleSpot('Risk-It Street', { x: CBD_CENTER.x + 5 * P, z: CBD_CENTER.z - 55 * P })),
  parkedEntry('taxi', kerbVehicleSpot('Fax Street', { x: CBD_CENTER.x + 60 * P, z: CBD_CENTER.z - 35 * P })),
  // Rank dressing: Quantums on the kerb at both story ranks — a rank without taxis is a bus stop.
  parkedEntry('taxi', kerbVehicleSpot('Ntemi Piliso Street', { x: NEWTOWN_RANK_SITE.x, z: NEWTOWN_RANK_SITE.z - 20 })),
  parkedEntry('taxi', kerbVehicleSpot('Ntemi Piliso Street', { x: NEWTOWN_RANK_SITE.x, z: NEWTOWN_RANK_SITE.z + 20 })),
  parkedEntry('taxi', kerbVehicleSpot('Wemmer Jubilee Road', { x: WEMMER_RANK_SITE.x - 20, z: WEMMER_RANK_SITE.z })),
  parkedEntry('bicycle', kerbVehicleSpot('Main Main Street', { x: CBD_CENTER.x + 25 * P, z: CBD_CENTER.z - 20 * P }, 2.4)),
  parkedEntry('bicycle', kerbVehicleSpot('Pothole Street', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z - 78 * P }, 2.4), 0xc44f9a),
  parkedEntry('motorbike', kerbVehicleSpot('You-Bet Street', { x: CBD_CENTER.x + 32 * P, z: CBD_CENTER.z + 55 * P }, 2)),
  parkedEntry('motorbike', kerbVehicleSpot('Anderson Street', { x: CBD_CENTER.x - 45 * P, z: CBD_CENTER.z + 25 * P }, 2)),
  parkedEntry('courier', kerbVehicleSpot('Commissioner Street', { x: COURIER_DEPOT.x, z: COURIER_DEPOT.z }, 2), 0x84f01c),
  (() => { const near = toward(hillbrow, 0.62); const spot = bestKerbSpot({ near, clearance: 2, ownRadius: 3.4, minEdge: 0.1, minRoadWidth: 7 }); return { kind: 'superbike', x: spot.x, z: spot.z, heading: Math.atan2(spot.dirX, spot.dirZ) }; })(), // top-of-town showroom superbike on the Hillbrow edge, ~1.5km (Stage Fright — the copy says "top of town", which this is; the true northern suburbs are 5km further out)
];

// ---- e-toll gantries (on the M1) -----------------------------------------------------

export interface GantrySpot { x: number; z: number; angle: number; width: number; }

function gantryAt(nearX: number, nearZ: number): GantrySpot {
  let best: { x: number; z: number; dirX: number; dirZ: number; width: number } | undefined; let bestDistance = Infinity;
  for (const road of GENERATED_ROADS) {
    if (road.name !== 'M1') continue;
    for (let index = 0; index < road.points.length; index++) {
      const point = road.points[index]!;
      const distance = (point.x - nearX) ** 2 + (point.z - nearZ) ** 2;
      if (distance >= bestDistance) continue;
      const previous = road.points[Math.max(0, index - 1)]!; const next = road.points[Math.min(road.points.length - 1, index + 1)]!;
      const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
      bestDistance = distance;
      best = { x: point.x, z: point.z, dirX: dx / length, dirZ: dz / length, width: road.width };
    }
  }
  if (!best) return { x: nearX, z: nearZ, angle: 0, width: 24 };
  // Truss local +x must span the carriageway: rotate it perpendicular to the road direction.
  return { x: best.x, z: best.z, angle: Math.atan2(best.dirX, best.dirZ) + Math.PI / 2, width: best.width };
}

export const ETOLL_SPOTS: GantrySpot[] = [
  gantryAt(CBD_CENTER.x - 280 * P, CBD_CENTER.z + 40 * P),
  gantryAt(braamfontein.x - 80 * P, braamfontein.z - 240 * P),
];

// ---- Taxi ranks / transit stops -------------------------------------------------------

export interface LabelledSpot { x: number; z: number; angle: number; label: string; }

function labelledStop(roadName: string, near: MapPt, label: string, clearance = 3.6, ownRadius = 4.5): LabelledSpot {
  const spot = bestKerbSpot({ name: roadName, near, clearance, ownRadius, minEdge: 0.8 });
  return { x: spot.x, z: spot.z, angle: Math.atan2(spot.dirX, spot.dirZ) + (spot.side > 0 ? Math.PI : 0), label };
}

export const TRANSIT_STOPS: LabelledSpot[] = [
  labelledStop('Lilian Ngoyi Street', { x: CBD_CENTER.x - 60 * P, z: CBD_CENTER.z - 120 * P }, 'BREE RANK'),
  labelledStop('Wanderers Street', { x: CBD_CENTER.x + 40 * P, z: CBD_CENTER.z - 130 * P }, 'NOORD RANK'),
  labelledStop('Albertina Sisulu Road', { x: CBD_CENTER.x - 90 * P, z: CBD_CENTER.z - 42 * P }, 'MTN RANK'),
  labelledStop('Commissioner Street', { x: CBD_CENTER.x + 110 * P, z: CBD_CENTER.z - 50 * P }, 'KAZERNE RANK'),
];

// ---- Roadside signage -------------------------------------------------------------------

export const ROADSIDE_SIGNS: LabelledSpot[] = [
  labelledStop('Fax Street', { x: CBD_CENTER.x - 15 * P, z: CBD_CENTER.z - 36 * P }, 'STOP', 1.6, 1.2),
  labelledStop('Martial Street', { x: CBD_CENTER.x + 45 * P, z: CBD_CENTER.z + 5 * P }, '60', 1.6, 1.2),
  labelledStop('Albertina Sisulu Road', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z - 45 * P }, 'HIJACKING HOTSPOT', 1.8, 1.4),
  labelledStop('Commissioner Street', { x: CBD_CENTER.x - 65 * P, z: CBD_CENTER.z - 52 * P }, 'SMASH & GRAB HOTSPOT', 1.8, 1.4),
  labelledStop('Loadshed Lane', { x: CBD_CENTER.x - 22 * P, z: CBD_CENTER.z - 62 * P }, 'P', 1.6, 1.2),
  labelledStop('Risk-It Street', { x: CBD_CENTER.x + 2 * P, z: CBD_CENTER.z + 60 * P }, 'TAXI', 1.6, 1.2),
  labelledStop('Jan Smuts Avenue', { x: zooLakeCenter.x, z: zooLakeCenter.z - 60 * P }, '60', 1.6, 1.2),
  labelledStop('Eish-loff Street', { x: CBD_CENTER.x + 46 * P, z: CBD_CENTER.z - 90 * P }, 'STOP', 1.6, 1.2),
];

// ---- Civic landmarks ----------------------------------------------------------------------

export const PONTE_SPOT: MapPt = (() => {
  const ponte = landmark('Ponte Tower');
  return ponte ? { x: ponte.x, z: ponte.z } : { x: hillbrow.x + 40 * P, z: hillbrow.z + 20 * P };
})();
export const HILLBROW_TOWER_SPOT: MapPt = (() => {
  const tower = landmark('Hillbrow tower');
  return tower ? { x: tower.x, z: tower.z } : { x: hillbrow.x, z: hillbrow.z };
})();
/** JOBURG WATER tower: on the first mine-dump/brownfield polygon (south mining belt flavour). */
export const WATER_TOWER_SPOT: MapPt = (() => {
  const dump = DIRT_POLYGONS[0];
  const anchor = dump ? { x: dump.cx, z: dump.cz } : { x: CBD_CENTER.x - 120 * P, z: CBD_CENTER.z + 260 * P };
  return walkSpotNear(anchor, 9, 8);
})();

// ---- Street-sign-only junctions near spawn (parody names must be readable on foot) ---------

const signalKeys = new Set(SIGNAL_JUNCTIONS.map((junction) => `${junction.x}|${junction.z}`));
export const SPAWN_SIGN_JUNCTIONS: SignalJunctionDef[] = computeSignalJunctions({ budget: 200, minSpacing: 30 * P, minWidestWidth: 7, minSecondWidth: 7 })
  .filter((junction) => !signalKeys.has(`${junction.x}|${junction.z}`))
  .filter((junction) => Math.hypot(junction.x - spawnPoint.x, junction.z - spawnPoint.z) < 150 * P)
  .slice(0, 8);

// ---- Reserved pads (procedural buildings & street props must keep clear) --------------------

export const RESERVED_PADS: ReservedPad[] = [
  { x: spawnPoint.x, z: spawnPoint.z, radius: 8 },
  { x: ARMS_SITE.building.x, z: ARMS_SITE.building.z, radius: 12 },
  { x: ARMS_SITE.pad.x, z: ARMS_SITE.pad.z, radius: 5 },
  { x: SPRAY_SITE.building.x, z: SPRAY_SITE.building.z, radius: 13 },
  { x: SPRAY_SITE.pad.x, z: SPRAY_SITE.pad.z, radius: 6 },
  { x: GARAGE_SITE.building.x, z: GARAGE_SITE.building.z, radius: 11 },
  { x: GARAGE_SITE.pad.x, z: GARAGE_SITE.pad.z, radius: 6 },
  { x: HOTDOG_SITE.building.x, z: HOTDOG_SITE.building.z, radius: 6 },
  ...BOTTLE_STORES.flatMap((store) => [
    { x: store.site.building.x, z: store.site.building.z, radius: 12 },
    { x: store.site.pad.x, z: store.site.pad.z, radius: 5 },
  ]),
  { x: SAFEHOUSE_SITE.building.x, z: SAFEHOUSE_SITE.building.z, radius: 12 },
  { x: SAFEHOUSE_SITE.pad.x, z: SAFEHOUSE_SITE.pad.z, radius: 5 },
  { x: COURIER_DEPOT.x, z: COURIER_DEPOT.z, radius: 7 },
  { x: PORTIA_START.x, z: PORTIA_START.z, radius: 7 },
  { x: VUSI_START.x, z: VUSI_START.z, radius: 7 },
  // The two rank set pieces (MissionRanks.ts): generous claims keep procedural buildings and
  // scatter off the shade ports, their kerbs and the walk-up approaches.
  { x: NEWTOWN_RANK_SITE.x, z: NEWTOWN_RANK_SITE.z, radius: 17 },
  { x: WEMMER_RANK_SITE.x, z: WEMMER_RANK_SITE.z, radius: 17 },
  { x: PERMIT_SPOT.x, z: PERMIT_SPOT.z, radius: 8 },
  { x: KIOSK_SPOT.x, z: KIOSK_SPOT.z, radius: 7 },
  // Vaalpunt Slipway dressing (ramp, moored boat, board) at the real landmark.
  { x: PIER_POINT.x, z: PIER_POINT.z, radius: 15 },
  // Ophirton feeder substation set piece on Booysens Road (MissionRanks.ts).
  { x: SUBSTATION_SITE.x, z: SUBSTATION_SITE.z, radius: 15 },
  // Ouma se Padstal set piece at the western landmark (MissionRanks.ts).
  { x: PADSTAL_SITE.building.x, z: PADSTAL_SITE.building.z, radius: 12 },
  { x: PADSTAL_SITE.pad.x, z: PADSTAL_SITE.pad.z, radius: 5 },
  { x: LOCKUP_SPOT.x, z: LOCKUP_SPOT.z, radius: 9 },
  // Kelvin Yard is a complete authored stealth arena, not just a marker. The generous claim keeps
  // the fence, its rear footpath, and the approach clear even though CityGen uses a deliberately
  // loose circumscribed-radius check for large procedural buildings.
  { x: KELVIN_YARD_CENTER.x, z: KELVIN_YARD_CENTER.z, radius: 50 },
  ...DELIVERY_STOPS.map((stop) => ({ x: stop.x, z: stop.z, radius: 6 })),
  ...PARKED_VEHICLES.map((spot) => ({ x: spot.x, z: spot.z, radius: 4.5 })),
  ...TRANSIT_STOPS.map((stop) => ({ x: stop.x, z: stop.z, radius: 5 })),
  { x: PONTE_SPOT.x, z: PONTE_SPOT.z, radius: 30 },
  { x: HILLBROW_TOWER_SPOT.x, z: HILLBROW_TOWER_SPOT.z, radius: 14 },
  { x: WATER_TOWER_SPOT.x, z: WATER_TOWER_SPOT.z, radius: 10 },
  ...BEACHFRONT_PADS, // Deneys Quay pier + dam-front venue strips + beach clutter (beachfront.ts)
];
