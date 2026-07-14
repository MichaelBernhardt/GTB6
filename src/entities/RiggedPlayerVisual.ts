import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { WeaponId } from '../config';
import { buildWeaponModel } from './WeaponModels';

export const PLAYER_MODEL_URL = '/models/characters/player-placeholder.glb';

export type PlayerAnimationName =
  | 'idle' | 'walk' | 'sprint'
  | 'aim' | 'aim_forward' | 'aim_back' | 'aim_left' | 'aim_right' | 'fire'
  | 'punch_left' | 'punch_right'
  | 'jump' | 'fall' | 'land' | 'death' | 'ride';

export interface PlayerVisualState {
  moving: boolean;
  sprinting: boolean;
  aiming: boolean;
  firing: boolean;
  moveSide: number;
  moveForward: number;
  onGround: boolean;
  velocityY: number;
  landing: boolean;
  attack?: 'punch_left' | 'punch_right';
  cover: boolean;
  riding: boolean;
  airborne: boolean;
  tumbling: boolean;
  dead: boolean;
}

export interface ProceduralHumanoidPose {
  model: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  leftForearm: THREE.Object3D;
  rightForearm: THREE.Object3D;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  leftShin: THREE.Object3D;
  rightShin: THREE.Object3D;
}

const DEFAULT_STATE: PlayerVisualState = {
  moving: false,
  sprinting: false,
  aiming: false,
  firing: false,
  moveSide: 0,
  moveForward: 0,
  onGround: true,
  velocityY: 0,
  landing: false,
  cover: false,
  riding: false,
  airborne: false,
  tumbling: false,
  dead: false,
};

export const initialPlayerVisualState = (): PlayerVisualState => ({ ...DEFAULT_STATE });

/** The GLB swaps in only from a visually neutral pose. Once active, procedural bone overrides cover rare poses. */
export function canActivateRiggedVisual(state: PlayerVisualState): boolean {
  return state.onGround && !state.moving && !state.aiming && !state.firing && !state.cover && !state.riding
    && !state.airborne && !state.tumbling && !state.dead;
}

export function selectPlayerAnimation(state: PlayerVisualState): PlayerAnimationName {
  if (state.dead) return 'death';
  if (state.attack) return state.attack;
  if (state.airborne || !state.onGround) return state.velocityY > 0.25 ? 'jump' : 'fall';
  if (state.landing) return 'land';
  if (state.riding) return 'ride';
  if (state.firing) return 'fire';
  if (state.aiming) {
    if (!state.moving) return 'aim';
    if (Math.abs(state.moveSide) > Math.abs(state.moveForward)) return state.moveSide < 0 ? 'aim_left' : 'aim_right';
    return state.moveForward < 0 ? 'aim_back' : 'aim_forward';
  }
  if (state.sprinting) return 'sprint';
  if (state.moving) return 'walk';
  return 'idle';
}

type HumanoidBone = 'hips' | 'spine' | 'chest' | 'head' | 'leftUpperArm' | 'leftLowerArm' | 'leftHand'
  | 'rightUpperArm' | 'rightLowerArm' | 'rightHand' | 'leftUpperLeg' | 'leftLowerLeg' | 'leftFoot'
  | 'rightUpperLeg' | 'rightLowerLeg' | 'rightFoot';

type HumanoidBones = Record<HumanoidBone, THREE.Object3D>;

const BONE_ALIASES: Record<HumanoidBone, readonly string[]> = {
  hips: ['Hips', 'hips', 'mixamorigHips', 'DEF-pelvis'],
  spine: ['Spine', 'spine', 'mixamorigSpine', 'DEF-spine'],
  chest: ['Chest', 'chest', 'Spine1', 'mixamorigSpine1', 'DEF-spine.001'],
  head: ['Head', 'head', 'mixamorigHead', 'DEF-head'],
  leftUpperArm: ['UpperArm_L', 'LeftArm', 'mixamorigLeftArm', 'DEF-upper_arm.L'],
  leftLowerArm: ['LowerArm_L', 'LeftForeArm', 'mixamorigLeftForeArm', 'DEF-forearm.L'],
  leftHand: ['Hand_L', 'LeftHand', 'mixamorigLeftHand', 'DEF-hand.L'],
  rightUpperArm: ['UpperArm_R', 'RightArm', 'mixamorigRightArm', 'DEF-upper_arm.R'],
  rightLowerArm: ['LowerArm_R', 'RightForeArm', 'mixamorigRightForeArm', 'DEF-forearm.R'],
  rightHand: ['Hand_R', 'RightHand', 'mixamorigRightHand', 'DEF-hand.R'],
  leftUpperLeg: ['UpperLeg_L', 'LeftUpLeg', 'mixamorigLeftUpLeg', 'DEF-thigh.L'],
  leftLowerLeg: ['LowerLeg_L', 'LeftLeg', 'mixamorigLeftLeg', 'DEF-shin.L'],
  leftFoot: ['Foot_L', 'LeftFoot', 'mixamorigLeftFoot', 'DEF-foot.L'],
  rightUpperLeg: ['UpperLeg_R', 'RightUpLeg', 'mixamorigRightUpLeg', 'DEF-thigh.R'],
  rightLowerLeg: ['LowerLeg_R', 'RightLeg', 'mixamorigRightLeg', 'DEF-shin.R'],
  rightFoot: ['Foot_R', 'RightFoot', 'mixamorigRightFoot', 'DEF-foot.R'],
};

