import * as THREE from 'three';
import type { HumanoidBone, HumanoidBones } from './RiggedPlayerVisual';
import { RAGDOLL_PARTICLES, RAGDOLL_PARTICLE_COUNT, VerletRagdoll } from './PedRagdoll';

/** Seeds a VerletRagdoll from a humanoid rig's live bone world positions and drives the skinned
 *  bones back from the particle frame each step. Shared by NPC (RiggedPedestrianVisual) and player
 *  (RiggedPlayerVisual) rigs — both are the same CMU-retargeted humanoid family with skewed local
 *  bone axes, so every orientation here is a delta against the seeded world frame (WeaponGrip's
 *  derive-the-rest-frame pattern), never raw axis math. */

const PARTICLE = RAGDOLL_PARTICLES;
/** Which bone seeds which particle (bone origins at the moment the ragdoll takes over). */
const RAGDOLL_BONE_PARTICLES: ReadonlyArray<readonly [HumanoidBone, number]> = [
  ['hips', PARTICLE.hips], ['chest', PARTICLE.chest], ['head', PARTICLE.head],
  ['leftUpperArm', PARTICLE.shoulderL], ['leftLowerArm', PARTICLE.elbowL], ['leftHand', PARTICLE.wristL],
  ['rightUpperArm', PARTICLE.shoulderR], ['rightLowerArm', PARTICLE.elbowR], ['rightHand', PARTICLE.wristR],
  ['leftUpperLeg', PARTICLE.hipL], ['leftLowerLeg', PARTICLE.kneeL], ['leftFoot', PARTICLE.ankleL],
  ['rightUpperLeg', PARTICLE.hipR], ['rightLowerLeg', PARTICLE.kneeR], ['rightFoot', PARTICLE.ankleR],
];

/** How each bone follows the particles. `frame` bones get a full two-vector basis (face-up vs
 *  face-down matters for the torso); the rest get swing-only, inheriting their twist from the seed
 *  pose. Ordered parents-first so the live parent chain is current when read. */
const RAGDOLL_DRIVE_SPECS: ReadonlyArray<{ bone: HumanoidBone; from: number; to: number; rightFrom: number; rightTo: number; frame: boolean }> = [
  { bone: 'hips', from: PARTICLE.hips, to: PARTICLE.chest, rightFrom: PARTICLE.hipL, rightTo: PARTICLE.hipR, frame: true },
  { bone: 'spine', from: PARTICLE.hips, to: PARTICLE.chest, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'chest', from: PARTICLE.chest, to: PARTICLE.head, rightFrom: PARTICLE.shoulderL, rightTo: PARTICLE.shoulderR, frame: true },
  { bone: 'head', from: PARTICLE.chest, to: PARTICLE.head, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'leftUpperArm', from: PARTICLE.shoulderL, to: PARTICLE.elbowL, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'leftLowerArm', from: PARTICLE.elbowL, to: PARTICLE.wristL, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'rightUpperArm', from: PARTICLE.shoulderR, to: PARTICLE.elbowR, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'rightLowerArm', from: PARTICLE.elbowR, to: PARTICLE.wristR, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'leftUpperLeg', from: PARTICLE.hipL, to: PARTICLE.kneeL, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'leftLowerLeg', from: PARTICLE.kneeL, to: PARTICLE.ankleL, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'rightUpperLeg', from: PARTICLE.hipR, to: PARTICLE.kneeR, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'rightLowerLeg', from: PARTICLE.kneeR, to: PARTICLE.ankleR, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'leftFoot', from: PARTICLE.ankleL, to: PARTICLE.toeL, rightFrom: -1, rightTo: -1, frame: false },
  { bone: 'rightFoot', from: PARTICLE.ankleR, to: PARTICLE.toeR, rightFrom: -1, rightTo: -1, frame: false },
];

interface RagdollDrive {
  bone: THREE.Bone; from: number; to: number; rightFrom: number; rightTo: number; frame: boolean;
  seedQuat: THREE.Quaternion;   // bone world orientation at seed time
  seedDir: THREE.Vector3;       // world particle-pair direction at seed time (swing bones)
  frameRest: THREE.Quaternion;  // inverse(seed frame) × seedQuat, precomposed (frame bones)
  undo: THREE.Quaternion;       // local rotation before the ragdoll took over (mixer handback)
}

