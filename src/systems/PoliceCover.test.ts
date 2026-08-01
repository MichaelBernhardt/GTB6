import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { AudioManager } from '../core/AudioManager';
import type { Pedestrian } from '../entities/Pedestrian';
import { buildCityNavPaths, PED_NAV_JOIN, ROAD_NETWORK, VEHICLE_NAV_JOIN, type City } from '../world/City';
import { SPAWN_POINT } from '../world/placements';
import { bridgeIslands, buildNavGraph } from './NavGraph';
import { PoliceKnowledge, SIGHT_RADIUS } from './PoliceKnowledge';
import { COVER_BREAK_SQ, COVER_ENTER_SQ, COVER_SLOT_SIDE, coverSlot, PoliceSystem, REBOARD_RANGE, roamRecalledByFreshReport, shouldHoldCover } from './PoliceSystem';
import { WantedSystem } from './WantedSystem';

// The arrest scene plays out on ELEVATED ground on purpose: the original cover check compared the
// officer's 3D position against a y=0 destination, so the day terrain relief shipped (the CBD sits
// ~16u up) the crouch threshold became unreachable and police cover silently died — officers got
// out and just stood at the car. Flat-ground stubs could never catch that, which is why it went
// unnoticed. GROUND_Y here is the regression tripwire.
const GROUND_Y = 12;

const { lanes, walks } = buildCityNavPaths(ROAD_NETWORK);
const sidewalkPoints = walks.flatMap((walk) => walk.points);
const makeCity = (): City => ({
  vehicleNav: bridgeIslands(buildNavGraph(lanes, VEHICLE_NAV_JOIN)),
  pedNav: bridgeIslands(buildNavGraph(walks, PED_NAV_JOIN)),
  sidewalkPoints,
  wanderTarget: () => sidewalkPoints[0],
  trafficRoutes: lanes.map((lane) => lane.points),
  collides: () => false,
  collidesAt: () => false,
  isOnRoad: () => true,
  signalStops: () => false,
  signalSlowFactor: () => 1,
  districtAt: () => 'Joburg CBD',
  surfaceHeightAt: () => GROUND_Y,
  sidewalkHeightAt: () => GROUND_Y,
  roadHeightAt: () => GROUND_Y,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0),
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x + minimum + 5, GROUND_Y, position.z), heading: 0 }),
}) as unknown as City;

const audio = { scream: () => {}, setSiren: () => {}, taxiHoot: () => {}, setTrafficEngine: () => {}, copGunshot: () => {}, policeShout: () => {}, collision: () => {} } as unknown as AudioManager;

/** Interleaved arrest-scene harness mirroring the Game loop: officer peds update (population pass)
 *  BEFORE the police system imposes state — the interplay the pure PoliceSystem tests skip, and
 *  exactly where the cover hand-off between Pedestrian arrival and the crouch gate lives. */
class ArrestScene {
  readonly city = makeCity();
  readonly police = new PoliceSystem(new THREE.Scene(), this.city, audio);
  readonly wanted = new WantedSystem();
  readonly knowledge = new PoliceKnowledge();
  readonly player = new THREE.Vector3(SPAWN_POINT.x, GROUND_Y, SPAWN_POINT.z);
  officers: Pedestrian[] = [];
  deployments = 0;
  reboards = 0;
  damage = 0;

  constructor() {
    this.wanted.addCrime(40); // two stars: live fire (and the drawn weapon) authorized
    this.knowledge.copWitness(this.player.x, this.player.z);
  }

  run(frames: number, perFrame?: () => void): void {
    for (let frame = 0; frame < frames; frame++) {
      for (const officer of this.officers) officer.update(1 / 30, this.city, sidewalkPoints, this.player);
      this.police.update(1 / 30, this.player, false, this.wanted, this.knowledge, (amount) => { this.damage += amount; });
      this.knowledge.update(1 / 30); // the dispatch clock must tick as it does in Game: sightings/reports carry real timestamps, or every same-spot report looks stale and no unit ever re-navigates

      for (const event of this.police.consumeEvents()) {
        if (event.kind === 'officers') { this.officers.push(...event.officers); this.deployments++; }
        else if (event.kind === 'reboard') { this.officers = this.officers.filter((ped) => !event.officers.includes(ped)); this.reboards++; }
      }
      perFrame?.();
    }
  }

