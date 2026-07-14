import { describe, expect, it } from 'vitest';
import { ARREST_DEPLOY_RANGE, ARREST_STOP_SPEED, bustSeconds, copHitChance, CULL_RADIUS, departTarget, DESPAWN_CELL, inSameCell, maxInterceptors, nextBustMeter, nextUnitMode, POLICE_UNITS_BY_WANTED, policeCarDeparted, policeCarStealable, policeCell, PURSUIT_RANGE, separationPush, shouldRemovePoliceCar, SHOOT_MIN_WANTED, sightLineClear, STANDOFF_RANGE, standoffSlotOffset, standoffThrottle, toggleSiren, type UnitSituation } from './PoliceSystem';
import { replanInterval } from './NavGraph';
import { pickRoamGoal, ROAM_RADIUS } from './PoliceKnowledge';

const onFoot = (overrides: Partial<UnitSituation> = {}): UnitSituation => ({ sighted: true, playerInVehicle: false, distance: 20, speed: 12, crewOut: false, ...overrides });

describe('police unit scaling', () => {
  it('scales max active interceptors with wanted stars', () => {
    expect(maxInterceptors(0)).toBe(0);
    expect(maxInterceptors(1)).toBe(2);
    expect(maxInterceptors(2)).toBe(2);
    expect(maxInterceptors(3)).toBe(4);
    expect(maxInterceptors(4)).toBe(6);
    expect(maxInterceptors(5)).toBe(8);
  });

  it('clamps out-of-range and fractional levels', () => {
    expect(maxInterceptors(-3)).toBe(0);
    expect(maxInterceptors(9)).toBe(POLICE_UNITS_BY_WANTED[5]);
    expect(maxInterceptors(3.9)).toBe(4);
  });

  it('never shrinks the response as heat rises', () => {
    for (let level = 1; level <= 5; level++) expect(maxInterceptors(level)).toBeGreaterThanOrEqual(maxInterceptors(level - 1));
  });

  it('adds persistent-pressure reinforcements only to an active response', () => {
    expect(maxInterceptors(0, 2)).toBe(0);
    expect(maxInterceptors(2, 1)).toBe(3);
    expect(maxInterceptors(5, 9)).toBe(10);
  });
});

describe('police replan cadence', () => {
  it('replans every 1.5-2 seconds with per-unit stagger', () => {
    const intervals = Array.from({ length: 8 }, (_, serial) => replanInterval(serial));
    for (const interval of intervals) { expect(interval).toBeGreaterThanOrEqual(1.5); expect(interval).toBeLessThan(2); }
    expect(new Set(intervals.map((interval) => interval.toFixed(3))).size).toBe(intervals.length);
  });

  it('keeps direct pursuit reserved for close-range line of sight', () => {
    expect(PURSUIT_RANGE).toBeGreaterThan(15);
    expect(PURSUIT_RANGE).toBeLessThan(40);
  });
});

describe('standoff driving', () => {
  it('never throttles inside the standoff ring, regardless of speed', () => {
    expect(standoffThrottle(STANDOFF_RANGE - 2, 0)).toBe(0);
    expect(standoffThrottle(5, 30)).toBe(0);
    expect(standoffThrottle(STANDOFF_RANGE, 0)).toBe(0);
  });

  it('brakes earlier when arriving fast: the stopping envelope grows with speed', () => {
    expect(standoffThrottle(16, 0)).toBeGreaterThan(0);
    expect(standoffThrottle(16, 20)).toBe(0);
  });

  it('ramps back to full pursuit throttle by PURSUIT_RANGE', () => {
    expect(standoffThrottle(PURSUIT_RANGE, 0)).toBe(1);
    expect(standoffThrottle(90, 0)).toBe(1);
  });

  it('is monotonic in distance at rest', () => {
    let previous = 0;
    for (let distance = 0; distance <= 40; distance += 2) { const throttle = standoffThrottle(distance, 0); expect(throttle).toBeGreaterThanOrEqual(previous); previous = throttle; }
  });
});

