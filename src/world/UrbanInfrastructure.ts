import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { PropRegistry } from '../systems/PropSystem';
import { addInstancedChunks, type ChunkStore, type InstanceItem, type InstanceSlot } from './ChunkVisibility';
import type { RoadPoint, RoadsidePoint } from './City';
import { SIGNAL_JUNCTIONS, STREET_SIGN_JUNCTIONS } from './mapData';
import { ETOLL_SPOTS, ROADSIDE_SIGNS, SPAWN_SIGN_JUNCTIONS, TRANSIT_STOPS } from './placements';
import { createSignMesh } from './ProceduralMaterials';
import { onPowerChange } from './powerGrid';
import { buildTreeInstance, type TreeInstancePart, type TreeSpecies } from './FoliageAssets';

const HIDDEN_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

/** Hide one instance of a per-cell InstancedMesh (knocked-over prop). */
const hideSlot = (slot: InstanceSlot): void => { slot.mesh.setMatrixAt(slot.index, HIDDEN_MATRIX); slot.mesh.instanceMatrix.needsUpdate = true; };

export interface JunctionDefinition {
  x: number;
  z: number;
  angle: number;
  roadA: string;
  roadB: string;
  phase: number;
  /** Width of the widest incident road: junction furniture offsets scale from it. */
  widest: number;
}

/** Signalised junctions ("robots") — picked from the generated map by degree/width, budgeted. */
export const CITY_JUNCTIONS: JunctionDefinition[] = SIGNAL_JUNCTIONS.map((junction) => ({
  x: junction.x, z: junction.z, angle: junction.angle,
  roadA: junction.roadA, roadB: junction.roadB,
  phase: junction.phase, widest: junction.widest,
}));

/** Corner clearance beyond the junction's widest carriageway for poles and signs. */
export const signalCornerOffset = (widest: number): number => widest / 2 + 4;

/** e-toll gantries over the M1, from the generated map. */
export const ETOLL_GANTRIES: Array<{ x: number; z: number; angle: number }> = ETOLL_SPOTS.map((spot) => ({ x: spot.x, z: spot.z, angle: spot.angle }));

interface SignalLens { axis: 0 | 1; phase: number; channel: 0 | 1 | 2; }
const SIGNAL_COLORS = [0xe83f3f, 0xf0ad2f, 0x39d36c] as const;

const BULB_COLOR = 0xffdca0;

/** One robot's 30s loop: green 0–11, amber 11–14, red 14–30. The two carriageway axes run 15s apart
 *  so their greens never overlap. Both the lens animation and the traffic AI read this, so the colour
 *  the player sees and the light a driver obeys can never disagree. */
export type SignalPhaseState = 'green' | 'amber' | 'red';
export function signalPhaseState(phase: number, axis: 0 | 1, elapsed: number): SignalPhaseState {
  const cycle = (((elapsed + phase + axis * 15) % 30) + 30) % 30;
  if (cycle < 11) return 'green';
  if (cycle < 14) return 'amber';
  return 'red';
}

/** Hold line sits this far beyond the junction box edge; a driver inside this ring is "at the robot". Wide
 *  enough that a car braking from cruise (see Vehicle.updateAI's brake-firm decel) actually halts before the
 *  box instead of coasting through — an 8u ring left too little room and cars rolled reds. */
export const SIGNAL_STOP_APPROACH = 17;
/** Once a driver is this far past the box edge (into the crossing) it commits through, never freezing mid-junction. */
export const SIGNAL_STOP_CLEAR = 1.5;

/** Graded companion to signalHoldsDriver: 1 = cruise (green, moving away, committed through, or out of range),
 *  easing linearly to 0 at the hold line so a driver lifts off and brakes SOONER across the whole approach ring
 *  instead of cruising to the box then slamming to a stop. Same approach/commit geometry as signalHoldsDriver. */
export function signalSlowFactor(junction: JunctionDefinition, x: number, z: number, heading: number, elapsed: number): number {
  const toX = junction.x - x; const toZ = junction.z - z;
  const dirX = Math.sin(heading); const dirZ = Math.cos(heading);
  if (toX * dirX + toZ * dirZ <= 0) return 1; // moving away / already past
  const half = junction.widest / 2;
  const distance = Math.hypot(toX, toZ);
  if (distance > half + SIGNAL_STOP_APPROACH) return 1; // too far out to matter yet
  if (distance < half - SIGNAL_STOP_CLEAR) return 1; // inside the box: commit through, don't crawl
  const align = Math.abs(dirX * Math.sin(junction.angle) + dirZ * Math.cos(junction.angle));
  const axis: 0 | 1 = align >= 0.5 ? 0 : 1;
  if (signalPhaseState(junction.phase, axis, elapsed) === 'green') return 1; // clear axis: full speed through
  return Math.max(0, Math.min(1, (distance - half) / SIGNAL_STOP_APPROACH)); // ease from cruise (ring edge) to stop (box edge)
}

/** True when an AI driver at (x, z) heading `heading` should hold for a non-green robot on the axis it
 *  is travelling: it must be approaching, within the hold ring, and not already committed into the box. */
