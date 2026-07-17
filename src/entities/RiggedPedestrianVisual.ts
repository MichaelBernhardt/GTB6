import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { findHumanoidBones, type HumanoidBones } from './RiggedPlayerVisual';
import { NPC_CATALOG, type NpcCharacterId } from './NpcCatalog';
import type { PedState } from './Pedestrian';

export const NPC_ANIMATIONS = ['idle', 'walk', 'sprint', 'punch_right', 'death'] as const;
export type NpcAnimationName = typeof NPC_ANIMATIONS[number];
export type NpcLoadStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'disposed';

export interface RiggedPedestrianState {
  state: PedState;
  punching: boolean;
  hailing: boolean;
  covering: boolean;
  stumbling: boolean;
  stumbleAmount: number;
}

export const selectNpcAnimation = (state: RiggedPedestrianState): NpcAnimationName => {
  if (state.state === 'down') return 'death';
  if (state.punching) return 'punch_right';
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

export const DEATH_EXTRA_SINK = 0.2; // owner call: corpses aren't limp, so stiff limbs read as floating — bury the body slightly
export const HEAP_DEATH_CHANCE = 0.5; // owner call: half the cast dies in a procedural crumple instead of the mocap pose
const HEAP_DURATION = 0.3; // seconds for the crumple — a body dropping, not a bow
const HEAP_BONE_NAMES = ['spine', 'chest', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'] as const;

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
  private current?: THREE.AnimationAction;
  private currentName?: NpcAnimationName;
  private state: RiggedPedestrianState = { state: 'idle', punching: false, hailing: false, covering: false, stumbling: false, stumbleAmount: 0 };
  private deathFloor: DeathFloorCurve = { step: DEATH_FLOOR_SAMPLE_STEP, floors: [] };
  private heapDeath = false;
  private heapJitter: number[] = [];
  private heapU = -1; // <0: not collapsing
  private heapBase?: Map<THREE.Bone, THREE.Euler>;
  private disposed = false;

  constructor(private parent: THREE.Object3D, readonly characterId: NpcCharacterId, private options: RiggedPedestrianVisualOptions = {}) {
    this.group.name = `RiggedPedestrianVisual:${characterId}`; this.group.visible = false; parent.add(this.group);
  }

  get ready(): boolean { return this.status === 'ready'; }
  get deathStyle(): 'heap' | 'pose' { return this.heapDeath ? 'heap' : 'pose'; }
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

  update(dt: number): void {
    if (!this.ready || !this.mixer || !this.bones) return;
    this.group.position.set(0, 0, 0); this.group.rotation.set(0, 0, 0); this.group.scale.set(1, 1, 1);
    if (this.state.state === 'down' && this.heapDeath) { this.collapseHeap(Math.max(0, dt)); return; }
    if (this.heapU >= 0) this.endHeap(); // knocked-down ped is back up: hand the bones back to the mixer
    const animation = selectNpcAnimation(this.state); this.transitionTo(animation); this.setPlaybackRate(animation);
    this.mixer.update(Math.max(0, dt)); this.applyAdditivePose();
  }

  /** Ragdoll-flavoured death: the mixer is frozen where the ped was hit and the body crumples
   *  procedurally — legs fold under, torso and head slump with per-ped jitter, the root drops and tips
   *  into a heap. Accelerating (u²) so it reads as gravity, not a bow. */
  private collapseHeap(dt: number): void {
    const bones = this.bones!;
    if (this.heapU < 0) {
      this.mixer!.stopAllAction(); this.current = undefined; this.currentName = undefined;
      this.heapBase = new Map(HEAP_BONE_NAMES.map((name) => [bones[name], bones[name].rotation.clone()]));
      this.heapU = 0;
    }
    this.heapU = Math.min(1, this.heapU + dt / HEAP_DURATION);
    const u = this.heapU * this.heapU;
    const [r0 = 0.5, r1 = 0.5, r2 = 0.5, r3 = 0.5, r4 = 0.5, r5 = 0.5] = this.heapJitter;
    for (const [bone, base] of this.heapBase!) bone.rotation.copy(base);
    bones.leftUpperLeg.rotation.x -= (1.7 + r0 * 0.5) * u; bones.rightUpperLeg.rotation.x -= (1.5 + r1 * 0.6) * u;
    bones.leftLowerLeg.rotation.x += (2.0 + r1 * 0.5) * u; bones.rightLowerLeg.rotation.x += (2.1 + r0 * 0.5) * u;
    bones.spine.rotation.x += (0.8 + r2 * 0.4) * u; bones.spine.rotation.y += (r3 - 0.5) * 0.8 * u;
    bones.chest.rotation.x += (0.55 + r3 * 0.3) * u;
    bones.head.rotation.x += (0.5 + r4 * 0.4) * u; bones.head.rotation.z += (r4 - 0.5) * 0.7 * u;
    bones.leftUpperArm.rotation.x -= (0.2 + r5 * 0.6) * u; bones.rightUpperArm.rotation.x -= (0.2 + r2 * 0.6) * u;
    bones.leftUpperArm.rotation.z += (0.5 + r3 * 0.4) * u; bones.rightUpperArm.rotation.z -= (0.5 + r4 * 0.4) * u;
    bones.leftLowerArm.rotation.x -= r2 * 0.7 * u; bones.rightLowerArm.rotation.x -= r5 * 0.7 * u;
    const side = r5 < 0.5 ? -1 : 1;
    this.group.rotation.z = side * (0.9 + r0 * 0.5) * u; // tips over sideways into the heap
    this.group.rotation.x = (r1 - 0.5) * 0.6 * u;
    // Ground the evolving heap: pin the measured floor of the CURRENT crumple pose just under the
    // road (the deliberate sink eases in with the fall). Measuring beats any parametric drop — the
    // folding limbs sweep unpredictably, and this window only lasts HEAP_DURATION per death.
    this.group.position.y = -DEATH_EXTRA_SINK * u - this.heapFloor();
  }

  /** Min skinned-vertex y of the current pose in the visual group's frame (rotation included,
   *  translation excluded) — computed from local chains so a ped standing anywhere in the world
   *  measures identically. */
  private heapFloor(): number {
    const model = this.model!; model.updateMatrixWorld(true);
    let floor = Infinity; const box = new THREE.Box3(); const matrix = new THREE.Matrix4(); const rotation = new THREE.Matrix4().makeRotationFromEuler(this.group.rotation);
    model.traverse((object) => {
      if (!(object instanceof THREE.SkinnedMesh)) return;
      object.computeBoundingBox(); // skinning-aware
      matrix.identity();
      for (let node: THREE.Object3D | null = object; node && node !== this.group; node = node.parent) matrix.premultiply(node.matrix);
      floor = Math.min(floor, box.copy(object.boundingBox!).applyMatrix4(matrix.premultiply(rotation)).min.y);
    });
    return Number.isFinite(floor) ? floor : 0;
  }

  private endHeap(): void {
    if (this.heapBase) for (const [bone, base] of this.heapBase) bone.rotation.copy(base);
    this.heapBase = undefined; this.heapU = -1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.status = 'disposed'; this.mixer?.stopAllAction();
    if (this.model && this.mixer) this.mixer.uncacheRoot(this.model);
    this.group.clear(); this.parent.remove(this.group); this.group.visible = false;
    this.actions.clear(); this.model = undefined; this.mixer = undefined; this.bones = undefined; this.current = undefined; this.currentName = undefined;
  }

  private install(template: NpcTemplate): void {
    const model = cloneSkeleton(template.gltf.scene); const bones = findHumanoidBones(model);
    if (!bones) throw new NpcCharacterError('Cloned NPC is missing its humanoid skeleton.');
    model.name = `NpcInstance:${this.characterId}`;
    model.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
    this.model = model; this.bones = bones; this.mixer = new THREE.AnimationMixer(model); this.deathFloor = template.deathFloor;
    const random = this.options.random ?? Math.random;
    this.heapDeath = random() < HEAP_DEATH_CHANCE;
    this.heapJitter = [random(), random(), random(), random(), random(), random()];
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
