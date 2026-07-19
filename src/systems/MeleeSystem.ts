import * as THREE from 'three';

/** NPC melee: the shared windup → hit → recover swing every hostile attacker runs.
 *
 *  Timing is anchored to the shipped punch_right clip (0.60s in every NPC GLB and the
 *  protagonist rig), with the damage frame at the fist's full extension partway through.
 *  Damage never applies at swing start: the hit lands only if the target is STILL in reach
 *  and in front of the attacker at the hit frame, so backing off mid-windup escapes clean
 *  and there is no invisible damage without a matching animation. */

/** Full swing duration — the length of the punch_right clip, so the animation always completes. */
export const MELEE_SWING_SECONDS = 0.6;
/** Damage frame: fist at full extension (~58% through the clip). The player's escape window. */
export const MELEE_HIT_AT = 0.35;
/** A pursuing hostile stops advancing and squares up inside this range of the player. */
export const MELEE_ENGAGE_RANGE = 1.6;
/** Swings may start a little outside the hold ring, so a strafing player still gets swung at. */
export const MELEE_START_RANGE = 2.0;
/** The target must still be inside this at the hit frame for damage to land. */
export const MELEE_HIT_RANGE = 2.4;
/** And roughly in front of the attacker: dot(facing, toTarget) above this. */
export const MELEE_HIT_ARC_DOT = 0.25;
/** Per landed hit. Forgiving by canon: a fumbling player in a 3-hostile scrum takes ~12-16/s
 *  standing still, so 100 health + stims survives a wave fight while still punishing tanking. */
export const MELEE_DAMAGE = 8;
/** Per-attacker recovery between swings (plus jitter so a crowd doesn't metronome). */
export const MELEE_COOLDOWN_MIN = 1.1;
export const MELEE_COOLDOWN_JITTER = 0.6;
/** Minimum gap between any two swing STARTS across the whole crowd: attacks arrive as a
 *  readable one-at-a-time cadence, not a synchronised flurry. */
export const MELEE_GLOBAL_STAGGER = 0.5;

export interface MeleeSwing { elapsed: number; hitDelivered: boolean; }

export const beginSwing = (): MeleeSwing => ({ elapsed: 0, hitDelivered: false });

/** Advance a swing. `hit` is true exactly once, the step the fist crosses full extension;
 *  `done` once the full clip has played out. */
export function advanceSwing(swing: MeleeSwing, dt: number): { hit: boolean; done: boolean } {
  swing.elapsed += dt;
  const hit = !swing.hitDelivered && swing.elapsed >= MELEE_HIT_AT;
  if (hit) swing.hitDelivered = true;
  return { hit, done: swing.elapsed >= MELEE_SWING_SECONDS };
}

/** Range + arc gate applied at the hit frame — the only place melee damage is ever decided. */
export function meleeHitLands(distance: number, facingDot: number): boolean {
  return distance < MELEE_HIT_RANGE && facingDot > MELEE_HIT_ARC_DOT;
}

/** Code-driven punch pose, layered over a stable base clip and scaled by swingExtension. The
 *  shipped punch clips (NPC and player alike) were retargeted with the swing axis reversed —
 *  the fist travels BEHIND the body at "extension", which on screen reads as a shoulder hunch —
 *  so until the assets are re-exported, the visible punch is authored here. */
export const PUNCH_POSE = {
  chestTwist: 0.3,  // shoulders rotate in behind the strike (sign flips for a left-hand punch)
  lean: 0.14,       // body weight commits forward
  rise: 0.16,       // the fist's upward bias: a chest-height cross, not a horizontal prod
} as const;

const PUNCH_V1 = new THREE.Vector3(); const PUNCH_V2 = new THREE.Vector3(); const PUNCH_V3 = new THREE.Vector3();
const PUNCH_Q1 = new THREE.Quaternion(); const PUNCH_Q2 = new THREE.Quaternion();
const PUNCH_IDENTITY = new THREE.Quaternion();

/** Swing the whole arm so the shoulder→fist ray points along the character's world forward,
 *  blended by `extension`. Both retargeted rigs have skewed bone axes where no authored euler
 *  offset reliably reads as a punch (measured: ±1 rad on the arm's x moves the fist <0.2u), so
 *  the correction is computed in world space and converted through the live parent chain —
 *  the WeaponGrip/ragdoll derive-the-frame pattern. Elbow bend is preserved: the arm rotates
 *  rigidly, so a guard-bent arm uncoils into a cross as the guard offsets fade with the swing. */
export function drivePunchArm(root: THREE.Object3D, upper: THREE.Object3D, hand: THREE.Object3D, extension: number): void {
  if (extension <= 0) return;
  upper.updateWorldMatrix(true, false); hand.updateWorldMatrix(true, false);
  const shoulder = upper.getWorldPosition(PUNCH_V1);
  const fist = hand.getWorldPosition(PUNCH_V2);
  const current = fist.sub(shoulder);
  if (current.lengthSq() < 1e-8) return;
  const desired = root.getWorldDirection(PUNCH_V3); // character forward: the NPC/player contract's +Z
  desired.y += PUNCH_POSE.rise;
  PUNCH_Q1.setFromUnitVectors(current.normalize(), desired.normalize());
  PUNCH_Q2.slerpQuaternions(PUNCH_IDENTITY, PUNCH_Q1, Math.min(1, extension));
  upper.getWorldQuaternion(PUNCH_Q1);
  PUNCH_Q2.multiply(PUNCH_Q1); // desired world orientation of the upper arm
  const parent = upper.parent;
  if (parent) { parent.getWorldQuaternion(PUNCH_Q1); upper.quaternion.copy(PUNCH_Q1.invert().multiply(PUNCH_Q2)); }
}

/** Arm extension over the swing: 0 → 1 at the hit frame → 0 at the end. Drives the
 *  procedural-fallback jab and the additive punch pose on rigged characters. */
export function swingExtension(elapsed: number): number {
  if (elapsed <= 0 || elapsed >= MELEE_SWING_SECONDS) return 0;
  if (elapsed <= MELEE_HIT_AT) return Math.sin(elapsed / MELEE_HIT_AT * Math.PI / 2);
  return Math.cos((elapsed - MELEE_HIT_AT) / (MELEE_SWING_SECONDS - MELEE_HIT_AT) * Math.PI / 2);
}
