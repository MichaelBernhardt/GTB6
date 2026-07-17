import * as THREE from 'three';

/** Procedural weapon models extend along -Y (muzzle) with +Z as the sight/top side (see WeaponModels). */
export const WEAPON_MUZZLE = new THREE.Vector3(0, -1, 0);
export const WEAPON_TOP = new THREE.Vector3(0, 0, 1);
/** Low-ready carry (character space, forward +Z): muzzle ~50° below horizontal, sights up-forward. */
export const CARRY_MUZZLE_DIR = new THREE.Vector3(0, -0.766, 0.643);
export const CARRY_TOP_DIR = new THREE.Vector3(0, 0.643, 0.766);
/** Raised aim: muzzle straight along the character's facing, sights up. */
export const AIM_MUZZLE_DIR = new THREE.Vector3(0, 0, 1);
export const AIM_TOP_DIR = new THREE.Vector3(0, 1, 0);

/** Hand-bone-space quaternion that points an attached weapon's muzzle/top along the wanted
 * model-space directions, whatever basis the rig gives the hand bone. `topDir` only needs to be
 * roughly perpendicular to `muzzleDir`; it is re-orthogonalised around the muzzle axis. */
export function weaponAttachQuaternion(handModelQuat: THREE.Quaternion, muzzleDir: THREE.Vector3, topDir: THREE.Vector3): THREE.Quaternion {
  const stock = muzzleDir.clone().normalize().negate();
  const side = new THREE.Vector3().crossVectors(stock, topDir).normalize();
  const top = new THREE.Vector3().crossVectors(side, stock);
  const desired = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, stock, top));
  return handModelQuat.clone().invert().multiply(desired);
}

export type AdditiveRotation = readonly [THREE.Object3D, readonly [number, number, number]];

/** Orientation of `boneName` relative to `root` with `clip` posed at `time`, plus optional additive
 * euler offsets (matching RiggedPlayerVisual's post-mix corrections). Restores every touched node. */
export function sampleBoneModelQuaternion(root: THREE.Object3D, clip: THREE.AnimationClip, boneName: string, time: number, additive: readonly AdditiveRotation[] = []): THREE.Quaternion {
  const saved = new Map<THREE.Object3D, THREE.Quaternion>();
  const remember = (node: THREE.Object3D) => { if (!saved.has(node)) saved.set(node, node.quaternion.clone()); };
  for (const track of clip.tracks) {
    if (!(track instanceof THREE.QuaternionKeyframeTrack)) continue;
    const node = root.getObjectByName(track.name.slice(0, track.name.lastIndexOf('.'))); if (!node) continue;
    const values = (track as unknown as { createInterpolant(): { evaluate(t: number): ArrayLike<number> } }).createInterpolant().evaluate(time);
    remember(node); node.quaternion.set(values[0], values[1], values[2], values[3]).normalize();
  }
  for (const [node, [x, y, z]] of additive) { remember(node); node.rotation.x += x; node.rotation.y += y; node.rotation.z += z; }
  const bone = root.getObjectByName(boneName) ?? null;
  const result = new THREE.Quaternion();
  for (let node: THREE.Object3D | null = bone; node && node !== root; node = node.parent) result.premultiply(node.quaternion);
  for (const [node, quaternion] of saved) node.quaternion.copy(quaternion);
  return result;
}
