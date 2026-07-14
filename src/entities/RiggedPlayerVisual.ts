import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { WeaponId } from '../config';
import { buildWeaponModel } from './WeaponModels';

export const PLAYER_MODEL_URL = '/models/characters/protagonist.glb';

export const PLAYER_ANIMATIONS = [
  'idle', 'walk', 'sprint',
  'aim', 'aim_forward', 'aim_back', 'aim_left', 'aim_right', 'fire',
  'punch_left', 'punch_right',
  'jump', 'fall', 'land', 'tumble', 'death',
  'cover_idle', 'cover_move', 'cover_aim',
  'ride_bicycle', 'ride_motorbike', 'ride_superbike',
  'freefall', 'parachute',
] as const;
export type PlayerAnimationName = typeof PLAYER_ANIMATIONS[number];
export type CoverMode = 'none' | 'idle' | 'move' | 'aim';
export type RideMode = 'none' | 'bicycle' | 'motorbike' | 'superbike';
export type AirMode = 'none' | 'freefall' | 'parachute';
export type CharacterLoadStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface PlayerVisualState {
  locomotionSpeed: number;
  aiming: boolean;
  firing: boolean;
  moveSide: number;
  moveForward: number;
  onGround: boolean;
  velocityY: number;
  landing: boolean;
  attack?: 'punch_left' | 'punch_right';
  coverMode: CoverMode;
  coverTwist: number;
  rideMode: RideMode;
  rideSpeed: number;
  driveBy: boolean;
  airMode: AirMode;
  airPitch: number;
  airBank: number;
  inebriation: number;
  tumbleProgress: number;
  tumbleDirection: -1 | 1;
  dead: boolean;
}

const DEFAULT_STATE: PlayerVisualState = {
  locomotionSpeed: 0,
  aiming: false,
  firing: false,
  moveSide: 0,
  moveForward: 0,
  onGround: true,
  velocityY: 0,
  landing: false,
  coverMode: 'none',
  coverTwist: 0,
  rideMode: 'none',
  rideSpeed: 0,
  driveBy: false,
  airMode: 'none',
  airPitch: 0,
  airBank: 0,
  inebriation: 0,
  tumbleProgress: 0,
  tumbleDirection: 1,
  dead: false,
};

export const initialPlayerVisualState = (): PlayerVisualState => ({ ...DEFAULT_STATE });

export function selectPlayerAnimation(state: PlayerVisualState): PlayerAnimationName {
  if (state.dead) return 'death';
  if (state.tumbleProgress > 0) return 'tumble';
  if (state.attack) return state.attack;
  if (state.airMode !== 'none') return state.airMode;
  if (!state.onGround) return state.velocityY > 0.25 ? 'jump' : 'fall';
  if (state.landing) return 'land';
  if (state.coverMode !== 'none') return `cover_${state.coverMode}` as 'cover_idle' | 'cover_move' | 'cover_aim';
  if (state.rideMode !== 'none') return `ride_${state.rideMode}`;
  if (state.firing) return 'fire';
  if (state.aiming) {
    if (state.locomotionSpeed <= 0.05) return 'aim';
    if (Math.abs(state.moveSide) > Math.abs(state.moveForward)) return state.moveSide < 0 ? 'aim_left' : 'aim_right';
    return state.moveForward < 0 ? 'aim_back' : 'aim_forward';
  }
  if (state.locomotionSpeed >= 6.5) return 'sprint';
  if (state.locomotionSpeed > 0.05) return 'walk';
  return 'idle';
}

export type HumanoidBone = 'hips' | 'spine' | 'chest' | 'head' | 'leftUpperArm' | 'leftLowerArm' | 'leftHand'
  | 'rightUpperArm' | 'rightLowerArm' | 'rightHand' | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot'
  | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot';
export type HumanoidBones = Record<HumanoidBone, THREE.Bone>;

export const BONE_NAMES: Record<HumanoidBone, string> = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', head: 'Head',
  leftUpperArm: 'UpperArm_L', leftLowerArm: 'LowerArm_L', leftHand: 'Hand_L',
  rightUpperArm: 'UpperArm_R', rightLowerArm: 'LowerArm_R', rightHand: 'Hand_R',
  leftUpperLeg: 'UpperLeg_L', leftLowerLeg: 'LowerLeg_L', leftFoot: 'Foot_L',
  rightUpperLeg: 'UpperLeg_R', rightLowerLeg: 'LowerLeg_R', rightFoot: 'Foot_R',
};

