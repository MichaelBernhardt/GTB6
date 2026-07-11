import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  addInstancedChunks, cellDistance, CHUNK_HYSTERESIS, CHUNK_VISIBLE_RANGE, chunkShouldBeVisible,
  ChunkStore, ChunkVisibility, FAR_CHUNK, type InstanceItem,
} from './ChunkVisibility';
import { splitGeometryByCell } from './StaticGeometry';

describe('cellDistance', () => {
  it('is zero inside the cell and measures to the nearest edge outside', () => {
    expect(cellDistance(500, 500, 0, 0, 1000)).toBe(0);
    expect(cellDistance(0, 0, 0, 0, 1000)).toBe(0); // on the corner
    expect(cellDistance(-100, 500, 0, 0, 1000)).toBe(100); // west of the cell
    expect(cellDistance(1200, 500, 0, 0, 1000)).toBe(200); // east of the cell
    expect(cellDistance(-300, -400, 0, 0, 1000)).toBe(500); // diagonal: 3-4-5
    expect(cellDistance(2500, 500, -2, 0, 1000)).toBe(3500); // negative cells
  });
});

describe('chunkShouldBeVisible (hysteresis)', () => {
  it('enters at the range and leaves only beyond range + hysteresis', () => {
    expect(chunkShouldBeVisible(false, CHUNK_VISIBLE_RANGE - 1)).toBe(true);
    expect(chunkShouldBeVisible(false, CHUNK_VISIBLE_RANGE + 1)).toBe(false);
    // Driving on the boundary must not thrash: a visible chunk survives the whole hysteresis band.
    expect(chunkShouldBeVisible(true, CHUNK_VISIBLE_RANGE + CHUNK_HYSTERESIS - 1)).toBe(true);
    expect(chunkShouldBeVisible(true, CHUNK_VISIBLE_RANGE + CHUNK_HYSTERESIS + 1)).toBe(false);
    // And an invisible chunk does not re-enter inside the band.
    expect(chunkShouldBeVisible(false, CHUNK_VISIBLE_RANGE + CHUNK_HYSTERESIS - 1)).toBe(false);
  });
});

describe('ChunkStore + ChunkVisibility', () => {
  it('detaches far chunks, keeps near ones and never touches the far bucket', () => {
    const parent = new THREE.Group();
    const store = new ChunkStore(parent, 1000);
    const near = store.group(500, 500); // cell 0,0
    const far = store.group(9500, 9500); // cell 9,9 — ~12km out
    const horizon = store.farGroup();
    horizon.add(new THREE.Mesh());
    expect(parent.children).toContain(near);
    expect(parent.children).toContain(far);
    const culling = new ChunkVisibility(store);
    culling.update(500, 500, 100);
    expect(near.parent).toBe(parent);
    expect(far.parent).toBeNull();
    expect(horizon.parent).toBe(parent);
    // Walk toward the far chunk: it re-attaches.
    culling.update(9000, 9000, 100);
    expect(far.parent).toBe(parent);
    expect(store.groups.get(FAR_CHUNK)!.parent).toBe(parent);
  });

  it('staggers work across calls but converges over a full pass', () => {
    const parent = new THREE.Group();
    const store = new ChunkStore(parent, 1000);
    for (let cell = 0; cell < 40; cell++) store.group(cell * 1000 + 500, 500);
    const culling = new ChunkVisibility(store, 1500, 200);
    culling.update(500, 500, 10); // only a quarter of the grid tested
    const afterFirst = parent.children.length;
    for (let call = 0; call < 3; call++) culling.update(500, 500, 10);
    const attached = store.groups.size - parent.children.length;
    expect(afterFirst).toBeGreaterThan(parent.children.length); // first slice culled some, full pass culled more
    expect(parent.children.length).toBe(3); // cells 0 and 1 are within 1500 of x=500; cell 2's near edge sits exactly on the range
    expect(attached).toBe(37);
  });
});

describe('addInstancedChunks', () => {
  it('re-buckets instances per cell and returns slots aligned with the input order', () => {
    const parent = new THREE.Group();
    const store = new ChunkStore(parent, 1000);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial();
    const items: InstanceItem[] = [
      { x: 100, z: 100, matrix: new THREE.Matrix4().makeTranslation(100, 0, 100) },
      { x: 5100, z: 100, matrix: new THREE.Matrix4().makeTranslation(5100, 0, 100), color: new THREE.Color(0xff0000) },
      { x: 200, z: 200, matrix: new THREE.Matrix4().makeTranslation(200, 0, 200) },
    ];
    const slots = addInstancedChunks(store, geometry, material, items, { cast: true });
    expect(slots).toHaveLength(3);
    expect(slots[0]!.mesh).toBe(slots[2]!.mesh); // same cell 0,0
    expect(slots[0]!.mesh).not.toBe(slots[1]!.mesh); // cell 5,0 got its own mesh
    expect(slots[0]!.mesh.count).toBe(2);
    expect(slots[1]!.mesh.count).toBe(1);
    expect(slots[0]!.index).toBe(0);
    expect(slots[2]!.index).toBe(1);
    expect(slots[0]!.mesh.castShadow).toBe(true);
    const matrix = new THREE.Matrix4();
    slots[2]!.mesh.getMatrixAt(slots[2]!.index, matrix);
    expect(matrix.elements[12]).toBe(200);
    expect(slots[1]!.mesh.instanceColor).not.toBeNull();
  });
});

describe('splitGeometryByCell', () => {
  it('returns single-cell geometry untouched (fast path)', () => {
    const geometry = new THREE.BoxGeometry(10, 10, 10).toNonIndexed();
    geometry.translate(500, 0, 500);
    const cells = splitGeometryByCell(geometry, 1000);
    expect(cells.size).toBe(1);
    expect(cells.get('0,0')).toBe(geometry);
  });

  it('splits a world-spanning ribbon by triangle centroid, preserving all attributes', () => {
    // Two triangles: one centred in cell 0,0 and one in cell 3,0.
    const position = new Float32Array([
      100, 0, 100, 200, 0, 100, 150, 0, 200, // centroid (150, 133)
      3100, 0, 100, 3200, 0, 100, 3150, 0, 200, // centroid (3150, 133)
    ]);
    const uv = new Float32Array([0, 0, 1, 0, 0.5, 1, 0, 0, 1, 0, 0.5, 1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const cells = splitGeometryByCell(geometry, 1000);
    expect([...cells.keys()].sort()).toEqual(['0,0', '3,0']);
    const west = cells.get('0,0')!;
    expect(west.getAttribute('position').count).toBe(3);
    expect(west.getAttribute('uv').count).toBe(3);
    expect(west.getAttribute('position').getX(0)).toBe(100);
    const east = cells.get('3,0')!;
    expect(east.getAttribute('position').getX(0)).toBe(3100);
    expect(east.getAttribute('uv').getY(2)).toBe(1);
    // No triangle lost: vertex counts add up.
    expect(west.getAttribute('position').count + east.getAttribute('position').count).toBe(6);
  });
});
