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
/** Fists reach this far vertically, no further: a target on a roof/ledge above (or below) this
 *  gap can be pursued and glowered at, but never swung at and never hit — no punching through
 *  floors. Applies identically to the player's own punch. */
export const MELEE_HEIGHT_REACH = 2.0;
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

/** Range + height + arc gate applied at the hit frame — the only place melee damage is ever
 *  decided. `distance` is horizontal; the height gap is gated separately so a rooftop target
 *  directly overhead (tiny horizontal distance, large Δy) can never be hit through the floor. */
export function meleeHitLands(distance: number, heightGap: number, facingDot: number): boolean {
  return distance < MELEE_HIT_RANGE && Math.abs(heightGap) <= MELEE_HEIGHT_REACH && facingDot > MELEE_HIT_ARC_DOT;
}

/** Code-driven punch pose, layered over a stable base clip and scaled by swingExtension. The
 *  shipped punch clips (NPC and player alike) were retargeted with the swing axis reversed —
 *  the fist travels BEHIND the body at "extension", which on screen reads as a shoulder hunch —
 *  so until the assets are re-exported, the visible punch is authored here. */
export const PUNCH_POSE = {
  chestTwist: 0.3,  // shoulders rotate in behind the strike (sign flips for a left-hand punch)
  lean: 0.14,       // body weight commits forward
  rise: 0.14,       // extension point's upward bias: fist lands at face height, not a horizontal prod
  wristTwist: 1.25, // roll the hand palm-inward (thumb up): side-on the open palm reads as a fist
} as const;

/** Jab shape. CHAMBER (first 30% of the windup): fist coils in by the ribs, elbow folded hard.
 *  DRIVE: the fist travels a straight line from the chamber to full extension on the facing ray,
 *  eased quadratically so the elbow stays bent until late and snaps straight over the last third.
 *  RETRACT (after the hit frame): a fast blend back to the guard base. */
const CHAMBER_END = 0.3;          // fraction of the windup spent coiling
const CHAMBER_FORWARD = 0.06;     // chamber point relative to the shoulder…
const CHAMBER_SIDE = 0.08;        // …slightly outside it…
const CHAMBER_DOWN = 0.26;        // …down by the ribs
const EXTEND_REACH = 0.97;        // fraction of full arm length at extension (never IK-locked straight)
const BLEND_IN = 0.18;            // fraction of the windup to fade the pose in (guard → chamber snap)
const RETRACT_RATE = 1.4;         // >1: back to guard before the recover window fully ends

const PUNCH_V6 = new THREE.Vector3(); const PUNCH_V7 = new THREE.Vector3(); // rotateBoneWorld-private scratch
const PUNCH_Q1 = new THREE.Quaternion(); const PUNCH_Q2 = new THREE.Quaternion();
const PUNCH_IDENTITY = new THREE.Quaternion();

/** Rotate `bone` (about its own origin, in world space) so `from`→`to` directions align, blended
 *  by `weight`, converted through the live parent chain — the WeaponGrip/ragdoll derive-the-frame
 *  pattern. Both retargeted rigs have skewed bone axes where authored euler offsets are useless
 *  (measured: ±1 rad on an arm's x moves the fist <0.2u), so ALL pose math here is world-space. */
function rotateBoneWorld(bone: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, weight: number): void {
  if (from.lengthSq() < 1e-8 || to.lengthSq() < 1e-8) return;
  PUNCH_Q1.setFromUnitVectors(PUNCH_V6.copy(from).normalize(), PUNCH_V7.copy(to).normalize());
  PUNCH_Q2.slerpQuaternions(PUNCH_IDENTITY, PUNCH_Q1, weight);
  bone.getWorldQuaternion(PUNCH_Q1);
  PUNCH_Q2.multiply(PUNCH_Q1);
  const parent = bone.parent;
  if (parent) { parent.getWorldQuaternion(PUNCH_Q1); bone.quaternion.copy(PUNCH_Q1.invert().multiply(PUNCH_Q2)); }
}

const JAB_SHOULDER = new THREE.Vector3(); const JAB_FWD = new THREE.Vector3(); const JAB_SIDE = new THREE.Vector3();
const JAB_TARGET = new THREE.Vector3(); const JAB_DIR = new THREE.Vector3(); const JAB_POLE = new THREE.Vector3();
const JAB_A = new THREE.Vector3(); const JAB_B = new THREE.Vector3(); const JAB_C = new THREE.Vector3(); const JAB_D = new THREE.Vector3();

/** Pose one arm as a boxing jab at `elapsed` seconds into the swing: two-bone IK (upper arm +
 *  elbow, law of cosines, pole down-and-slightly-out) placing the fist on the straight
 *  chamber→extension line, plus a palm-inward wrist roll. `mirror` is +1 for the right arm,
 *  -1 for the left. Full extension coincides exactly with MELEE_HIT_AT, the damage frame. */
