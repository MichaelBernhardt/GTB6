import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { bumpBreaksSolidarity } from './FearSystem';
import type { AudioManager } from '../core/AudioManager';
import type { City } from '../world/City';
import { roadHazards } from './NavGraph';
import { PopulationSystem } from './PopulationSystem';

/**
 * The two halves of the protest report, at the level the simulation owns them.
 *
 *  1. "everyone gets scared of me and runs away" — who stops standing with the player, and how far
 *     the news of an attack travels.
 *  2. "cars etc just drive through it" — a driver meeting junk in his lane: round it when there is
 *     room, stopped short when there is not, and MOVING AGAIN the moment it is cleared. That last one
 *     is the thing nobody can see by looking, and the reason a blockade is allowed to block at all.
 */

/** A single straight lane running north from the origin, so a driver's path is a number line. The
 *  pavement is a parallel line 60 units away, well clear of it: PopulationSystem's constructor
 *  populates the sidewalk, and a citizen standing in the carriageway is a car-following test of its
 *  own that would drown out this one. */
const line = (x: number) => Array.from({ length: 25 }, (_, index) => ({ x, z: index * 5 }));
const chain = (nodes: ReadonlyArray<{ x: number; z: number }>) => ({
  nodes: [...nodes],
  edges: nodes.map((_, index) => [index - 1, index + 1].filter((n) => n >= 0 && n < nodes.length)),
});
const LANE = line(0);
const PAVEMENT = line(60);
const city = {
  vehicleNav: chain(LANE), pedNav: chain(PAVEMENT), sidewalkPoints: PAVEMENT, trafficRoutes: [],
  wanderTarget: () => PAVEMENT[0], collides: () => false, collidesAt: () => false, isOnRoad: () => true,
  signalStops: () => false, signalSlowFactor: () => 1, signalNearby: () => false, districtAt: () => 'Brixton',
  surfaceHeightAt: () => 0, sidewalkHeightAt: () => 0, roadHeightAt: () => 0,
  surfaceNormalAt: () => new THREE.Vector3(0, 1, 0),
  clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone(),
  nearestRoadPose: (position: THREE.Vector3) => ({ position: position.clone(), heading: 0 }),
  roadPoseAwayFrom: (position: THREE.Vector3, minimum: number) => ({ position: new THREE.Vector3(position.x, 0, position.z + minimum), heading: 0 }),
} as unknown as City;

const silence = {
  scream: () => {}, grunt: () => {}, collision: () => {}, playerImpact: () => {}, melee: () => {},
  whiff: () => {}, setTrafficEngine: () => {}, hornAt: () => {}, taxiHoot: () => {},
} as unknown as AudioManager;

/** A row of circles laid across the lane at `z`: the shape a barricade publishes. */
const wallAcross = (z: number) => [-4.5, 0, 4.5].map((x) => ({ x, z, r: 2 }));

afterEach(() => roadHazards.clear());