export function findHumanoidBones(root: THREE.Object3D): HumanoidBones | undefined {
  const found = {} as Partial<HumanoidBones>;
  for (const [key, name] of Object.entries(BONE_NAMES) as [HumanoidBone, string][]) {
    const bone = root.getObjectByName(name); if (!(bone instanceof THREE.Bone)) return undefined; found[key] = bone;
  }
  return found as HumanoidBones;
}

const ONE_SHOT_ANIMATIONS = new Set<PlayerAnimationName>(['fire', 'punch_left', 'punch_right', 'jump', 'land', 'tumble', 'death']);
const MATERIAL_NAMES = ['SkinEyes', 'TealTechnicalJacket', 'CharcoalJeans', 'HairShoes'];

export class PlayerCharacterError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'PlayerCharacterError'; }
}

export interface ValidatedPlayerGltf { bones: HumanoidBones; clips: Map<PlayerAnimationName, THREE.AnimationClip>; }

export function validatePlayerGltf(gltf: GLTF): ValidatedPlayerGltf {
  const contract = gltf.scene.getObjectByName('JohannesburgProtagonist')?.userData.characterContract as Record<string, unknown> | undefined;
  if (contract?.version !== 1 || contract.forwardAxis !== '+Z' || contract.feetAtOrigin !== true || contract.fps !== 30) throw new PlayerCharacterError('Character metadata is missing or invalid.');
  const bones = findHumanoidBones(gltf.scene); if (!bones) throw new PlayerCharacterError('Character is missing one or more required humanoid bones.');
  const clipNames = gltf.animations.map((clip) => clip.name);
  if (new Set(clipNames).size !== PLAYER_ANIMATIONS.length || clipNames.length !== PLAYER_ANIMATIONS.length || PLAYER_ANIMATIONS.some((name) => !clipNames.includes(name))) {
    throw new PlayerCharacterError('Character animation set does not exactly match the required 24 clips.');
  }
  const clips = new Map(PLAYER_ANIMATIONS.map((name) => [name, gltf.animations.find((clip) => clip.name === name)!]));
  let triangles = 0; const materials = new Set<THREE.Material>(); let skinnedMeshes = 0;
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position?.count ?? 0) / 3;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    if (!(object instanceof THREE.SkinnedMesh)) throw new PlayerCharacterError(`Unskinned character mesh: ${object.name || '(unnamed)'}.`);
    skinnedMeshes++;
    const joints = object.geometry.getAttribute('skinIndex'); const weights = object.geometry.getAttribute('skinWeight');
    if (!joints || !weights || joints.itemSize !== 4 || weights.itemSize !== 4) throw new PlayerCharacterError(`${object.name} does not use four-influence skin attributes.`);
    for (let vertex = 0; vertex < weights.count; vertex++) {
      const sum = weights.getX(vertex) + weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex);
      if (Math.abs(sum - 1) > 0.001) throw new PlayerCharacterError(`${object.name} has unnormalised bone weights.`);
    }
  });
  if (triangles < 45_000 || triangles > 60_000) throw new PlayerCharacterError(`Character has ${triangles} triangles; expected 45–60k.`);
  if (skinnedMeshes !== 4 || materials.size !== 4) throw new PlayerCharacterError('Character must contain exactly four skinned material meshes.');
  const names = [...materials].map((material) => material.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...MATERIAL_NAMES].sort())) throw new PlayerCharacterError('Character material names are invalid.');
  for (const material of materials) {
    if (material.transparent || material.alphaTest > 0) throw new PlayerCharacterError(`${material.name} must be opaque.`);
    const map = (material as THREE.MeshStandardMaterial).map; const image = map?.image as { width?: number; height?: number } | undefined;
    if (!image || image.width !== 2048 || image.height !== 2048) throw new PlayerCharacterError(`${material.name} must use a 2048×2048 base-colour map.`);
  }
  const box = new THREE.Box3().setFromObject(gltf.scene); const height = box.max.y - box.min.y;
  if (Math.abs(height - 1.8) > 0.01 || Math.abs(box.min.y) > 0.015) throw new PlayerCharacterError(`Character scale/origin is invalid (${height.toFixed(3)} m high, feet y=${box.min.y.toFixed(3)}).`);
  for (const clip of gltf.animations) if (clip.tracks.some((track) => track.name.endsWith('.position'))) throw new PlayerCharacterError(`${clip.name} contains root translation.`);
  return { bones, clips };
}