export function signalHoldsDriver(junction: JunctionDefinition, x: number, z: number, heading: number, elapsed: number): boolean {
  const toX = junction.x - x; const toZ = junction.z - z;
  const dirX = Math.sin(heading); const dirZ = Math.cos(heading);
  if (toX * dirX + toZ * dirZ <= 0) return false; // moving away from / already past the crossing
  const half = junction.widest / 2;
  const distance = Math.hypot(toX, toZ);
  if (distance > half + SIGNAL_STOP_APPROACH) return false; // too far out to matter yet
  if (distance < half - SIGNAL_STOP_CLEAR) return false; // inside the box: clear it, don't stall in the middle
  const align = Math.abs(dirX * Math.sin(junction.angle) + dirZ * Math.cos(junction.angle));
  const axis: 0 | 1 = align >= 0.5 ? 0 : 1; // aligned with roadA (the junction angle) => axis 0, else the cross axis
  return signalPhaseState(junction.phase, axis, elapsed) !== 'green';
}

export class UrbanInfrastructure {
  /** Interleaved xz world positions of every streetlamp fixture, for the day/night light pool. */
  lampsXZ = new Float32Array(0);
  private group = new THREE.Group();
  private lenses: SignalLens[] = [];
  private lensSlots: InstanceSlot[] = [];
  private lensLit: boolean[] = [];
  private lensDirty = new Set<THREE.InstancedMesh>();
  private lensColor = new THREE.Color();
  private lensTick = -1;
  private lensPowerDirty = true;
  private elapsed = 0;
  private bulbMaterial?: THREE.MeshBasicMaterial;
  private powered = true;

  constructor(
    parent: THREE.Group,
    /** World-tier chunk grid (~2500u): trees and everything with a far-readable silhouette. */
    private chunks: ChunkStore,
    /** Detail-tier chunk grid (~1200u): furniture, lamp hardware, lenses — sub-pixel beyond it. */
    private detail: ChunkStore,
    private roadsidePoints: RoadsidePoint[],
    /** Distance-spaced, kerb-alternating lamp anchors — one per STREETLAMP_SPACING of road. */
    private streetlampPoints: RoadsidePoint[],
    private isBlocked: (x: number, z: number, radius: number) => boolean,
    private isRoad: (x: number, z: number, margin: number) => boolean,
    private props: PropRegistry,
    private surfaceHeight: (x: number, z: number) => number,
  ) {
    this.group.name = 'Urban infrastructure'; parent.add(this.group);
    onPowerChange((on) => { this.powered = on; this.lensPowerDirty = true; });
    this.buildVegetation();
    this.buildStreetlights();
    this.buildTrafficSignals();
    this.buildStreetSigns();
    this.buildRoadsideSigns();
    this.buildStreetFurniture();
    this.buildLitterBins();
    this.buildTransitStops();
    this.buildEtollGantries();
    this.groundInfrastructure();
  }

  /** Raise every streetscape root or instance onto its local sidewalk surface. */
  private groundInfrastructure(): void {
    const matrix = new THREE.Matrix4(); const position = new THREE.Vector3(); const rotation = new THREE.Quaternion(); const scale = new THREE.Vector3();
    for (const object of this.group.children) {
      if (object instanceof THREE.InstancedMesh) {
        for (let index = 0; index < object.count; index++) {
          object.getMatrixAt(index, matrix); matrix.decompose(position, rotation, scale);
          position.y += this.surfaceHeight(position.x, position.z); matrix.compose(position, rotation, scale); object.setMatrixAt(index, matrix);
        }
        object.instanceMatrix.needsUpdate = true;
      } else object.position.y += this.surfaceHeight(object.position.x, object.position.z);
    }
  }

  /** Bake sidewalk height into each instance's Y at build time. Trees, streetlamps, shrubs, signal lenses
   *  and benches go into the chunk/detail stores, which are SHARED with City's already-grounded scatter —
   *  so groundInfrastructure() can't blanket-walk them (it would double-count). Each build pass instead
   *  grounds only its own items through here, right before handing them to addInstancedChunks. */
  private groundItems(items: InstanceItem[]): InstanceItem[] {
    const position = new THREE.Vector3(); const rotation = new THREE.Quaternion(); const scale = new THREE.Vector3();
    for (const item of items) {
      item.matrix.decompose(position, rotation, scale);
      position.y += this.surfaceHeight(item.x, item.z);
      item.matrix.compose(position, rotation, scale);
    }
    return items;
  }