describe('who stops standing with the player', () => {
  it('breaks solidarity only inside the crime radius, and never brings it back', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, silence, { x: 0, z: 0 });
    const near = population.spawnFixture(0, 5, 'Resident');
    const far = population.spawnFixture(0, 80, 'Resident');
    near.solidarity = true; far.solidarity = true;

    expect(population.breakSolidarity(new THREE.Vector3(0, 0, 0), 24)).toBe(1);
    expect(near.solidarity).toBe(false);
    expect(far.solidarity).toBe(true); // 80 units away: they did not see it

    // Nothing puts it back. The feature that granted it is the only thing that ever grants it again.
    expect(population.breakSolidarity(new THREE.Vector3(0, 0, 0), 24)).toBe(0);
  });

  it('reaches further for a killing than for a shove, because it borrows the crime’s own radius', () => {
    const population = new PopulationSystem(new THREE.Scene(), city, silence, { x: 0, z: 0 });
    const witness = population.spawnFixture(0, 40, 'Resident');
    witness.solidarity = true;
    expect(population.breakSolidarity(new THREE.Vector3(0, 0, 0), 24)).toBe(0); // assault radius: too far
    expect(population.breakSolidarity(new THREE.Vector3(0, 0, 0), 58)).toBe(1); // kill radius: heard it
  });

  it('a jostle is not an attack: only a body going down ends the picket’s patience', () => {
    // The owner's rule, verbatim: people aren't scared of him "unless I actually attack someone". A
    // walking bump — even the second one that JMPD books as assault — never passes this gate, because a
    // protest is dense enough that reaching its middle guarantees a few. Game routes the gate's verdict
    // into reportCrime as `jostle`, whose absence is what triggers the witness sweep. If this table
    // changes, arriving in your own picket revokes it for everyone within earshot again — the exact
    // playtest report that created solidarity in the first place.
    expect(bumpBreaksSolidarity({ knockdown: false, killed: false })).toBe(false); // barging: never
    expect(bumpBreaksSolidarity({ knockdown: true, killed: false })).toBe(true); // trampled at a sprint
    expect(bumpBreaksSolidarity({ knockdown: true, killed: true })).toBe(true); // killed outright
  });

  it('Game wires the shove exemption through the jostle flag, and nothing else claims it', () => {
    // vitest never constructs Game (the boot-order gate exists because of that), so the wiring is
    // pinned textually: the bump path must consult the gate, reportCrime must honour the flag, and no
    // other call site may quietly grant itself the exemption.
    const game = readFileSync(resolve(__dirname, '../Game.ts'), 'utf8');
    expect(game).toMatch(/jostle: !bumpBreaksSolidarity\(bump\)/);
    expect(game).toMatch(/if \(!options\.jostle\) this\.population\.breakSolidarity\(/);
    expect(game.match(/jostle: /g)?.length).toBe(1); // exactly one call site sets it: the bump loop
  });
});

describe('a driver meeting junk in the lane', () => {
  /** One AI driver on the lane, routed north, with the player standing beside it so nothing freezes. */
  const drive = (): { population: PopulationSystem; vehicle: ReturnType<PopulationSystem['spawnScriptVehicle']>; run(seconds: number): void } => {
    const population = new PopulationSystem(new THREE.Scene(), city, silence, { x: 0, z: 0 });
    const vehicle = population.spawnScriptVehicle('compact', 0, 0, 0);
    expect(population.routeVehicleTo(vehicle, 0, 100)).toBe(true);
    const player = new THREE.Vector3(0, 0, 0);
    const run = (seconds: number): void => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        player.set(vehicle.group.position.x, 0, vehicle.group.position.z - 6); // stay in the AI ring
        population.update(1 / 60, player);
      }
    };
    return { population, vehicle, run };
  };

  it('drives the clear lane, so the control case is a control case', () => {
    const { vehicle, run } = drive();
    run(12);
    expect(vehicle.group.position.z).toBeGreaterThan(40);
  });

  it('goes ROUND a single tyre near the kerb instead of stopping for it', () => {
    const { vehicle, run } = drive();
    roadHazards.publish('protest', [{ x: 1.4, z: 30, r: 1.6 }]);
    run(12);
    expect(vehicle.group.position.z).toBeGreaterThan(40); // it got past
    expect(Math.abs(vehicle.speed)).toBeGreaterThan(4); // ...without ever coming to a stop for it
  });

  it('STOPS at a line of tyres across the lane, short of the fire, and does not drive through', () => {
    const { vehicle, run } = drive();
    roadHazards.publish('protest', wallAcross(30));
    run(14);
    expect(vehicle.group.position.z).toBeLessThan(28); // never reached the fire
    expect(Math.abs(vehicle.speed)).toBeLessThan(2); // and is sitting there
  });

  it('MOVES AGAIN when the road is cleared — a blockade may block, it may not deadlock', () => {
    const { vehicle, run } = drive();
    roadHazards.publish('protest', wallAcross(30));
    run(14);
    const held = vehicle.group.position.z;
    expect(Math.abs(vehicle.speed)).toBeLessThan(2);

    roadHazards.retract('protest'); // the tyres burnt out
    run(10);
    expect(vehicle.group.position.z).toBeGreaterThan(held + 10);
    expect(Math.abs(vehicle.speed)).toBeGreaterThan(4);
  });

  it('does not brake for junk on the pavement beside it', () => {
    const { vehicle, run } = drive();
    roadHazards.publish('protest', [{ x: 9, z: 20, r: 2 }, { x: -9, z: 40, r: 2 }]);
    run(12);
    expect(vehicle.group.position.z).toBeGreaterThan(40);
  });
});