export function findHumanoidBones(root: THREE.Object3D): HumanoidBones | undefined {
  const found = {} as Partial<HumanoidBones>;
  for (const [key, aliases] of Object.entries(BONE_ALIASES) as [HumanoidBone, readonly string[]][]) {
    const bone = aliases.map((name) => root.getObjectByName(name)).find(Boolean);
    if (!bone) return undefined;
    found[key] = bone;
  }
  return found as HumanoidBones;
}

const CLIP_ALIASES: Record<PlayerAnimationName, readonly string[]> = {
  idle: ['idle', 'Idle'], walk: ['walk', 'Walk'], sprint: ['sprint', 'Sprint', 'Run'],
  aim: ['aim', 'Aim', 'GunIdle'], aim_forward: ['aim_forward', 'AimForward', 'GunWalk'],
  aim_back: ['aim_back', 'AimBack'], aim_left: ['aim_left', 'AimLeft'], aim_right: ['aim_right', 'AimRight'],
  fire: ['fire', 'Fire', 'Shoot'], punch_left: ['punch_left', 'PunchLeft', 'Punch'], punch_right: ['punch_right', 'PunchRight', 'Punch'],
  jump: ['jump', 'Jump'], fall: ['fall', 'Fall'], land: ['land', 'Land'], death: ['death', 'Death'], ride: ['ride', 'Ride', 'Sit'],
};

const FALLBACK_ACTION: Partial<Record<PlayerAnimationName, PlayerAnimationName>> = {
  aim_forward: 'aim', aim_back: 'aim', aim_left: 'aim', aim_right: 'aim', fire: 'aim',
  punch_left: 'idle', punch_right: 'idle', jump: 'fall', land: 'idle', death: 'fall', ride: 'idle',
};

function clipFor(clips: readonly THREE.AnimationClip[], name: PlayerAnimationName): THREE.AnimationClip | undefined {
  return clips.find((clip) => CLIP_ALIASES[name].includes(clip.name));
}

export interface RiggedPlayerVisualOptions {
  url?: string;
  load?: (url: string) => Promise<GLTF>;
  onError?: (error: unknown) => void;
}

/** Authored animation layer with a fail-closed procedural fallback. Gameplay never depends on this class loading. */
export class RiggedPlayerVisual {
  readonly group = new THREE.Group();
  ready = false;
  active = false;
  failed = false;
  private state = initialPlayerVisualState();
  private mixer?: THREE.AnimationMixer;
  private bones?: HumanoidBones;
  private actions = new Map<PlayerAnimationName, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private currentName?: PlayerAnimationName;
  private weapon: WeaponId = 'pistol';
  private weaponMeshes = new Map<WeaponId, THREE.Group>();

  constructor(
    private parent: THREE.Object3D,
    private proceduralModel: THREE.Object3D,
    private pose: ProceduralHumanoidPose,
    options: RiggedPlayerVisualOptions = {},
  ) {
    this.group.name = 'RiggedPlayerVisual'; this.group.visible = false; this.parent.add(this.group);
    if (typeof window !== 'undefined') {
      const load = options.load ?? ((url: string) => new GLTFLoader().loadAsync(url));
      void load(options.url ?? PLAYER_MODEL_URL).then((gltf) => this.install(gltf)).catch((error: unknown) => {
        this.failed = true; options.onError?.(error);
        if (!options.onError) console.warn('[player] Rigged character unavailable; using procedural fallback.', error);
      });
    }
  }