  update(dt: number): void {
    this.elapsed = (this.elapsed + dt) % 30;
    // Generated signal phases and all three state boundaries land on whole seconds. Recolouring every
    // lens on every render frame was therefore identical work ~59 frames out of 60, including needless
    // instance-buffer uploads. Keep the traffic clock continuous, but refresh visuals only when a state
    // can actually change (or immediately after a power cut/restoration).
    const tick = Math.floor(this.elapsed);
    if (tick === this.lensTick && !this.lensPowerDirty) return;
    this.lensTick = tick; this.lensPowerDirty = false;
    this.lensDirty.clear();
    this.lenses.forEach((lens, index) => {
      const slot = this.lensSlots[index];
      if (!slot) return;
      const state = signalPhaseState(lens.phase, lens.axis, this.elapsed); // culled lens meshes still get colors: the GPU upload only happens when their chunk is rendered again
      const on = this.powered && (lens.channel === 2 ? state === 'green' : lens.channel === 1 ? state === 'amber' : state === 'red');
      if (this.lensLit[index] === on) return;
      this.lensLit[index] = on;
      this.lensColor.setHex(on ? SIGNAL_COLORS[lens.channel] : 0x14100e);
      if (on) this.lensColor.multiplyScalar(2.1);
      slot.mesh.setColorAt(slot.index, this.lensColor);
      this.lensDirty.add(slot.mesh);
    });
    for (const mesh of this.lensDirty) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Seconds into the shared 30s robot loop — the traffic AI reads this to obey the same lights the player sees. */
  get signalClock(): number { return this.elapsed; }

  /** 0 = day (dim panel), 1 = night: pushes the shared bulb material into HDR so streetlamp heads bloom.
   *  During load shedding the panel goes fully dark whatever the hour — Eskom outranks dusk. */
  setLampGlow(factor: number): void {
    if (!this.powered) { this.bulbMaterial?.color.setHex(0x2a2d2f); return; }
    this.bulbMaterial?.color.setHex(BULB_COLOR).multiplyScalar(0.35 + factor * 2.85);
  }

  private buildVegetation(): void {
    // Verge planting: trees/shrubs stand 2.1u OUTWARD of the roadside line, clear of both the sidewalk walk
    // line peds actually route along and of junction lane chords. The generated map has ~15k roadside
    // points, so strides are wider than the old hand-authored city to keep instance budgets sane
    // (stride 6 ≈ 2.5k tree sites citywide — authored variants, instanced per chunk).
    const sites = this.roadsidePoints
      .filter((point, index) => index % 6 === 0 && point.width >= 9)
      .map((point) => ({ x: point.x - point.inwardX * 2.1, z: point.z - point.inwardZ * 2.1 }))
      .filter((point) => !this.isBlocked(point.x, point.z, 2.8) && !this.isRoad(point.x, point.z, 2.4));
    const jacarandas = sites.filter((_, index) => index % 2 === 0);
    const broadleaf = sites.filter((_, index) => index % 2 !== 0);
    this.buildBroadleafTrees(broadleaf);
    this.buildJacarandas(jacarandas);

    const shrubSites = sites.filter((_, index) => index % 3 === 0);
    const shrubGeometry = new THREE.SphereGeometry(1, 16, 10);
    const shrubDebrisMaterial = new THREE.MeshStandardMaterial({ color: 0x3c6a41, roughness: 0.94 });
    const items: InstanceItem[] = [];
    const placed: Array<{ x: number; z: number; scale: number }> = [];
    shrubSites.forEach((site, index) => {
      for (let cluster = 0; cluster < 3; cluster++) {
        const angle = cluster / 3 * Math.PI * 2 + index; const scale = 0.42 + ((index + cluster) % 4) * 0.08;
        const x = site.x + Math.cos(angle) * 1.35; const z = site.z + Math.sin(angle) * 1.35;
        const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, scale * 0.75, z), new THREE.Quaternion(), new THREE.Vector3(scale * 1.25, scale, scale));
        items.push({ x, z, matrix, color: new THREE.Color(cluster === 1 ? 0x4f7d45 : 0x315c3b) });
        placed.push({ x, z, scale });
      }
    });
    const slots = addInstancedChunks(this.detail, shrubGeometry, new THREE.MeshStandardMaterial({ color: 0x365f3d, roughness: 0.94 }), this.groundItems(items), { cast: true, receive: true });
    placed.forEach(({ x, z, scale }, index) => {
      const slot = slots[index]!;
      this.props.register('shrub', x, z, scale * 1.1, scale * 1.5, {
        hide: () => hideSlot(slot),
        debris: () => {
          const group = new THREE.Group(); group.position.set(x, this.surfaceHeight(x, z), z);
          const tuft = new THREE.Mesh(shrubGeometry, shrubDebrisMaterial); tuft.position.y = scale * 0.75; tuft.scale.set(scale * 1.25, scale, scale); tuft.castShadow = true; group.add(tuft);
          return group;
        },
      });
    });
  }

  private buildBroadleafTrees(sites: RoadPoint[]): void {
    this.buildAuthoredTrees(sites, 'shade-tree');
  }

  private buildJacarandas(sites: RoadPoint[]): void {
    this.buildAuthoredTrees(sites, 'jacaranda');
  }

  /** Roadside trees use the same required Blender library as streamed foliage. Each authored variant stays
   *  instanced per chunk, including its material groups, so the richer silhouettes do not restore one draw
   *  call per tree. */
  private buildAuthoredTrees(sites: RoadPoint[], species: TreeSpecies): void {
    interface Batch { part: TreeInstancePart; items: InstanceItem[]; }
    const batches = new Map<string, Batch>();
    const up = new THREE.Vector3(0, 1, 0);
    sites.forEach((site, index) => {
      const seed = site.x * 0.017 + site.z * 0.031 + index * 13.7;
      const tree = buildTreeInstance(species, seed);
      this.props.register('tree', site.x, site.z, tree.trunkRadius, tree.trunkHeight);
      const placement = new THREE.Matrix4().compose(
        new THREE.Vector3(site.x, 0, site.z),
        new THREE.Quaternion().setFromAxisAngle(up, index * 2.399963229728653),
        new THREE.Vector3(tree.scale, tree.scale, tree.scale),
      );
      tree.parts.forEach((part, partIndex) => {
        const key = `${tree.variant}:${partIndex}`;
        const batch = batches.get(key) ?? { part, items: [] };
        batch.items.push({ x: site.x, z: site.z, matrix: placement.clone().multiply(part.matrix) });
        batches.set(key, batch);
      });
    });
    for (const { part, items } of batches.values()) {
      addInstancedChunks(this.chunks, part.geometry, part.material, this.groundItems(items), { cast: true, receive: true });
    }
  }

  private buildStreetlights(): void {
    // Lamps line every road at a consistent ~36u pitch, alternating kerbs, drawn from the arc-length
    // streetlampPoints (not the coarse verge stride). The width floor lives in addStreetlampPoints, so
    // here we only drop anchors that landed inside a building footprint or back on the tar.
    const sites = this.streetlampPoints.filter((point) => !this.isBlocked(point.x, point.z, 1.2) && !this.isRoad(point.x, point.z, 0.9));
    const metal = new THREE.MeshStandardMaterial({ color: 0x253033, roughness: 0.34, metalness: 0.82 });
    const deadBulbMaterial = new THREE.MeshBasicMaterial({ color: 0x2a2d2f, side: THREE.DoubleSide }); // a downed lamp is dark, day or night, powered or not
    const poleGeometry = new THREE.CylinderGeometry(0.08, 0.17, 6.5, 12);
    const armGeometry = new THREE.CylinderGeometry(0.055, 0.065, 1.25, 10);
    const collarGeometry = new THREE.CylinderGeometry(0.23, 0.28, 0.42, 14);
    const fixtureGeometry = new RoundedBoxGeometry(0.9, 0.22, 0.42, 3, 0.07);
    const bulbGeometry = new THREE.PlaneGeometry(0.62, 0.22);
    const bulbMaterial = new THREE.MeshBasicMaterial({ color: BULB_COLOR, side: THREE.DoubleSide });
    this.bulbMaterial = bulbMaterial; this.setLampGlow(0); // day/night + load shedding drive this material instead of registerPowered
    const lampsXZ = new Float32Array(sites.length * 2); this.lampsXZ = lampsXZ;
    const up = new THREE.Vector3(0, 1, 0); const one = new THREE.Vector3(1, 1, 1);
    const poleItems: InstanceItem[] = []; const armItems: InstanceItem[] = []; const collarItems: InstanceItem[] = [];
    const fixtureItems: InstanceItem[] = []; const bulbItems: InstanceItem[] = [];
    const lampData: Array<{ direction: THREE.Vector3; armRotation: THREE.Quaternion; headRotation: THREE.Quaternion; bulbRotation: THREE.Quaternion }> = [];
    sites.forEach((site, index) => {
      const direction = new THREE.Vector3(site.inwardX, 0, site.inwardZ).normalize();
      lampsXZ[index * 2] = site.x + direction.x * 1.18; lampsXZ[index * 2 + 1] = site.z + direction.z * 1.18;
      const headRotation = new THREE.Quaternion().setFromAxisAngle(up, Math.atan2(-direction.z, direction.x));
      const armRotation = new THREE.Quaternion().setFromUnitVectors(up, direction);
      const bulbRotation = headRotation.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
      poleItems.push({ x: site.x, z: site.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(site.x, 3.25, site.z), new THREE.Quaternion(), one) });
      collarItems.push({ x: site.x, z: site.z, matrix: new THREE.Matrix4().makeTranslation(site.x, 0.23, site.z) });
      armItems.push({ x: site.x, z: site.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(site.x, 6.08, site.z).addScaledVector(direction, 0.58), armRotation, one) });
      fixtureItems.push({ x: site.x, z: site.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(site.x, 6.15, site.z).addScaledVector(direction, 1.18), headRotation, one) });
      bulbItems.push({ x: site.x, z: site.z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(site.x, 6.02, site.z).addScaledVector(direction, 1.18), bulbRotation, one) });
      lampData.push({ direction, armRotation, headRotation, bulbRotation });
    });
    const poleSlots = addInstancedChunks(this.detail, poleGeometry, metal, this.groundItems(poleItems), { cast: true });
    const armSlots = addInstancedChunks(this.detail, armGeometry, metal, this.groundItems(armItems), { cast: true });
    const collarSlots = addInstancedChunks(this.detail, collarGeometry, metal, this.groundItems(collarItems));
    const fixtureSlots = addInstancedChunks(this.detail, fixtureGeometry, metal, this.groundItems(fixtureItems), { cast: true });
    const bulbSlots = addInstancedChunks(this.detail, bulbGeometry, bulbMaterial, this.groundItems(bulbItems));
    sites.forEach((site, index) => {
      const { direction, armRotation, headRotation, bulbRotation } = lampData[index]!;
      this.props.register('streetlight', site.x, site.z, 0.2, 6.5, {
        hide: () => {
          for (const slots of [poleSlots, armSlots, collarSlots, fixtureSlots, bulbSlots]) hideSlot(slots[index]!);
          lampsXZ[index * 2] = 1e9; lampsXZ[index * 2 + 1] = 1e9; // evict from the day/night light pool: felled lamps shine no more
        },
        debris: () => {
          const group = new THREE.Group(); group.position.set(site.x, this.surfaceHeight(site.x, site.z), site.z);
          const pole = new THREE.Mesh(poleGeometry, metal); pole.position.y = 3.25;
          const collar = new THREE.Mesh(collarGeometry, metal); collar.position.y = 0.23;
          const arm = new THREE.Mesh(armGeometry, metal); arm.position.set(direction.x * 0.58, 6.08, direction.z * 0.58); arm.quaternion.copy(armRotation);
          const fixture = new THREE.Mesh(fixtureGeometry, metal); fixture.position.set(direction.x * 1.18, 6.15, direction.z * 1.18); fixture.quaternion.copy(headRotation);
          const bulb = new THREE.Mesh(bulbGeometry, deadBulbMaterial); bulb.position.set(direction.x * 1.18, 6.02, direction.z * 1.18); bulb.quaternion.copy(bulbRotation);
          for (const part of [pole, collar, arm, fixture]) part.castShadow = true;
          group.add(pole, collar, arm, fixture, bulb);
          return group;
        },
      });
    });
  }

  private buildTrafficSignals(): void {
    const lensTransforms: Array<{ matrix: THREE.Matrix4; baseX: number; baseZ: number }> = [];
    for (const junction of CITY_JUNCTIONS) {
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      const offset = signalCornerOffset(junction.widest);
      for (const forwardSide of [-1, 1] as const) for (const rightSide of [-1, 1] as const) {
        // South-African left-hand driving: each corner hosts the signal for the approach it is the near-LEFT
        // of, and the head faces that oncoming driver. axis 0 = the junction's forward road (fS≠rS corners),
        // axis 1 = the cross road (fS===rS corners). travel = that approach's direction of travel.
        const axis: 0 | 1 = forwardSide === rightSide ? 1 : 0;
        const travel = (axis === 0 ? forward : right).clone().multiplyScalar(-forwardSide);
        const position = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, forwardSide * offset).addScaledVector(right, rightSide * offset);
        if (!this.clearOfRoad(position, junction)) continue; // corner diagonal ran down a road: no pole beats a pole in a lane
        const heading = Math.atan2(-travel.x, -travel.z); // lens normal = -travel, i.e. the head faces the oncoming driver
        // The mast arm (the head's local -X) must reach OVER the carriageway, not the verge — mirror the head
        // model on corners where, at this heading, -X would point away from the junction centre.
        const armWorldX = -Math.cos(heading); const armWorldZ = Math.sin(heading);
        const mirror = armWorldX * (junction.x - position.x) + armWorldZ * (junction.z - position.z) < 0;
        this.addSignalPole(position, heading, axis, junction.phase, lensTransforms, mirror);
      }
      this.addStreetSigns(junction, forward, right);
    }
    // Sign-only corners near the spawn so the parody street names read on foot (no lenses, just boards).
    for (const junction of SPAWN_SIGN_JUNCTIONS) {
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      this.addStreetSigns(junction, forward, right);
    }
    // Ground each lens by its POLE-BASE height (not the lens's own x,z out over the road) so it shares the
    // exact offset groundInfrastructure() gives the pole/hood assembly — otherwise terrain slope between the
    // corner and the head floats the lights off their hoods, differently per pole.
    const lensItems: InstanceItem[] = lensTransforms.map(({ matrix, baseX, baseZ }) => ({ x: baseX, z: baseZ, matrix, color: new THREE.Color(0x14100e) }));
    this.lensSlots = addInstancedChunks(this.detail, new THREE.CircleGeometry(0.19, 20), new THREE.MeshBasicMaterial(), this.groundItems(lensItems));
  }

  /** Street-name boards across every named crossing on the generated map, not just the ~64 signalised
   *  ones — so junctions everywhere read their two street names like the old hand-authored city. Signal
   *  and spawn corners already carry boards via buildTrafficSignals, so those keys are skipped (no double
   *  posts). Each board stays an unmerged, chunk-culled knock-over prop, exactly like the signal signs. */
  private buildStreetSigns(): void {
    const placed = new Set<string>();
    for (const junction of CITY_JUNCTIONS) placed.add(`${junction.x}|${junction.z}`);
    for (const junction of SPAWN_SIGN_JUNCTIONS) placed.add(`${junction.x}|${junction.z}`);
    for (const junction of STREET_SIGN_JUNCTIONS) {
      if (placed.has(`${junction.x}|${junction.z}`)) continue;
      const forward = new THREE.Vector3(Math.sin(junction.angle), 0, Math.cos(junction.angle));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      this.addStreetSigns(junction, forward, right);
    }
  }

  private addSignalPole(position: THREE.Vector3, heading: number, axis: 0 | 1, phase: number, lensTransforms: Array<{ matrix: THREE.Matrix4; baseX: number; baseZ: number }>, mirror = false): void {
    this.props.register('signal', position.x, position.z, 0.24, 5.7); // robots are heavy municipal steel — they stop a bakkie
    const assembly = new THREE.Group(); assembly.position.copy(position); assembly.rotation.y = heading;
    const metal = new THREE.MeshStandardMaterial({ color: 0x273135, metalness: 0.78, roughness: 0.34 });
    const yellow = new THREE.MeshStandardMaterial({ color: 0xe0aa29, metalness: 0.32, roughness: 0.48 });
    const s = mirror ? -1 : 1; // flip the mast arm + head to the pole's other side (keeps the arm over the road) while the lens face (local +Z) is unchanged
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, 5.7, 12), metal); pole.position.y = 2.85;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.13, 0.13), metal); arm.position.set(-2.05 * s, 5.4, 0);
    const head = new THREE.Mesh(new RoundedBoxGeometry(0.72, 2.2, 0.58, 3, 0.09), yellow); head.position.set(-3.95 * s, 4.65, 0);
    const hoodGeometry = new THREE.CylinderGeometry(0.25, 0.25, 0.22, 16, 1, false, Math.PI / 2, Math.PI); // rain hood: the half-arc caps the TOP of the lens (thetaStart 0 put it on the side), projecting forward along +Z
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    const matrix = new THREE.Matrix4(); const one = new THREE.Vector3(1, 1, 1);
    for (const channel of [0, 1, 2] as const) {
      matrix.compose(new THREE.Vector3(-3.95 * s, 5.28 - channel * 0.64, 0.301).applyQuaternion(rotation).add(position), rotation, one);
      lensTransforms.push({ matrix: matrix.clone(), baseX: position.x, baseZ: position.z }); this.lenses.push({ axis, phase, channel });
      const hood = new THREE.Mesh(hoodGeometry, yellow); hood.rotation.set(Math.PI / 2, 0, 0); hood.position.set(-3.95 * s, 5.38 - channel * 0.64, 0.34); assembly.add(hood);
    }
    assembly.add(pole, arm, head); assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(assembly);
  }

  /** Junction anchors sit on real centreline crossings and roads meet at odd angles, so a corner
   *  diagonal can land in a lane. Slide the corner outward along its diagonal until it clears every
   *  road by a solid-prop-safe margin; give up past 12u extra. */
  private clearOfRoad(position: THREE.Vector3, junction: { x: number; z: number }): boolean {
    const diagonal = new THREE.Vector3(position.x - junction.x, 0, position.z - junction.z).normalize();
    for (let slide = 0; slide <= 6; slide++) {
      if (!this.isRoad(position.x, position.z, 2.2)) return true;
      position.addScaledVector(diagonal, 2);
    }
    return false;
  }

  private addStreetSigns(junction: Omit<JunctionDefinition, 'phase'>, forward: THREE.Vector3, right: THREE.Vector3): void {
    const offset = signalCornerOffset(junction.widest);
    const postPosition = new THREE.Vector3(junction.x, 0, junction.z).addScaledVector(forward, offset).addScaledVector(right, offset);
    if (!this.clearOfRoad(postPosition, junction)) return;
    if (this.isBlocked(postPosition.x, postPosition.z, 0.5)) return;
    const assembly = new THREE.Group(); assembly.position.copy(postPosition);
    assembly.position.y = this.surfaceHeight(postPosition.x, postPosition.z); // sit the post on the terrain, not the flat-world plane
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.6, 10), new THREE.MeshStandardMaterial({ color: 0x344044, metalness: 0.68, roughness: 0.4 })); post.position.y = 1.8; assembly.add(post);
    // Each blade runs ALONG the street it names (its face perpendicular to that street, read head-on by that
    // road's traffic) — hence the +90° from the road bearing. Two back-to-back front-side planes give correct,
    // un-mirrored text on both faces (a single double-sided plane shows the back reflected/backwards).
    // Two blades (0.92 tall) stacked ABOVE the 3.6m post, like a real street-name assembly: the lower blade's
    // bottom edge meets the post top (3.6), the upper blade sits directly on top of it — touching, no overlap.
    const labels: Array<[string, number, number]> = [[junction.roadA, junction.angle + Math.PI / 2, 4.98], [junction.roadB, junction.angle + Math.PI, 4.06]];
    for (const [label, angle, y] of labels) {
      for (const flip of [0, Math.PI]) {
        const sign = createSignMesh(new THREE.PlaneGeometry(4.2, 0.92), label, '#f2f4e9', { background: '#176a5a' });
        sign.position.y = y; sign.rotation.y = angle + flip; assembly.add(sign);
      }
    }
    assembly.traverse((object) => { object.userData.dynamic = true; }); // knock-over props stay unmerged so they can tip
    this.detail.group(postPosition.x, postPosition.z).add(assembly); // unmerged, but still distance-culled with its chunk
    this.props.register('sign', postPosition.x, postPosition.z, 0.14, 3.6, { debris: () => assembly });
  }

  private buildRoadsideSigns(): void {
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x7b8380, metalness: 0.68, roughness: 0.38 });
    for (const { x, z, angle, label } of ROADSIDE_SIGNS) {
      if (this.isRoad(x, z, 0.45)) continue;
      const hotspot = label.includes('HOTSPOT');
      const assembly = new THREE.Group(); assembly.position.set(x, this.surfaceHeight(x, z), z); // grounded onto the terrain
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.065, 2.6, 9), poleMaterial); pole.position.y = 1.3; assembly.add(pole);
      const background = label === 'STOP' ? '#b62f2d' : label === 'P' ? '#28619a' : label === 'TAXI' ? '#f2c521' : '#f0eee2';
      const foreground = label === 'STOP' || label === 'P' ? '#ffffff' : '#182326';
      const geometry = label === 'STOP' ? new THREE.CircleGeometry(0.7, 8) : hotspot ? new THREE.PlaneGeometry(2.4, 1.1) : new THREE.PlaneGeometry(1.1, 1.25);
      const sign = createSignMesh(geometry, label, foreground, { background, doubleSide: true });
      sign.position.y = 2.45; sign.rotation.y = angle; assembly.add(sign);
      assembly.traverse((object) => { object.userData.dynamic = true; }); // knock-over props stay unmerged so they can tip
      this.detail.group(x, z).add(assembly); // unmerged, but still distance-culled with its chunk
      this.props.register('sign', x, z, 0.14, 2.6, { debris: () => assembly });
    }
  }

  private buildStreetFurniture(): void {
    const sites = this.roadsidePoints.filter((point, index) => index % 13 === 3 && point.width >= 9 && !this.isBlocked(point.x, point.z, 2) && !this.isRoad(point.x, point.z, 0.7));
    const wood = new THREE.MeshStandardMaterial({ color: 0x744d32, roughness: 0.77 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2c3739, metalness: 0.72, roughness: 0.35 });
    const red = new THREE.MeshStandardMaterial({ color: 0xa8322d, metalness: 0.3, roughness: 0.5 });
    const slatGeometry = new RoundedBoxGeometry(2.25, 0.11, 0.16, 2, 0.035);
    const legGeometry = new THREE.BoxGeometry(0.08, 0.55, 0.5);
    const backGeometry = new RoundedBoxGeometry(2.25, 0.62, 0.1, 2, 0.03);
    const bodyGeometry = new THREE.CylinderGeometry(0.17, 0.23, 0.7, 16);
    const capGeometry = new THREE.SphereGeometry(0.23, 14, 9);
    const identity = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0); const backTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.12);
    const slatItems: InstanceItem[] = []; const legItems: InstanceItem[] = []; const backItems: InstanceItem[] = [];
    const bodyItems: InstanceItem[] = []; const capItems: InstanceItem[] = [];
    const furnitureData: Array<{ yaw: number; bx: number; bz: number; hx: number; hz: number }> = [];
    sites.forEach((site) => {
      const yaw = Math.atan2(site.inwardX, site.inwardZ);
      const rotation = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      const bx = site.x - site.inwardX * 0.8; const bz = site.z - site.inwardZ * 0.8; // benches sit back from the walk line so their 0.85u shell doesn't clip routed peds
      const world = (lx: number, ly: number, lz: number) => new THREE.Vector3(lx, ly, lz).applyQuaternion(rotation).add(new THREE.Vector3(bx, 0, bz));
      for (const lz of [-0.22, 0, 0.22]) slatItems.push({ x: bx, z: bz, matrix: new THREE.Matrix4().compose(world(0, 0.62, lz), rotation, one) });
      for (const lx of [-0.78, 0.78]) legItems.push({ x: bx, z: bz, matrix: new THREE.Matrix4().compose(world(lx, 0.3, 0), rotation, one) });
      backItems.push({ x: bx, z: bz, matrix: new THREE.Matrix4().compose(world(0, 0.98, -0.29), rotation.clone().multiply(backTilt), one) });
      const hx = site.x - site.inwardX * 0.75; const hz = site.z - site.inwardZ * 0.75; // hydrants sit off the walk line so they don't embed spawned peds
      bodyItems.push({ x: hx, z: hz, matrix: new THREE.Matrix4().compose(new THREE.Vector3(hx, 0.36, hz), identity, one) });
      capItems.push({ x: hx, z: hz, matrix: new THREE.Matrix4().compose(new THREE.Vector3(hx, 0.76, hz), identity, one) });
      furnitureData.push({ yaw, bx, bz, hx, hz });
    });
    const slatSlots = addInstancedChunks(this.detail, slatGeometry, wood, this.groundItems(slatItems), { cast: true, receive: true });
    const legSlots = addInstancedChunks(this.detail, legGeometry, metal, this.groundItems(legItems), { cast: true, receive: true });
    const backSlots = addInstancedChunks(this.detail, backGeometry, wood, this.groundItems(backItems), { cast: true, receive: true });
    const bodySlots = addInstancedChunks(this.detail, bodyGeometry, red, this.groundItems(bodyItems), { cast: true, receive: true });
    const capSlots = addInstancedChunks(this.detail, capGeometry, red, this.groundItems(capItems), { cast: true, receive: true });
    furnitureData.forEach(({ yaw, bx, bz, hx, hz }, index) => {
      this.props.register('bench', bx, bz, 0.85, 1.1, {
        hide: () => {
          for (const slot of [0, 1, 2]) hideSlot(slatSlots[index * 3 + slot]!);
          for (const slot of [0, 1]) hideSlot(legSlots[index * 2 + slot]!);
          hideSlot(backSlots[index]!);
        },
        debris: () => {
          const group = new THREE.Group(); group.position.set(bx, this.surfaceHeight(bx, bz), bz); group.rotation.y = yaw;
          for (const lz of [-0.22, 0, 0.22]) { const slat = new THREE.Mesh(slatGeometry, wood); slat.position.set(0, 0.62, lz); group.add(slat); }
          for (const lx of [-0.78, 0.78]) { const leg = new THREE.Mesh(legGeometry, metal); leg.position.set(lx, 0.3, 0); group.add(leg); }
          const back = new THREE.Mesh(backGeometry, wood); back.position.set(0, 0.98, -0.29); back.rotation.x = -0.12; group.add(back);
          group.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
          return group;
        },
      });
      this.props.register('hydrant', hx, hz, 0.24, 0.9, {
        hide: () => { hideSlot(bodySlots[index]!); hideSlot(capSlots[index]!); },
        debris: () => {
          const group = new THREE.Group(); group.position.set(hx, this.surfaceHeight(hx, hz), hz);
          const body = new THREE.Mesh(bodyGeometry, red); body.position.y = 0.36; body.castShadow = true;
          const cap = new THREE.Mesh(capGeometry, red); cap.position.y = 0.76; group.add(body, cap);
          return group;
        },
      });
    });
  }

  /** Municipal litter bins on their own roadside stride (offset from the bench stride so streets
   *  carry both): a ribbed drum + darker lid, instanced per detail chunk, knockable like a hydrant. */
  private buildLitterBins(): void {
    const sites = this.roadsidePoints.filter((point, index) => index % 17 === 8 && point.width >= 9 && !this.isBlocked(point.x, point.z, 1.4) && !this.isRoad(point.x, point.z, 0.7));
    const drum = new THREE.MeshStandardMaterial({ color: 0x3f5c46, metalness: 0.35, roughness: 0.6 });
    const lidMaterial = new THREE.MeshStandardMaterial({ color: 0x22302a, metalness: 0.45, roughness: 0.5 });
    const drumGeometry = new THREE.CylinderGeometry(0.3, 0.26, 0.82, 12);
    const lidGeometry = new THREE.CylinderGeometry(0.33, 0.33, 0.12, 12);
    const identity = new THREE.Quaternion(); const one = new THREE.Vector3(1, 1, 1);
    const drumItems: InstanceItem[] = []; const lidItems: InstanceItem[] = [];
    const binSpots: Array<{ x: number; z: number }> = [];
    sites.forEach((site) => {
      const x = site.x - site.inwardX * 0.7; const z = site.z - site.inwardZ * 0.7; // off the ped walk line, like hydrants
      drumItems.push({ x, z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, 0.41, z), identity, one) });
      lidItems.push({ x, z, matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, 0.88, z), identity, one) });
      binSpots.push({ x, z });
    });
    const drumSlots = addInstancedChunks(this.detail, drumGeometry, drum, this.groundItems(drumItems), { cast: true, receive: true });
    const lidSlots = addInstancedChunks(this.detail, lidGeometry, lidMaterial, this.groundItems(lidItems), { cast: true, receive: true });
    binSpots.forEach(({ x, z }, index) => {
      this.props.register('bin', x, z, 0.34, 0.95, {
        hide: () => { hideSlot(drumSlots[index]!); hideSlot(lidSlots[index]!); },
        debris: () => {
          const group = new THREE.Group(); group.position.set(x, this.surfaceHeight(x, z), z);
          const body = new THREE.Mesh(drumGeometry, drum); body.position.y = 0.41; body.castShadow = true;
          const lid = new THREE.Mesh(lidGeometry, lidMaterial); lid.position.y = 0.88; group.add(body, lid);
          return group;
        },
      });
    });
  }

  private buildEtollGantries(): void {
    const steel = new THREE.MeshStandardMaterial({ color: 0x7d8489, metalness: 0.72, roughness: 0.36 });
    const purple = new THREE.MeshStandardMaterial({ color: 0x4b2e83, metalness: 0.3, roughness: 0.5 });
    for (const gantry of ETOLL_SPOTS) {
      const half = gantry.width / 2 + 3;
      const assembly = new THREE.Group(); assembly.position.set(gantry.x, 0, gantry.z); assembly.rotation.y = gantry.angle;
      for (const side of [-half, half]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 7, 12), steel); post.position.set(side, 3.5, 0); assembly.add(post);
        this.props.register('post', gantry.x + side * Math.cos(gantry.angle), gantry.z - side * Math.sin(gantry.angle), 0.3, 7); // gantry pylons: SANRAL built them to last
      }
      const truss = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 2, 0.9, 1.1), steel); truss.position.y = 6.6; assembly.add(truss);
      for (const x of [-half * 0.5, 0, half * 0.5]) { const camera = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.6), purple); camera.position.set(x, 5.9, 0.3); assembly.add(camera); }
      const board = createSignMesh(new THREE.PlaneGeometry(6, 1.4), 'E-TOLL · SANRAL', '#f2f4e9', { background: '#4b2e83', doubleSide: true });
      board.position.set(0, 6.65, 0.62); assembly.add(board);
      assembly.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
      this.group.add(assembly);
    }
  }

  private buildTransitStops(): void {
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x6e9da3, roughness: 0.16, metalness: 0.08, clearcoat: 0.7, transparent: true, opacity: 0.66 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x293638, metalness: 0.72, roughness: 0.35 });
    for (const { x, z, angle, label } of TRANSIT_STOPS) {
      if (this.isRoad(x, z, 2.8)) continue;
      this.props.register('shelter', x, z, 2.7, 2.9);
      const shelter = new THREE.Group(); shelter.position.set(x, 0, z); shelter.rotation.y = angle;
      const back = new THREE.Mesh(new THREE.BoxGeometry(5.5, 2.7, 0.08), glass); back.position.y = 1.45;
      const roof = new THREE.Mesh(new RoundedBoxGeometry(5.8, 0.16, 1.65, 3, 0.06), metal); roof.position.set(0, 2.9, 0.7);
      const seat = new THREE.Mesh(new RoundedBoxGeometry(3.4, 0.16, 0.55, 2, 0.04), metal); seat.position.set(0, 0.65, 0.42);
      const name = createSignMesh(new THREE.PlaneGeometry(3.8, 0.65), label, '#172023', { background: '#c7982c', powered: true }); name.position.set(0, 2.45, 0.06);
      shelter.add(back, roof, seat, name); shelter.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; }); this.group.add(shelter);
    }
  }
}
