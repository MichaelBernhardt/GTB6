import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City } from '../world/City';
import { FEAR_EVENTS, FEAR_MAX, FLEE_THRESHOLD } from '../systems/FearSystem';
import { Pedestrian } from './Pedestrian';

/**
 * THE OWNER'S RULE, at the entity seam:
 *
 *   "There is a bug whereby the people in deep orange and purple run away when I approach them
 *    and you can't talk to them. They shouldn't scare away at all unless actually shot at or
 *    punched. Seeing a gun or whatever spooks them now is not enough."
 *
 * The "deep orange and purple" are LIGHT COLUMNS, not clothing: the street feature's two corner
 * beacons (src/features/street/street.ts DEALER_COLOR #f0842a / WORKER_COLOR #c07bff — a lit pad, a
 * ring and a 26-unit beam) standing over the dealer and the worker, each with an `E  Talk to <name>`
 * rung at TALK_RANGE. That is why the owner met the bug in exactly those two colours: a column is an
 * instruction to walk over, so those are the only pedestrians in the game he has a REASON to
 * approach — and `nearestFixture` measures from the ped's LIVE position, so a fixture driven off her
 * kerb takes the prompt with her and leaves the column lit over an empty slab.
 *
 * TWO holes had to close, and the second only became visible once the first did:
 *   1. sight of a raised gun frightened everyone who could see it — general, and it emptied the
 *      whole pavement; the fixtures were merely the ones whose absence the player could feel.
 *   2. a fixture still bolted at ANY gunshot inside 48 units, so one round across the road
 *      un-staffed a corner the player was walking to. Fixtures now hold their ground through
 *      violence that was not aimed at them, and break only for a personal attack.
 *
 * FearSystem.test.ts pins the same rule in the shape of the event table; this pins the behaviour a
 * player actually sees.
 */
const flatCity = { surfaceHeightAt: () => 0, wanderTarget: () => undefined, clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone() } as unknown as City;
const DT = 1 / 30;

/** Two ordinary bodies: not aggressive (index % 9), not armed (index % 12 === 3), so nothing but the
 *  fear model can move them — and one of each is then dressed as a corner fixture below. */
const ORDINARY = [12, 4];

const citizen = (index: number): Pedestrian => {
  const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), index);
  expect(ped.aggressive).toBe(false); // not the 1-in-9 who squares up on his own account
  expect(ped.armed).toBe(false);
  ped.state = 'idle'; ped.idleTime = 999_999; // standing on his corner, the way a talkable ped stands
  return ped;
};

/** A street corner fixture as street.ts spawns one: scripted, never aggressive, broke, arm raised,
 *  idle forever on her own paving slab. This is the body the owner was trying to talk to. */
const fixture = (index: number): Pedestrian => {
  const ped = citizen(index);
  ped.scripted = true; ped.wallet = 0; ped.setHail(true);
  return ped;
};

