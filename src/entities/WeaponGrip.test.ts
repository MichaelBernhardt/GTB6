import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  AIM_MUZZLE_DIR, AIM_TOP_DIR, CARRY_MUZZLE_DIR, CARRY_TOP_DIR,
  sampleBoneModelQuaternion, weaponAttachQuaternion, WEAPON_MUZZLE, WEAPON_TOP,
} from './WeaponGrip';

const worldDir = (local: THREE.Vector3, hand: THREE.Quaternion, attach: THREE.Quaternion): THREE.Vector3 =>
  local.clone().applyQuaternion(attach).applyQuaternion(hand);

describe('weaponAttachQuaternion', () => {
  it('is the identity when the hand basis already matches the weapon basis', () => {
    const attach = weaponAttachQuaternion(new THREE.Quaternion(), WEAPON_MUZZLE, WEAPON_TOP);
    expect(attach.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('points the muzzle and sights along the requested directions for arbitrary hand bases', () => {
    const hands = [
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -1.2, 2.4)),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-2.1, 0.3, 0.9)),
      new THREE.Quaternion(0.31, -0.49, 0.81, 0.08).normalize(),
    ];
    for (const [muzzle, top] of [[AIM_MUZZLE_DIR, AIM_TOP_DIR], [CARRY_MUZZLE_DIR, CARRY_TOP_DIR]] as const) {
      for (const hand of hands) {
        const attach = weaponAttachQuaternion(hand, muzzle, top);
        expect(worldDir(WEAPON_MUZZLE, hand, attach).distanceTo(muzzle.clone().normalize())).toBeLessThan(1e-6);
        expect(worldDir(WEAPON_TOP, hand, attach).distanceTo(top.clone().normalize())).toBeLessThan(1e-6);
      }
    }
  });

  it('re-orthogonalises a sloppy top hint around the muzzle axis', () => {
    const hand = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 0.4, 0.4));
    const attach = weaponAttachQuaternion(hand, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0.5));
    expect(worldDir(WEAPON_MUZZLE, hand, attach).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-6);
    expect(worldDir(WEAPON_TOP, hand, attach).distanceTo(new THREE.Vector3(0, 1, 0))).toBeLessThan(1e-6);
  });
});

describe('sampleBoneModelQuaternion', () => {
  const buildChain = () => {
    const root = new THREE.Group(); root.name = 'Root';
    const shoulder = new THREE.Bone(); shoulder.name = 'Shoulder';
    const hand = new THREE.Bone(); hand.name = 'Hand';
    root.add(shoulder); shoulder.add(hand);
    return { root, shoulder, hand };
  };
  const quatTrack = (bone: string, quaternion: THREE.Quaternion) =>
    new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [0, 0, 0, 1, quaternion.x, quaternion.y, quaternion.z, quaternion.w]);

  it('composes the clip-posed chain into a model-space quaternion and restores the pose', () => {
    const { root, shoulder, hand } = buildChain();
    shoulder.quaternion.setFromEuler(new THREE.Euler(0, 0.8, 0)); const restingHand = hand.quaternion.clone();
    const qShoulder = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0));
    const qHand = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -0.7));
    const clip = new THREE.AnimationClip('aim', 1, [quatTrack('Shoulder', qShoulder), quatTrack('Hand', qHand)]);
    const sampled = sampleBoneModelQuaternion(root, clip, 'Hand', 1);
    expect(sampled.angleTo(qShoulder.clone().multiply(qHand))).toBeLessThan(1e-6);
    expect(shoulder.quaternion.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.8, 0)))).toBeLessThan(1e-6);
    expect(hand.quaternion.angleTo(restingHand)).toBeLessThan(1e-6);
  });

  it('interpolates between keyframes and applies additive euler corrections', () => {
    const { root, shoulder, hand } = buildChain();
    const full = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.0, 0, 0));
    const clip = new THREE.AnimationClip('aim', 1, [quatTrack('Hand', full)]);
    const halfway = sampleBoneModelQuaternion(root, clip, 'Hand', 0.5);
    expect(halfway.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 0, 0)))).toBeLessThan(1e-3);
    const nudged = sampleBoneModelQuaternion(root, clip, 'Hand', 0.5, [[shoulder, [0, 0.25, 0]]]);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.25, 0)).multiply(halfway);
    expect(nudged.angleTo(expected)).toBeLessThan(1e-3);
    expect(shoulder.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    expect(hand.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });
});
