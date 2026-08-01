import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City } from '../world/City';
import { FEAR_EVENTS, FLEE_THRESHOLD } from '../systems/FearSystem';
import { Pedestrian } from './Pedestrian';

/**
 * The owner's deterrence rule, at the entity seams (see SidearmSystem for the rule itself):
 * every path where an unarmed citizen would start or continue a fist fight must fold when the
 * player visibly holds a firearm — and the armed citizen, the officer and the Rank Enforcer
 * must each ignore that fold for their own reasons. These seams regressed repeatedly through
 * the protest work; pin them.
 *
 * Index cheat sheet (the deterministic personality wheels):
 *   9 — aggressive (9 % 9 = 0), unarmed (9 % 12 ≠ 3), bravery 0.44
 *  27 — aggressive AND armed (27 % 36 = 27): the citizen who answers a gun with a gun
 *   2 — brave good samaritan (bravery 0.85), unarmed, not aggressive
 *  51 — brave good samaritan (bravery 0.98), ARMED (51 % 12 = 3), not aggressive
 */
const flatCity = { surfaceHeightAt: () => 0, wanderTarget: () => undefined, clampMove: (_from: THREE.Vector3, desired: THREE.Vector3) => desired.clone() } as unknown as City;
const DT = 1 / 30;
const step = (ped: Pedestrian, seconds: number, player: THREE.Vector3): void => {
  for (let t = 0; t < seconds; t += DT) ped.update(DT, flatCity, [], player);
};

describe('the square-up gate', () => {
  it('an unarmed aggressive does not start a fight with a visibly armed player', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 9);
    expect(ped.aggressive).toBe(true); expect(ped.armed).toBe(false);
    ped.playerArmed = true;
    ped.update(DT, flatCity, [], new THREE.Vector3(2, 0, 0));
    expect(ped.state).not.toBe('hostile');
  });

  it('the identical personality still squares up to an unarmed player', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 9);
    ped.update(DT, flatCity, [], new THREE.Vector3(2, 0, 0));
    expect(ped.state).toBe('hostile');
    expect(ped.gunDrawn).toBe(false); // fists vs fists: nobody draws anything
  });

  it('an ARMED aggressive squares up to the gun and draws his own', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 27);
    expect(ped.aggressive).toBe(true); expect(ped.armed).toBe(true);
    ped.playerArmed = true;
    ped.update(DT, flatCity, [], new THREE.Vector3(2, 0, 0));
    expect(ped.state).toBe('hostile');
    expect(ped.gunDrawn).toBe(true);
    expect(ped.gunAimed).toBe(true); // inside the gun hold ring: settled into the aim stance
    expect(ped.aimingWeapon).toBe(true); // the per-frame pose handshake the police path uses
  });
});