describe('arrest state machine', () => {
  it('turns a close on-foot sighting into a standoff, never a ram', () => {
    expect(nextUnitMode('drive', onFoot({ distance: 20, speed: 18 }))).toBe('standoff');
  });

  it('deploys the crew only once stopped inside the arrest ring', () => {
    expect(nextUnitMode('standoff', onFoot({ distance: ARREST_DEPLOY_RANGE - 2, speed: ARREST_STOP_SPEED - 2 }))).toBe('arrest');
  });

  it('never bails out at speed or straight from drive', () => {
    expect(nextUnitMode('standoff', onFoot({ distance: 12, speed: 15 }))).toBe('standoff');
    expect(nextUnitMode('drive', onFoot({ distance: 12, speed: 1 }))).toBe('standoff'); // one tick of standoff before deploying
  });

  it('returns to driving when the player boards a vehicle or the sighting is lost', () => {
    expect(nextUnitMode('standoff', onFoot({ playerInVehicle: true, distance: 12, speed: 1 }))).toBe('drive');
    expect(nextUnitMode('standoff', onFoot({ sighted: false }))).toBe('drive');
    expect(nextUnitMode('standoff', onFoot({ distance: PURSUIT_RANGE + 5 }))).toBe('drive');
  });

  it('stays pinned on scene while the crew is deployed, whatever the player does', () => {
    expect(nextUnitMode('arrest', onFoot({ sighted: false, playerInVehicle: true, distance: 80, speed: 0, crewOut: true }))).toBe('arrest');
    expect(nextUnitMode('drive', onFoot({ crewOut: true, distance: 90 }))).toBe('arrest');
  });

  it('releases back to drive once the crew has reboarded', () => {
    expect(nextUnitMode('arrest', onFoot({ sighted: false, distance: 80, crewOut: false }))).toBe('drive');
  });
});

describe('officer marksmanship', () => {
  it('loses accuracy with distance but always keeps a miss and a hit chance', () => {
    expect(copHitChance(4)).toBeGreaterThan(copHitChance(30));
    expect(copHitChance(0)).toBeLessThanOrEqual(0.8);
    expect(copHitChance(500)).toBeGreaterThanOrEqual(0.15);
  });

  it('holds fire below two stars by policy', () => { expect(SHOOT_MIN_WANTED).toBe(2); });
});

describe('cruiser theft and siren', () => {
  const empty = { police: true, occupied: false, wrecked: false, disabled: false, playerControlled: false };

  it('lets the player take a cruiser only when no cop is in it', () => {
    expect(policeCarStealable(empty)).toBe(true);
    expect(policeCarStealable({ ...empty, occupied: true })).toBe(false);
    expect(policeCarStealable({ ...empty, wrecked: true })).toBe(false);
    expect(policeCarStealable({ ...empty, disabled: true })).toBe(false);
    expect(policeCarStealable({ ...empty, playerControlled: true })).toBe(false);
    expect(policeCarStealable({ ...empty, police: false })).toBe(false);
  });

  it('toggles the siren on police cars only', () => {
    expect(toggleSiren({ police: true, sirenOn: false })).toBe(true);
    expect(toggleSiren({ police: true, sirenOn: true })).toBe(false);
    expect(toggleSiren({ police: false, sirenOn: false })).toBe(false);
  });
});

