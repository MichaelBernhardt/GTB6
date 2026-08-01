import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { City } from '../world/City';
import { DEATH_SPIN_DURATION, Pedestrian } from './Pedestrian';
import { DRAWN_ON_ME_FEAR, FEAR_EVENTS, FLEE_THRESHOLD } from '../systems/FearSystem';

const flatCity = { surfaceHeightAt: () => 0 } as unknown as City;
const step = (ped: Pedestrian, seconds: number): void => {
  for (let t = 0; t < seconds; t += 1 / 30) ped.update(1 / 30, flatCity, [], new THREE.Vector3(50, 0, 50));
};

describe('death spin', () => {
  const shoot = (originX: number): Pedestrian => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    ped.group.rotation.y = 0; // facing +z
    expect(ped.takeDamage(999, new THREE.Vector3(originX, 1, 0))).toBe(true);
    return ped;
  };

  it('whips the felled body away from the shot side, then comes to rest', () => {
    const ped = shoot(4); // shot from the ped's right
    step(ped, DEATH_SPIN_DURATION + 0.2);
    const settled = ped.group.rotation.y;
    expect(settled).toBeLessThan(-1); // spun left, a meaningful whip (~65-125°)
    expect(Math.abs(settled)).toBeLessThanOrEqual(2.3);
    step(ped, 0.5);
    expect(ped.group.rotation.y).toBe(settled); // the corpse does not keep creeping around
    expect(ped.state).toBe('down');
  });

  it('spins the opposite way when hit from the other side and is front-loaded like an impact', () => {
    const ped = shoot(-4); // shot from the ped's left
    step(ped, DEATH_SPIN_DURATION / 2);
    const early = ped.group.rotation.y;
    expect(early).toBeGreaterThan(0);
    step(ped, DEATH_SPIN_DURATION);
    const settled = ped.group.rotation.y;
    expect(settled).toBeGreaterThan(1);
    expect(early).toBeGreaterThan(settled / 2); // most of the whip lands in the first half — impact, not a lazy turntable
  });

  it('still spins on kills with no known source, and survivors do not spin', () => {
    const blasted = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    expect(blasted.takeDamage(999)).toBe(true);
    step(blasted, DEATH_SPIN_DURATION + 0.1);
    expect(Math.abs(blasted.group.rotation.y)).toBeGreaterThan(1);

    const grazed = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    expect(grazed.takeDamage(5, new THREE.Vector3(4, 1, 0))).toBe(false);
    expect(grazed.state).not.toBe('down');
  });
});

describe('pedestrian distance LOD', () => {
  it('uses one tiny silhouette draw between the detailed body and hidden tier', () => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    const detail = ped.group.getObjectByName('ProceduralPedestrianFallback')!;
    const proxy = ped.group.getObjectByName('pedestrian-lod-proxy') as THREE.Mesh;
    expect(proxy).toBeInstanceOf(THREE.Mesh);
    expect((proxy.geometry.index?.count ?? proxy.geometry.getAttribute('position').count) / 3).toBeLessThanOrEqual(80);
    expect(detail.visible).toBe(true); expect(proxy.visible).toBe(false);

    ped.setVisualLod('proxy');
    expect(ped.isRenderVisible).toBe(true); expect(ped.isDetailVisible).toBe(false);
    expect(detail.visible).toBe(false); expect(proxy.visible).toBe(true);
    ped.setVisualLod('hidden');
    expect(ped.isRenderVisible).toBe(false); expect(detail.visible).toBe(false); expect(proxy.visible).toBe(false);
    ped.setVisualLod('detail');
    expect(ped.isDetailVisible).toBe(true); expect(detail.visible).toBe(true); expect(proxy.visible).toBe(false);
  });
});

/**
 * The entity half of solidarity: a protester who does not run from the man who joined them, and does
 * stop standing with him the moment he hurts somebody.
 */
describe('solidarity', () => {
  const protester = (index = 3): Pedestrian => {
    const ped = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), index);
    ped.scripted = true; ped.state = 'idle'; ped.idleTime = 999999; ped.solidarity = true;
    return ped;
  };
  const player = new THREE.Vector3(1, 0, 0);

  it('holds the line through the fear that scatters an ordinary crowd', () => {
    const ped = protester();
    ped.applyFear(FEAR_EVENTS.assault.base, player); // barged into twice inside the bump window
    ped.applyFear(DRAWN_ON_ME_FEAR, player); // and a gun pulled on them mid-scuffle
    ped.applyFear(FEAR_EVENTS.kill.base, player);
    expect(ped.state).toBe('idle');
    expect(ped.fear).toBeLessThan(FLEE_THRESHOLD);
  });

  it('scatters the identical pedestrian who is NOT on the picket', () => {
    // `scripted` shares the picket's hold-ground cap (a feature fixture must not leave its marker
    // either — see HOLD_GROUND_CAP), so an honest contrast has to drop BOTH flags: what is being
    // asserted is that an ordinary body in that spot still runs, and the hold is what stops it.
    const bystander = protester(); bystander.solidarity = false; bystander.scripted = false;
    bystander.applyFear(FEAR_EVENTS.assault.base, player);
    expect(bystander.state).toBe('flee'); // the behaviour the owner reported, still intact off the line
  });

  it('does not square up to the player it is standing next to', () => {
    // One ambient body in nine is `aggressive` and turns hostile on anyone within 4.5 units, which at
    // a protest means the crowd you just joined starts a fight with you.
    const bruiser = protester(9); // index % 9 === 0
    expect(bruiser.aggressive).toBe(true);
    for (let t = 0; t < 0.5; t += 1 / 30) bruiser.update(1 / 30, flatCity, [], new THREE.Vector3(1, 0, 1));
    expect(bruiser.state).toBe('idle');
    bruiser.solidarity = false;
    for (let t = 0; t < 0.5; t += 1 / 30) bruiser.update(1 / 30, flatCity, [], new THREE.Vector3(1, 0, 1));
    expect(bruiser.state).toBe('hostile');
  });

  it('ends the instant somebody actually hits them, and the fear that lands then does its normal job', () => {
    const ped = protester();
    ped.takeDamage(10, player);
    expect(ped.solidarity).toBe(false);
    expect(ped.state).toBe('flee');
  });

  it('ends on a knockdown and on a mugging too', () => {
    const floored = protester();
    floored.knockdown(player);
    expect(floored.solidarity).toBe(false);
    const mugged = protester();
    mugged.mug(player);
    expect(mugged.solidarity).toBe(false);
  });
});

describe('self-defence evidence', () => {
  it('records that the hit landed on someone hostile, and keeps it through the kill', () => {
    // takeDamage overwrites `state` before Game files the crime ('down' on a kill), so whether the
    // victim was attacking is captured at the moment of the hit. reportCrime reads it to keep
    // self-defence from revoking a picket's solidarity — the crowd watched who started it.
    const attacker = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 3);
    attacker.state = 'hostile';
    expect(attacker.takeDamage(999)).toBe(true);
    expect(attacker.state).toBe('down');
    expect(attacker.hitWhileHostile).toBe(true); // the evidence survives the kill

    const civilian = new Pedestrian(new THREE.Scene(), new THREE.Vector3(), 4);
    civilian.takeDamage(5);
    expect(civilian.hitWhileHostile).toBe(false); // an unprovoked victim never reads as one
  });
});
