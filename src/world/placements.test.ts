import { describe, expect, it } from 'vitest';
import { CBD_CENTER, districtAt, distanceToRoadEdge, MAP_WORLD_SIZE, ROAD_EDGE_CAP } from './mapData';
import {
  ARMS_SITE,
  CANDICE_START,
  DELIVERY_STOPS,
  ESCAPE_SPOT,
  ETOLL_SPOTS,
  GARAGE_PARK,
  GARAGE_SITE,
  GTI_SPOT,
  HOSTILE_SPOTS,
  HOTDOG_SITE,
  KIOSK_SPOT,
  LOCKUP_SPOT,
  PARKED_VEHICLES,
  PERMIT_SPOT,
  PLAYER_SPAWN,
  PORTIA_CAR_SPOT,
  PORTIA_START,
  RESERVED_PADS,
  ROADSIDE_SIGNS,
  SPAWN_SIGN_JUNCTIONS,
  SAFEHOUSE_SITE,
  SPRAY_SITE,
  TERMINAL_SPOT,
  THANDI_START,
  TRANSIT_STOPS,
  VUSI_START,
} from './placements';

const HALF = MAP_WORLD_SIZE / 2;
// Distance thresholds authored on the 6000u map scale with the footprint (roads/blocks are ~6x further
// apart at 36000u). Real kerb clearances (edge, pad-fronts-building) are NOT scaled.
const SCALE = MAP_WORLD_SIZE / 6000;
const inBounds = ({ x, z }: { x: number; z: number }): boolean => Math.abs(x) < HALF && Math.abs(z) < HALF;

