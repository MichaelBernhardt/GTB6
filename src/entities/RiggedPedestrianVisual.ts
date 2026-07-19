import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { findHumanoidBones, type HumanoidBones } from './RiggedPlayerVisual';
import { NPC_CATALOG, type NpcCharacterId } from './NpcCatalog';
import type { RagdollEnvironment, VerletRagdoll } from './PedRagdoll';
import { RagdollDriver } from './RagdollDriver';
import { drivePunchArm, PUNCH_POSE, swingExtension } from '../systems/MeleeSystem';
import type { PedState } from './Pedestrian';

export const NPC_ANIMATIONS = ['idle', 'walk', 'sprint', 'punch_right', 'death'] as const;
export type NpcAnimationName = typeof NPC_ANIMATIONS[number];
export type NpcLoadStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'disposed';

export interface RiggedPedestrianState {
  state: PedState;
  /** Health-depleted down (a corpse) as opposed to a knockdown survivor about to rise. */
  dead: boolean;
  /** Floored by a physical impact (sprint bump, vehicle): always ragdolls, whatever the death-style
   *  draw; survivors hand back to animation when the down timer expires and they rise. */
  knockdown: boolean;
  punching: boolean;
  /** Seconds into the current swing; drives the additive punch pose (the shipped punch clip is
   *  retired — its retarget swings the fist backwards and reads as a shoulder hunch). */
  punchElapsed: number;
  /** Squared up at melee range: standing guard, not running — sprint-in-place reads as broken. */
  braced: boolean;
  hailing: boolean;
  covering: boolean;
  stumbling: boolean;
  stumbleAmount: number;
}

export const selectNpcAnimation = (state: RiggedPedestrianState): NpcAnimationName => {
  if (state.state === 'down') return 'death';
  // Punching and braced both sit on the stable idle base: the punch itself is the additive pose
  // (the shipped punch_right clip retargeted the swing BACKWARDS — fist behind the body at
  // "extension" — so playing it reads as a shoulder hunch, never a punch).
  if (state.punching || state.braced) return 'idle';
  if (state.state === 'flee' || state.state === 'hostile') return 'sprint';
  if (state.state === 'walk') return 'walk';
  return 'idle';
};

export class NpcCharacterError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'NpcCharacterError'; }
}

export interface ValidatedNpcGltf {
  clips: ReadonlyMap<NpcAnimationName, THREE.AnimationClip>;
}