describe('the mid-fight break table', () => {
  const player = new THREE.Vector3(2, 0, 0);
  const midFight = (index: number): Pedestrian => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), index);
    ped.update(DT, flatCity, [], player); // fists vs fists: the fight starts legitimately
    expect(ped.state).toBe('hostile');
    return ped;
  };

  it('unarmed: the drawn gun breaks the attacker off through the fear model, into flight', () => {
    const ped = midFight(9);
    ped.playerArmed = true; // the player pulls a gun mid-punch-up
    ped.update(DT, flatCity, [], player);
    expect(ped.state).toBe('flee');
    expect(ped.enraged).toBe(false);
    expect(ped.gunDrawn).toBe(false);
    expect(ped.fear).toBeGreaterThanOrEqual(FLEE_THRESHOLD); // a real fright, not a state teleport
  });

  it('armed: the attacker answers the draw with his own and CONTINUES', () => {
    const ped = midFight(27);
    ped.playerArmed = true;
    ped.update(DT, flatCity, [], player);
    expect(ped.state).toBe('hostile');
    expect(ped.gunDrawn).toBe(true);
  });

  it('holds the drawn gun sticky through the fight, and holsters when the fight ends', () => {
    const ped = midFight(27);
    ped.playerArmed = true;
    ped.update(DT, flatCity, [], player);
    ped.playerArmed = false; // the player holsters to bait
    ped.update(DT, flatCity, [], player);
    expect(ped.gunDrawn).toBe(true); // they do not holster because the player did
    ped.state = 'flee'; // fight over by any route
    ped.update(DT, flatCity, [], new THREE.Vector3(50, 0, 50));
    expect(ped.gunDrawn).toBe(false);
  });

  it('police: officers are exempt — facing an armed suspect is the job', () => {
    const officer = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 5, false, true);
    officer.state = 'hostile'; officer.destination.set(10, 0, 0); // an arrest hustle in progress
    officer.playerArmed = true;
    officer.update(DT, flatCity, [], new THREE.Vector3(2, 0, 0));
    expect(officer.state).toBe('hostile');
    expect(officer.gunDrawn).toBe(false); // their sidearm belongs to PoliceSystem, not this path
    expect(officer.fear).toBe(0);
  });

  it('Rank Enforcers: constructor-hostile crews are committed — no scattering a defeat wave', () => {
    const enforcer = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3, true, false);
    expect(enforcer.armed).toBe(false); // index 3 would carry as a citizen; the crew fights with fists
    enforcer.playerArmed = true;
    enforcer.update(DT, flatCity, [], new THREE.Vector3(5, 0, 0));
    expect(enforcer.state).toBe('hostile');
    expect(enforcer.gunDrawn).toBe(false);
  });
});

describe('the good-samaritan gate', () => {
  const threat = new THREE.Vector3(3, 0, 0);

  it('a brave unarmed samaritan flees a visibly armed attacker instead of wading in', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 2);
    expect(ped.bravery).toBeGreaterThanOrEqual(0.85);
    ped.playerArmed = true;
    ped.applyFear(FEAR_EVENTS.assault.base, threat);
    expect(ped.state).toBe('flee');
    expect(ped.enraged).toBe(false);
  });

  it('the same samaritan fights an unarmed one, and an ARMED samaritan fights the gun', () => {
    const unarmedVsUnarmed = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 2);
    unarmedVsUnarmed.applyFear(FEAR_EVENTS.assault.base, threat);
    expect(unarmedVsUnarmed.state).toBe('hostile');

    const armedSamaritan = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 51);
    expect(armedSamaritan.armed).toBe(true); expect(armedSamaritan.aggressive).toBe(false);
    armedSamaritan.playerArmed = true;
    armedSamaritan.applyFear(FEAR_EVENTS.assault.base, threat);
    expect(armedSamaritan.state).toBe('hostile');
    armedSamaritan.update(DT, flatCity, [], threat);
    expect(armedSamaritan.gunDrawn).toBe(true); // and the answer comes out of the waistband
  });
});

describe('the knockdown rise', () => {
  it('nobody rises swinging fists at a drawn firearm; the same personality rises fighting fists', () => {
    const deterred = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 9);
    deterred.knockdown(new THREE.Vector3(2, 0, 0));
    deterred.playerArmed = true;
    step(deterred, 3, new THREE.Vector3(2, 0, 0));
    expect(deterred.state).toBe('flee');

    const undeterred = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 9);
    undeterred.knockdown(new THREE.Vector3(2, 0, 0));
    step(undeterred, 3, new THREE.Vector3(2, 0, 0));
    expect(undeterred.state).toBe('hostile');
  });
});

describe('interlock: self-defence evidence survives the draw', () => {
  it('an armed citizen shot mid-gunfight still reads as retaliation (hostile at hit time)', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 27);
    ped.playerArmed = true;
    ped.update(DT, flatCity, [], new THREE.Vector3(2, 0, 0));
    expect(ped.gunDrawn).toBe(true);
    expect(ped.takeDamage(999, new THREE.Vector3(2, 0, 0))).toBe(true);
    expect(ped.hitWhileHostile).toBe(true); // reportCrime's retaliation exemption keeps working
  });
});
