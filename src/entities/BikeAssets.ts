/**
 * Code-built two-wheeler library — the Blender-free half of the fleet.
 *
 * One template Group per kind is built lazily and cached for the session; every Vehicle gets a
 * `clone(true)` of it, so geometry is shared and only materials are cloned. That is the same
 * contract art/vehicles/README.md states for the authored road cars ("Geometry is shared between
 * instances; materials are cloned per vehicle") and it is what makes the detail below affordable:
 * a courier bike costs one geometry upload for the whole session no matter how many are on screen.
 *
 * Two consequences the callers must honour:
 *  - Object3D.clone() mints new identities, so every handle (wheels, steering, cranks, rider, lamps)
 *    is resolved BY NAME out of the clone. Renaming a part here silently unanimates it.
 *  - Vehicle.dispose() must skip anything in `sharedGeometries` or it frees the template out from
 *    under every other bike on the map.
 *
 * Static parts are merged per material inside each moving group, so a bike is ~12-16 draws rather
 * than one draw per bolt. The moving groups themselves stay separate: wheel_front / wheel_rear spin,
 * `steer` yaws, `crank` pedals, `rider` toggles.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { VEHICLE_SPECS } from '../config';
import { createSignMesh } from '../world/ProceduralMaterials';

export type TwoWheelerKind = 'bicycle' | 'motorbike' | 'courier' | 'superbike';

export interface BikeModelInstance {
  root: THREE.Group;
  /** [front, rear] — each spins on rotation.x only; front is a descendant of steerGroup. */
  wheels: THREE.Object3D[];
  steerGroup: THREE.Group;
  cranks: THREE.Object3D[];
  rider: THREE.Group;
  headLights: THREE.Mesh[];
  brakeLights: THREE.Mesh[];
  /** Rolling radius for the wheel-spin rate — bikes no longer share the road car's 0.36 m fudge. */
  rollRadius: number;
  sharedGeometries: Set<THREE.BufferGeometry>;
  ownedMaterials: Set<THREE.Material>;
}

// ---- Geometry helpers (all mutate-and-return; every geometry here is freshly made) --------------

const UP = new THREE.Vector3(0, 1, 0);
const spanVec = new THREE.Vector3();
const posVec = new THREE.Vector3();
const scaleVec = new THREE.Vector3();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();
const matrix = new THREE.Matrix4();

/** Position / rotate / scale a fresh geometry in one call (scale is applied before rotation). */
function at(
  geometry: THREE.BufferGeometry,
  x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  matrix.compose(posVec.set(x, y, z), quat.setFromEuler(euler.set(rx, ry, rz)), scaleVec.set(sx, sy, sz));
  return geometry.applyMatrix4(matrix);
}

/**
 * Scale-safe rounded box. three's RoundedBoxGeometry derives its corner normals from
 * `0.5 / segments` in the geometry's OWN units, so at metre-fractions (every part on a bike) the
 * corner pass folds vertices through the origin and inverts normals — a 0.30x0.26x0.42 box with
 * segments=1 comes back 0.11 tall with half its normals pointing inward, which renders black.
 * Building at unit scale and scaling afterwards keeps the maths in the range it was written for;
 * `round` is the corner radius as a fraction of the unit cube, so corners stay proportional.
 */
function rbox(w: number, h: number, d: number, round = 0.16, segments = 1): THREE.BufferGeometry {
  const geometry = new RoundedBoxGeometry(1, 1, 1, segments, Math.min(0.48, Math.max(0.02, round)));
  return geometry.scale(w, h, d);
}

/** A straight tube from a to b — the workhorse for frame, forks, stays and stands. */
function rod(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  radiusA: number, radiusB = radiusA, sides = 10,
): THREE.BufferGeometry {
  spanVec.set(bx - ax, by - ay, bz - az);
  const geometry = new THREE.CylinderGeometry(radiusB, radiusA, spanVec.length(), sides, 1, false);
  geometry.applyQuaternion(quat.setFromUnitVectors(UP, spanVec.normalize()));
  geometry.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  return geometry;
}

/** A swept tube through control points — handlebars, exhaust headers, brake cables, grab rails. */
function bent(points: Array<[number, number, number]>, radius: number, sides = 8, segments = 16): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  return new THREE.TubeGeometry(curve, segments, radius, sides, false);
}

/** A wheel-hugging guard: a torus arc squashed into a ribbon, axis along local X. */
function guard(radius: number, width: number, thickness: number, arcStart: number, arcLength: number, segments = 14): THREE.BufferGeometry {
  const geometry = new THREE.TorusGeometry(radius, thickness, 5, segments, arcLength);
  geometry.rotateZ(arcStart);
  return at(geometry, 0, 0, 0, 0, Math.PI / 2, 0, 1, 1, width / (2 * thickness));
}