describe('unit spacing', () => {
  it('fans arrest slots: five consecutive serials take five distinct lanes at 36° spacing', () => {
    const offsets = [0, 1, 2, 3, 4].map(standoffSlotOffset);
    expect(new Set(offsets.map((offset) => offset.toFixed(4))).size).toBe(5);
    const sorted = [...offsets].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index++) expect(sorted[index]! - sorted[index - 1]!).toBeCloseTo(Math.PI / 5, 6);
  });

  it('caps slot offsets at ±72° so nobody is routed through the suspect', () => {
    for (let serial = 0; serial < 20; serial++) expect(Math.abs(standoffSlotOffset(serial))).toBeLessThanOrEqual((Math.PI * 2) / 5 + 1e-9);
  });

  it('reuses a lane only once the fan is exhausted', () => { expect(standoffSlotOffset(7)).toBe(standoffSlotOffset(2)); });

  it('pushes overlapping bodies apart to exactly the minimum distance', () => {
    const push = separationPush(2, 0, 3);
    expect(push).not.toBeNull();
    expect(push!.x).toBeCloseTo(0.5, 6); // each body moves 0.5 along the axis: gap 2 becomes exactly 3
    expect(push!.z).toBe(0);
    const diagonal = separationPush(1, 1, 3)!;
    expect(Math.hypot(1 + diagonal.x * 2, 1 + diagonal.z * 2)).toBeCloseTo(3, 6);
  });

  it('splits a dead-centre stack deterministically and leaves clear bodies alone', () => {
    expect(separationPush(0, 0, 1)).toEqual({ x: 0.5, z: 0 }); // same-point stack still resolves
    expect(separationPush(4, 0, 3)).toBeNull();
    expect(separationPush(0, 3, 3)).toBeNull(); // boundary counts as clear
  });
});

describe('bust meter', () => {
  it('sets the collar time by how many officers are in contact', () => {
    expect(bustSeconds(0)).toBe(Infinity);
    expect(bustSeconds(1)).toBe(10);
    expect(bustSeconds(2)).toBe(5);
    expect(bustSeconds(3)).toBe(3);
    expect(bustSeconds(6)).toBe(3); // 3+ all collar in three seconds
  });

  it('fills in the threshold time for each contact count', () => {
    const dt = 0.02;
    const fill = (contacts: number) => { let m = 0; let t = 0; while (m < 1 && t < 60) { m = nextBustMeter(m, contacts, dt); t += dt; } return t; };
    expect(fill(1)).toBeCloseTo(10, 1); // within a frame of the threshold
    expect(fill(2)).toBeCloseTo(5, 1);
    expect(fill(3)).toBeCloseTo(3, 1);
  });

  it('never fills with nobody in contact, and drains once you break away', () => {
    expect(nextBustMeter(0, 0, 1)).toBe(0);
    const half = nextBustMeter(0.5, 0, 0.5); // draining
    expect(half).toBeLessThan(0.5);
    let m = 0.9; for (let i = 0; i < 10; i++) m = nextBustMeter(m, 0, 0.5);
    expect(m).toBe(0); // fully drained after breaking contact
  });

  it('clamps to [0,1]', () => {
    expect(nextBustMeter(0.99, 3, 10)).toBe(1); // overshoot capped so the caller's >=1 check is exact
    expect(nextBustMeter(0.01, 0, 10)).toBe(0);
  });
});

describe('departure and despawn', () => {
  it('puts the same-cell test on the despawn grid', () => {
    expect(inSameCell(5, 5, DESPAWN_CELL - 5, 5)).toBe(true); // both in cell (0,0)
    expect(inSameCell(5, 5, DESPAWN_CELL + 5, 5)).toBe(false); // neighbour cell in x
    expect(inSameCell(-5, -5, 5, -5)).toBe(false); // straddles the 0 boundary: cell (-1,-1) vs (0,-1)
  });

  it('aims a departing car at a player-ringing cell, away from the player', () => {
    const target = departTarget(0, 0, 40, 10); // car to the +x/+z side of the player
    expect(policeCell(target.x, target.z)).toEqual({ cx: 1, cz: 1 });
    const behind = departTarget(0, 0, -50, 0); // car to the -x side, dead level in z
    expect(policeCell(behind.x, behind.z).cx).toBe(-1);
  });

  it('never targets the player\'s own cell', () => {
    for (const [cx, cz] of [[8, -3], [-4, 4], [0, 0]]) {
      const player = { x: cx! * DESPAWN_CELL + 20, z: cz! * DESPAWN_CELL + 20 };
      for (const car of [{ x: player.x + 30, z: player.z + 5 }, { x: player.x - 30, z: player.z - 40 }, { x: player.x, z: player.z }]) {
        const target = departTarget(player.x, player.z, car.x, car.z);
        expect(inSameCell(player.x, player.z, target.x, target.z)).toBe(false);
      }
    }
  });

  it('counts a car as departed only once it is a clear cell and a cell-width away', () => {
    expect(policeCarDeparted(0, 0, DESPAWN_CELL + 10, 0)).toBe(true); // different cell, past a cell width
    // Player near the far edge of their cell, car just over the boundary: different cell but physically close — not yet gone.
    expect(policeCarDeparted(DESPAWN_CELL - 5, 5, DESPAWN_CELL + 5, 5)).toBe(false);
    expect(policeCarDeparted(0, 0, 10, 10)).toBe(false); // same cell
    expect(policeCarDeparted(0, 0, CULL_RADIUS + 5, 0)).toBe(true); // hard cull regardless of cell
  });

  it('keeps live units while wanted, culls wrecks when far, departs cars once heat clears', () => {
    const far = DESPAWN_CELL + 20;
    expect(shouldRemovePoliceCar(0, 0, far, 0, true, false)).toBe(false); // live + wanted: stays
    expect(shouldRemovePoliceCar(0, 0, 10, 10, false, false)).toBe(false); // heat off but still in the block
    expect(shouldRemovePoliceCar(0, 0, far, 0, false, false)).toBe(true); // heat off and clear: gone
    expect(shouldRemovePoliceCar(0, 0, CULL_RADIUS + 5, 0, true, true)).toBe(true); // wreck, far: cleaned up even while wanted
    expect(shouldRemovePoliceCar(0, 0, 30, 0, true, true)).toBe(false); // wreck but near: lingers as scenery
  });
});