  /** Live cover assignments this frame (assert immediately after run(): takingCover is the
   *  per-frame handshake between the police update and the ped's next own update). */
  get covering(): { ped: Pedestrian; car: THREE.Vector3 }[] {
    return this.police.coverAssignments().map(({ ped, car }) => ({ ped, car: car.group.position }));
  }

  expectBehindOwnCar({ ped, car }: { ped: Pedestrian; car: THREE.Vector3 }): void {
    const toOfficer = new THREE.Vector2(ped.group.position.x - car.x, ped.group.position.z - car.z);
    const toPlayer = new THREE.Vector2(this.player.x - car.x, this.player.z - car.z);
    expect(toOfficer.dot(toPlayer)).toBeLessThan(0); // far side: the car is the cover object
  }

  expectSettledIntoSlot({ ped, car }: { ped: Pedestrian; car: THREE.Vector3 }): void {
    const slots = [coverSlot(car.x, car.z, this.player.x, this.player.z, 1), coverSlot(car.x, car.z, this.player.x, this.player.z, -1)];
    const settle = Math.min(...slots.map((slot) => Math.hypot(slot.x - ped.group.position.x, slot.z - ped.group.position.z)));
    expect(settle).toBeLessThan(0.6); // settled INTO the slot, not parked at the arrival ring
  }
}

describe('cover slot geometry', () => {
  it('puts both slots on the far side of the car from the player, on distinct spots', () => {
    for (const [px, pz] of [[10, 0], [0, 10], [7, 7], [-4, 9]] as const) {
      const a = coverSlot(0, 0, px, pz, 1);
      const b = coverSlot(0, 0, px, pz, -1);
      expect(a.x * px + a.z * pz).toBeLessThan(0); // dot(slot - car, player - car) < 0: the car shields the officer
      expect(b.x * px + b.z * pz).toBeLessThan(0);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(2 * COVER_SLOT_SIDE, 5); // bonnet and boot, never one dogpile spot
    }
  });

  it('survives a player standing dead on the car', () => {
    const slot = coverSlot(0, 0, 0, 0, 1);
    expect(Number.isFinite(slot.x) && Number.isFinite(slot.z)).toBe(true);
    expect(Math.hypot(slot.x, slot.z)).toBeGreaterThan(1);
  });
});

describe('cover hysteresis', () => {
  it('enters at the ped arrival ring, holds through drift, breaks when flanked', () => {
    expect(shouldHoldCover(false, COVER_ENTER_SQ)).toBe(true);
    expect(shouldHoldCover(false, COVER_ENTER_SQ + 0.1)).toBe(false);
    expect(shouldHoldCover(true, COVER_BREAK_SQ)).toBe(true); // slot drifting with a strafing player does not strobe the crouch
    expect(shouldHoldCover(true, COVER_BREAK_SQ + 0.1)).toBe(false);
  });

  it('admits the stall distance Pedestrian arrival enforces — a tighter gate is unreachable and deadlocks the officer', () => {
    // Pedestrian.updateMotion parks any non-pursuing hostile ped once its destination is closer
    // than sqrt(5) and refuses to walk further. If this ever fails, the officer can no longer
    // reach the cover gate on foot and stands at the ring edge forever — the pre-fix deadlock.
    expect(COVER_ENTER_SQ).toBeGreaterThanOrEqual(5);
  });
});

describe('roam recall on fresh same-spot intel', () => {
  it('recalls only far-flung roamers: the outward search walk never returns on its own', () => {
    expect(roamRecalledByFreshReport(false, 500)).toBe(false); // not roaming: normal pursuit handles it
    expect(roamRecalledByFreshReport(true, SIGHT_RADIUS - 1)).toBe(false); // still in eyeshot of the scene: keep the local search
    expect(roamRecalledByFreshReport(true, SIGHT_RADIUS + 1)).toBe(true); // out of eyeshot: a re-offending suspect must re-engage this unit
  });
});