const SEED_SCRATCH = new Float32Array(RAGDOLL_PARTICLE_COUNT * 3);
const SCRATCH_V1 = new THREE.Vector3(); const SCRATCH_V2 = new THREE.Vector3(); const SCRATCH_V3 = new THREE.Vector3();
const SCRATCH_Q1 = new THREE.Quaternion(); const SCRATCH_Q2 = new THREE.Quaternion();
const SCRATCH_M1 = new THREE.Matrix4();

/** Orientation of the orthonormalised (right, up) particle frame; false when the vectors are too
 *  short or parallel to define one (the caller then just keeps the bone's last orientation). */
function particleFrameQuaternion(rightX: number, rightY: number, rightZ: number, upX: number, upY: number, upZ: number, out: THREE.Quaternion): boolean {
  SCRATCH_V1.set(rightX, rightY, rightZ); SCRATCH_V2.set(upX, upY, upZ);
  if (SCRATCH_V1.lengthSq() < 1e-8 || SCRATCH_V2.lengthSq() < 1e-8) return false;
  SCRATCH_V1.normalize(); SCRATCH_V3.crossVectors(SCRATCH_V1, SCRATCH_V2);
  if (SCRATCH_V3.lengthSq() < 1e-8) return false;
  SCRATCH_V3.normalize(); SCRATCH_V2.crossVectors(SCRATCH_V3, SCRATCH_V1);
  out.setFromRotationMatrix(SCRATCH_M1.makeBasis(SCRATCH_V1, SCRATCH_V2, SCRATCH_V3));
  return true;
}

export class RagdollDriver {
  body?: VerletRagdoll;
  private drives?: RagdollDrive[];
  private group?: THREE.Object3D;
  private bones?: HumanoidBones;
  private readonly groupQuat = new THREE.Quaternion();
  private readonly hipsParentInverse = new THREE.Matrix4();
  private readonly hipsUndoPos = new THREE.Vector3();

  get active(): boolean { return Boolean(this.body); }

  /** Seed the Verlet body from the rig's bone world positions (inheriting the current pose) and
   *  record each driven bone's world frame so drive() can rotate the shipped rest orientations by
   *  particle-frame deltas. The caller must stop its mixer first. */
  begin(group: THREE.Object3D, bones: HumanoidBones): VerletRagdoll {
    this.group = group; this.bones = bones;
    group.updateWorldMatrix(true, true);
    group.getWorldQuaternion(this.groupQuat);
    for (const [name, particle] of RAGDOLL_BONE_PARTICLES) {
      bones[name].getWorldPosition(SCRATCH_V1);
      SEED_SCRATCH[particle * 3] = SCRATCH_V1.x; SEED_SCRATCH[particle * 3 + 1] = SCRATCH_V1.y; SEED_SCRATCH[particle * 3 + 2] = SCRATCH_V1.z;
    }
    // Toe particles sit at the ball-of-foot so the whole foot rests on the road (the retarget keeps
    // ball_l/ball_r); if a rig drops them, fall back to a nominal foot-length ahead of the ankle.
    for (const [foot, ballName, particle] of [[bones.leftFoot, 'ball_l', PARTICLE.toeL], [bones.rightFoot, 'ball_r', PARTICLE.toeR]] as const) {
      const ball = foot.getObjectByName(ballName);
      if (ball) ball.getWorldPosition(SCRATCH_V1);
      else foot.getWorldPosition(SCRATCH_V1).add(SCRATCH_V2.set(0, 0, 0.14).applyQuaternion(this.groupQuat));
      SEED_SCRATCH[particle * 3] = SCRATCH_V1.x; SEED_SCRATCH[particle * 3 + 1] = SCRATCH_V1.y; SEED_SCRATCH[particle * 3 + 2] = SCRATCH_V1.z;
    }
    this.body = new VerletRagdoll(SEED_SCRATCH);
    this.hipsParentInverse.copy((bones.hips.parent ?? group).matrixWorld).invert();
    this.hipsUndoPos.copy(bones.hips.position);
    this.drives = RAGDOLL_DRIVE_SPECS.map((spec) => {
      const bone = bones[spec.bone];
      const drive: RagdollDrive = {
        bone, from: spec.from, to: spec.to, rightFrom: spec.rightFrom, rightTo: spec.rightTo, frame: spec.frame,
        seedQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
        seedDir: new THREE.Vector3(
          SEED_SCRATCH[spec.to * 3] - SEED_SCRATCH[spec.from * 3],
          SEED_SCRATCH[spec.to * 3 + 1] - SEED_SCRATCH[spec.from * 3 + 1],
          SEED_SCRATCH[spec.to * 3 + 2] - SEED_SCRATCH[spec.from * 3 + 2],
        ),
        frameRest: new THREE.Quaternion(), undo: bone.quaternion.clone(),
      };
      if (drive.seedDir.lengthSq() < 1e-8) drive.seedDir.set(0, 1, 0); else drive.seedDir.normalize();
      if (spec.frame && particleFrameQuaternion(
        SEED_SCRATCH[spec.rightTo * 3] - SEED_SCRATCH[spec.rightFrom * 3],
        SEED_SCRATCH[spec.rightTo * 3 + 1] - SEED_SCRATCH[spec.rightFrom * 3 + 1],
        SEED_SCRATCH[spec.rightTo * 3 + 2] - SEED_SCRATCH[spec.rightFrom * 3 + 2],
        drive.seedDir.x, drive.seedDir.y, drive.seedDir.z, SCRATCH_Q1,
      )) drive.frameRest.copy(SCRATCH_Q1).invert().multiply(drive.seedQuat);
      else if (spec.frame) drive.frame = false; // degenerate seed frame: fall back to swing
      return drive;
    });
    return this.body;
  }