export interface RiggedPlayerVisualOptions {
  url?: string;
  load?: (url: string) => Promise<GLTF>;
  onStatus?: (status: CharacterLoadStatus, error?: PlayerCharacterError) => void;
}

const WEAPON_SOCKET: Partial<Record<WeaponId, { position: [number, number, number]; rotation: [number, number, number]; scale?: number }>> = {
  pistol: { position: [0, -0.045, 0.035], rotation: [-Math.PI / 2, 0, Math.PI] },
  smg: { position: [0, -0.04, 0.045], rotation: [-Math.PI / 2, 0, Math.PI] },
  shotgun: { position: [0, -0.03, 0.055], rotation: [-Math.PI / 2, 0, Math.PI] },
  sniper: { position: [0, -0.03, 0.06], rotation: [-Math.PI / 2, 0, Math.PI] },
  rpg: { position: [-0.28, 0.12, -0.2], rotation: [-Math.PI / 2, 0.12, -0.18], scale: 0.94 },
};

export class RiggedPlayerVisual {
  readonly group = new THREE.Group();
  status: CharacterLoadStatus = 'idle';
  error?: PlayerCharacterError;
  private readonly url: string;
  private readonly loader: (url: string) => Promise<GLTF>;
  private readonly onStatus?: RiggedPlayerVisualOptions['onStatus'];
  private state = initialPlayerVisualState();
  private loading?: Promise<void>;
  private mixer?: THREE.AnimationMixer;
  private bones?: HumanoidBones;
  private actions = new Map<PlayerAnimationName, THREE.AnimationAction>();
  private restRotations = new Map<THREE.Bone, THREE.Quaternion>();
  private current?: THREE.AnimationAction;
  private currentName?: PlayerAnimationName;
  private weapon: WeaponId = 'pistol';
  private weaponMeshes = new Map<WeaponId, THREE.Group>();
  private elapsed = 0;
  private pedalPhase = 0;

  constructor(private parent: THREE.Object3D, options: RiggedPlayerVisualOptions = {}) {
    this.url = options.url ?? PLAYER_MODEL_URL; this.loader = options.load ?? ((url) => new GLTFLoader().loadAsync(url)); this.onStatus = options.onStatus;
    this.group.name = 'RiggedPlayerVisual'; this.group.visible = false; this.parent.add(this.group);
  }

  get ready(): boolean { return this.status === 'ready'; }
  get failed(): boolean { return this.status === 'failed'; }

  load(): Promise<void> {
    if (this.status === 'ready') return Promise.resolve();
    if (this.loading) return this.loading;
    this.setStatus('loading');
    this.loading = this.loader(this.url).then((gltf) => this.install(gltf)).catch((reason: unknown) => {
      const error = reason instanceof PlayerCharacterError ? reason : new PlayerCharacterError('Unable to load the player character.', { cause: reason });
      this.group.visible = false; this.setStatus('failed', error); throw error;
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  retry(): Promise<void> {
    if (this.status === 'loading') return this.loading ?? Promise.resolve();
    this.resetInstalledModel(); return this.load();
  }

  setState(state: PlayerVisualState): void { this.state = { ...state }; }
  setWeapon(id: WeaponId): void {
    this.weapon = id;
    for (const [weaponId, mesh] of this.weaponMeshes) mesh.visible = weaponId === id;
  }

  update(dt: number): void {
    if (!this.ready || !this.mixer || !this.bones) return;
    const step = Math.max(0, dt); this.elapsed += step;
    this.restoreRestPose();
    const requested = selectPlayerAnimation(this.state); this.transitionTo(requested); this.setPlaybackRate(requested);
    this.mixer.update(step); this.applyAdditivePose(step);
  }

  private install(gltf: GLTF): void {
    const { bones, clips } = validatePlayerGltf(gltf); this.resetInstalledModel();
    gltf.scene.name = 'RiggedPlayerModel';
    gltf.scene.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; } });
    this.bones = bones; this.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const [name, clip] of clips) {
      const action = this.mixer.clipAction(clip);
      if (ONE_SHOT_ANIMATIONS.has(name)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      this.actions.set(name, action);
    }
    for (const bone of Object.values(bones)) this.restRotations.set(bone, bone.quaternion.clone());
    this.buildWeapons(); this.setWeapon(this.weapon);
    this.transitionTo('idle', 0); this.mixer.update(0);
    this.group.add(gltf.scene); this.group.visible = true; this.setStatus('ready');
  }