describe('arrest cover on elevated terrain (the lost behaviour)', () => {
  it('officers deploy, dig in behind the cruiser, crouch, aim, and keep shooting', () => {
    const scene = new ArrestScene();
    scene.run(2400);
    expect(scene.officers.length).toBeGreaterThanOrEqual(2);
    const covering = scene.covering;
    expect(covering.length).toBeGreaterThanOrEqual(2); // the crouch actually happens — dead code until this fix
    for (const assignment of covering) {
      expect(assignment.ped.takingCover).toBe(true); // crouch pose handshake is live
      expect(assignment.ped.aimingWeapon).toBe(true); // weapon up at two stars: cover without the aim read looks broken
      scene.expectBehindOwnCar(assignment);
      scene.expectSettledIntoSlot(assignment);
    }
    for (let i = 0; i < covering.length; i++) for (let j = i + 1; j < covering.length; j++) {
      expect(covering[i]!.ped.group.position.distanceTo(covering[j]!.ped.group.position)).toBeGreaterThan(1.2); // distinct spots
    }
    expect(scene.damage).toBeGreaterThan(0); // suppression is real fire, not theatre
  });

  it('breaks cover and re-forms on the new far side when the player flanks', () => {
    const scene = new ArrestScene();
    scene.run(2400);
    const dugIn = scene.covering;
    expect(dugIn.length).toBeGreaterThanOrEqual(2);
    // Flank: mirror the player through one crew's cruiser — that crew's cover side is now exposed.
    const car = dugIn[0]!.car.clone();
    scene.player.set(car.x * 2 - scene.player.x, GROUND_Y, car.z * 2 - scene.player.z);
    scene.knowledge.copWitness(scene.player.x, scene.player.z);
    let brokeCover = false;
    scene.run(600, () => { if (scene.officers.some((ped) => ped.state === 'hostile' && !ped.takingCover)) brokeCover = true; });
    expect(brokeCover).toBe(true); // they repositioned, not swivelled in place
    const reformed = scene.covering;
    expect(reformed.length).toBeGreaterThanOrEqual(1);
    for (const assignment of reformed) scene.expectBehindOwnCar(assignment); // behind their car relative to the NEW player position
  });

  it('holds the full arc without deadlock: engage, player flees (reboard), player returns (re-deploy, re-cover)', () => {
    const scene = new ArrestScene();
    scene.run(2400);
    expect(scene.deployments).toBeGreaterThanOrEqual(1);
    expect(scene.covering.length).toBeGreaterThanOrEqual(2);
    const engageDamage = scene.damage;
    expect(engageDamage).toBeGreaterThan(0);
    // Flee well beyond the reboard ring: the ORIGINAL scene must dissolve — cover officers mount
    // back up (reboard) rather than staying pinned to an empty street. The cars then re-pursue,
    // and a fresh arrest forms wherever the suspect stops: that re-engagement is the design.
    const origin = scene.player.clone();
    scene.player.x += REBOARD_RANGE + 30;
    scene.run(1200);
    expect(scene.reboards).toBeGreaterThanOrEqual(1); // nobody ducks forever at an abandoned scene
    // Return to the original scene: the response must follow and re-form — stop, deploy, cover,
    // fire. Sampled across the window, not the final frame: mid-cycle a scene is legitimately in
    // foot-chase or re-pursuit (a lone chaser holds the car's claim while it repositions), so the
    // pin is that a two-officer cover scene EXISTS again, not that the arc happens to end on one.
    scene.player.copy(origin);
    scene.knowledge.copWitness(scene.player.x, scene.player.z);
    let reformedCover = 0;
    // A generous window on purpose: with the search fully cold, a recalled roamer can be hundreds
    // of units out and needs real drive time (plus budgeted A* replans) to get back on scene.
    scene.run(6000, () => { reformedCover = Math.max(reformedCover, scene.covering.length); });
    expect(scene.deployments).toBeGreaterThanOrEqual(2);
    expect(reformedCover).toBeGreaterThanOrEqual(2);
    expect(scene.damage).toBeGreaterThan(engageDamage); // re-engaged with live fire, not a standing crowd
  });
});
