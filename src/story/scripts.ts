import type { MapPt } from '../world/mapData';
import type { PlacedSite } from '../world/placements';
import { CANDICE_VAN_SPOT, DELIVERY_STOPS, GTI_SPOT, HOSTILE_SPOTS, KELVIN_GATE_SPOT, PORTIA_CAR_SPOT, QUARRY_SPAWN, RANK_STOPS } from '../world/placements';

export const CANDICE_VAN_COLOR = 0x2e8b57; // bottle-green, matches her utility streetwear
export const QUARRY_COLOR = 0x6b4b2a; // the cable buyer's rust-brown bakkie

/** Hostile crew spawned when the mission enters an objective (or registers a specific checkpoint stop). */
export interface MissionWave { objective: number; checkpoint?: number; spots: MapPt[] }
/** A scripted vehicle the player tails: parked at `spawn` from `spawnObjective`, drives for `departObjective`. */
export interface MissionQuarry { spawnObjective: number; departObjective: number; kind: string; color: number; spawn: PlacedSite; destination: MapPt; arriveRadius: number }

/**
 * Declarative per-mission runtime: everything Game.ts needs beyond the pure objective
 * list — checkpoint stop routes, the mission-critical vehicle to reset on restart,
 * hostile waves, tail quarries, diary-page payouts. Data only; the wiring is generic.
 */
export interface MissionScript {
  stops?: MapPt[];
  vehicle?: { color: number; spot: PlacedSite };
  waves?: MissionWave[];
  quarry?: MissionQuarry;
  /** Grid Diary page granted when the mission completes. */
  diaryPage?: number;
}

const around = (point: MapPt, offsets: Array<[number, number]>): MapPt[] => offsets.map(([dx, dz]) => ({ x: point.x + dx, z: point.z + dz }));

export const MISSION_SCRIPTS: Readonly<Record<string, MissionScript>> = {
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
};
