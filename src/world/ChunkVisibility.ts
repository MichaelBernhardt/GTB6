import * as THREE from 'three';

/**
 * Scene-level distance culling for the full-city generated map.
 *
 * All static world geometry (merged road/ground/building meshes and per-cell instanced props) is
 * bucketed into per-cell chunk groups on the MERGE_CHUNK_SIZE grid. Each frame a staggered slice of
 * chunks is tested against the player: chunks within CHUNK_VISIBLE_RANGE join the scene, chunks
 * beyond it (plus hysteresis) are detached — geometry stays in memory, so re-entry is free.
 *
 * The 'far' bucket (ground plane, skyline landmarks) is never culled: it is the cheap horizon
 * representation that keeps the world from visibly ending at the chunk radius. Frustum culling and
 * fog handle the rest.
 */

/** Chunks whose nearest edge is inside this range of the player are kept in the scene. */
export const CHUNK_VISIBLE_RANGE = 2500;
/** Extra range a visible chunk keeps before detaching, so boundary driving doesn't thrash. */
export const CHUNK_HYSTERESIS = 200;
/** Street micro-detail (markings, curbs, potholes, furniture, signal lenses…) is sub-pixel long
 *  before this range, so its chunk tier culls much tighter than the world tier. */
export const DETAIL_VISIBLE_RANGE = 1200;
export const DETAIL_HYSTERESIS = 150;
/** Potato (Skorokoro) tier pulls both streaming rings in hard; the denser potato fog (Game's world
 *  budget) is tuned to be near-opaque at the world ring so the pop-in edge hides in the haze. */
export const POTATO_CHUNK_RANGE = 1500;
export const POTATO_DETAIL_RANGE = 700;

/** Key of the always-visible bucket (world ground plane, skyline landmarks). */
export const FAR_CHUNK = 'far';

/** Distance from (x, z) to the nearest point of grid cell (cellX, cellZ): 0 inside the cell. */
export function cellDistance(x: number, z: number, cellX: number, cellZ: number, size: number): number {
  const dx = Math.max(cellX * size - x, 0, x - (cellX + 1) * size);
  const dz = Math.max(cellZ * size - z, 0, z - (cellZ + 1) * size);
  return Math.hypot(dx, dz);
}

/** Hysteretic visibility: enter within `range`, leave only beyond `range + hysteresis`. */
export function chunkShouldBeVisible(currentlyVisible: boolean, distance: number, range = CHUNK_VISIBLE_RANGE, hysteresis = CHUNK_HYSTERESIS): boolean {
  return distance <= (currentlyVisible ? range + hysteresis : range);
}

/** Lazily-created per-cell chunk groups under one parent, all attached until culling runs. */
export class ChunkStore {
  readonly groups = new Map<string, THREE.Group>();

  constructor(readonly parent: THREE.Object3D, readonly size: number) {}

  /** The chunk group owning world position (x, z). */
  group(x: number, z: number): THREE.Group {
    return this.groupForKey(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`);
  }

  /** The always-visible far bucket (ground plane, skyline landmarks). */
  farGroup(): THREE.Group { return this.groupForKey(FAR_CHUNK); }

  groupForKey(key: string): THREE.Group {
    let group = this.groups.get(key);
    if (!group) {
      group = new THREE.Group(); group.name = `chunk ${key}`; group.userData.chunk = true;
      if (key !== FAR_CHUNK) {
        const [cellX, cellZ] = key.split(',').map(Number);
        group.userData.cellX = cellX; group.userData.cellZ = cellZ;
      }
      this.groups.set(key, group); this.parent.add(group);
    }
    return group;
  }
}

/** One instance slot inside a per-cell InstancedMesh — knock-over props hide themselves through it. */
export interface InstanceSlot { mesh: THREE.InstancedMesh; index: number; }

export interface InstanceItem { x: number; z: number; matrix: THREE.Matrix4; color?: THREE.Color; }

/**
 * Per-cell instancing: instead of one world-spanning InstancedMesh (which frustum culling can never
 * discard), items are re-bucketed into one InstancedMesh per chunk cell. Returns a slot per item, in
 * item order, so callers can keep hiding/recoloring individual instances.
 */
export function addInstancedChunks(
  store: ChunkStore,
  geometry: THREE.BufferGeometry,
  material: THREE.Material | THREE.Material[],
  items: readonly InstanceItem[],
  shadows: { cast?: boolean; receive?: boolean } = {},
): InstanceSlot[] {
  const cells = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = `${Math.floor(item.x / store.size)},${Math.floor(item.z / store.size)}`;
    const cell = cells.get(key);
    if (cell) cell.push(index); else cells.set(key, [index]);
  });
  const slots: InstanceSlot[] = new Array(items.length);
  for (const [key, indices] of cells) {
    const mesh = new THREE.InstancedMesh(geometry, material, indices.length);
    indices.forEach((itemIndex, instance) => {
      const item = items[itemIndex]!;
      mesh.setMatrixAt(instance, item.matrix);
      if (item.color) mesh.setColorAt(instance, item.color);
      slots[itemIndex] = { mesh, index: instance };
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (shadows.cast) mesh.castShadow = true;
    if (shadows.receive) mesh.receiveShadow = true;
    store.groupForKey(key).add(mesh);
  }
  return slots;
}

/** Walks the chunk grid a staggered slice per frame, attaching/detaching chunk groups by distance. */
export class ChunkVisibility {
  private keys: string[] = [];
  private cursor = 0;

  constructor(
    private store: ChunkStore,
    private range = CHUNK_VISIBLE_RANGE,
    private hysteresis = CHUNK_HYSTERESIS,
  ) {}

  /** Live range change (quality tier switch): the staggered walk re-evaluates every chunk against
   *  the new ring within a few frames — no rebuild, geometry stays in memory either way. */
  setRange(range: number): void { this.range = range; }

  /** Test up to `budget` chunks against the focus point; call once per frame. */
  update(x: number, z: number, budget = 192): void {
    if (this.keys.length !== this.store.groups.size) { this.keys = [...this.store.groups.keys()]; this.cursor = 0; }
    const count = Math.min(budget, this.keys.length);
    for (let step = 0; step < count; step++) {
      const key = this.keys[this.cursor]!;
      this.cursor = (this.cursor + 1) % this.keys.length;
      if (key === FAR_CHUNK) continue;
      const group = this.store.groups.get(key);
      if (!group) continue;
      const attached = group.parent !== null;
      const distance = cellDistance(x, z, group.userData.cellX as number, group.userData.cellZ as number, this.store.size);
      const wanted = chunkShouldBeVisible(attached, distance, this.range, this.hysteresis);
      if (wanted && !attached) this.store.parent.add(group);
      else if (!wanted && attached) this.store.parent.remove(group);
    }
  }
}