describe('a drawn gun frightens nobody who is not already in the fight', () => {
  for (const index of ORDINARY) {
    it(`stands its ground while the player closes to arm's length holding a firearm (index ${index})`, () => {
      const ped = citizen(index);
      const start = ped.group.position.clone();
      ped.playerArmed = true; // the player is visibly carrying, the whole approach
      for (let range = 20; range > 1; range -= 0.25) { // walk right up to them, gun out
        for (let t = 0; t < 0.25; t += DT) ped.update(DT, flatCity, [], new THREE.Vector3(range, 0, 0));
      }
      for (let t = 0; t < 10; t += DT) ped.update(DT, flatCity, [], new THREE.Vector3(1.2, 0, 0)); // and stand there
      expect(ped.fear).toBe(0);
      expect(ped.state).toBe('idle'); // not 'flee', not 'cower' — still there to be talked to
      expect(ped.group.position.distanceTo(start)).toBeLessThan(0.01); // and still on the same spot
    });

    it(`scatters at a shot, a punch and a killing exactly as before (index ${index})`, () => {
      // The three real events, each applied at the value PopulationSystem.broadcastFear would
      // deliver point blank. Unchanged by the sight-fear removal, and asserted so it stays that way.
      const shot = citizen(index);
      shot.applyFear(FEAR_EVENTS.gunshot.base, new THREE.Vector3(2, 0, 0)); // a round goes off beside them
      shot.applyFear(FEAR_EVENTS.gunshot.base, new THREE.Vector3(2, 0, 0)); // ...and a second
      expect(shot.state).toBe('flee');

      const punched = citizen(index);
      punched.applyFear(FEAR_EVENTS.assault.base, new THREE.Vector3(1, 0, 0));
      expect(punched.state).toBe('flee');
      expect(punched.fear).toBeGreaterThanOrEqual(FLEE_THRESHOLD);

      const witness = citizen(index);
      witness.applyFear(FEAR_EVENTS.kill.base, new THREE.Vector3(3, 0, 0));
      expect(witness.state === 'flee' || witness.state === 'cower').toBe(true);
    });

    it(`still goes down and panics when actually struck, armed player or not (index ${index})`, () => {
      const hit = citizen(index);
      hit.playerArmed = true;
      hit.takeDamage(12, new THREE.Vector3(1, 0, 0)); // punched by someone holding a gun: violence is violence
      expect(hit.fear).toBeGreaterThanOrEqual(FLEE_THRESHOLD);

      const flattened = citizen(index);
      flattened.playerArmed = true;
      flattened.knockdown(new THREE.Vector3(1, 0, 0));
      expect(flattened.state).toBe('down');
      expect(flattened.fear).toBeGreaterThanOrEqual(FLEE_THRESHOLD);
    });
  }

  it('leaves a dealer/worker corner fixture on her kerb, arm still raised, through the whole approach', () => {
    // The owner's actual complaint, end to end: the `E  Talk to <name>` rung is resolved from the
    // fixture's LIVE position (street.ts nearestFixture, TALK_RANGE 5), so a fixture that walks off
    // her slab deletes her own prompt while the beacon stays lit over an empty pavement.
    const TALK_RANGE = 5;
    for (const index of ORDINARY) {
      const ped = fixture(index);
      const kerb = ped.group.position.clone();
      ped.playerArmed = true;
      for (let range = 20; range > 1; range -= 0.25) {
        for (let t = 0; t < 0.25; t += DT) ped.update(DT, flatCity, [], new THREE.Vector3(range, 0, 0));
      }
      for (let t = 0; t < 10; t += DT) ped.update(DT, flatCity, [], new THREE.Vector3(1.2, 0, 0));
      expect(ped.state).toBe('idle');
      expect(ped.hailing).toBe(true); // still beckoning, not fleeing
      expect(ped.group.position.distanceTo(kerb)).toBeLessThan(TALK_RANGE); // still inside her own prompt
    }
  });

  it('holds a fixture on her slab through gunfire that was not aimed at her', () => {
    // Removing the sight-fear was necessary but not sufficient. `gunshot` carries 48 units, so a
    // single round fired across the road still un-staffed every corner within earshot — the column
    // stays lit, the vendor is gone, and the player walks to a promise nobody is keeping. A fixture
    // now stands through ambient violence (HOLD_GROUND_CAP) and only moves for a personal attack.
    for (const index of ORDINARY) {
      const ped = fixture(index);
      const kerb = ped.group.position.clone();
      for (let i = 0; i < 12; i++) ped.applyFear(FEAR_EVENTS.gunshot.base, new THREE.Vector3(2, 0, 0));
      ped.applyFear(FEAR_EVENTS.kill.base, new THREE.Vector3(3, 0, 0)); // someone else is killed nearby
      expect(ped.fear).toBeLessThan(FLEE_THRESHOLD); // rattled, and still standing
      expect(ped.state).toBe('idle');
      expect(ped.hailing).toBe(true);
      expect(ped.group.position.distanceTo(kerb)).toBeLessThan(0.01);
    }
  });

  it('scatters the IDENTICAL pedestrian who is not a fixture, so the street still reacts', () => {
    const bystander = citizen(ORDINARY[0]); // same index, same personality, no `scripted`
    for (let i = 0; i < 12; i++) bystander.applyFear(FEAR_EVENTS.gunshot.base, new THREE.Vector3(2, 0, 0));
    expect(bystander.state).toBe('flee');
  });

  it('still breaks a fixture the player personally attacks — shot, punched, floored or robbed', () => {
    // The hold is not armour. takeDamage/knockdown/mug write fear directly and never touch the cap,
    // which is exactly the owner's line: ambient violence is noise, being attacked is not.
    const shotAt = fixture(ORDINARY[0]);
    shotAt.takeDamage(12, new THREE.Vector3(1, 0, 0));
    expect(shotAt.fear).toBe(FEAR_MAX);
    expect(shotAt.state).toBe('flee');

    const floored = fixture(ORDINARY[0]);
    floored.knockdown(new THREE.Vector3(1, 0, 0));
    expect(floored.state).toBe('down');
    expect(floored.fear).toBeGreaterThanOrEqual(FLEE_THRESHOLD);

    const robbed = fixture(ORDINARY[1]);
    robbed.mug(new THREE.Vector3(1, 0, 0));
    expect(robbed.fear).toBe(FEAR_MAX);
    expect(robbed.state).toBe('flee');
  });

  it('does not frighten a bystander standing beside a fight the player draws in', () => {
    // The one surviving firearm fright is gated on `state === 'hostile'` — being mid-swing at the
    // player. The person watching from a metre away is not in the fight and feels nothing.
    const attacker = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 9); // the 1-in-9 aggressive
    const bystander = citizen(ORDINARY[0]);
    const player = new THREE.Vector3(2, 0, 0);

    attacker.update(DT, flatCity, [], player); // fists vs fists: the fight starts
    expect(attacker.state).toBe('hostile');

    attacker.playerArmed = true; bystander.playerArmed = true; // the player pulls a gun mid-punch-up
    attacker.update(DT, flatCity, [], player);
    bystander.update(DT, flatCity, [], player);

    expect(attacker.state).toBe('flee'); // the man swinging at it lets go — the deterrence rule, intact
    expect(bystander.fear).toBe(0); // the man watching it does not move
    expect(bystander.state).toBe('idle');
  });
});