describe('patrol destination spread', () => {
  const nodes = [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 40, z: 0 }, { x: 0, z: 45 }];

  it('avoids re-picking the node the car is already on when a fresh one is in range', () => {
    // Car sits on node 0; avoid ring rules it (and its close neighbour) out, leaving the farther nodes.
    for (const roll of [0, 0.34, 0.67, 0.99]) {
      const goal = pickRoamGoal(nodes, { x: 0, z: 0 }, ROAM_RADIUS, () => roll, { x: 0, z: 0 }, 15);
      expect([2, 3]).toContain(goal);
    }
  });

  it('falls back to any in-range node when every candidate sits inside the spread ring', () => {
    const goal = pickRoamGoal([{ x: 2, z: 0 }, { x: 3, z: 0 }], { x: 0, z: 0 }, ROAM_RADIUS, () => 0, { x: 0, z: 0 }, 15);
    expect([0, 1]).toContain(goal); // no node clears the ring, so it still returns one rather than stalling
  });
});

describe('3D sight lines', () => {
  // One 9u-tall building between the shooter and the target; occlusion mirrors the collider band test.
  const building = { minX: -5, maxX: 5, minZ: 10, maxZ: 20, y0: 0, height: 9 };
  const occludes = (x: number, z: number, y0: number, y1: number): boolean =>
    x > building.minX && x < building.maxX && z > building.minZ && z < building.maxZ && building.y0 < y1 && building.y0 + building.height > y0;

  it('blocks a street-level target behind the building', () => {
    expect(sightLineClear({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 30 }, occludes)).toBe(false);
  });

  it('sees a clear street-level target', () => {
    expect(sightLineClear({ x: 30, y: 0, z: 0 }, { x: 30, y: 0, z: 30 }, occludes)).toBe(true);
  });

  it('cannot shoot a rooftop player through the floors below him', () => {
    // Player on the 9u roof, cop right at the base: every sample passes through the building band.
    expect(sightLineClear({ x: 0, y: 0, z: 5 }, { x: 0, y: 9, z: 15 }, occludes)).toBe(false);
  });

  it('sees the rooftop player once the sight line rises over the parapet', () => {
    // From 60u out, the eye-to-chest line clears the 9u roof edge on its way to the elevated target.
    expect(sightLineClear({ x: 0, y: 0, z: 80 }, { x: 0, y: 9, z: 15 }, occludes)).toBe(true);
    // Same geometry with the player at street level behind the building stays blocked.
    expect(sightLineClear({ x: 0, y: 0, z: 80 }, { x: 0, y: 0, z: 5 }, occludes)).toBe(false);
  });
});