/** A helical coil — shock springs, which no amount of box stacking ever fakes. */
function coil(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
  coilRadius: number, wire: number, turns: number,
): THREE.BufferGeometry {
  const points: Array<[number, number, number]> = [];
  const steps = Math.round(turns * 6);
  spanVec.set(bx - ax, by - ay, bz - az);
  const axis = spanVec.clone().normalize();
  const side = new THREE.Vector3().crossVectors(axis, Math.abs(axis.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
  const other = new THREE.Vector3().crossVectors(axis, side).normalize();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; const angle = t * turns * Math.PI * 2;
    points.push([
      ax + spanVec.x * t + side.x * Math.cos(angle) * coilRadius + other.x * Math.sin(angle) * coilRadius,
      ay + spanVec.y * t + side.y * Math.cos(angle) * coilRadius + other.y * Math.sin(angle) * coilRadius,
      az + spanVec.z * t + side.z * Math.cos(angle) * coilRadius + other.z * Math.sin(angle) * coilRadius,
    ]);
  }
  return bent(points, wire, 4, steps);
}

// ---- Per-material batching ---------------------------------------------------------------------

/** Collects static geometry per material and flushes one merged mesh each — the draw-call budget. */
class Batch {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    // mergeGeometries needs a consistent index state; RoundedBoxGeometry is the only non-indexed source.
    const indexed = geometry.index ? geometry : mergeVertices(geometry);
    const bucket = this.buckets.get(material);
    if (bucket) bucket.push(indexed); else this.buckets.set(material, [indexed]);
  }

  flush(parent: THREE.Object3D, label: string): THREE.Object3D {
    for (const [material, parts] of this.buckets) {
      const geometry = parts.length === 1 ? parts[0]! : mergeGeometries(parts, false)!;
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${label}_${material.name}`; mesh.castShadow = true;
      parent.add(mesh);
    }
    this.buckets.clear();
    return parent;
  }
}

// ---- Materials ---------------------------------------------------------------------------------

/** Every bike material lives here so instantiate() can clone the lot and re-tint the painted ones. */
interface Palette {
  paint: THREE.MeshPhysicalMaterial;
  dark: THREE.MeshStandardMaterial;
  chrome: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  alloy: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  amber: THREE.MeshStandardMaterial;
  hivis: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
}

const AMBER = 0xd9821f; const AMBER_GLOW = 0x6d3a06;
const LENS = 0xf4edc5; const LENS_GLOW = 0xffe7a0;
const TAIL = 0x5b0808; const TAIL_GLOW = 0x390000;

function tag<T extends THREE.Material>(material: T, name: string, tint = false): T {
  material.name = name;
  if (tint) material.userData.bikeTint = 'paint';
  return material;
}

function palette(colour: number): Palette {
  return {
    paint: tag(new THREE.MeshPhysicalMaterial({ color: colour, metalness: 0.4, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1 }), 'paint', true),
    dark: tag(new THREE.MeshStandardMaterial({ color: 0x1d2124, metalness: 0.42, roughness: 0.5 }), 'dark'),
    chrome: tag(new THREE.MeshStandardMaterial({ color: 0xb9c0c4, metalness: 0.94, roughness: 0.14 }), 'chrome'),
    steel: tag(new THREE.MeshStandardMaterial({ color: 0x8d959a, metalness: 0.82, roughness: 0.36 }), 'steel'),
    alloy: tag(new THREE.MeshStandardMaterial({ color: 0x676e74, metalness: 0.7, roughness: 0.35 }), 'alloy'),
    rubber: tag(new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.88, metalness: 0.02 }), 'rubber'),
    glass: tag(new THREE.MeshPhysicalMaterial({ color: 0x1b2a33, roughness: 0.08, metalness: 0.2, clearcoat: 1, transparent: true, opacity: 0.66 }), 'glass'),
    amber: tag(new THREE.MeshStandardMaterial({ color: AMBER, emissive: AMBER_GLOW, emissiveIntensity: 0.5, roughness: 0.3 }), 'amber'),
    hivis: tag(new THREE.MeshStandardMaterial({ color: 0xc9f52b, roughness: 0.46 }), 'hivis'),
    plate: tag(new THREE.MeshStandardMaterial({ color: 0xe7e4cf, roughness: 0.55 }), 'plate'),
    skin: tag(new THREE.MeshStandardMaterial({ color: 0x8b5b43, roughness: 0.8 }), 'skin'),
    cloth: tag(new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.74 }), 'cloth'),
    helmet: tag(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.3, metalness: 0.2 }), 'helmet', true),
  };
}

// ---- Wheels --------------------------------------------------------------------------------------

interface WheelSpec {
  /** Outer tyre radius = the rolling radius. Both wheels of a bike share it (one spin rate). */
  radius: number;
  /** Tyre carcass radius: the round profile you see from the front. */
  tyre: number;
  /** Tread width across the axle. Wider than 2*tyre gives a flat-shouldered motorcycle tyre. */
  width: number;
  style: 'wire' | 'cast' | 'pressed';
  spokes: number;
  hubRadius: number;
  hubWidth: number;
  knobbly?: boolean;
  /** Brake-disc radius, and which sides carry one. */
  discRadius?: number;
  discSides?: number[];
  /** Rear only: chain sprocket / cassette radius, and which side of the hub it sits on. */
  sprocket?: number;
  sprocketSide?: 1 | -1;
  /** Bicycle cassette: two extra sprockets stepping inward. */
  cassette?: boolean;
  rimMaterial: 'chrome' | 'alloy' | 'steel';
}

/**
 * A wheel in its own frame: the axle is local +X, so Vehicle spins it on rotation.x alone.
 * Tyre / rim+spokes / brake hardware batch into three merged meshes.
 */
function buildWheel(name: string, spec: WheelSpec, M: Palette): THREE.Group {
  const wheel = new THREE.Group(); wheel.name = name;
  const batch = new Batch();
  const rimMaterial = M[spec.rimMaterial];
  const carcass = spec.radius - spec.tyre;
  const stretch = spec.width / (2 * spec.tyre);

  // Tyre: a torus stretched along the axle, so the profile stays round but the tread is flat and wide.
  batch.add(at(new THREE.TorusGeometry(carcass, spec.tyre, 8, 26), 0, 0, 0, 0, Math.PI / 2, 0, 1, 1, stretch), M.rubber);
  if (spec.knobbly) {
    // Two staggered rows of blocks — the whole reason a scrambler reads as a scrambler.
    for (let row = 0; row < 2; row++) for (let i = 0; i < 14; i++) {
      const angle = ((i + row * 0.5) / 14) * Math.PI * 2;
      const block = new THREE.BoxGeometry(spec.width * 0.34, 0.055, 0.055);
      batch.add(at(block, (row - 0.5) * spec.width * 0.42, Math.cos(angle) * (spec.radius - 0.014), Math.sin(angle) * (spec.radius - 0.014), angle, 0, 0), M.rubber);
    }
  }

  // Rim: a lathed section with real flanges and a dropped well, not a flat disc.
  const bead = spec.radius - spec.tyre * 1.85;
  const half = Math.max(0.018, spec.tyre * 0.72);
  const profile = [
    [bead, -half], [bead * 1.035, -half * 0.78], [bead * 0.9, -half * 0.42],
    [bead * 0.9, half * 0.42], [bead * 1.035, half * 0.78], [bead, half],
  ].map(([r, y]) => new THREE.Vector2(r, y!));
  batch.add(at(new THREE.LatheGeometry(profile, 26), 0, 0, 0, 0, 0, Math.PI / 2), rimMaterial);

  // Hub + axle.
  batch.add(at(new THREE.CylinderGeometry(spec.hubRadius, spec.hubRadius, spec.hubWidth, 16), 0, 0, 0, 0, 0, Math.PI / 2), rimMaterial);
  batch.add(at(new THREE.CylinderGeometry(spec.hubRadius * 0.45, spec.hubRadius * 0.45, spec.hubWidth * 1.9, 10), 0, 0, 0, 0, 0, Math.PI / 2), M.steel);

  const inner = bead * 0.88;
  if (spec.style === 'wire') {
    // Cross-laced: alternate hub flanges and tangential offset, which is what makes a real wheel glitter.
    for (let i = 0; i < spec.spokes; i++) {
      const angle = (i / spec.spokes) * Math.PI * 2;
      const side = i % 2 === 0 ? 1 : -1;
      const lace = side * 0.38;
      batch.add(rod(
        side * spec.hubWidth * 0.44, Math.cos(angle) * spec.hubRadius * 0.86, Math.sin(angle) * spec.hubRadius * 0.86,
        0, Math.cos(angle + lace) * inner, Math.sin(angle + lace) * inner,
        spec.radius * 0.011, spec.radius * 0.009, 4,
      ), M.steel);
    }
  } else if (spec.style === 'cast') {
    // Y-spokes: a stem off the hub that forks to two rim landings — the sportbike signature.
    for (let i = 0; i < spec.spokes; i++) {
      const angle = (i / spec.spokes) * Math.PI * 2;
      const forkAngle = Math.PI / spec.spokes * 0.72;
      const midR = inner * 0.55;
      batch.add(rod(0, Math.cos(angle) * spec.hubRadius * 0.7, Math.sin(angle) * spec.hubRadius * 0.7,
        0, Math.cos(angle) * midR, Math.sin(angle) * midR, spec.radius * 0.165, spec.radius * 0.125, 5), rimMaterial);
      for (const branch of [-1, 1]) {
        batch.add(rod(0, Math.cos(angle) * midR, Math.sin(angle) * midR,
          0, Math.cos(angle + branch * forkAngle) * inner, Math.sin(angle + branch * forkAngle) * inner,
          spec.radius * 0.115, spec.radius * 0.085, 5), rimMaterial);
      }
    }
  } else {
    // Pressed steel: broad dished spokes with a raised centre — the cheap commuter wheel.
    for (let i = 0; i < spec.spokes; i++) {
      const angle = (i / spec.spokes) * Math.PI * 2;
      const plate = new THREE.BoxGeometry(spec.hubWidth * 0.5, inner - spec.hubRadius * 0.6, 0.075);
      batch.add(at(plate, 0, Math.cos(angle) * (inner + spec.hubRadius * 0.6) / 2, Math.sin(angle) * (inner + spec.hubRadius * 0.6) / 2, angle, 0, 0), rimMaterial);
    }
    batch.add(at(new THREE.CylinderGeometry(spec.hubRadius * 2.1, spec.hubRadius * 2.1, spec.hubWidth * 0.6, 18), 0, 0, 0, 0, 0, Math.PI / 2), rimMaterial);
  }

  if (spec.discRadius) {
    for (const side of spec.discSides ?? [-1]) {
      const x = side * (spec.hubWidth * 0.5 + 0.022);
      batch.add(at(new THREE.CylinderGeometry(spec.discRadius, spec.discRadius, 0.009, 28), x, 0, 0, 0, 0, Math.PI / 2), M.steel);
      batch.add(at(new THREE.CylinderGeometry(spec.discRadius * 0.46, spec.discRadius * 0.46, 0.016, 16), x, 0, 0, 0, 0, Math.PI / 2), M.dark);
      // Five drilling arcs read as a floating disc without paying for real holes.
      for (let i = 0; i < 5; i++) {
        const angle = (i / 5) * Math.PI * 2;
        batch.add(at(new THREE.BoxGeometry(0.022, 0.05, 0.05), x, Math.cos(angle) * spec.discRadius * 0.66, Math.sin(angle) * spec.discRadius * 0.66, angle, 0, 0), M.dark);
      }
    }
  }
  if (spec.sprocket) {
    const side = spec.sprocketSide ?? -1;
    const x = side * (spec.hubWidth * 0.5 + 0.03);
    batch.add(at(new THREE.CylinderGeometry(spec.sprocket, spec.sprocket, 0.012, 22), x, 0, 0, 0, 0, Math.PI / 2), M.steel);
    batch.add(at(new THREE.TorusGeometry(spec.sprocket, 0.009, 4, 26), x, 0, 0, 0, Math.PI / 2, 0), M.steel);
    if (spec.cassette) for (let i = 1; i <= 2; i++) {
      batch.add(at(new THREE.CylinderGeometry(spec.sprocket - i * 0.011, spec.sprocket - i * 0.011, 0.008, 20), x + side * i * 0.013, 0, 0, 0, 0, Math.PI / 2), M.steel);
    }
  }
  batch.flush(wheel, name);
  return wheel;
}

// ---- Lamps ---------------------------------------------------------------------------------------

/** Headlamp lens: its own mesh + material because setHeadlightGlow writes emissiveIntensity per bike. */
function lamp(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, tag(new THREE.MeshStandardMaterial({ color: LENS, emissive: LENS_GLOW, emissiveIntensity: 1.15, roughness: 0.12 }), 'lamp'));
  mesh.name = 'headlamp'; mesh.castShadow = true;
  return mesh;
}

/** Tail lens: applyBrakeLights writes color.setHex on this material every frame. */
function taillight(geometry: THREE.BufferGeometry): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, tag(new THREE.MeshStandardMaterial({ color: TAIL, emissive: TAIL_GLOW, emissiveIntensity: 1.8, roughness: 0.22 }), 'tail'));
  mesh.name = 'taillight'; mesh.castShadow = true;
  return mesh;
}

// ---- The seated NPC dummy --------------------------------------------------------------------

type P3 = [number, number, number];

/** Place a +Y-long geometry so it spans a..b (used for limbs and the torso). */
function between(geometry: THREE.BufferGeometry, a: P3, b: P3): THREE.BufferGeometry {
  spanVec.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
  geometry.applyQuaternion(quat.setFromUnitVectors(UP, spanVec));
  geometry.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return geometry;
}

const dist = (a: P3, b: P3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
const mid = (a: P3, b: P3, dx = 0, dy = 0, dz = 0): P3 => [(a[0] + b[0]) / 2 + dx, (a[1] + b[1]) / 2 + dy, (a[2] + b[2]) / 2 + dz];

interface RiderSpec {
  /** Rider group origin — spec.saddle, the one lever the frozen player ride clips also use. */
  saddle: [number, number];
  hips: P3;
  /** Right-hand grip and right footrest in BIKE-local space; the dummy is mirrored onto both sides. */
  grip: P3;
  foot: P3;
  lean: number;
  helmet: boolean;
}

/**
 * Built from the bike's own grip and footrest positions rather than hard-coded limb angles, so the
 * dummy's hands are ON the bars and its feet ON the pegs by construction — reposition the bars and
 * the rider follows. (The PLAYER's pose is Blender-baked and cannot; see the geometry notes.)
 */
function buildRider(spec: RiderSpec, M: Palette): THREE.Group {
  const rider = new THREE.Group(); rider.name = 'rider'; rider.visible = false;
  rider.position.set(0, spec.saddle[0], spec.saddle[1]);
  const local = (p: P3): P3 => [p[0], p[1] - spec.saddle[0], p[2] - spec.saddle[1]];
  const batch = new Batch();

  const hips = local(spec.hips);
  const torso = 0.44;
  const shoulders: P3 = [0, hips[1] + Math.cos(spec.lean) * torso, hips[2] + Math.sin(spec.lean) * torso];
  batch.add(between(rbox(0.40, torso * 1.06, 0.25, 0.14, 1), hips, shoulders), M.cloth);
  batch.add(at(new THREE.SphereGeometry(0.115, 10, 6), 0, hips[1] + 0.03, hips[2] - 0.02, 0, 0, 0, 1.5, 0.7, 1.1), M.cloth);

  const neck: P3 = [0, shoulders[1] + 0.09, shoulders[2] + 0.02];
  const headY = neck[1] + 0.15; const headZ = neck[2] + Math.sin(spec.lean) * 0.14;
  if (spec.helmet) {
    batch.add(at(new THREE.SphereGeometry(0.135, 12, 9), 0, headY, headZ), M.helmet);
    batch.add(at(new THREE.SphereGeometry(0.128, 12, 5, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.3), 0, headY, headZ + 0.03, -0.3, 0, 0, 1, 1, 1.06), M.dark);
  } else {
    batch.add(at(new THREE.SphereGeometry(0.115, 11, 8), 0, headY, headZ), M.skin);
    batch.add(at(new THREE.SphereGeometry(0.122, 11, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), 0, headY - 0.005, headZ), M.cloth); // beanie
  }

  for (const side of [-1, 1]) {
    const shoulder: P3 = [side * 0.19, shoulders[1] - 0.02, shoulders[2]];
    const hand: P3 = local([side * spec.grip[0], spec.grip[1] + 0.035, spec.grip[2]]);
    const elbow = mid(shoulder, hand, side * 0.07, -0.09, -0.04);
    batch.add(between(new THREE.CapsuleGeometry(0.058, Math.max(0.05, dist(shoulder, elbow) - 0.09), 2, 7), shoulder, elbow), M.cloth);
    batch.add(between(new THREE.CapsuleGeometry(0.05, Math.max(0.05, dist(elbow, hand) - 0.09), 2, 7), elbow, hand), M.cloth);
    batch.add(at(new THREE.SphereGeometry(0.055, 7, 5), hand[0], hand[1], hand[2]), M.dark);

    const hip: P3 = [side * 0.125, hips[1] - 0.02, hips[2]];
    const boot: P3 = local([side * spec.foot[0], spec.foot[1] + 0.05, spec.foot[2]]);
    const knee = mid(hip, boot, side * 0.035, 0.07, 0.17);
    batch.add(between(new THREE.CapsuleGeometry(0.082, Math.max(0.05, dist(hip, knee) - 0.13), 2, 7), hip, knee), M.cloth);
    batch.add(between(new THREE.CapsuleGeometry(0.066, Math.max(0.05, dist(knee, boot) - 0.11), 2, 7), knee, boot), M.cloth);
    batch.add(at(rbox(0.095, 0.075, 0.21, 0.14, 1), boot[0], boot[1] - 0.03, boot[2] + 0.03), M.dark);
  }
  batch.flush(rider, 'rider');
  return rider;
}

// ---- Kasi Cruiser: an upright township commuter bicycle ----------------------------------------

/**
 * Swept-back bars, mudguards, a rear rack, a real drivetrain. The bar sweep is not just styling:
 * the frozen ride_bicycle clip puts the player's hands at bike-local (±0.24, 1.085, 0.20), which is
 * where a cruiser's grips actually are and nowhere near where a flat bar over the axle would be.
 */
function buildBicycle(M: Palette): THREE.Group {
  const root = new THREE.Group();
  const R = 0.34; const axleZ = 1.85 * 0.36;
  const wheel = (name: string): WheelSpec => ({
    radius: R, tyre: 0.032, width: 0.046, style: 'wire', spokes: 20, hubRadius: 0.03, hubWidth: 0.085,
    rimMaterial: 'chrome', sprocket: name === 'wheel_rear' ? 0.05 : undefined, sprocketSide: 1, cassette: true,
  });

  const rear = buildWheel('wheel_rear', wheel('wheel_rear'), M); rear.position.set(0, R, -axleZ);
  const steer = new THREE.Group(); steer.name = 'steer'; steer.position.set(0, R, axleZ);
  const front = buildWheel('wheel_front', wheel('wheel_front'), M); steer.add(front);

  // ---- Front end (turns with the bars) ----
  const S = new Batch();
  for (const side of [-1, 1]) S.add(rod(side * 0.048, 0, 0, side * 0.03, 0.35, -0.115, 0.016, 0.013), M.paint); // fork blades
  S.add(rod(-0.05, 0.355, -0.12, 0.05, 0.355, -0.12, 0.019), M.paint); // crown
  S.add(rod(0, 0.35, -0.118, 0, 0.675, -0.222, 0.015, 0.015, 10), M.chrome); // steerer + quill stem
  S.add(rod(0, 0.672, -0.222, 0, 0.692, -0.272, 0.017), M.chrome);
  S.add(bent([
    [-0.235, 0.715, -0.441], [-0.155, 0.700, -0.336], [-0.055, 0.692, -0.276],
    [0.055, 0.692, -0.276], [0.155, 0.700, -0.336], [0.235, 0.715, -0.441],
  ], 0.0155, 7, 15), M.chrome); // swept cruiser bar
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.185, 0.706, -0.412, side * 0.243, 0.717, -0.451, 0.021, 0.021, 10), M.rubber); // grip
    S.add(at(new THREE.BoxGeometry(0.022, 0.02, 0.10), side * 0.163, 0.687, -0.386, 0.35, side * 0.3, 0), M.chrome); // brake lever
    S.add(bent([[side * 0.152, 0.694, -0.382], [side * 0.075, 0.660, -0.268], [side * 0.03, 0.500, -0.155], [side * 0.028, 0.320, -0.052]], 0.0055, 4, 9), M.dark); // cable
  }
  S.add(at(new THREE.SphereGeometry(0.028, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 0.095, 0.706, -0.306), M.chrome); // bell
  S.add(rod(-0.03, 0.30, -0.028, 0.03, 0.30, -0.028, 0.014), M.dark); // brake caliper bridge
  for (const side of [-1, 1]) S.add(at(new THREE.BoxGeometry(0.018, 0.055, 0.03), side * 0.03, 0.283, -0.022), M.dark);
  S.add(guard(R + 0.032, 0.075, 0.017, 0.38, 2.2), M.paint); // fork-mounted front guard
  for (const side of [-1, 1]) S.add(rod(side * 0.042, 0.02, 0.01, side * 0.03, R * 0.72, R * 0.62, 0.005, 0.005, 5), M.steel); // guard stays
  S.flush(steer, 'front');

  // ---- Frame ----
  const F = new Batch();
  const bb: P3 = [0, 0.30, -0.11];
  F.add(rod(0, 0.694, 0.548, 0, 0.929, 0.474, 0.029), M.paint); // head tube
  F.add(rod(0, 0.685, 0.535, bb[0], bb[1] + 0.008, bb[2] + 0.045, 0.024, 0.021), M.paint); // down tube
  F.add(rod(0, 0.905, 0.470, 0, 0.968, -0.252, 0.021), M.paint); // top tube
  F.add(rod(bb[0], bb[1] + 0.005, bb[2] + 0.005, 0, 1.005, -0.266, 0.021), M.paint); // seat tube
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.045, bb[1], bb[2] - 0.02, side * 0.048, R, -axleZ + 0.02, 0.016, 0.012), M.paint); // chainstay
    F.add(rod(side * 0.022, 0.965, -0.258, side * 0.048, R + 0.006, -axleZ + 0.02, 0.013, 0.011), M.paint); // seat stay
  }
  F.add(rod(-0.045, bb[1], bb[2], 0.045, bb[1], bb[2], 0.028), M.chrome); // bottom bracket shell
  F.add(rod(0, 0.975, -0.260, 0, 1.060, -0.285, 0.014, 0.014, 10), M.chrome); // seatpost
  F.add(at(rbox(0.145, 0.05, 0.24, 0.09, 1), 0, 1.078, -0.315, 0.07, 0, 0), M.dark); // saddle
  F.add(at(rbox(0.07, 0.042, 0.17, 0.11, 1), 0, 1.062, -0.185, 0.1, 0, 0), M.dark); // saddle nose
  F.add(guard(R + 0.032, 0.075, 0.017, -0.30, 2.25).translate(0, R, -axleZ), M.paint); // rear guard
  F.add(rod(0, 0.66, -axleZ + 0.05, 0, 0.66, -axleZ - 0.05, 0.013), M.dark); // rear caliper
  F.add(bent([[0, 0.92, 0.44], [0, 1.00, 0.02], [0, 0.99, -0.28], [0, 0.70, -0.60]], 0.0055, 4, 10), M.dark); // rear cable

  // Rear rack — the thing every township commuter actually carries a passenger on.
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.078, 0.790, -0.50, side * 0.078, 0.800, -0.86, 0.008, 0.008, 6), M.steel);
    F.add(rod(side * 0.078, 0.796, -0.84, side * 0.052, R + 0.02, -axleZ - 0.02, 0.007, 0.007, 6), M.steel);
    F.add(rod(side * 0.078, 0.790, -0.52, side * 0.026, 0.965, -0.27, 0.007, 0.007, 6), M.steel);
  }
  for (const z of [-0.53, -0.69, -0.84]) F.add(rod(-0.078, 0.795, z, 0.078, 0.797, z, 0.007, 0.007, 6), M.steel);

  // Drivetrain: chainring, chain runs, derailleur.
  F.add(at(new THREE.CylinderGeometry(0.086, 0.086, 0.005, 22), 0.058, bb[1], bb[2], 0, 0, Math.PI / 2), M.chrome);
  F.add(at(new THREE.TorusGeometry(0.092, 0.007, 4, 26), 0.058, bb[1], bb[2], 0, Math.PI / 2, 0), M.steel);
  F.add(at(new THREE.BoxGeometry(0.011, 0.013, 0.505), 0.058, bb[1] + 0.09, (bb[2] - axleZ) / 2 + 0.005), M.steel); // top run
  F.add(rod(0.058, bb[1] - 0.086, bb[2] - 0.01, 0.058, 0.252, -0.585, 0.007, 0.007, 5), M.steel); // bottom run
  F.add(at(new THREE.BoxGeometry(0.03, 0.10, 0.06), 0.062, 0.255, -0.615), M.dark); // derailleur cage
  for (const y of [0.222, 0.292]) F.add(at(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 10), 0.062, y, -0.615, 0, 0, Math.PI / 2), M.steel);
  F.add(at(new THREE.BoxGeometry(0.05, 0.035, 0.014), 0, 0.755, -0.875), M.amber); // rear reflector
  F.flush(root, 'frame');

  // ---- Cranks (the only pedalling part) ----
  const crank = new THREE.Group(); crank.name = 'crank'; crank.position.set(bb[0], bb[1], bb[2]);
  const C = new Batch();
  for (const side of [-1, 1]) {
    C.add(at(rbox(0.024, 0.21, 0.035, 0.05, 1), side * 0.058, side * 0.085, 0), M.chrome); // crank arm
    C.add(rod(side * 0.058, side * 0.17, 0, side * 0.175, side * 0.17, 0, 0.008, 0.008, 6), M.steel); // pedal spindle
    C.add(at(new THREE.BoxGeometry(0.115, 0.02, 0.078), side * 0.172, side * 0.17, 0), M.dark); // pedal body
    C.add(at(new THREE.BoxGeometry(0.02, 0.012, 0.05), side * 0.222, side * 0.17, 0), M.amber); // pedal reflector
  }
  C.flush(crank, 'crank');

  root.add(rear, steer, crank);
  root.add(buildRider({ saddle: VEHICLE_SPECS.bicycle.saddle!, hips: [0, 1.04, -0.30], grip: [0.235, 1.055, 0.225], foot: [0.20, 0.45, -0.13], lean: 0.26, helmet: false }, M));
  return root;
}

// ---- Soweto Scrambler: tall, knobbly, air-and-water-cooled dual-sport --------------------------

function buildScrambler(M: Palette): { root: THREE.Group; lamp: THREE.Mesh; tail: THREE.Mesh } {
  const root = new THREE.Group();
  const R = 0.32; const axleZ = 2.25 * 0.36;
  const wheelOf = (rearWheel: boolean): WheelSpec => ({
    radius: R, tyre: 0.088, width: 0.135, style: 'wire', spokes: 24, hubRadius: 0.07, hubWidth: 0.14,
    rimMaterial: 'alloy', knobbly: true, discRadius: rearWheel ? 0.135 : 0.185, discSides: [-1],
    sprocket: rearWheel ? 0.105 : undefined, sprocketSide: -1,
  });

  const rear = buildWheel('wheel_rear', wheelOf(true), M); rear.position.set(0, R, -axleZ);
  const steer = new THREE.Group(); steer.name = 'steer'; steer.position.set(0, R, axleZ);
  steer.add(buildWheel('wheel_front', wheelOf(false), M));

  // ---- Front end ----
  const S = new Batch();
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.105, 0.005, 0, side * 0.105, 0.30, -0.098, 0.036, 0.032), M.dark); // slider
    S.add(rod(side * 0.105, 0.27, -0.089, side * 0.105, 0.635, -0.208, 0.0245, 0.0245, 12), M.chrome); // stanchion
    S.add(at(new THREE.BoxGeometry(0.045, 0.075, 0.06), side * 0.105, 0.30, -0.098), M.dark); // seal head
  }
  S.add(at(rbox(0.30, 0.048, 0.095, 0.06, 1), 0, 0.445, -0.152), M.alloy); // lower yoke
  S.add(at(rbox(0.275, 0.042, 0.09, 0.06, 1), 0, 0.615, -0.208), M.alloy); // upper yoke
  S.add(rod(0, 0.40, -0.135, 0, 0.66, -0.218, 0.026, 0.026, 10), M.dark); // steerer
  S.add(bent([
    [-0.25, 0.805, -0.505], [-0.175, 0.760, -0.398], [-0.07, 0.672, -0.246],
    [0.07, 0.672, -0.246], [0.175, 0.760, -0.398], [0.25, 0.805, -0.505],
  ], 0.019, 7, 15), M.alloy); // wide scrambler bar
  S.add(rod(-0.115, 0.735, -0.335, 0.115, 0.735, -0.335, 0.0155, 0.0155, 8), M.alloy); // crossbar
  S.add(at(new THREE.BoxGeometry(0.14, 0.045, 0.05), 0, 0.742, -0.335), M.rubber); // bar pad
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.185, 0.782, -0.470, side * 0.244, 0.800, -0.502, 0.024, 0.024, 10), M.rubber); // grip
    S.add(at(new THREE.BoxGeometry(0.024, 0.018, 0.115), side * 0.152, 0.762, -0.418, 0.28, side * 0.34, 0), M.alloy); // lever
    S.add(rod(side * 0.155, 0.790, -0.430, side * 0.298, 0.865, -0.395, 0.010, 0.010, 6), M.dark); // mirror stalk
    S.add(at(new THREE.BoxGeometry(0.115, 0.075, 0.018), side * 0.305, 0.878, -0.392, 0, side * -0.45, 0.15), M.dark);
    S.add(at(new THREE.BoxGeometry(0.10, 0.062, 0.008), side * 0.307, 0.878, -0.384, 0, side * -0.45, 0.15), M.chrome); // mirror glass
    S.add(rod(side * 0.135, 0.505, -0.20, side * 0.225, 0.545, -0.20, 0.009, 0.009, 6), M.dark); // indicator stalk
    S.add(at(new THREE.SphereGeometry(0.032, 8, 6), side * 0.238, 0.549, -0.20, 0, 0, 0, 1, 1, 0.7), M.amber);
  }
  // Round headlamp with a scrambler stone guard.
  S.add(at(new THREE.CylinderGeometry(0.108, 0.098, 0.11, 18), 0, 0.535, -0.055, Math.PI / 2, 0, 0), M.dark);
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI;
    S.add(rod(Math.cos(angle) * 0.10, 0.535 + Math.sin(angle) * 0.10, 0.012, -Math.cos(angle) * 0.10, 0.535 - Math.sin(angle) * 0.10, 0.012, 0.006, 0.006, 5), M.chrome);
  }
  S.add(at(new THREE.TorusGeometry(0.104, 0.008, 4, 20), 0, 0.535, 0.012, 0, 0, 0), M.chrome);
  // High-mounted front guard, fork braced.
  S.add(guard(R + 0.115, 0.16, 0.026, 0.50, 1.55), M.paint);
  for (const side of [-1, 1]) S.add(rod(side * 0.10, 0.28, -0.085, side * 0.082, R + 0.075, 0.09, 0.008, 0.008, 5), M.steel); // guard stays
  S.add(at(new THREE.BoxGeometry(0.05, 0.10, 0.075), -0.145, 0.155, -0.088, 0, 0, -0.35), M.alloy); // brake caliper
  S.flush(steer, 'front');
  const lampMesh = lamp(at(new THREE.SphereGeometry(0.098, 16, 7, 0, Math.PI * 2, 0, Math.PI * 0.5), 0, 0.535, -0.002, Math.PI / 2, 0, 0, 1, 0.42, 1));
  steer.add(lampMesh); // fork-mounted on a scrambler: it turns with the bars

  // ---- Frame, engine, running gear ----
  const F = new Batch();
  const pivot: P3 = [0, 0.455, -0.16];
  F.add(rod(0, 0.775, 0.652, 0, 0.945, 0.596, 0.048), M.dark); // headstock
  F.add(rod(0, 0.79, 0.632, 0, 0.42, 0.29, 0.028, 0.024), M.dark); // down tube
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.062, 0.905, 0.60, side * 0.085, 0.845, 0.02, 0.024, 0.024), M.dark); // spine
    F.add(rod(side * 0.085, 0.845, 0.02, pivot[0] + side * 0.088, pivot[1] + 0.02, pivot[2] + 0.02, 0.023, 0.023), M.dark);
    F.add(rod(0, 0.44, 0.26, side * 0.09, 0.335, 0.03, 0.021, 0.021), M.dark); // cradle
    F.add(rod(side * 0.09, 0.335, 0.03, pivot[0] + side * 0.09, pivot[1] - 0.05, pivot[2], 0.021, 0.021), M.dark);
    F.add(rod(side * 0.082, 0.795, -0.06, side * 0.092, 0.815, -0.78, 0.019, 0.017), M.dark); // subframe
    F.add(rod(side * 0.090, 0.805, -0.66, side * 0.088, 0.585, -0.36, 0.016, 0.016), M.dark);
    F.add(at(rbox(0.03, 0.16, 0.13, 0.08, 1), pivot[0] + side * 0.10, pivot[1], pivot[2]), M.alloy); // pivot plate
    // Airbox side cover: without it the frame's rear triangle is an empty hole you can see the road through.
    F.add(at(rbox(0.055, 0.26, 0.40, 0.06, 1), side * 0.098, 0.685, -0.30, 0.06, side * 0.05, 0), M.paint);
    F.add(at(rbox(0.06, 0.075, 0.16, 0.12, 1), side * 0.104, 0.60, -0.15), M.dark); // cover vent
  }
  // Engine: crankcase, finned barrel, head, clutch cover.
  F.add(at(rbox(0.30, 0.24, 0.40, 0.15, 1), 0, 0.465, 0.03), M.dark);
  F.add(at(rbox(0.20, 0.22, 0.19, 0.14, 1), 0, 0.655, 0.135, -0.32, 0, 0), M.alloy);
  for (let i = 0; i < 5; i++) F.add(at(rbox(0.235, 0.011, 0.225, 0.04, 1), 0, 0.585 + i * 0.036, 0.113 + i * 0.012, -0.32, 0, 0), M.alloy);
  F.add(at(rbox(0.215, 0.085, 0.20, 0.14, 1), 0, 0.775, 0.185, -0.32, 0, 0), M.alloy); // head cover
  F.add(at(new THREE.CylinderGeometry(0.105, 0.105, 0.055, 18), 0.16, 0.455, 0.0, 0, 0, Math.PI / 2), M.chrome); // clutch cover
  F.add(at(rbox(0.26, 0.022, 0.36, 0.04, 1), 0, 0.312, 0.04, 0.06, 0, 0), M.alloy); // bash plate
  // Radiator with slats.
  F.add(at(rbox(0.255, 0.235, 0.05, 0.06, 1), 0, 0.60, 0.375), M.dark);
  for (let i = 0; i < 7; i++) F.add(at(new THREE.BoxGeometry(0.235, 0.012, 0.012), 0, 0.505 + i * 0.031, 0.402), M.steel);
  // Fuel tank: a lathed teardrop, not a box.
  const tankProfile: Array<[number, number]> = [[0.02, -0.30], [0.10, -0.20], [0.155, -0.03], [0.16, 0.12], [0.115, 0.26], [0.02, 0.31]];
  F.add(at(new THREE.LatheGeometry(tankProfile.map(([r, y]) => new THREE.Vector2(r, y)), 20), 0, 0.865, 0.245, Math.PI / 2, 0, 0, 1.02, 1, 0.72), M.paint);
  F.add(at(new THREE.CylinderGeometry(0.038, 0.042, 0.022, 14), 0, 0.955, 0.33), M.chrome); // filler cap
  // Seat.
  F.add(at(rbox(0.27, 0.095, 0.72, 0.06, 1), 0, 0.855, -0.33, -0.035, 0, 0), M.rubber);
  F.add(at(rbox(0.235, 0.055, 0.22, 0.09, 1), 0, 0.885, 0.035, -0.10, 0, 0), M.rubber); // seat nose over the tank join
  // Swingarm + monoshock.
  for (const side of [-1, 1]) F.add(rod(pivot[0] + side * 0.095, pivot[1] - 0.01, pivot[2], side * 0.082, R, -axleZ, 0.035, 0.024), M.alloy);
  F.add(rod(-0.09, 0.40, -0.44, 0.09, 0.40, -0.44, 0.022, 0.022, 8), M.alloy);
  F.add(rod(0, 0.80, -0.355, 0, 0.435, -0.46, 0.021, 0.021, 8), M.dark);
  F.add(coil(0, 0.775, -0.362, 0, 0.475, -0.448, 0.044, 0.0095, 7), M.steel);
  // Chain and sprockets.
  F.add(at(new THREE.CylinderGeometry(0.052, 0.052, 0.018, 16), -0.10, pivot[1] - 0.015, pivot[2] + 0.03, 0, 0, Math.PI / 2), M.steel);
  F.add(at(new THREE.BoxGeometry(0.013, 0.016, 0.60), -0.10, 0.42, -0.48), M.steel);
  F.add(at(new THREE.BoxGeometry(0.013, 0.016, 0.60), -0.10, 0.265, -0.50), M.steel);
  F.add(at(rbox(0.055, 0.035, 0.30, 0.04, 1), -0.10, 0.455, -0.34), M.paint); // chain guard
  // Exhaust: header sweeping to a high muffler.
  F.add(bent([[0.075, 0.735, 0.28], [0.125, 0.50, 0.40], [0.165, 0.365, 0.14], [0.19, 0.44, -0.30], [0.205, 0.585, -0.62]], 0.0265, 8, 16), M.chrome);
  F.add(at(new THREE.CylinderGeometry(0.062, 0.054, 0.42, 16), 0.205, 0.665, -0.79, Math.PI / 2 - 0.20, 0, 0), M.chrome);
  F.add(at(new THREE.CylinderGeometry(0.072, 0.072, 0.28, 14, 1, true, -1.2, 2.4), 0.205, 0.675, -0.75, Math.PI / 2 - 0.20, 0, 0), M.steel); // heat shield
  // Tail: guard, plate, grab rails.
  F.add(guard(R + 0.06, 0.185, 0.028, 0.05, 1.35).translate(0, R, -axleZ), M.paint);
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.098, 0.868, -0.62, side * 0.105, 0.878, -0.88, 0.014, 0.014, 8), M.alloy); // grab rail
    F.add(rod(side * 0.055, 0.82, -0.93, side * 0.115, 0.845, -0.95, 0.008, 0.008, 5), M.dark);
    F.add(at(new THREE.SphereGeometry(0.030, 8, 6), side * 0.125, 0.847, -0.95, 0, 0, 0, 1, 1, 0.7), M.amber);
    F.add(rod(side * 0.30, 0.335, -0.19, side * 0.115, 0.415, -0.165, 0.016, 0.016, 8), M.alloy); // peg hanger
    F.add(at(new THREE.BoxGeometry(0.055, 0.028, 0.115), side * 0.305, 0.325, -0.19), M.steel); // footpeg
  }
  F.add(at(rbox(0.175, 0.115, 0.012, 0.04, 1), 0, 0.705, -0.995, -0.30, 0, 0), M.plate); // number plate
  F.add(rod(0, 0.80, -0.93, 0, 0.70, -0.99, 0.010, 0.010, 6), M.dark);
  F.add(at(new THREE.BoxGeometry(0.10, 0.06, 0.10), 0, 0.845, -0.905), M.dark); // tail light housing
  F.add(at(new THREE.BoxGeometry(0.10, 0.028, 0.12), 0.215, 0.365, 0.05, 0, 0, -0.25), M.alloy); // rear brake pedal
  F.add(at(new THREE.BoxGeometry(0.09, 0.026, 0.11), -0.215, 0.355, 0.02, 0, 0, 0.25), M.alloy); // gear lever
  F.add(at(new THREE.BoxGeometry(0.05, 0.10, 0.075), -0.115, 0.415, -0.71, 0, 0, 0.4), M.alloy); // rear caliper
  F.flush(root, 'frame');

  const tailMesh = taillight(at(new THREE.BoxGeometry(0.085, 0.05, 0.02), 0, 0.845, -0.96));
  root.add(rear, steer, tailMesh);
  root.add(buildRider({ saddle: VEHICLE_SPECS.motorbike.saddle!, hips: [0, 0.90, -0.27], grip: [0.25, 1.12, 0.30], foot: [0.30, 0.34, -0.19], lean: 0.30, helmet: true }, M));
  return { root, lamp: lampMesh, tail: tailMesh };
}

/** A curved body panel with real thickness: a closed profile swept about the vertical axis. */
function shell(radius: number, halfHeight: number, thickness: number, sweep: number, segments = 14): THREE.BufferGeometry {
  const profile = [
    new THREE.Vector2(radius, -halfHeight), new THREE.Vector2(radius, halfHeight),
    new THREE.Vector2(radius - thickness, halfHeight), new THREE.Vector2(radius - thickness, -halfHeight),
    new THREE.Vector2(radius, -halfHeight),
  ];
  return new THREE.LatheGeometry(profile, segments, -sweep / 2, sweep);
}

// ---- Sixty-Sekonds Delivery Bike: a step-through commuter that works for a living ---------------

function buildCourier(M: Palette): { root: THREE.Group; lamp: THREE.Mesh; tail: THREE.Mesh } {
  const root = new THREE.Group();
  const R = 0.27; const axleZ = 2.30 * 0.36;
  const wheelOf = (rearWheel: boolean): WheelSpec => ({
    radius: R, tyre: 0.072, width: 0.10, style: 'pressed', spokes: 6, hubRadius: 0.055, hubWidth: 0.11,
    rimMaterial: 'steel', discRadius: rearWheel ? undefined : 0.125, discSides: [-1],
    sprocket: rearWheel ? 0.095 : undefined, sprocketSide: -1,
  });

  const rear = buildWheel('wheel_rear', wheelOf(true), M); rear.position.set(0, R, -axleZ);
  const steer = new THREE.Group(); steer.name = 'steer'; steer.position.set(0, R, axleZ);
  steer.add(buildWheel('wheel_front', wheelOf(false), M));

  const S = new Batch();
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.09, 0.005, 0, side * 0.09, 0.31, -0.10, 0.03, 0.026), M.dark); // fork leg
    S.add(rod(side * 0.09, 0.29, -0.094, side * 0.075, 0.60, -0.196, 0.021, 0.021, 12), M.chrome);
  }
  S.add(at(rbox(0.24, 0.045, 0.085, 0.07, 1), 0, 0.42, -0.135), M.alloy);
  S.add(rod(0, 0.40, -0.13, 0, 0.72, -0.235, 0.024, 0.024, 10), M.dark); // steerer
  S.add(bent([
    [-0.25, 0.855, -0.512], [-0.175, 0.815, -0.408], [-0.07, 0.745, -0.262],
    [0.07, 0.745, -0.262], [0.175, 0.815, -0.408], [0.25, 0.855, -0.512],
  ], 0.0175, 7, 15), M.dark); // upright commuter bar
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.185, 0.833, -0.478, side * 0.244, 0.851, -0.509, 0.023, 0.023, 10), M.rubber);
    S.add(at(new THREE.BoxGeometry(0.022, 0.017, 0.11), side * 0.152, 0.815, -0.428, 0.26, side * 0.33, 0), M.chrome);
    S.add(rod(side * 0.15, 0.845, -0.44, side * 0.30, 0.945, -0.40, 0.010, 0.010, 6), M.dark); // long delivery mirrors
    S.add(at(new THREE.BoxGeometry(0.10, 0.135, 0.018), side * 0.305, 0.955, -0.398, 0, side * -0.42, 0), M.dark);
    S.add(at(new THREE.BoxGeometry(0.086, 0.118, 0.008), side * 0.307, 0.955, -0.390, 0, side * -0.42, 0), M.chrome);
  }
  S.add(at(new THREE.BoxGeometry(0.085, 0.13, 0.024), 0, 0.82, -0.20, -0.5, 0, 0), M.dark); // phone cradle
  S.add(at(rbox(0.20, 0.135, 0.10, 0.17, 1), 0, 0.605, -0.045), M.paint); // headlamp nacelle
  S.add(at(shell(0.24, 0.115, 0.014, 1.5, 12), 0, 0.845, -0.30, -0.22, 0, 0), M.glass); // windscreen
  for (const side of [-1, 1]) S.add(rod(side * 0.10, 0.70, -0.20, side * 0.13, 0.80, -0.235, 0.008, 0.008, 6), M.chrome);
  S.add(guard(R + 0.055, 0.125, 0.011, 0.10, 2.3), M.paint); // close-fitting front guard
  S.add(at(new THREE.BoxGeometry(0.045, 0.09, 0.07), -0.125, 0.115, -0.075, 0, 0, -0.3), M.alloy);
  S.flush(steer, 'front');
  const lampMesh = lamp(at(rbox(0.155, 0.10, 0.03, 0.08, 1), 0, 0.605, 0.012));
  steer.add(lampMesh);

  const F = new Batch();
  const pivot: P3 = [0, 0.365, -0.30];
  F.add(rod(0, 0.735, 0.665, 0, 0.905, 0.61, 0.042), M.dark); // headstock
  F.add(rod(0, 0.75, 0.648, 0, 0.365, 0.36, 0.03, 0.026), M.dark);
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.09, 0.30, 0.33, side * 0.09, 0.30, -0.26, 0.024, 0.024), M.dark); // floor rail
    F.add(rod(side * 0.09, 0.30, -0.26, side * 0.086, 0.665, -0.50, 0.024, 0.022), M.dark);
    F.add(rod(side * 0.086, 0.665, -0.50, side * 0.092, 0.755, -0.92, 0.019, 0.017), M.dark);
    F.add(at(rbox(0.155, 0.022, 0.42, 0.04, 1), side * 0.255, 0.302, -0.15), M.steel); // floorboard
    F.add(rod(side * 0.09, 0.30, -0.15, side * 0.235, 0.302, -0.15, 0.014, 0.014, 6), M.steel);
    F.add(rod(pivot[0] + side * 0.082, pivot[1], pivot[2], side * 0.072, R, -axleZ, 0.028, 0.021), M.alloy); // swingarm
    F.add(rod(side * 0.088, 0.685, -0.60, side * 0.076, 0.30, -0.79, 0.019, 0.019, 8), M.dark); // twin shocks
    F.add(coil(side * 0.087, 0.665, -0.606, side * 0.077, 0.335, -0.775, 0.036, 0.008, 6), M.steel);
    F.add(at(rbox(0.09, 0.30, 0.38, 0.10, 1), side * 0.255, 0.55, -0.60), M.hivis); // pannier
    F.add(at(rbox(0.012, 0.09, 0.30, 0.04, 1), side * 0.302, 0.55, -0.60), M.dark);
  }
  // Leg shield and apron — the silhouette that says "delivery scooter" from a block away.
  F.add(at(shell(0.30, 0.30, 0.018, 1.9, 14), 0, 0.62, 0.19), M.paint);
  F.add(at(shell(0.26, 0.10, 0.016, 2.0, 12), 0, 0.34, 0.20), M.paint);
  F.add(at(rbox(0.34, 0.16, 0.20, 0.15, 1), 0, 0.86, 0.40, -0.18, 0, 0), M.paint); // dash
  F.add(at(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 14), 0, 0.905, 0.44, 1.35, 0, 0), M.dark);
  // Engine, exhaust, chain case.
  F.add(at(rbox(0.26, 0.24, 0.34, 0.18, 1), 0, 0.42, -0.24), M.dark);
  F.add(at(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 16), 0.14, 0.415, -0.25, 0, 0, Math.PI / 2), M.alloy);
  F.add(bent([[0.075, 0.44, -0.12], [0.13, 0.33, -0.28], [0.155, 0.315, -0.52]], 0.024, 7, 10), M.chrome);
  F.add(at(new THREE.CylinderGeometry(0.05, 0.044, 0.30, 14), 0.155, 0.325, -0.66, Math.PI / 2 - 0.05, 0, 0), M.chrome);
  F.add(at(rbox(0.06, 0.14, 0.55, 0.05, 1), -0.10, 0.335, -0.55), M.paint); // full chain case
  // Seat and rack.
  F.add(at(rbox(0.29, 0.10, 0.52, 0.08, 1), 0, 0.795, -0.42, -0.03, 0, 0), M.rubber);
  for (const side of [-1, 1]) {
    F.add(rod(side * 0.10, 0.755, -0.66, side * 0.10, 0.765, -0.98, 0.011, 0.011, 6), M.steel);
    F.add(rod(side * 0.10, 0.762, -0.94, side * 0.055, 0.70, -0.99, 0.009, 0.009, 5), M.steel);
  }
  for (const z of [-0.68, -0.82, -0.95]) F.add(rod(-0.10, 0.76, z, 0.10, 0.76, z, 0.009, 0.009, 5), M.steel);
  F.add(at(rbox(0.16, 0.105, 0.012, 0.04, 1), 0, 0.62, -1.00, -0.26, 0, 0), M.plate);
  F.add(guard(R + 0.075, 0.16, 0.012, -0.15, 1.9).translate(0, R, -axleZ), M.paint);
  F.flush(root, 'frame');

  // The branded top box keeps its own name and sign child — Vehicle.test.ts asserts both.
  const box = new THREE.Mesh(rbox(0.56, 0.52, 0.54, 0.12, 2), M.hivis);
  box.name = 'courierbox'; box.position.set(0, 0.99, -0.80); box.castShadow = true;
  const sign = createSignMesh(new THREE.PlaneGeometry(0.44, 0.26), '60-SEK', '#10220b', { background: '#f4ffea' });
  sign.name = 'sign'; sign.position.set(0, 0.02, 0.276);
  (sign.material as THREE.Material).userData.bikeShared = true; // the city sign atlas: never cloned, never disposed
  box.add(sign);
  const boxTrim = new THREE.Mesh(rbox(0.58, 0.05, 0.56, 0.04, 1), M.dark);
  boxTrim.position.set(0, 0.262, 0); boxTrim.castShadow = true; box.add(boxTrim);

  const tailMesh = taillight(at(new THREE.BoxGeometry(0.10, 0.055, 0.02), 0, 0.755, -1.005));
  root.add(rear, steer, box, tailMesh);
  root.add(buildRider({ saddle: VEHICLE_SPECS.courier.saddle!, hips: [0, 0.85, -0.40], grip: [0.25, 1.12, 0.31], foot: [0.27, 0.32, -0.16], lean: 0.20, helmet: true }, M));
  return { root, lamp: lampMesh, tail: tailMesh };
}

// ---- Sandton Rocket: the litre sportbike, the quality bar for the other three -------------------

function buildSuperbike(M: Palette): { root: THREE.Group; lamp: THREE.Mesh; tail: THREE.Mesh } {
  const root = new THREE.Group();
  const R = 0.315; const axleZ = 2.20 * 0.36;
  const frontWheel: WheelSpec = {
    radius: R, tyre: 0.082, width: 0.125, style: 'cast', spokes: 5, hubRadius: 0.065, hubWidth: 0.12,
    rimMaterial: 'alloy', discRadius: 0.20, discSides: [-1, 1],
  };
  const rearWheel: WheelSpec = {
    radius: R, tyre: 0.105, width: 0.195, style: 'cast', spokes: 5, hubRadius: 0.075, hubWidth: 0.16,
    rimMaterial: 'alloy', discRadius: 0.13, discSides: [1], sprocket: 0.10, sprocketSide: -1,
  };

  const rear = buildWheel('wheel_rear', rearWheel, M); rear.position.set(0, R, -axleZ);
  const steer = new THREE.Group(); steer.name = 'steer'; steer.position.set(0, R, axleZ);
  steer.add(buildWheel('wheel_front', frontWheel, M));

  // ---- Front end: upside-down forks, clip-ons, hugger. The FAIRING stays body-fixed (below). ----
  const S = new Batch();
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.115, 0.005, 0, side * 0.115, 0.245, -0.072, 0.028, 0.026), M.chrome); // slider
    S.add(rod(side * 0.115, 0.215, -0.063, side * 0.115, 0.575, -0.172, 0.0375, 0.0375, 14), M.dark); // fat USD upper
    S.add(at(new THREE.BoxGeometry(0.055, 0.115, 0.075), side * 0.155, 0.145, -0.045, 0, 0, side * -0.2), M.alloy); // radial caliper
  }
  S.add(at(rbox(0.31, 0.05, 0.10, 0.06, 1), 0, 0.415, -0.126), M.alloy);
  S.add(at(rbox(0.29, 0.042, 0.095, 0.06, 1), 0, 0.565, -0.171), M.alloy);
  S.add(rod(0, 0.38, -0.115, 0, 0.60, -0.182, 0.026, 0.026, 10), M.dark);
  for (const side of [-1, 1]) {
    S.add(rod(side * 0.10, 0.560, -0.235, side * 0.235, 0.610, -0.430, 0.018, 0.018, 10), M.alloy); // clip-on
    S.add(rod(side * 0.185, 0.599, -0.393, side * 0.244, 0.621, -0.478, 0.023, 0.023, 10), M.rubber); // grip
    S.add(at(new THREE.BoxGeometry(0.022, 0.016, 0.115), side * 0.15, 0.585, -0.345, 0.2, side * 0.36, 0), M.alloy);
  }
  S.add(guard(R + 0.045, 0.135, 0.012, 0.55, 1.45), M.paint); // fork-mounted hugger
  S.flush(steer, 'front');

  // ---- Chassis, engine, bodywork ----
  const F = new Batch();
  const pivot: P3 = [0, 0.44, -0.10];
  F.add(rod(0, 0.735, 0.66, 0, 0.885, 0.615, 0.05), M.dark); // headstock
  for (const side of [-1, 1]) {
    F.add(at(rbox(0.075, 0.16, 0.62, 0.05, 1), side * 0.155, 0.685, 0.24, 0, 0, 0), M.alloy); // twin beam spar
    F.add(at(rbox(0.055, 0.20, 0.16, 0.12, 1), side * 0.135, 0.545, -0.09), M.alloy); // pivot plate
    F.add(rod(pivot[0] + side * 0.10, pivot[1], pivot[2], side * 0.10, R, -axleZ, 0.042, 0.03), M.alloy); // swingarm
    F.add(rod(side * 0.10, 0.50, -0.35, side * 0.10, 0.365, -0.62, 0.016, 0.016, 8), M.alloy); // swingarm brace
    F.add(rod(side * 0.26, 0.395, -0.44, side * 0.135, 0.475, -0.30, 0.014, 0.014, 8), M.alloy); // rearset hanger
    F.add(at(new THREE.BoxGeometry(0.05, 0.026, 0.10), side * 0.265, 0.385, -0.44), M.steel); // rearset peg
    F.add(rod(side * 0.155, 0.585, 0.545, side * 0.20, 0.735, 0.40, 0.012, 0.012, 6), M.dark); // mirror stalk
    F.add(at(rbox(0.145, 0.055, 0.02, 0.06, 1), side * 0.215, 0.752, 0.392, 0, side * -0.55, 0.2), M.paint);
    F.add(at(new THREE.BoxGeometry(0.125, 0.042, 0.008), side * 0.217, 0.752, 0.383, 0, side * -0.55, 0.2), M.chrome);
  }
  // Engine block: inline-four, exhaust headers curling under the belly.
  F.add(at(rbox(0.34, 0.26, 0.36, 0.17, 1), 0, 0.44, 0.06), M.dark);
  F.add(at(rbox(0.30, 0.20, 0.24, 0.13, 1), 0, 0.63, 0.16, -0.28, 0, 0), M.alloy);
  F.add(at(new THREE.CylinderGeometry(0.10, 0.10, 0.06, 16), 0.185, 0.435, 0.03, 0, 0, Math.PI / 2), M.alloy);
  for (const x of [-0.105, -0.035, 0.035, 0.105]) F.add(bent([[x, 0.575, 0.26], [x * 1.15, 0.40, 0.36], [x * 1.2, 0.295, 0.10], [x * 0.8, 0.30, -0.16]], 0.019, 6, 10), M.chrome);
  F.add(at(rbox(0.28, 0.28, 0.055, 0.06, 1), 0, 0.585, 0.415), M.dark); // radiator
  for (let i = 0; i < 8; i++) F.add(at(new THREE.BoxGeometry(0.26, 0.012, 0.012), 0, 0.475 + i * 0.031, 0.445), M.steel);
  // Fairing: nose, flanks, belly pan, screen.
  F.add(at(shell(0.215, 0.30, 0.022, 2.3, 16), 0, 0.700, 0.345, 0.10, 0, 0), M.paint); // nose fairing
  F.add(at(new THREE.ConeGeometry(0.205, 0.42, 14, 1, false), 0, 0.735, 0.545, Math.PI / 2 - 0.30, 0, 0, 1, 1, 0.62), M.paint);
  for (const side of [-1, 1]) {
    F.add(at(rbox(0.07, 0.36, 0.70, 0.09, 2), side * 0.168, 0.560, 0.235, 0, side * 0.10, 0.26), M.paint); // side fairing
    F.add(at(rbox(0.05, 0.12, 0.26, 0.12, 1), side * 0.196, 0.685, 0.435, 0, side * 0.18, 0.18), M.dark); // duct
  }
  F.add(at(rbox(0.30, 0.075, 0.68, 0.05, 1), 0, 0.315, 0.14, 0.06, 0, 0), M.paint); // belly pan
  F.add(at(shell(0.19, 0.135, 0.012, 1.6, 12), 0, 0.930, 0.290, -0.60, 0, 0), M.glass); // screen
  // Tank and tail.
  const tankProfile: Array<[number, number]> = [[0.02, -0.32], [0.11, -0.22], [0.165, -0.02], [0.16, 0.16], [0.10, 0.28], [0.02, 0.32]];
  F.add(at(new THREE.LatheGeometry(tankProfile.map(([r, y]) => new THREE.Vector2(r, y)), 20), 0, 0.815, 0.155, Math.PI / 2, 0, 0, 1.0, 1, 0.66), M.paint);
  F.add(at(new THREE.CylinderGeometry(0.036, 0.04, 0.02, 14), 0, 0.895, 0.24), M.chrome);
  F.add(at(rbox(0.25, 0.08, 0.40, 0.10, 1), 0, 0.800, -0.235, 0.07, 0, 0), M.rubber); // rider seat
  F.add(at(rbox(0.28, 0.19, 0.52, 0.13, 2), 0, 0.815, -0.47, 0.18, 0, 0), M.paint); // tail unit
  F.add(at(rbox(0.20, 0.06, 0.26, 0.10, 1), 0, 0.888, -0.60, 0.18, 0, 0), M.rubber); // pillion pad
  for (const side of [-1, 1]) {
    F.add(at(new THREE.CylinderGeometry(0.052, 0.058, 0.26, 14), side * 0.095, 0.695, -0.735, Math.PI / 2 - 0.26, side * 0.10, 0), M.chrome); // underseat can
    F.add(at(new THREE.TorusGeometry(0.053, 0.007, 4, 16), side * 0.098, 0.727, -0.858, Math.PI / 2 - 0.26, side * 0.10, 0), M.dark);
  }
  F.add(rod(0, 0.70, -0.62, 0, 0.44, -0.36, 0.022, 0.022, 8), M.dark); // monoshock
  F.add(coil(0, 0.68, -0.605, 0, 0.475, -0.393, 0.043, 0.0095, 6), M.paint);
  F.add(at(rbox(0.155, 0.105, 0.012, 0.04, 1), 0, 0.495, -0.845, -0.35, 0, 0), M.plate);
  F.add(rod(0, 0.62, -0.83, 0, 0.55, -0.90, 0.010, 0.010, 6), M.dark);
  F.add(at(new THREE.BoxGeometry(0.055, 0.09, 0.07), -0.135, 0.415, -0.60, 0, 0, 0.35), M.alloy); // rear caliper
  F.add(at(new THREE.BoxGeometry(0.012, 0.015, 0.62), -0.115, 0.395, -0.44), M.steel); // chain
  F.add(at(new THREE.BoxGeometry(0.012, 0.015, 0.62), -0.115, 0.275, -0.46), M.steel);
  F.flush(root, 'frame');

  // Stacked twin projectors, merged into one lens mesh so there is exactly one headlight material.
  const lensL = at(new THREE.SphereGeometry(0.072, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), -0.072, 0.700, 0.560, Math.PI / 2 - 0.24, 0.22, 0, 1, 1, 0.5);
  const lensR = at(new THREE.SphereGeometry(0.072, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.45), 0.072, 0.700, 0.560, Math.PI / 2 - 0.24, -0.22, 0, 1, 1, 0.5);
  const lampMesh = lamp(mergeGeometries([mergeVertices(lensL), mergeVertices(lensR)], false)!);
  const tailMesh = taillight(at(new THREE.BoxGeometry(0.15, 0.055, 0.02), 0, 0.845, -0.715, 0.18, 0, 0));

  root.add(rear, steer, lampMesh, tailMesh); // lamp is fairing-mounted, so it does NOT steer
  root.add(buildRider({ saddle: VEHICLE_SPECS.superbike.saddle!, hips: [0, 0.87, -0.30], grip: [0.235, 0.935, 0.33], foot: [0.265, 0.42, -0.44], lean: 0.80, helmet: true }, M));
  return { root, lamp: lampMesh, tail: tailMesh };
}

// ---- Template cache + instantiation -------------------------------------------------------------

interface Template { root: THREE.Group; rollRadius: number }

const templates = new Map<TwoWheelerKind, Template>();

/** Built on first use (never at module load: the Vehicle constructor must stay callable under vitest). */
function template(kind: TwoWheelerKind): Template {
  const cached = templates.get(kind);
  if (cached) return cached;
  const M = palette(VEHICLE_SPECS[kind].color);
  const built: Template = kind === 'bicycle' ? { root: buildBicycle(M), rollRadius: 0.34 }
    : kind === 'motorbike' ? { root: buildScrambler(M).root, rollRadius: 0.32 }
      : kind === 'courier' ? { root: buildCourier(M).root, rollRadius: 0.27 }
        : { root: buildSuperbike(M).root, rollRadius: 0.315 };
  built.root.name = `bike-${kind}`;
  built.root.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
  templates.set(kind, built);
  return built;
}

/**
 * One bike: shared template geometry, per-instance materials. Every handle is resolved by name from
 * the clone because clone(true) mints fresh Object3D identities.
 */
export function instantiateBikeModel(kind: TwoWheelerKind, colour: number): BikeModelInstance {
  const source = template(kind);
  const root = source.root.clone(true);
  const clones = new Map<THREE.Material, THREE.Material>();
  const sharedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    sharedGeometries.add(object.geometry);
    const material = object.material as THREE.Material;
    if (material.userData.bikeShared) return; // shared city atlas: leave the reference alone
    let copy = clones.get(material);
    if (!copy) {
      copy = material.clone();
      if (copy.userData.bikeTint === 'paint') (copy as THREE.MeshStandardMaterial).color.setHex(colour);
      clones.set(material, copy); ownedMaterials.add(copy);
    }
    object.material = copy;
  });
  const named = <T extends THREE.Object3D>(name: string): T => root.getObjectByName(name) as T;
  const crank = root.getObjectByName('crank');
  // The Kasi Cruiser is deliberately lampless (Vehicle.headlightsOn and DayNight's beam pool both
  // exclude bicycles), so these lists come back empty for it rather than glowing with no beam.
  const optional = (name: string): THREE.Mesh[] => { const mesh = root.getObjectByName(name); return mesh ? [mesh as THREE.Mesh] : []; };
  return {
    root,
    wheels: [named('wheel_front'), named('wheel_rear')],
    steerGroup: named<THREE.Group>('steer'),
    cranks: crank ? [crank] : [],
    rider: named<THREE.Group>('rider'),
    headLights: optional('headlamp'),
    brakeLights: optional('taillight'),
    rollRadius: source.rollRadius,
    sharedGeometries,
    ownedMaterials,
  };
}