describe('data-driven anchors', () => {
  const walkUpSpots: Array<[string, { x: number; z: number }]> = [
    ['spawn', { x: PLAYER_SPAWN[0], z: PLAYER_SPAWN[2] }],
    ['arms pad', ARMS_SITE.pad],
    ['hotdog pad', HOTDOG_SITE.pad],
    ['safehouse pad', SAFEHOUSE_SITE.pad],
    ['portia', PORTIA_START],
    ['vusi', VUSI_START],
    ['candice', CANDICE_START],
    ['thandi', THANDI_START],
    ['escape', ESCAPE_SPOT],
    ['kiosk', KIOSK_SPOT],
    ['lockup', LOCKUP_SPOT],
    ...DELIVERY_STOPS.map((stop, index) => [`delivery ${index}`, stop] as [string, { x: number; z: number }]),
  ];

  it('places every walk-up anchor beside a road, not on the tar and not in the veld', () => {
    for (const [name, spot] of walkUpSpots) {
      expect(inBounds(spot), `${name} in bounds`).toBe(true);
      const edge = distanceToRoadEdge(spot.x, spot.z);
      expect(edge, `${name} off the tar`).toBeGreaterThan(-0.6);
      expect(edge, `${name} near a road`).toBeLessThan(ROAD_EDGE_CAP);
    }
  });

  it('spawns the player on a CBD sidewalk', () => {
    expect(districtAt(PLAYER_SPAWN[0], PLAYER_SPAWN[2])).toBe('Joburg CBD');
    expect(Math.hypot(PLAYER_SPAWN[0] - CBD_CENTER.x, PLAYER_SPAWN[2] - CBD_CENTER.z)).toBeLessThan(160 * SCALE);
  });

  it('keeps the shops walking distance from the spawn', () => {
    for (const [name, site] of [['arms', ARMS_SITE], ['spray', SPRAY_SITE], ['garage', GARAGE_SITE], ['hotdog', HOTDOG_SITE], ['safehouse', SAFEHOUSE_SITE]] as const) {
      const distance = Math.hypot(site.pad.x - PLAYER_SPAWN[0], site.pad.z - PLAYER_SPAWN[2]);
      expect(distance, `${name} close to spawn`).toBeLessThan(320 * SCALE);
      expect(Math.hypot(site.pad.x - site.building.x, site.pad.z - site.building.z), `${name} pad fronts its building`).toBeLessThan(16);
    }
  });

  it('parks every kerbside vehicle just off a road', () => {
    expect(PARKED_VEHICLES.some((spot) => spot.kind === 'cab')).toBe(false);
    expect(PARKED_VEHICLES.filter((spot) => spot.kind === 'taxi')).toHaveLength(2);
    for (const spot of PARKED_VEHICLES) {
      expect(inBounds(spot), `${spot.kind} in bounds`).toBe(true);
      const edge = distanceToRoadEdge(spot.x, spot.z);
      expect(edge, `${spot.kind} hugs a kerb`).toBeLessThan(6);
      expect(edge, `${spot.kind} not mid-lane`).toBeGreaterThan(-1.5);
    }
    expect(Math.hypot(PORTIA_CAR_SPOT.x - PORTIA_START.x, PORTIA_CAR_SPOT.z - PORTIA_START.z)).toBeLessThan(60 * SCALE); // mission car near its contact
    expect(distanceToRoadEdge(GTI_SPOT.x, GTI_SPOT.z)).toBeLessThan(6);
  });

  it('spans the M1 with both gantries and marks the terminal off-road', () => {
    expect(ETOLL_SPOTS).toHaveLength(2);
    for (const gantry of ETOLL_SPOTS) expect(distanceToRoadEdge(gantry.x, gantry.z)).toBeLessThan(0); // pylons stand ON the motorway centreline spot
    expect(distanceToRoadEdge(TERMINAL_SPOT.x, TERMINAL_SPOT.z)).toBeGreaterThan(0);
    expect(distanceToRoadEdge(PERMIT_SPOT.x, PERMIT_SPOT.z)).toBeGreaterThan(0);
    for (const spot of HOSTILE_SPOTS) expect(inBounds(spot)).toBe(true);
  });

  it('keeps street furniture anchors beside roads', () => {
    for (const stop of [...TRANSIT_STOPS, ...ROADSIDE_SIGNS]) {
      expect(inBounds(stop), stop.label).toBe(true);
      expect(distanceToRoadEdge(stop.x, stop.z), stop.label).toBeGreaterThan(0);
      expect(distanceToRoadEdge(stop.x, stop.z), stop.label).toBeLessThan(ROAD_EDGE_CAP);
    }
  });

  it('shows parody street names on signs near the spawn', () => {
    const parody = /RISK-IT|MARTIAL|FAX|MAIN MAIN|LOADSHED|EISH-LOFF|YOU-BET|POTHOLE|HAIRYSON/;
    const named = SPAWN_SIGN_JUNCTIONS.filter((junction) => parody.test(junction.roadA) || parody.test(junction.roadB));
    expect(named.length).toBeGreaterThanOrEqual(3);
    for (const junction of SPAWN_SIGN_JUNCTIONS) {
      expect(Math.hypot(junction.x - PLAYER_SPAWN[0], junction.z - PLAYER_SPAWN[2])).toBeLessThan(160 * SCALE);
    }
  });

  it('reserves pads for every anchor and keeps the major structures apart', () => {
    expect(RESERVED_PADS.length).toBeGreaterThan(20);
    // Marker pads intentionally brush their own buildings; the STRUCTURES must never stack.
    const majors: Array<[string, { x: number; z: number }, number]> = [
      ['spawn', { x: PLAYER_SPAWN[0], z: PLAYER_SPAWN[2] }, 8],
      ['arms', ARMS_SITE.building, 12],
      ['spray', SPRAY_SITE.building, 13],
      ['garage', GARAGE_SITE.building, 11],
      ['safehouse', SAFEHOUSE_SITE.building, 12],
      ['terminal', TERMINAL_SPOT, 15],
    ];
    for (let a = 0; a < majors.length; a++) for (let b = a + 1; b < majors.length; b++) {
      const [nameA, padA, radiusA] = majors[a]!; const [nameB, padB, radiusB] = majors[b]!;
      expect(Math.hypot(padA.x - padB.x, padA.z - padB.z), `${nameA} vs ${nameB}`).toBeGreaterThan((radiusA + radiusB) * 0.72);
    }
  });

  it('parks the stored vehicle inside the garage footprint', () => {
    expect(Math.hypot(GARAGE_PARK.x - GARAGE_SITE.building.x, GARAGE_PARK.z - GARAGE_SITE.building.z)).toBeLessThan(2);
  });
});
