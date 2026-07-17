import type { MapPt } from '../world/mapData';
import type { PlacedSite } from '../world/placements';
import {
  CANDICE_VAN_SPOT, DELIVERY_STOPS, EVIDENCE_VAN_SPOT, GENNY_ROUND_STOPS, GTI_SPOT, HOSTILE_SPOTS,
  KELVIN_GATE_SPOT, PIER_SPOT, PORTIA_CAR_SPOT, QUARRY_SPAWN, RANK_STOPS, STASH_SPOTS, SUBSTATION_SPOT, TANKER_SPOT,
} from '../world/placements';

export const CANDICE_VAN_COLOR = 0x2e8b57; // bottle-green, matches her utility streetwear
export const QUARRY_COLOR = 0x6b4b2a; // the cable buyer's rust-brown bakkie
export const TANKER_COLOR = 0xb8621b; // the diesel tanker's rusted orange
export const EVIDENCE_VAN_COLOR = 0xdfe3e6; // Sindi's boxy white evidence van

/** Hostile crew spawned when the mission enters an objective (or registers a specific checkpoint stop). */
export interface MissionWave { objective: number; checkpoint?: number; spots: MapPt[] }
/** A scripted vehicle: parked at `spawn` from `spawnObjective`; optionally drives off at `departObjective`
 *  toward `destination`; optionally set alight when `igniteObjective` begins (Paper Fire). */
export interface MissionQuarry { spawnObjective: number; departObjective?: number; kind: string; color: number; spawn: PlacedSite; destination?: MapPt; arriveRadius?: number; igniteObjective?: number }
/** Showroom-style alarm: evaluated once when the objective begins — screams if the grid is up, dead if not. */
export interface MissionAlarm { objective: number; level: number; title: string; detail: string; silentTitle: string; silentDetail: string }

/**
 * Declarative per-mission runtime: everything Game.ts needs beyond the pure objective
 * list — checkpoint stop routes, the mission-critical vehicle to reset on restart,
 * hostile waves, tail quarries, grid/wanted/radio beats, diary payouts. Data only.
 */
export interface MissionScript {
  stops?: MapPt[];
  vehicle?: { color: number; spot: PlacedSite };
  waves?: MissionWave[];
  quarry?: MissionQuarry;
  /** Entering this objective trips the grid (forces a load-shedding start if the power is up). */
  forceBlackout?: number;
  /** Entering this objective brings JMPD heat. */
  wanted?: { objective: number; level: number };
  /** Entering this objective tops the player up to one parachute (Sipho keeps spares under the seat). */
  grantParachute?: number;
  alarm?: MissionAlarm;
  /** Radio-tone story beats when an objective begins. */
  radio?: Array<{ objective: number; title: string; detail: string }>;
  /** Run the Kelvin Yard security model every frame while this mission is active. */
  depot?: boolean;
  /** Grid Diary page granted when the mission completes. */
  diaryPage?: number;
}

const around = (point: MapPt, offsets: Array<[number, number]>): MapPt[] => offsets.map(([dx, dz]) => ({ x: point.x + dx, z: point.z + dz }));

export const MISSION_SCRIPTS: Readonly<Record<string, MissionScript>> = {
  // ---- On-ramp + Act 1 --------------------------------------------------------------
  'delivery-run': { stops: DELIVERY_STOPS, vehicle: { color: 0xf1c232, spot: PORTIA_CAR_SPOT } },
  'hot-property': { vehicle: { color: 0xd83a40, spot: GTI_SPOT } },
  'dockside-signal': { waves: [{ objective: 1, spots: HOSTILE_SPOTS }] },
  'copper-wire-blues': { quarry: { spawnObjective: 0, departObjective: 1, kind: 'van', color: QUARRY_COLOR, spawn: QUARRY_SPAWN, destination: KELVIN_GATE_SPOT, arriveRadius: 26 } },
  'rank-cold-war': {
    stops: RANK_STOPS,
    vehicle: { color: CANDICE_VAN_COLOR, spot: CANDICE_VAN_SPOT },
    waves: [
      { objective: 1, checkpoint: 0, spots: around(RANK_STOPS[0]!, [[7, 4], [-6, 6]]) },
      { objective: 1, checkpoint: 1, spots: around(RANK_STOPS[1]!, [[6, -5], [-7, 4], [4, 8]]) },
    ],
  },
  'reading-signs': { diaryPage: 1 },

  // ---- Act 2: "The Payroll" ---------------------------------------------------------
  'the-audition': {
    vehicle: { color: TANKER_COLOR, spot: TANKER_SPOT },
    radio: [{ objective: 1, title: 'Solly', detail: 'Gently, my laaitie. That tanker is worth more than you are. For now.' }],
  },
  'pull-the-plug': {
    forceBlackout: 2, // the breaker goes over: the grid dies around you
    wanted: { objective: 2, level: 2 },
    radio: [{ objective: 2, title: 'The city goes dark', detail: 'Every light you can see just died. Somewhere, a control room phone is ringing.' }],
  },
  'stage-fright': {
    alarm: {
      objective: 1, level: 3,
      title: 'Showroom alarm', detail: 'The forecourt floodlights snap to you. All of Sandton hears it.',
      silentTitle: 'Dead quiet', silentDetail: 'The alarm pad is dark. Nothing squeals. Nothing sees.',
    },
  },
  'genny-round': {
    stops: GENNY_ROUND_STOPS,
    waves: [{ objective: 0, checkpoint: 2, spots: around(GENNY_ROUND_STOPS[2]!, [[6, 4], [-5, 6]]) }],
  },
  'paper-round': { diaryPage: 2 },
  'the-wrong-train': {
    radio: [{ objective: 1, title: 'Solly', detail: 'Crown Station siding. Stop it like you own it, because tonight you do.' }],
  },
  'crosswinds': { grantParachute: 0 },
  'two-fires': {},
  'paper-fire': {
    quarry: { spawnObjective: 0, kind: 'van', color: EVIDENCE_VAN_COLOR, spawn: EVIDENCE_VAN_SPOT, igniteObjective: 2 },
    wanted: { objective: 2, level: 2 },
  },
  'catch-them-cutting': {
    waves: [{ objective: 1, spots: around(SUBSTATION_SPOT, [[7, 5], [-6, 4], [5, -6]]) }],
  },

  // ---- Act 3: "Stage Six" -----------------------------------------------------------
  'dark-house': { depot: true },
  'long-live-the-king': {
    waves: [
      { objective: 1, spots: around(KELVIN_GATE_SPOT, [[8, 6], [-7, 8], [6, -7]]) },
      { objective: 2, spots: around(KELVIN_GATE_SPOT, [[10, 4], [-8, -6], [5, 9], [-4, 10]]) },
    ],
  },
  'carcass': {
    stops: STASH_SPOTS,
    wanted: { objective: 0, level: 2 },
  },
  'the-switch': {
    waves: [
      { objective: 1, spots: around(SUBSTATION_SPOT, [[8, 5], [-7, 6], [6, -6], [-5, -7]]) },
      { objective: 2, spots: around(SUBSTATION_SPOT, [[9, 3], [-8, 5], [4, 9]]) },
    ],
  },

  // ---- Side pieces --------------------------------------------------------------------
  'padstal-run': {},
  'pier-pressure': { waves: [{ objective: 1, spots: around(PIER_SPOT, [[5, 3]]) }] },
};