export function drivePunchArm(root: THREE.Object3D, upper: THREE.Object3D, lower: THREE.Object3D, hand: THREE.Object3D, elapsed: number, mirror = 1): void {
  if (elapsed <= 0 || elapsed >= MELEE_SWING_SECONDS) return;
  const windup = Math.min(1, elapsed / MELEE_HIT_AT);
  const retract = elapsed <= MELEE_HIT_AT ? 0 : (elapsed - MELEE_HIT_AT) / (MELEE_SWING_SECONDS - MELEE_HIT_AT);
  const weight = Math.min(1, windup / BLEND_IN) * Math.max(0, 1 - retract * RETRACT_RATE);
  if (weight <= 0) return;
  upper.updateWorldMatrix(true, false); lower.updateWorldMatrix(true, false); hand.updateWorldMatrix(true, false);
  const shoulder = JAB_SHOULDER.setFromMatrixPosition(upper.matrixWorld);
  const upperLength = JAB_A.setFromMatrixPosition(lower.matrixWorld).distanceTo(shoulder);
  const lowerLength = JAB_B.setFromMatrixPosition(hand.matrixWorld).distanceTo(JAB_A);
  if (upperLength < 1e-4 || lowerLength < 1e-4) return;
  const forward = root.getWorldDirection(JAB_FWD);
  const side = JAB_SIDE.set(forward.z, 0, -forward.x).multiplyScalar(mirror); // forward × up: the punching arm's own side of the body
  // Fist waypoint on the straight jab line: chamber by the ribs → extension at face height on
  // the facing ray. The quadratic ease keeps the fist (and so the elbow) coiled until late,
  // covering half the distance in the last third of the drive — the snap.
  const drive = windup <= CHAMBER_END ? 0 : ((windup - CHAMBER_END) / (1 - CHAMBER_END)) ** 2;
  const reach = (upperLength + lowerLength) * EXTEND_REACH;
  const target = JAB_TARGET.copy(shoulder)
    .addScaledVector(forward, CHAMBER_FORWARD + (reach - CHAMBER_FORWARD) * drive)
    .addScaledVector(side, CHAMBER_SIDE * (1 - drive));
  target.y += -CHAMBER_DOWN + (CHAMBER_DOWN + reach * PUNCH_POSE.rise) * drive;
  // Two-bone IK: clamp the span, solve the upper-arm angle, bend the elbow toward the pole.
  const span = THREE.MathUtils.clamp(shoulder.distanceTo(target), Math.abs(upperLength - lowerLength) + 0.01, upperLength + lowerLength - 0.005);
  const dir = JAB_DIR.copy(target).sub(shoulder).normalize();
  const cosUpper = THREE.MathUtils.clamp((upperLength * upperLength + span * span - lowerLength * lowerLength) / (2 * upperLength * span), -1, 1);
  const pole = JAB_POLE.copy(side).multiplyScalar(0.4).addScaledVector(forward, -0.1); pole.y -= 0.9; // elbow hangs down, slightly out — a jab, not a chicken wing
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-6) { pole.set(0, -1, 0); pole.addScaledVector(dir, -pole.dot(dir)); }
  pole.normalize();
  const elbowTarget = JAB_A.copy(shoulder).addScaledVector(dir, upperLength * cosUpper).addScaledVector(pole, upperLength * Math.sqrt(Math.max(0, 1 - cosUpper * cosUpper)));
  const elbowNow = JAB_B.setFromMatrixPosition(lower.matrixWorld);
  rotateBoneWorld(upper, JAB_C.copy(elbowNow).sub(shoulder), JAB_D.copy(elbowTarget).sub(shoulder), weight);
  // The upper arm moved: refresh the chain, then swing the forearm onto the fist target.
  lower.updateWorldMatrix(true, false); hand.updateWorldMatrix(true, false);
  const elbowAfter = JAB_A.setFromMatrixPosition(lower.matrixWorld);
  const fistAfter = JAB_B.setFromMatrixPosition(hand.matrixWorld);
  const fistTarget = JAB_C.copy(shoulder).addScaledVector(dir, span);
  rotateBoneWorld(lower, JAB_B.copy(fistAfter).sub(elbowAfter), JAB_D.copy(fistTarget).sub(elbowAfter), weight);
  // Palm-inward wrist roll about the forearm axis: side-on, the open palm reads as a fist.
  hand.updateWorldMatrix(true, false);
  const axis = JAB_D.setFromMatrixPosition(hand.matrixWorld).sub(elbowAfter);
  if (axis.lengthSq() > 1e-8) {
    axis.normalize();
    PUNCH_Q1.setFromAxisAngle(axis, PUNCH_POSE.wristTwist * mirror * weight);
    hand.getWorldQuaternion(PUNCH_Q2);
    PUNCH_Q1.multiply(PUNCH_Q2);
    const parent = hand.parent;
    if (parent) { parent.getWorldQuaternion(PUNCH_Q2); hand.quaternion.copy(PUNCH_Q2.invert().multiply(PUNCH_Q1)); }
  }
}

/** Arm extension over the swing: 0 → 1 at the hit frame → 0 at the end. Drives the
 *  procedural-fallback jab and the additive punch pose on rigged characters. */
export function swingExtension(elapsed: number): number {
  if (elapsed <= 0 || elapsed >= MELEE_SWING_SECONDS) return 0;
  if (elapsed <= MELEE_HIT_AT) return Math.sin(elapsed / MELEE_HIT_AT * Math.PI / 2);
  return Math.cos((elapsed - MELEE_HIT_AT) / (MELEE_SWING_SECONDS - MELEE_HIT_AT) * Math.PI / 2);
}