export function validateNpcGltf(gltf: GLTF, expectedId?: NpcCharacterId): ValidatedNpcGltf {
  let root = expectedId ? gltf.scene.getObjectByName(`Npc_${expectedId}`) : undefined;
  if (!root) gltf.scene.traverse((object) => { if (!root && object.name.startsWith('Npc_')) root = object; });
  const contract = root?.userData.npcContract as Record<string, unknown> | undefined;
  if (contract?.version !== 1 || contract.forwardAxis !== '+Z' || contract.feetAtOrigin !== true || contract.fps !== 30 || (expectedId && contract.characterId !== expectedId)) {
    throw new NpcCharacterError('NPC metadata is missing or invalid.');
  }
  if (!findHumanoidBones(gltf.scene)) throw new NpcCharacterError('NPC is missing one or more required humanoid bones.');
  const names = gltf.animations.map((clip) => clip.name);
  if (names.length !== NPC_ANIMATIONS.length || new Set(names).size !== NPC_ANIMATIONS.length || NPC_ANIMATIONS.some((name) => !names.includes(name))) {
    throw new NpcCharacterError('NPC animation set does not exactly match the required five clips.');
  }
  let triangles = 0; let skinned = 0; const materials = new Set<THREE.Material>();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (!(object instanceof THREE.SkinnedMesh)) throw new NpcCharacterError(`Unskinned NPC mesh: ${object.name || '(unnamed)'}.`);
    skinned += 1; triangles += (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3;
    const joints = object.geometry.getAttribute('skinIndex'); const weights = object.geometry.getAttribute('skinWeight');
    if (!joints || !weights || joints.itemSize !== 4 || weights.itemSize !== 4) throw new NpcCharacterError(`${object.name} does not use four-influence skin attributes.`);
    for (let vertex = 0; vertex < weights.count; vertex++) {
      const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
      if (Math.abs(sum - 1) > 0.001) throw new NpcCharacterError(`${object.name} has unnormalised bone weights.`);
    }
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  if (triangles < 12_000 || triangles > 30_000) throw new NpcCharacterError(`NPC has ${triangles} triangles; expected 12–30k.`);
  if (skinned < 1 || skinned > 5 || materials.size > 5) throw new NpcCharacterError('NPC exceeds the five-material skinned-mesh limit.');
  for (const material of materials) {
    if (material.transparent || material.alphaTest > 0) throw new NpcCharacterError(`${material.name} must be opaque.`);
    const map = (material as THREE.MeshStandardMaterial).map; const image = map?.image as { width?: number; height?: number } | undefined;
    if (!image || image.width !== 1024 || image.height !== 1024) throw new NpcCharacterError(`${material.name} must use a 1024×1024 base-colour map.`);
  }
  const box = new THREE.Box3().setFromObject(gltf.scene); const height = box.max.y - box.min.y;
  const expectedHeight = Number(contract.heightMetres);
  if (!Number.isFinite(expectedHeight) || Math.abs(height - expectedHeight) > 0.02 || Math.abs(box.min.y) > 0.02) throw new NpcCharacterError(`NPC scale/origin is invalid (${height.toFixed(3)} m high, feet y=${box.min.y.toFixed(3)}).`);
  // Locomotion clips may carry a zero-mean pelvis bob/sway on the Hips bone;
  // any other translation track would fight the code-driven root motion.
  for (const clip of gltf.animations) if (clip.tracks.some((track) => track.name.endsWith('.position') && !track.name.startsWith('Hips.'))) throw new NpcCharacterError(`${clip.name} contains root translation.`);
  return { clips: new Map(NPC_ANIMATIONS.map((name) => [name, gltf.animations.find((clip) => clip.name === name)!])) };
}

interface NpcTemplate { gltf: GLTF; validated: ValidatedNpcGltf; deathFloor: DeathFloorCurve; }
const templateCache = new Map<string, Promise<NpcTemplate>>();

export const DEATH_FLOOR_SAMPLE_STEP = 0.1;
export interface DeathFloorCurve { step: number; floors: number[]; }

export const DEATH_EXTRA_SINK = 0.2; // owner call: corpses aren't limp, so stiff limbs read as floating — bury the body slightly (pose deaths; ragdolls rest by physics)
export const RAGDOLL_DEATH_CHANCE = 0.9; // owner call: 90% ragdoll, 10% mocap pose ("pose might be eliminated entirely later")
export const MAX_ACTIVE_RAGDOLLS = 8; // dying peds beyond this freeze the oldest ragdoll first

/** Only actively-simulating ragdolls; frozen corpses leave the list and cost nothing. */
const activeRagdolls: RiggedPedestrianVisual[] = [];
export function activeRagdollCount(): number { return activeRagdolls.length; }
const unregisterRagdoll = (visual: RiggedPedestrianVisual): void => {
  const index = activeRagdolls.indexOf(visual); if (index >= 0) activeRagdolls.splice(index, 1);
};
/** Test isolation only: forget leftover simulating ragdolls from a previous test. */
export function resetActiveRagdolls(): void { activeRagdolls.length = 0; }

/** Floor (min skinned-vertex y, model space) of this rig's death pose, sampled across the clip.
 *  The retargeted capture keeps the hips near standing height while the body tips over, so the pose's
 *  lowest point climbs 0 → ~0.65 through the clip (varying per character) — played raw, corpses end up
 *  hovering above the road. Sinking the rig by this measured curve keeps the body in ground contact for
 *  the whole collapse and lets it settle exactly when the animation does. Posed on a throwaway clone so
 *  the cached template stays in bind pose. */
function measureDeathFloorCurve(scene: THREE.Object3D, death: THREE.AnimationClip): DeathFloorCurve {
  const posed = cloneSkeleton(scene);
  const mixer = new THREE.AnimationMixer(posed);
  const action = mixer.clipAction(death); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const floors: number[] = []; const box = new THREE.Box3();
  for (let time = 0, previous = 0; time <= death.duration + DEATH_FLOOR_SAMPLE_STEP; time += DEATH_FLOOR_SAMPLE_STEP) {
    mixer.update(time - previous); previous = time;
    posed.updateMatrixWorld(true);
    let floor = Infinity;
    posed.traverse((object) => {
      if (!(object instanceof THREE.SkinnedMesh)) return;
      object.computeBoundingBox(); // SkinnedMesh override: skinning-aware, so it reads the posed bones
      floor = Math.min(floor, box.copy(object.boundingBox!).applyMatrix4(object.matrixWorld).min.y);
    });
    floors.push(Number.isFinite(floor) ? Math.max(0, floor) : 0); // never lift the body, only ground it
  }
  return { step: DEATH_FLOOR_SAMPLE_STEP, floors };
}

export function deathFloorAt(curve: DeathFloorCurve, time: number): number {
  if (curve.floors.length === 0) return 0;
  const position = THREE.MathUtils.clamp(time / curve.step, 0, curve.floors.length - 1);
  const index = Math.floor(position); const next = Math.min(index + 1, curve.floors.length - 1);
  return THREE.MathUtils.lerp(curve.floors[index], curve.floors[next], position - index);
}

export function clearNpcTemplateCache(): void { templateCache.clear(); }
export function cachedNpcTemplateCount(): number { return templateCache.size; }

function loadTemplate(url: string, id: NpcCharacterId, load: (url: string) => Promise<GLTF>): Promise<NpcTemplate> {
  const existing = templateCache.get(url); if (existing) return existing;
  const pending = Promise.resolve().then(() => load(url)).then((gltf) => {
    const validated = validateNpcGltf(gltf, id);
    return { gltf, validated, deathFloor: measureDeathFloorCurve(gltf.scene, validated.clips.get('death')!) };
  }).catch((reason: unknown) => {
    templateCache.delete(url); throw reason;
  });
  templateCache.set(url, pending); return pending;
}

export interface RiggedPedestrianVisualOptions {
  load?: (url: string) => Promise<GLTF>;
  random?: () => number;
  onReady?: () => void;
  onFailure?: (error: NpcCharacterError) => void;
}

export class RiggedPedestrianVisual {
  readonly group = new THREE.Group();
  status: NpcLoadStatus = 'idle';
  error?: NpcCharacterError;
  private loading?: Promise<void>;
  private mixer?: THREE.AnimationMixer;
  private model?: THREE.Object3D;
  private bones?: HumanoidBones;
  private actions = new Map<NpcAnimationName, THREE.AnimationAction>();
  private mixedRotations = new Map<THREE.Bone, THREE.Quaternion>();
  private current?: THREE.AnimationAction;
  private currentName?: NpcAnimationName;
  private state: RiggedPedestrianState = { state: 'idle', dead: false, knockdown: false, punching: false, punchElapsed: 0, braced: false, hailing: false, covering: false, stumbling: false, stumbleAmount: 0 };
  private deathFloor: DeathFloorCurve = { step: DEATH_FLOOR_SAMPLE_STEP, floors: [] };
  private ragdollDeath = false;
  private ragdollJitter: number[] = [];
  private readonly ragdollDriver = new RagdollDriver();
  private ragdollGroundY = 0;
  private impactX?: number;
  private impactZ?: number;
  private impactSpeed?: number;
  /** Bare-visual fallback (unit tests / missing city): flat ground at the ped group's own height. */
  private readonly fallbackEnv: RagdollEnvironment = { heightAt: () => this.ragdollGroundY };
  private disposed = false;

  constructor(private parent: THREE.Object3D, readonly characterId: NpcCharacterId, private options: RiggedPedestrianVisualOptions = {}) {
    this.group.name = `RiggedPedestrianVisual:${characterId}`; this.group.visible = false; parent.add(this.group);
  }

  get ready(): boolean { return this.status === 'ready'; }
  get deathStyle(): 'ragdoll' | 'pose' { return this.ragdollDeath ? 'ragdoll' : 'pose'; }
  /** Live sim handle for tests; undefined until a ragdoll death starts. */
  get ragdollBody(): VerletRagdoll | undefined { return this.ragdollDriver.body; }
  get failed(): boolean { return this.status === 'failed'; }
  get activeAnimation(): NpcAnimationName | undefined { return this.currentName; }
  animationTime(name: NpcAnimationName): number | undefined { return this.actions.get(name)?.time; }

  load(): Promise<void> {
    if (this.disposed || this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    this.status = 'loading';
    const url = NPC_CATALOG[this.characterId].modelUrl;
    const loader = this.options.load ?? ((path: string) => new GLTFLoader().loadAsync(path));
    this.loading = loadTemplate(url, this.characterId, loader).then((template) => {
      if (!this.disposed) this.install(template);
    }).catch((reason: unknown) => {
      if (this.disposed) return;
      const error = reason instanceof NpcCharacterError ? reason : new NpcCharacterError(`Unable to load ${this.characterId}.`, { cause: reason });
      this.error = error; this.status = 'failed'; this.group.visible = false; this.options.onFailure?.(error); throw error;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  setState(state: RiggedPedestrianState): void { this.state = { ...state }; }

  update(dt: number, env?: RagdollEnvironment): void {
    if (!this.ready || !this.mixer || !this.bones) return;
    this.group.position.set(0, 0, 0); this.group.rotation.set(0, 0, 0); this.group.scale.set(1, 1, 1);
    if (this.state.state === 'down' && (this.state.knockdown || (this.state.dead && this.ragdollDeath))) { this.updateRagdoll(Math.max(0, dt), env); return; }
    if (this.ragdollDriver.active) this.endRagdoll(); // knocked-down ped is back up: hand the bones back to the mixer
    // Restore last frame's pure mixed pose before advancing the mixer: on a static clip the mixer
    // skips rewriting unchanged bones, so additive edits (guard, punch, hail, cower) would
    // otherwise compound every frame and spiral (the player visual's proven pattern).
    this.restoreMixedPose();
    const animation = selectNpcAnimation(this.state); this.transitionTo(animation); this.setPlaybackRate(animation);
    this.mixer.update(Math.max(0, dt)); this.captureMixedPose(); this.applyAdditivePose();
  }

  private restoreMixedPose(): void {
    for (const [bone, rotation] of this.mixedRotations) bone.quaternion.copy(rotation);
  }

  private captureMixedPose(): void {
    if (!this.bones) return;
    for (const bone of Object.values(this.bones)) {
      const rotation = this.mixedRotations.get(bone);
      if (rotation) rotation.copy(bone.quaternion); else this.mixedRotations.set(bone, bone.quaternion.clone());
    }
  }

  /** The ped was felled by an impact from `direction` (world XZ, pointing away from the source):
   *  the ragdoll starts with a matching kick — `speed` scales it (bump vs car) — instead of the
   *  pose path's yaw whip. */
  primeRagdollImpact(directionX?: number, directionZ?: number, speed?: number): void {
    this.impactX = directionX; this.impactZ = directionZ; this.impactSpeed = speed;
  }

  private updateRagdoll(dt: number, env?: RagdollEnvironment): void {
    if (!this.ragdollDriver.active) this.beginRagdoll();
    const body = this.ragdollDriver.body!;
    if (body.frozen) return; // settled corpse: zero per-frame cost
    body.step(dt, env ?? this.fallbackEnv);
    this.ragdollDriver.drive();
    if (body.frozen) unregisterRagdoll(this);
  }

  /** Freeze the mixer, hand the skeleton to the shared driver, then kick the fresh body. */
  private beginRagdoll(): void {
    this.mixer!.stopAllAction(); this.current = undefined; this.currentName = undefined;
    const body = this.ragdollDriver.begin(this.group, this.bones!);
    this.ragdollGroundY = this.group.getWorldPosition(new THREE.Vector3()).y;
    // Always kick — a perfectly balanced seed pose could otherwise settle standing upright.
    this.applyImpactKick(body);
    if (activeRagdolls.length >= MAX_ACTIVE_RAGDOLLS) activeRagdolls[0]?.haltRagdoll();
    activeRagdolls.push(this);
  }

  /** Spend the primed impact (or the jittered fallback) as a kick on `body`. */
  private applyImpactKick(body: VerletRagdoll): void {
    const [r0 = 0.5, r1 = 0.5, , , , r5 = 0.5] = this.ragdollJitter;
    let kickX = this.impactX ?? 0; let kickZ = this.impactZ ?? 0;
    if (kickX * kickX + kickZ * kickZ < 1e-6) { const angle = r5 * Math.PI * 2; kickX = Math.sin(angle); kickZ = Math.cos(angle); }
    const twist = (r1 - 0.5) * 0.5; const cos = Math.cos(twist); const sin = Math.sin(twist); // ±14°: same shot, different falls
    body.kick(kickX * cos - kickZ * sin, kickX * sin + kickZ * cos, this.impactSpeed ?? (2.6 + r0 * 1.6));
    this.impactX = undefined; this.impactZ = undefined; this.impactSpeed = undefined;
  }

  /** Overkill: a fresh hit lands on a corpse — wake its ragdoll for another damage-scaled flop, same
   *  sim and settle logic. Pure spectacle: no health/state side effects, and a settled corpse SKIPS
   *  when the concurrency cap is full rather than evicting a fresh death. Pose-death corpses convert:
   *  the next update seeds a ragdoll from their settled pose (the body may pop slightly as the sink
   *  offset re-resolves — reads as the hit jolting it). */
  reviveRagdollImpact(directionX?: number, directionZ?: number, speed?: number): void {
    if (!this.ready || !this.state.dead || this.state.state !== 'down') return;
    const body = this.ragdollDriver.body;
    if (body && !body.frozen) { this.primeRagdollImpact(directionX, directionZ, speed); this.applyImpactKick(body); return; } // still tumbling: fold the impulse straight in
    if (activeRagdolls.length >= MAX_ACTIVE_RAGDOLLS) return;
    this.primeRagdollImpact(directionX, directionZ, speed);
    if (body) { body.revive(); this.applyImpactKick(body); activeRagdolls.push(this); return; }
    this.ragdollDeath = true; // pose corpse: beginRagdoll takes it from here on the next update
  }

  /** Concurrency cap: freeze this ragdoll wherever it is so a newer death can simulate. */
  private haltRagdoll(): void {
    if (this.ragdollDriver.body) this.ragdollDriver.body.frozen = true;
    unregisterRagdoll(this);
  }

  private endRagdoll(): void {
    this.ragdollDriver.end();
    unregisterRagdoll(this);
  }

  dispose(): void {
    if (this.disposed) return;
    unregisterRagdoll(this); this.ragdollDriver.release();
    this.disposed = true; this.status = 'disposed'; this.mixer?.stopAllAction();
    if (this.model && this.mixer) this.mixer.uncacheRoot(this.model);
    this.group.clear(); this.parent.remove(this.group); this.group.visible = false;
    this.actions.clear(); this.mixedRotations.clear(); this.model = undefined; this.mixer = undefined; this.bones = undefined; this.current = undefined; this.currentName = undefined;
  }

  private install(template: NpcTemplate): void {
    const model = cloneSkeleton(template.gltf.scene); const bones = findHumanoidBones(model);
    if (!bones) throw new NpcCharacterError('Cloned NPC is missing its humanoid skeleton.');
    model.name = `NpcInstance:${this.characterId}`;
    model.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
    this.model = model; this.bones = bones; this.mixer = new THREE.AnimationMixer(model); this.deathFloor = template.deathFloor;
    const random = this.options.random ?? Math.random;
    this.ragdollDeath = random() < RAGDOLL_DEATH_CHANCE;
    this.ragdollJitter = [random(), random(), random(), random(), random(), random()];
    for (const [name, clip] of template.validated.clips) {
      const action = this.mixer.clipAction(clip); action.time = random() * Math.max(0, clip.duration);
      if (name === 'punch_right' || name === 'death') { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      this.actions.set(name, action);
    }
    this.group.add(model); this.group.visible = true; this.status = 'ready'; this.transitionTo(selectNpcAnimation(this.state), 0, true); this.mixer.update(0); this.options.onReady?.();
  }

  private transitionTo(name: NpcAnimationName, fade = 0.12, preservePhase = false): void {
    const next = this.actions.get(name); if (!next || (this.current === next && this.currentName === name)) return;
    if (fade > 0) this.current?.fadeOut(fade); else this.current?.stop();
    const phase = preservePhase ? next.time : (name === 'idle' || name === 'walk' || name === 'sprint') ? (this.options.random ?? Math.random)() * Math.max(0, next.getClip().duration) : 0;
    next.reset(); next.time = phase; next.setEffectiveWeight(1).setEffectiveTimeScale(1);
    if (fade > 0) next.fadeIn(fade); next.play(); this.current = next; this.currentName = name;
  }

  private setPlaybackRate(name: NpcAnimationName): void {
    if (!this.current) return;
    if (name === 'death') {
      // The capture is a gentle 1.2s tip-over; a shot body should collapse and SLAM (owner call —
      // "faster faster"). Accelerating playback reads as gravity taking over: 2× at the hit, 7× at
      // the ground, ~0.3s total.
      const clip = this.current.getClip();
      const progress = clip.duration > 0 ? THREE.MathUtils.clamp(this.current.time / clip.duration, 0, 1) : 1;
      this.current.setEffectiveTimeScale(2 + 5 * progress);
      return;
    }
    this.current.setEffectiveTimeScale(name === 'walk' ? 0.92 : name === 'sprint' ? 1.08 : 1);
  }

  private applyAdditivePose(): void {
    const bones = this.bones; if (!bones) return;
    if (this.state.punching || this.state.braced) {
      // Guard stance over the idle base: fists half-raised, slight crouch-lean — a fighter, not a queuer.
      bones.leftUpperArm.rotation.x -= 0.55; bones.rightUpperArm.rotation.x -= 0.55;
      bones.leftLowerArm.rotation.x -= 0.85; bones.rightLowerArm.rotation.x -= 0.85;
      bones.spine.rotation.x += 0.1;
    }
    if (this.state.punching) {
      // The punch itself: shoulders twist in, weight leans forward, the guard's bent elbow
      // unbends, and the whole right arm is driven onto the ped's forward ray in world space.
      const extension = swingExtension(this.state.punchElapsed);
      bones.rightLowerArm.rotation.x += 0.85 * extension; // cancel the guard bend: the fist leads
      bones.chest.rotation.y += PUNCH_POSE.chestTwist * extension;
      bones.spine.rotation.x += PUNCH_POSE.lean * extension;
      drivePunchArm(this.parent, bones.rightUpperArm, bones.rightHand, extension);
    }
    if (this.state.state === 'cower' || this.state.covering) {
      bones.spine.rotation.x += 0.42; bones.chest.rotation.x += 0.26;
      if (this.state.state === 'cower') {
        bones.leftUpperArm.rotation.x -= 0.72; bones.rightUpperArm.rotation.x -= 0.72;
        bones.leftUpperArm.rotation.z += 0.42; bones.rightUpperArm.rotation.z -= 0.42;
      }
      bones.leftUpperLeg.rotation.x -= 0.22; bones.rightUpperLeg.rotation.x -= 0.22;
      bones.leftLowerLeg.rotation.x += 0.38; bones.rightLowerLeg.rotation.x += 0.38;
      this.group.position.y -= 0.18;
    }
    if (this.state.hailing && this.state.state === 'idle') {
      bones.rightUpperArm.rotation.x -= 0.95; bones.rightUpperArm.rotation.z -= 0.34; bones.rightLowerArm.rotation.x -= 0.28;
    }
    if (this.state.stumbling) {
      this.group.rotation.x = -0.32 * this.state.stumbleAmount;
      bones.leftUpperArm.rotation.x += 0.7 * this.state.stumbleAmount; bones.rightUpperArm.rotation.x += 0.7 * this.state.stumbleAmount;
    }
    if (this.state.state === 'down') {
      // Keep the collapsing body in ground contact: sink by the measured floor of the CURRENT death
      // pose, so the fall lands as fast as the clip plays and the corpse rests on the road, never
      // hovering (the capture tips over at standing hip height) nor clipping through mid-fall.
      // The extra sink eases in with the fall and buries the stiff pose slightly (limbs aren't limp).
      const death = this.actions.get('death'); const duration = death?.getClip().duration ?? 0;
      const progress = duration > 0 ? THREE.MathUtils.clamp((death?.time ?? 0) / duration, 0, 1) : 1;
      this.group.position.y -= deathFloorAt(this.deathFloor, death?.time ?? 0) + DEATH_EXTRA_SINK * progress;
    }
  }
}