  setState(state: PlayerVisualState): void { this.state = { ...state }; }

  setWeapon(id: WeaponId): void {
    this.weapon = id;
    for (const [weaponId, mesh] of this.weaponMeshes) mesh.visible = weaponId === id;
  }

  update(dt: number): void {
    if (!this.ready || !this.mixer) return;
    if (!this.active && canActivateRiggedVisual(this.state)) {
      this.active = true; this.group.visible = true; this.proceduralModel.visible = false;
    }
    if (!this.active) return;
    const requested = selectPlayerAnimation(this.state);
    this.transitionTo(requested);
    this.mixer.update(Math.max(0, dt));
    if (this.usesProceduralPose()) this.applyProceduralPose(); else this.group.rotation.set(0, 0, 0);
  }

  private install(gltf: GLTF): void {
    const bones = findHumanoidBones(gltf.scene);
    if (!bones || !clipFor(gltf.animations, 'idle') || !clipFor(gltf.animations, 'walk') || !clipFor(gltf.animations, 'sprint')) {
      this.failed = true; return;
    }
    const box = new THREE.Box3().setFromObject(gltf.scene); const height = box.max.y - box.min.y;
    if (!Number.isFinite(height) || height <= 0.1) { this.failed = true; return; }
    gltf.scene.scale.setScalar(1.8 / height); gltf.scene.position.y = -box.min.y * (1.8 / height);
    gltf.scene.name = 'RiggedPlayerModel';
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; object.frustumCulled = false; }
    });
    this.group.add(gltf.scene); this.bones = bones; this.mixer = new THREE.AnimationMixer(gltf.scene);
    for (const name of Object.keys(CLIP_ALIASES) as PlayerAnimationName[]) {
      const clip = clipFor(gltf.animations, name); if (!clip) continue;
      const action = this.mixer.clipAction(clip); if (['punch_left', 'punch_right', 'jump', 'land', 'death'].includes(name)) { action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; }
      this.actions.set(name, action);
    }
    this.buildWeapons(); this.setWeapon(this.weapon); this.ready = true;
  }

  private transitionTo(requested: PlayerAnimationName): void {
    let name = requested; let next = this.actions.get(name);
    while (!next && FALLBACK_ACTION[name]) { name = FALLBACK_ACTION[name]!; next = this.actions.get(name); }
    if (!next || (this.current === next && this.currentName === requested)) return;
    this.current?.fadeOut(0.16);
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).fadeIn(0.16).play();
    this.current = next; this.currentName = requested;
  }

  private usesProceduralPose(): boolean {
    return this.state.cover || this.state.riding || this.state.airborne || this.state.tumbling;
  }

  private applyProceduralPose(): void {
    const bones = this.bones; if (!bones) return;
    this.group.rotation.copy(this.pose.model.rotation);
    bones.chest.rotation.copy(this.pose.torso.rotation); bones.head.rotation.copy(this.pose.head.rotation);
    bones.leftUpperArm.rotation.copy(this.pose.leftArm.rotation); bones.rightUpperArm.rotation.copy(this.pose.rightArm.rotation);
    bones.leftLowerArm.rotation.copy(this.pose.leftForearm.rotation); bones.rightLowerArm.rotation.copy(this.pose.rightForearm.rotation);
    bones.leftUpperLeg.rotation.copy(this.pose.leftLeg.rotation); bones.rightUpperLeg.rotation.copy(this.pose.rightLeg.rotation);
    bones.leftLowerLeg.rotation.copy(this.pose.leftShin.rotation); bones.rightLowerLeg.rotation.copy(this.pose.rightShin.rotation);
  }

  private buildWeapons(): void {
    const bones = this.bones; if (!bones) return;
    for (const id of ['pistol', 'smg', 'shotgun', 'sniper'] as const) {
      const mesh = buildWeaponModel(id); if (!mesh) continue;
      mesh.name = `RiggedWeapon:${id}`; mesh.position.set(0, 0.02, 0); bones.rightHand.add(mesh); this.weaponMeshes.set(id, mesh);
    }
    const rpg = buildWeaponModel('rpg');
    if (rpg) { rpg.name = 'RiggedWeapon:rpg'; rpg.rotation.x = -Math.PI / 2; rpg.position.set(-0.3, 0.15, -0.28); bones.chest.add(rpg); this.weaponMeshes.set('rpg', rpg); }
  }
}