  private setStatus(status: CharacterLoadStatus, error?: PlayerCharacterError): void {
    this.status = status; this.error = error; this.onStatus?.(status, error);
  }

  private resetInstalledModel(): void {
    this.mixer?.stopAllAction(); this.group.clear(); this.group.visible = false; this.mixer = undefined; this.bones = undefined;
    this.actions.clear(); this.restRotations.clear(); this.weaponMeshes.clear(); this.current = undefined; this.currentName = undefined;
    if (this.status !== 'loading') { this.status = 'idle'; this.error = undefined; }
  }

  private transitionTo(name: PlayerAnimationName, fade = 0.16): void {
    const next = this.actions.get(name); if (!next || (this.current === next && this.currentName === name)) return;
    if (fade > 0) this.current?.fadeOut(fade); else this.current?.stop();
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
    if (fade > 0) next.fadeIn(fade); next.play(); this.current = next; this.currentName = name;
  }

  private setPlaybackRate(name: PlayerAnimationName): void {
    if (!this.current) return;
    if (name === 'walk') this.current.setEffectiveTimeScale(THREE.MathUtils.clamp(this.state.locomotionSpeed / 4.6, 0.45, 1.8));
    else if (name === 'sprint') this.current.setEffectiveTimeScale(THREE.MathUtils.clamp(this.state.locomotionSpeed / 8.2, 0.65, 1.6));
    else if (name === 'ride_bicycle') this.current.setEffectiveTimeScale(THREE.MathUtils.clamp(Math.abs(this.state.rideSpeed) / 6, 0.2, 2.5));
    else this.current.setEffectiveTimeScale(1);
  }

  private restoreRestPose(): void {
    for (const [bone, rotation] of this.restRotations) bone.quaternion.copy(rotation);
    this.group.position.set(0, 0, 0); this.group.rotation.set(0, 0, 0);
  }

  private applyAdditivePose(dt: number): void {
    const bones = this.bones; if (!bones) return;
    bones.chest.rotation.y += this.state.coverTwist;
    if (this.state.driveBy) { bones.rightUpperArm.rotation.x -= 0.32; bones.rightUpperArm.rotation.z += 0.12; bones.head.rotation.y -= 0.12; }
    if (this.state.firing) { bones.rightUpperArm.rotation.x += 0.08; bones.chest.rotation.x -= 0.035; }
    if (this.state.airMode !== 'none') {
      this.group.rotation.x = this.state.airMode === 'freefall' ? THREE.MathUtils.clamp(1.22 + this.state.airPitch * 0.28, 0.5, Math.PI / 2 - 0.06) : 0.08 + this.state.airPitch * 0.14;
      this.group.rotation.z = -this.state.airBank * 0.55;
    }
    if (this.state.rideMode === 'bicycle') {
      this.pedalPhase += dt * Math.abs(this.state.rideSpeed) * 0.62; const pedal = Math.sin(this.pedalPhase);
      bones.leftUpperLeg.rotation.x += pedal * 0.42; bones.rightUpperLeg.rotation.x -= pedal * 0.42;
      bones.leftLowerLeg.rotation.x -= pedal * 0.38; bones.rightLowerLeg.rotation.x += pedal * 0.38;
    }
    if (this.state.tumbleProgress > 0) {
      const progress = this.state.tumbleProgress; const roll = Math.min(1, progress * 3.2) * (1 - THREE.MathUtils.smoothstep(progress, 0.72, 1));
      this.group.rotation.z += this.state.tumbleDirection * Math.PI / 2 * roll;
    }
    if (this.state.inebriation > 0) {
      const sway = Math.sin(this.elapsed * 2.1) * this.state.inebriation;
      this.group.rotation.z += sway * 0.13; bones.chest.rotation.z += sway * 0.16; bones.head.rotation.z += Math.sin(this.elapsed * 2.7) * this.state.inebriation * 0.2;
    }
  }

  private buildWeapons(): void {
    const bones = this.bones; if (!bones) return;
    for (const id of ['pistol', 'smg', 'shotgun', 'sniper', 'rpg'] as const) {
      const mesh = buildWeaponModel(id); const socket = WEAPON_SOCKET[id]; if (!mesh || !socket) continue;
      mesh.name = `RiggedWeapon:${id}`; mesh.position.set(...socket.position); mesh.rotation.set(...socket.rotation); if (socket.scale) mesh.scale.setScalar(socket.scale);
      (id === 'rpg' ? bones.chest : bones.rightHand).add(mesh); this.weaponMeshes.set(id, mesh);
    }
  }
}
