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

export interface PlacedSite {
  x: number;
  z: number;
  /** Yaw for buildings is snapped to a quarter turn so AABB colliders remain valid. */
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

const QUARTER = Math.PI / 2;
/** Snap a yaw to the nearest quarter turn so box colliders stay axis-aligned. */
export function snapHeading(yaw: number): number {
  return Math.round(yaw / QUARTER) * QUARTER;
}

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

/** Walks the matching polylines around `near` (samples every ~8u) and returns the clearest kerbside spot. */
function bestKerbSpot(query: SpotQuery): KerbSpot {
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
  if (!best) { // last resort: nearest vertex of the matching road, claims ignored
    for (const road of GENERATED_ROADS) {
      if (query.name !== undefined && road.name !== query.name) continue;
      for (let index = 0; index < road.points.length; index++) {
        const point = road.points[index]!;
        const distance = (point.x - near.x) ** 2 + (point.z - near.z) ** 2;
        if (distance < (best ? (best.x - near.x) ** 2 + (best.z - near.z) ** 2 : Infinity)) {
          const previous = road.points[Math.max(0, index - 1)]!; const next = road.points[Math.min(road.points.length - 1, index + 1)]!;
          const dx = next.x - previous.x; const dz = next.z - previous.z; const length = Math.hypot(dx, dz) || 1;
          const offset = road.width / 2 + query.clearance;
          best = { x: point.x - (dz / length) * offset, z: point.z + (dx / length) * offset, roadX: point.x, roadZ: point.z, dirX: dx / length, dirZ: dz / length, side: 1, road };
        }
      }
    }
  }
  if (!best) throw new Error(`placements: no road matches ${query.name ?? 'any'}`);
  claim(best.x, best.z, ownRadius);
  return best;
}

/** Storefront site: pad near the kerb, building behind it, door facing the road. */
function shopSite(roadName: string, near: MapPt, buildingClearance: number, padClearance: number, buildingRadius: number, minEdge: number): ShopSite {
  const spot = bestKerbSpot({ name: roadName, near, clearance: buildingClearance, ownRadius: buildingRadius, minEdge });
  const toRoadX = spot.roadX - spot.x; const toRoadZ = spot.roadZ - spot.z;
  const toRoadLength = Math.hypot(toRoadX, toRoadZ) || 1;
  const pad = {
    x: spot.roadX - (toRoadX / toRoadLength) * (spot.road.width / 2 + padClearance),
    z: spot.roadZ - (toRoadZ / toRoadLength) * (spot.road.width / 2 + padClearance),
  };
  const heading = snapHeading(Math.atan2(toRoadX, toRoadZ));
  return { pad, building: { x: spot.x, z: spot.z, heading } };
}

/** Kerbside vehicle spot: parked just off the carriageway, nose along the road. */
function kerbVehicleSpot(roadName: string, near: MapPt, clearance = 1.6): PlacedSite {
  const spot = bestKerbSpot({ name: roadName, near, clearance, ownRadius: 3.4, minEdge: 0.1 });
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

// ---- Shops --------------------------------------------------------------------

/** Jozi Arms: Martial Street, near the spawn corner. */
export const ARMS_SITE = shopSite('Martial Street', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z }, 8.2, 3.8, 8, 3);
/** Pik-'n'-Spray: Eish-loff Street, a block south-east (drive-in). */
export const SPRAY_SITE = shopSite('Eish-loff Street', { x: CBD_CENTER.x + 55 * P, z: CBD_CENTER.z + 60 * P }, 9.6, 3.4, 9, 4);
/** Garage: Loadshed Lane, north-west block (drive-in storage). */
export const GARAGE_SITE = shopSite('Loadshed Lane', { x: CBD_CENTER.x - 25 * P, z: CBD_CENTER.z - 45 * P }, 8, 3.4, 7.5, 3.5);
/** Boerie Stand: Fax Street sidewalk. */
export const HOTDOG_SITE = shopSite('Fax Street', { x: CBD_CENTER.x + 25 * P, z: CBD_CENTER.z - 38 * P }, 3, 1.9, 3, 0.8);

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

/** Main Main Mansions: a flat on Main Main Street, a block from spawn. */
export const SAFEHOUSE_SITE = shopSite('Main Main Street', { x: CBD_CENTER.x - 70 * P, z: CBD_CENTER.z - 20 * P }, 9.4, 3.6, 9, 3.5);

// ---- Districts / landmarks used by missions --------------------------------------

const braamfontein = districtCenter('Braamfontein') ?? CBD_CENTER;
const newtown = districtCenter('Newtown') ?? CBD_CENTER;
const hillbrow = districtCenter('Hillbrow') ?? CBD_CENTER;
const sandton = districtCenter('Sandton') ?? CBD_CENTER;
const zooLake = WATER_POLYGONS.find((water) => /zoo/i.test(water.name));
const zooLakeCenter: MapPt = zooLake ? { x: zooLake.cx, z: zooLake.cz } : { x: braamfontein.x, z: braamfontein.z };

// ---- Missions ---------------------------------------------------------------------

/** Auntie Portia (Couch Run): You-Bet Street, around the corner from spawn. */
export const PORTIA_START = walkSpot('You-Bet Street', { x: CBD_CENTER.x + 30 * P, z: CBD_CENTER.z + 25 * P }, 3, 5);
/** The three couch drops: Newtown, Braamfontein, Hillbrow roadside spots. */
export const DELIVERY_STOPS: MapPt[] = [
  walkSpotNear({ x: newtown.x, z: newtown.z }, 3, 5),
  walkSpotNear({ x: braamfontein.x, z: braamfontein.z }, 3, 5),
  walkSpotNear({ x: hillbrow.x, z: hillbrow.z }, 3, 5),
];

/** Bra Vusi (Hot Copper): Pothole Street block. */
export const VUSI_START = walkSpot('Pothole Street', { x: CBD_CENTER.x + 30 * P, z: CBD_CENTER.z - 75 * P }, 3, 5);
/** Braamfontein lock-up: roadside near the district centre. */
export const LOCKUP_SPOT = walkSpotNear({ x: braamfontein.x - 30 * P, z: braamfontein.z + 20 * P }, 4.5, 6);

/** Candice (Rank Business): Jan Smuts Avenue at Zoo Lake. */
export const CANDICE_START = walkSpot('Jan Smuts Avenue', zooLakeCenter, 3, 5);
/** The stolen-permit taxi terminal: Wemmer Jubilee Road, south of the CBD (industrial belt). */
const terminalSpot = bestKerbSpot({ name: 'Wemmer Jubilee Road', near: { x: CBD_CENTER.x + 20 * P, z: CBD_CENTER.z + 120 * P }, clearance: 6, ownRadius: 12, minEdge: 5 });
export const TERMINAL_SPOT: MapPt = { x: terminalSpot.x, z: terminalSpot.z };
export const PERMIT_SPOT: MapPt = {
  x: terminalSpot.x + (terminalSpot.x - terminalSpot.roadX) * 0.7,
  z: terminalSpot.z + (terminalSpot.z - terminalSpot.roadZ) * 0.7,
};
/** Escape marker: back on Albertina Sisulu, north-west of the terminal. */
export const ESCAPE_SPOT = walkSpot('Albertina Sisulu Road', { x: CBD_CENTER.x - 120 * P, z: CBD_CENTER.z - 40 * P }, 3, 5);
/** Braai kiosk on the Zoo Lake shore. */
export const KIOSK_SPOT = walkSpotNear(zooLakeCenter, 3.4, 5);

/** Rank enforcer spawn spots around the terminal. */
export const HOSTILE_SPOTS: MapPt[] = [
  { x: TERMINAL_SPOT.x + 7, z: TERMINAL_SPOT.z + 5 },
  { x: PERMIT_SPOT.x - 5, z: PERMIT_SPOT.z + 4 },
  { x: PERMIT_SPOT.x + 6, z: PERMIT_SPOT.z - 4 },
];

/** Thandi (The Arms Deal): at the Jozi Arms pad. */
export const THANDI_START: MapPt = { x: ARMS_SITE.pad.x + 2.5, z: ARMS_SITE.pad.z + 2 };

// ---- Parked vehicles ----------------------------------------------------------------

export interface ParkedVehicleSpot { kind: string; x: number; z: number; heading: number; color?: number; }

const parkedEntry = (kind: string, site: PlacedSite, color?: number): ParkedVehicleSpot =>
  ({ kind, x: site.x, z: site.z, heading: site.heading, ...(color !== undefined ? { color } : {}) });

/** Auntie Portia's yellow Citi Golf — mission-critical, kerb near her driveway. */
export const PORTIA_CAR_SPOT = kerbVehicleSpot('You-Bet Street', { x: PORTIA_START.x, z: PORTIA_START.z });
/** The hot red GTI — mission-critical, Commissioner Street kerb. */
export const GTI_SPOT = kerbVehicleSpot('Commissioner Street', { x: CBD_CENTER.x + 55 * P, z: CBD_CENTER.z - 55 * P });

export const PARKED_VEHICLES: ParkedVehicleSpot[] = [
  parkedEntry('compact', PORTIA_CAR_SPOT, 0xf1c232),
  parkedEntry('sport', GTI_SPOT, 0xd83a40),
  parkedEntry('van', kerbVehicleSpot('Albertina Sisulu Road', { x: CBD_CENTER.x - 150 * P, z: CBD_CENTER.z - 45 * P })),
  parkedEntry('compact', kerbVehicleSpot('Hairyson Street', { x: CBD_CENTER.x - 35 * P, z: CBD_CENTER.z - 60 * P })),
  parkedEntry('sport', kerbVehicleSpot('Eish-loff Street', { x: CBD_CENTER.x + 48 * P, z: CBD_CENTER.z + 110 * P }), 0x3f6faa),
  parkedEntry('van', kerbVehicleSpot('Wemmer Jubilee Road', { x: CBD_CENTER.x + 80 * P, z: CBD_CENTER.z + 140 * P })),
  parkedEntry('compact', kerbVehicleSpot('Loadshed Lane', { x: CBD_CENTER.x - 25 * P, z: CBD_CENTER.z - 90 * P })),
  parkedEntry('cab', kerbVehicleSpot('Risk-It Street', { x: CBD_CENTER.x + 5 * P, z: CBD_CENTER.z - 55 * P })),
  parkedEntry('cab', kerbVehicleSpot('Fax Street', { x: CBD_CENTER.x + 60 * P, z: CBD_CENTER.z - 35 * P })),
  parkedEntry('bicycle', kerbVehicleSpot('Main Main Street', { x: CBD_CENTER.x + 25 * P, z: CBD_CENTER.z - 20 * P }, 2.4)),
  parkedEntry('bicycle', kerbVehicleSpot('Pothole Street', { x: CBD_CENTER.x - 40 * P, z: CBD_CENTER.z - 78 * P }, 2.4), 0xc44f9a),
  parkedEntry('motorbike', kerbVehicleSpot('You-Bet Street', { x: CBD_CENTER.x + 32 * P, z: CBD_CENTER.z + 55 * P }, 2)),
  parkedEntry('motorbike', kerbVehicleSpot('Anderson Street', { x: CBD_CENTER.x - 45 * P, z: CBD_CENTER.z + 25 * P }, 2)),
  (() => { const spot = bestKerbSpot({ near: { x: sandton.x, z: sandton.z }, clearance: 2, ownRadius: 3.4, minEdge: 0.1, minRoadWidth: 7 }); return { kind: 'superbike', x: spot.x, z: spot.z, heading: Math.atan2(spot.dirX, spot.dirZ) }; })(), // flashy toy on a Sandton kerb
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
  { x: SAFEHOUSE_SITE.building.x, z: SAFEHOUSE_SITE.building.z, radius: 12 },
  { x: SAFEHOUSE_SITE.pad.x, z: SAFEHOUSE_SITE.pad.z, radius: 5 },
  { x: PORTIA_START.x, z: PORTIA_START.z, radius: 7 },
  { x: VUSI_START.x, z: VUSI_START.z, radius: 7 },
  { x: CANDICE_START.x, z: CANDICE_START.z, radius: 7 },
  { x: TERMINAL_SPOT.x, z: TERMINAL_SPOT.z, radius: 15 },
  { x: PERMIT_SPOT.x, z: PERMIT_SPOT.z, radius: 8 },
  { x: KIOSK_SPOT.x, z: KIOSK_SPOT.z, radius: 7 },
  { x: LOCKUP_SPOT.x, z: LOCKUP_SPOT.z, radius: 9 },
  ...DELIVERY_STOPS.map((stop) => ({ x: stop.x, z: stop.z, radius: 6 })),
  ...PARKED_VEHICLES.map((spot) => ({ x: spot.x, z: spot.z, radius: 4.5 })),
  ...TRANSIT_STOPS.map((stop) => ({ x: stop.x, z: stop.z, radius: 5 })),
  { x: PONTE_SPOT.x, z: PONTE_SPOT.z, radius: 30 },
  { x: HILLBROW_TOWER_SPOT.x, z: HILLBROW_TOWER_SPOT.z, radius: 14 },
  { x: WATER_TOWER_SPOT.x, z: WATER_TOWER_SPOT.z, radius: 10 },
];