  /** Pose the skeleton from the particles: each driven bone's world orientation is its seeded
   *  orientation rotated by the delta between its seed and current particle frame, converted to a
   *  local rotation through the live parent chain (parents are driven first). */
  drive(): void {
    const drives = this.drives; const body = this.body; const bones = this.bones;
    if (!drives || !body || !bones || !this.group) return;
    const p = body.positions;
    for (const drive of drives) {
      const dirX = p[drive.to * 3] - p[drive.from * 3];
      const dirY = p[drive.to * 3 + 1] - p[drive.from * 3 + 1];
      const dirZ = p[drive.to * 3 + 2] - p[drive.from * 3 + 2];
      if (drive.frame) {
        if (!particleFrameQuaternion(
          p[drive.rightTo * 3] - p[drive.rightFrom * 3],
          p[drive.rightTo * 3 + 1] - p[drive.rightFrom * 3 + 1],
          p[drive.rightTo * 3 + 2] - p[drive.rightFrom * 3 + 2],
          dirX, dirY, dirZ, SCRATCH_Q1,
        )) continue;
        SCRATCH_Q1.multiply(drive.frameRest); // desired world orientation
      } else {
        SCRATCH_V1.set(dirX, dirY, dirZ);
        if (SCRATCH_V1.lengthSq() < 1e-8) continue;
        SCRATCH_Q1.setFromUnitVectors(drive.seedDir, SCRATCH_V1.normalize()).multiply(drive.seedQuat);
      }
      SCRATCH_Q2.set(0, 0, 0, 1);
      for (let node: THREE.Object3D | null = drive.bone.parent; node && node !== this.group; node = node.parent) SCRATCH_Q2.premultiply(node.quaternion);
      SCRATCH_Q2.premultiply(this.groupQuat);
      drive.bone.quaternion.copy(SCRATCH_Q2.invert().multiply(SCRATCH_Q1));
    }
    SCRATCH_V1.set(p[PARTICLE.hips * 3], p[PARTICLE.hips * 3 + 1], p[PARTICLE.hips * 3 + 2]).applyMatrix4(this.hipsParentInverse);
    bones.hips.position.copy(SCRATCH_V1);
  }

  /** World XZ of the hips particle — where the body actually lies (a knockdown survivor should
   *  stand up here, not back at the impact point). False while no ragdoll is live. */
  hipsPosition(out: THREE.Vector3): boolean {
    const body = this.body; if (!body) return false;
    out.set(body.positions[PARTICLE.hips * 3], body.positions[PARTICLE.hips * 3 + 1], body.positions[PARTICLE.hips * 3 + 2]);
    return true;
  }

  /** Hand the bones back to the mixer: restore every driven bone's pre-ragdoll local pose. */
  end(): void {
    if (this.drives && this.bones) {
      for (const drive of this.drives) drive.bone.quaternion.copy(drive.undo);
      this.bones.hips.position.copy(this.hipsUndoPos);
    }
    this.body = undefined; this.drives = undefined; this.group = undefined; this.bones = undefined;
  }

  /** Drop all state without touching the bones (dispose path: the model is going away anyway). */
  release(): void { this.body = undefined; this.drives = undefined; this.group = undefined; this.bones = undefined; }
}
