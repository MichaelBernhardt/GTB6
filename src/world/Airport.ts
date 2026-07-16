/**
 * O.R. Tambourine Regional — the airfield in the southern farmland corridor.
 *
 * Everything is procedural and deterministic, driven by the generated map's `airport` block
 * (mapData.AIRPORT): draped asphalt runway/taxiway with painted markings, a concrete apron,
 * a glazed terminal + control tower + hangars raised on the given footprints, floodlight masts,
 * a windsock, low perimeter fencing along the aerodrome boundary (gapped where roads and the rail
 * spur cross it), parked light aircraft (buildLightAircraft is reusable — future flying features
 * should build from it) and a small halt platform where the Lughawe Spur ends by the apron.
 *
 * The runway/taxiway are deliberately NOT roads: they never touch the road index, nav graphs or
 * spawn surfaces, so NPC cars and peds keep off the field (ModelScatter likewise refuses to place
 * anything inside the aerodrome polygon). All geometry lands in the host group BEFORE the static
 * merge, so it chunks and distance-culls with the rest of the world.
 */
import * as THREE from 'three';
import {
  AERODROME_POLYGONS,
  AIRPORT,
  GENERATED_RAILWAYS,
  pointInPolygon,
  type AirportData,
  type MapPolygon,
  type MapPt,
} from './mapData';
import { createSignMesh } from './ProceduralMaterials';
import { registerPowered } from './powerGrid';
import type { Collider } from './City';
import type { PropRegistry } from '../systems/PropSystem';

/** Surface lifts above the terrain — all kept below the road tar (0.15) so a crossing road wins. */
export const RUNWAY_LIFT = 0.09;
export const TAXIWAY_LIFT = 0.075;
export const APRON_LIFT = 0.06;
/** Painted markings ride this far above their own surface's lift. */
const MARK_LIFT = 0.045;

const seeded = (x: number, z: number, salt = 0): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

// ---- Pure layout helpers (unit-tested) ---------------------------------------

/** Oriented rectangle fitted to a (near-rectangular) quad footprint. Heading follows the City collider
 *  convention (rotation.y = heading maps local +x → world (cos θ, −sin θ)); u is the LONG axis (local +x),
 *  v the short one (local +z), hw/hd the half extents along them. */
export interface OrientedRect { cx: number; cz: number; heading: number; hw: number; hd: number; ux: number; uz: number; vx: number; vz: number; }

export function rectFromQuad(points: MapPt[]): OrientedRect {
  const p0 = points[0]!; const p1 = points[1]!; const p2 = points[2]!;
  const e0x = p1.x - p0.x; const e0z = p1.z - p0.z; const e1x = p2.x - p1.x; const e1z = p2.z - p1.z;
  const l0 = Math.hypot(e0x, e0z); const l1 = Math.hypot(e1x, e1z);
  const longLen = Math.max(l0, l1) || 1;
  const ux = (l0 >= l1 ? e0x : e1x) / longLen; const uz = (l0 >= l1 ? e0z : e1z) / longLen;
  let cx = 0; let cz = 0;
  for (const point of points) { cx += point.x; cz += point.z; }
  cx /= points.length; cz /= points.length;
  return { cx, cz, heading: Math.atan2(-uz, ux), hw: Math.max(l0, l1) / 2, hd: Math.min(l0, l1) / 2, ux, uz, vx: -uz, vz: ux };
}

/** World point at rect-local (lx along the long axis u, lz along the short axis v). */
export const rectPoint = (rect: OrientedRect, lx: number, lz: number): MapPt =>
  ({ x: rect.cx + rect.ux * lx + rect.vx * lz, z: rect.cz + rect.uz * lx + rect.vz * lz });

/** One painted dash: centre, unit direction along the line, and its length. */
export interface DashSpec { x: number; z: number; dirX: number; dirZ: number; len: number; }

/** Dash centres along a straight line, inset `margin` from both ends, one dash per `pitch` of travel
 *  (len < pitch gives gaps; len === pitch reads as a continuous line). Pure — unit-testable. */
export function lineDashes(a: MapPt, b: MapPt, margin: number, pitch: number, len: number): DashSpec[] {
  const dx = b.x - a.x; const dz = b.z - a.z; const total = Math.hypot(dx, dz);
  const usable = total - margin * 2;
  if (total < 1e-6 || usable < len) return [];
  const dirX = dx / total; const dirZ = dz / total;
  const count = Math.floor((usable - len) / pitch) + 1;
  const out: DashSpec[] = [];
  for (let index = 0; index < count; index++) {
    const centre = margin + len / 2 + index * pitch;
    out.push({ x: a.x + dirX * centre, z: a.z + dirZ * centre, dirX, dirZ, len });
  }
  return out;
}

/** Straight fence runs along a boundary polygon: each edge is probed every `step` and split wherever
 *  `blocked` holds (roads / rail crossing the boundary), backing off one probe either side so the gap
 *  reads as a gate. Pure — unit-testable. */
export function fenceRuns(points: MapPt[], step: number, blocked: (x: number, z: number) => boolean): Array<{ ax: number; az: number; bx: number; bz: number }> {
  const runs: Array<{ ax: number; az: number; bx: number; bz: number }> = [];
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!; const b = points[(index + 1) % points.length]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < step) continue;
    const dirX = (b.x - a.x) / length; const dirZ = (b.z - a.z) / length;
    const steps = Math.ceil(length / step);
    let openStart: number | undefined;
    for (let probe = 0; probe <= steps; probe++) {
      const distance = Math.min(length, probe * step);
      const hit = blocked(a.x + dirX * distance, a.z + dirZ * distance);
      if (!hit && openStart === undefined) openStart = distance;
      if ((hit || probe === steps) && openStart !== undefined) {
        const end = hit ? distance - step : distance;
        if (end - openStart > step) runs.push({ ax: a.x + dirX * openStart, az: a.z + dirZ * openStart, bx: a.x + dirX * end, bz: a.z + dirZ * end });
        openStart = undefined;
      }
    }
  }
  return runs;
}

// ---- Light aircraft (reusable) -------------------------------------------------

export interface BuiltAircraft { group: THREE.Group; halfSpan: number; halfLength: number; height: number; }

/** A light aircraft (high-wing single-prop, Cessna-ish) built from primitives at the origin: wheels on
 *  y = 0, nose toward local +z, wings along local x. Deterministic per seed (livery colour). Reusable —
 *  future flying/airfield features should build theirs from this. */
export function buildLightAircraft(seed: number): BuiltAircraft {
  const liveries = [0xc9402f, 0x2f6fa8, 0x3e8a52, 0xd08a2c];
  const accent = liveries[Math.floor(seeded(seed, 1, 17) * liveries.length) % liveries.length]!;
  const body = new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.42, metalness: 0.25 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.45, metalness: 0.2 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22282b, roughness: 0.5, metalness: 0.35 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x2e4b55, roughness: 0.15, metalness: 0.2, clearcoat: 0.7 });
  const group = new THREE.Group();
  const add = (mesh: THREE.Mesh): THREE.Mesh => { mesh.castShadow = true; group.add(mesh); return mesh; };
  const fuselage = add(new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.5, 3.4, 12), body)); fuselage.rotation.x = Math.PI / 2; fuselage.position.set(0, 1.28, 0.4);
  const tail = add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.14, 3.0, 10), body)); tail.rotation.x = Math.PI / 2; tail.position.set(0, 1.38, -2.8);
  const cowl = add(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.44, 0.7, 12), trim)); cowl.rotation.x = Math.PI / 2; cowl.position.set(0, 1.28, 2.4);
  const spinner = add(new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.5, 10), dark)); spinner.rotation.x = Math.PI / 2; spinner.position.set(0, 1.28, 2.95);
  const bladeA = add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.95, 0.06), dark)); bladeA.position.set(0, 1.28, 2.82);
  const bladeB = add(new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.16, 0.06), dark)); bladeB.position.set(0, 1.28, 2.82);
  const canopy = add(new THREE.Mesh(new THREE.BoxGeometry(0.94, 0.55, 1.25), glass)); canopy.position.set(0, 1.85, 0.85);
  const wing = add(new THREE.Mesh(new THREE.BoxGeometry(11, 0.15, 1.55), body)); wing.position.set(0, 2.12, 0.72);
  const wingTipL = add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.17, 1.56), trim)); wingTipL.position.set(-4.95, 2.12, 0.72);
  const wingTipR = add(new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.17, 1.56), trim)); wingTipR.position.set(4.95, 2.12, 0.72);
  for (const side of [-1, 1]) {
    const strut = add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.9, 0.12), body)); strut.position.set(side * 1.35, 1.55, 0.85); strut.rotation.z = side * 0.98;
    const stripe = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.3, 3.9), trim)); stripe.position.set(side * 0.56, 1.4, -0.5);
    const wheel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.15, 12), dark)); wheel.rotation.z = Math.PI / 2; wheel.position.set(side * 0.95, 0.26, 0.5);
    const gear = add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.78, 0.2), body)); gear.position.set(side * 0.55, 0.62, 0.5); gear.rotation.z = side * 0.72;
  }
  const noseWheel = add(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.13, 12), dark)); noseWheel.rotation.z = Math.PI / 2; noseWheel.position.set(0, 0.22, 1.95);
  const noseGear = add(new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.7, 0.07), body)); noseGear.position.set(0, 0.6, 1.95);
  const fin = add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.35, 0.9), body)); fin.position.set(0, 2.15, -4.0); fin.rotation.x = 0.18;
  const finFlash = add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.92), trim)); finFlash.position.set(0, 2.45, -4.02); finFlash.rotation.x = 0.18;
  const stab = add(new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.09, 0.8), body)); stab.position.set(0, 1.5, -4.1);
  return { group, halfSpan: 5.6, halfLength: 4.5, height: 3.0 };
}

// ---- The airfield build ---------------------------------------------------------

/** Everything the airport needs from City, so this module never reaches into City internals. */
export interface AirportHost {
  group: THREE.Group;
  colliders: Collider[];
  props: PropRegistry;
  asphalt: THREE.Texture;
  concrete: THREE.Texture;
  ground(x: number, z: number): number;
  strip(points: MapPt[], width: number, material: THREE.Material, lift: number): THREE.Mesh;
  addInstanced(geometry: THREE.BufferGeometry, material: THREE.Material, transforms: THREE.Matrix4[], shadows: { cast?: boolean; receive?: boolean }): void;
  isOnRoad(x: number, z: number, margin?: number): boolean;
}

export function buildAirport(host: AirportHost): void {
  if (AIRPORT) new AirportBuilder(host, AIRPORT).build();
}

class AirportBuilder {
  private matrix = new THREE.Matrix4();
  private whiteTransforms: THREE.Matrix4[] = [];
  private yellowTransforms: THREE.Matrix4[] = [];
  private postTransforms: THREE.Matrix4[] = [];
  private railTransforms: THREE.Matrix4[] = [];
  private white = new THREE.MeshStandardMaterial({ color: 0xe9e6d6, roughness: 0.78 });
  private yellow = new THREE.MeshStandardMaterial({ color: 0xd9b23c, roughness: 0.76 });
  private tarmac: THREE.MeshStandardMaterial;
  private apronConcrete: THREE.MeshStandardMaterial;
  private wall: THREE.MeshStandardMaterial;
  private metal = new THREE.MeshStandardMaterial({ color: 0x5e6868, metalness: 0.55, roughness: 0.45 });
  private fencePost = new THREE.MeshStandardMaterial({ color: 0x4a5254, metalness: 0.6, roughness: 0.42 });
  private fenceRail = new THREE.MeshStandardMaterial({ color: 0x707a7c, metalness: 0.62, roughness: 0.4 });
  private glass = new THREE.MeshPhysicalMaterial({ color: 0x3a6672, roughness: 0.16, metalness: 0.18, clearcoat: 0.6 });
  private apronRect: OrientedRect;
  /** Sign (±1) of the apron-local v direction that points AT the terminal row. */
  private terminalSide: 1 | -1;

  constructor(private host: AirportHost, private airport: AirportData) {
    this.tarmac = new THREE.MeshStandardMaterial({ color: 0x9fa4a8, map: host.asphalt, roughness: 0.92, metalness: 0.02 });
    this.apronConcrete = new THREE.MeshStandardMaterial({ color: 0xd8d5cc, map: host.concrete, roughness: 0.94 });
    this.wall = new THREE.MeshStandardMaterial({ color: 0xd6d2c6, map: host.concrete, roughness: 0.88 });
    this.apronRect = rectFromQuad(airport.apron.points);
    const buildings = airport.buildings[0] ?? airport.apron;
    const toBuildings = { x: buildings.cx - this.apronRect.cx, z: buildings.cz - this.apronRect.cz };
    this.terminalSide = toBuildings.x * this.apronRect.vx + toBuildings.z * this.apronRect.vz >= 0 ? 1 : -1;
  }

  build(): void {
    this.buildRunway();
    this.buildTaxiway();
    this.buildApron();
    this.buildBuildings();
    this.buildWindsock();
    this.buildFloodlights();
    this.buildFence();
    this.buildAircraft();
    this.buildRailHalt();
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.host.addInstanced(box, this.white, this.whiteTransforms, {});
    this.host.addInstanced(box, this.yellow, this.yellowTransforms, {});
    this.host.addInstanced(box, this.fencePost, this.postTransforms, { cast: true });
    this.host.addInstanced(box, this.fenceRail, this.railTransforms, {});
  }

  /** Orientation for a surface-hugging box: forward along (x0,z0)→(x1,z1) including the terrain pitch. */
  private segmentQuat(x0: number, z0: number, x1: number, z1: number): THREE.Quaternion {
    const g = (x: number, z: number): number => this.host.ground(x, z);
    const forward = new THREE.Vector3(x1 - x0, g(x1, z1) - g(x0, z0), z1 - z0).normalize();
    const mx = (x0 + x1) / 2; const mz = (z0 + z1) / 2; const s = 1.5;
    const normal = new THREE.Vector3(g(mx - s, mz) - g(mx + s, mz), s * 2, g(mx, mz - s) - g(mx, mz + s)).normalize();
    const right = new THREE.Vector3().crossVectors(normal, forward).normalize();
    const up = new THREE.Vector3().crossVectors(forward, right).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, forward));
  }

  /** One painted bar draped on the terrain: centre, direction, plan size, lift above the ground. */
  private bar(x: number, z: number, dirX: number, dirZ: number, width: number, len: number, lift: number, out: THREE.Matrix4[]): void {
    const quaternion = this.segmentQuat(x - dirX * len / 2, z - dirZ * len / 2, x + dirX * len / 2, z + dirZ * len / 2);
    this.matrix.compose(new THREE.Vector3(x, this.host.ground(x, z) + lift, z), quaternion, new THREE.Vector3(width, 0.02, len));
    out.push(this.matrix.clone());
  }

  /** Oriented-box collider push (heading convention shared with City.tierToWorldCollider). */
  private pushCollider(cx: number, cz: number, heading: number, hw: number, hd: number, y0: number, height: number): void {
    const c = Math.cos(heading); const s = Math.sin(heading);
    const nx = Math.abs(hw * c) + Math.abs(hd * s); const nz = Math.abs(hw * s) + Math.abs(hd * c);
    const box: Collider = { minX: cx - nx, maxX: cx + nx, minZ: cz - nz, maxZ: cz + nz, y0, height };
    if (Math.abs(c) > 1e-4 && Math.abs(s) > 1e-4) { box.heading = heading; box.hw = hw; box.hd = hd; }
    this.host.colliders.push(box);
  }

  private buildRunway(): void {
    const runway = this.airport.runway;
    const a = runway.points[0]!; const b = runway.points.at(-1)!;
    const strip = this.host.strip(runway.points, runway.width, this.tarmac, RUNWAY_LIFT);
    strip.receiveShadow = true; strip.name = runway.name; this.host.group.add(strip);
    const markY = RUNWAY_LIFT + MARK_LIFT;
    for (const dash of lineDashes(a, b, 56, 30, 18)) this.bar(dash.x, dash.z, dash.dirX, dash.dirZ, 0.9, dash.len, markY, this.whiteTransforms);
    const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz) || 1;
    const ux = dx / length; const uz = dz / length; const nx = -uz; const nz = ux;
    for (const side of [-1, 1]) { // continuous edge stripes
      const off = side * (runway.width / 2 - 0.6);
      const ea = { x: a.x + nx * off, z: a.z + nz * off }; const eb = { x: b.x + nx * off, z: b.z + nz * off };
      for (const dash of lineDashes(ea, eb, 2, 12, 12)) this.bar(dash.x, dash.z, dash.dirX, dash.dirZ, 0.35, dash.len, markY, this.whiteTransforms);
    }
    for (const [ex, ez, dir] of [[a.x, a.z, 1], [b.x, b.z, -1]] as const) {
      for (const lane of [-4.55, -3.25, -1.95, 1.95, 3.25, 4.55]) { // threshold piano keys
        const cx = ex + ux * dir * 14 + nx * lane; const cz = ez + uz * dir * 14 + nz * lane;
        this.bar(cx, cz, ux * dir, uz * dir, 0.9, 12, markY, this.whiteTransforms);
      }
      for (const side of [-1, 1]) { // aiming-point bars
        const cx = ex + ux * dir * 300 + nx * side * 3.1; const cz = ez + uz * dir * 300 + nz * side * 3.1;
        this.bar(cx, cz, ux * dir, uz * dir, 2.2, 16, markY, this.whiteTransforms);
      }
    }
  }

  private buildTaxiway(): void {
    const taxiway = this.airport.taxiway; const runway = this.airport.runway;
    const a = taxiway.points[0]!; const b = taxiway.points.at(-1)!;
    const strip = this.host.strip(taxiway.points, taxiway.width, this.tarmac, TAXIWAY_LIFT);
    strip.receiveShadow = true; strip.name = taxiway.name; this.host.group.add(strip);
    const markY = TAXIWAY_LIFT + MARK_LIFT;
    for (const dash of lineDashes(a, b, 4, 8, 8)) this.bar(dash.x, dash.z, dash.dirX, dash.dirZ, 0.28, dash.len, markY, this.yellowTransforms);
    // Stub connectors: each taxiway end joins the runway at its projection onto the centreline, and the
    // apron mouths onto the taxiway opposite its centre — the classic parallel-taxiway layout.
    const ra = runway.points[0]!; const rb = runway.points.at(-1)!;
    const rdx = rb.x - ra.x; const rdz = rb.z - ra.z; const rlen = Math.hypot(rdx, rdz) || 1;
    const rux = rdx / rlen; const ruz = rdz / rlen;
    for (const end of [a, b]) {
      const t = (end.x - ra.x) * rux + (end.z - ra.z) * ruz;
      const proj = { x: ra.x + rux * t, z: ra.z + ruz * t };
      const link = this.host.strip([end, proj], taxiway.width, this.tarmac, TAXIWAY_LIFT - 0.008);
      link.receiveShadow = true; this.host.group.add(link);
      for (const dash of lineDashes(end, proj, 2, 8, 8)) this.bar(dash.x, dash.z, dash.dirX, dash.dirZ, 0.28, dash.len, markY - 0.008, this.yellowTransforms);
    }
    const tdx = b.x - a.x; const tdz = b.z - a.z; const tlen = Math.hypot(tdx, tdz) || 1;
    const tux = tdx / tlen; const tuz = tdz / tlen;
    const tt = (this.apronRect.cx - a.x) * tux + (this.apronRect.cz - a.z) * tuz;
    const apronMouth = { x: a.x + tux * tt, z: a.z + tuz * tt };
    const throat = this.host.strip([rectPoint(this.apronRect, 0, 0), apronMouth], 30, this.apronConcrete, APRON_LIFT - 0.006);
    throat.receiveShadow = true; this.host.group.add(throat);
  }

  /** The concrete apron: a regular grid in the apron rect's own frame (exact quad coverage), draped. */
  private buildApron(): void {
    const rect = this.apronRect;
    const cols = Math.max(2, Math.ceil((rect.hw * 2) / 20)); const rows = Math.max(2, Math.ceil((rect.hd * 2) / 20));
    const positions: number[] = []; const uvs: number[] = []; const indices: number[] = [];
    for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) {
      const point = rectPoint(rect, -rect.hw + (c / cols) * rect.hw * 2, -rect.hd + (r / rows) * rect.hd * 2);
      positions.push(point.x, this.host.ground(point.x, point.z) + APRON_LIFT, point.z); uvs.push(point.x / 9, point.z / 9);
    }
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * stride + c;
      indices.push(i, i + 1, i + stride, i + 1, i + stride + 1, i + stride);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    const normals = geometry.attributes.normal.array; let sumY = 0;
    for (let i = 1; i < normals.length; i += 3) sumY += normals[i]!;
    if (sumY < 0) { for (let i = 0; i < indices.length; i += 3) { const t = indices[i]!; indices[i] = indices[i + 2]!; indices[i + 2] = t; } geometry.setIndex(indices); geometry.computeVertexNormals(); }
    const apron = new THREE.Mesh(geometry, this.apronConcrete);
    apron.receiveShadow = true; apron.name = this.airport.apron.name; this.host.group.add(apron);
  }

  /** Terminal (largest footprint, glazed airside front + tower alongside) and hangars on the rest. */
  private buildBuildings(): void {
    const rects = this.airport.buildings.map((building) => rectFromQuad(building.points));
    if (rects.length === 0) return;
    const terminal = rects.reduce((best, rect) => (rect.hw > best.hw ? rect : best));
    let hangarNumber = 1;
    for (const rect of rects) {
      if (rect === terminal) this.buildTerminal(rect);
      else this.buildHangar(rect, hangarNumber++);
    }
    this.buildTower(terminal);
  }

  /** Base height + underslab for a footprint on sloped ground: sit on the highest corner, bury a plinth
   *  past the lowest (the same slope-fitting contract as City's buildings). */
  private plinth(group: THREE.Group, rect: OrientedRect, shrink: number): number {
    let hMax = -Infinity; let hMin = Infinity;
    for (const lx of [-rect.hw, 0, rect.hw]) for (const lz of [-rect.hd, 0, rect.hd]) {
      const point = rectPoint(rect, lx * shrink, lz * shrink);
      const h = this.host.ground(point.x, point.z);
      if (h > hMax) hMax = h; if (h < hMin) hMin = h;
    }
    const drop = hMax - hMin + 1.6;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(rect.hw * 2 * shrink + 2, drop + 0.5, rect.hd * 2 * shrink + 2), new THREE.MeshStandardMaterial({ color: 0xb4b3aa, map: this.host.concrete, roughness: 0.92 }));
    slab.position.y = 0.25 - drop / 2; slab.receiveShadow = true; group.add(slab);
    return hMax;
  }

  private buildTerminal(rect: OrientedRect): void {
    const group = new THREE.Group();
    const baseY = this.plinth(group, rect, 0.98);
    group.position.set(rect.cx, baseY, rect.cz); group.rotation.y = rect.heading;
    const s = this.sideToApron(rect);
    const hallHw = rect.hw * 0.92; const hallHd = rect.hd * 0.55; const hallLz = s * rect.hd * 0.28;
    const hall = new THREE.Mesh(new THREE.BoxGeometry(hallHw * 2, 9, hallHd * 2), this.wall);
    hall.position.set(0, 4.75, hallLz); hall.castShadow = true; hall.receiveShadow = true; group.add(hall);
    const glassFront = new THREE.Mesh(new THREE.BoxGeometry(hallHw * 2 * 0.86, 5.8, 0.35), this.glass);
    glassFront.position.set(0, 3.3, hallLz + s * (hallHd + 0.25)); group.add(glassFront);
    for (let m = -6; m <= 6; m++) { // curtain-wall mullions
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.16, 5.8, 0.14), this.metal);
      mullion.position.set(m * (hallHw * 0.86 / 6.5), 3.3, hallLz + s * (hallHd + 0.42)); group.add(mullion);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(hallHw * 2 + 3, 0.6, hallHd * 2 + 6), this.metal);
    roof.position.set(0, 9.55, hallLz + s * 1.2); roof.castShadow = true; group.add(roof);
    const landside = new THREE.Mesh(new THREE.BoxGeometry(rect.hw * 1.3, 6, rect.hd * 0.6), this.wall);
    landside.position.set(0, 3, -s * rect.hd * 0.52); landside.castShadow = true; landside.receiveShadow = true; group.add(landside);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(rect.hw * 0.8, 0.3, 5), this.metal);
    canopy.position.set(0, 4, -s * (rect.hd * 0.82 + 2)); canopy.castShadow = true; group.add(canopy);
    for (const ox of [-rect.hw * 0.3, rect.hw * 0.15]) { // rooftop plant
      const unit = new THREE.Mesh(new THREE.BoxGeometry(4, 1.6, 2.6), this.metal); unit.position.set(ox, 10.6, hallLz); unit.castShadow = true; group.add(unit);
    }
    const name = this.airport.name.toUpperCase();
    const airsideSign = createSignMesh(new THREE.PlaneGeometry(30, 3), name, '#e8b23a', { powered: true });
    airsideSign.position.set(0, 10.9, hallLz + s * (hallHd + 0.6)); if (s < 0) airsideSign.rotation.y = Math.PI; group.add(airsideSign);
    const landSign = createSignMesh(new THREE.PlaneGeometry(22, 2.4), name, '#e8b23a', { powered: true });
    landSign.position.set(0, 6.9, -s * (rect.hd * 0.82 + 0.4)); if (s > 0) landSign.rotation.y = Math.PI; group.add(landSign);
    this.host.group.add(group);
    const hallCentre = rectPoint(rect, 0, s * rect.hd * 0.28);
    this.pushCollider(hallCentre.x, hallCentre.z, rect.heading, hallHw, hallHd, baseY, 10.2);
    const landCentre = rectPoint(rect, 0, -s * rect.hd * 0.52);
    this.pushCollider(landCentre.x, landCentre.z, rect.heading, rect.hw * 0.65, rect.hd * 0.3, baseY, 6);
  }

  /** The control tower — the field's landmark — free-standing off the terminal's west airside corner. */
  private buildTower(terminal: OrientedRect): void {
    const s = this.sideToApron(terminal);
    const spot = rectPoint(terminal, -(terminal.hw + 14), s * terminal.hd * 0.4);
    const baseY = this.host.ground(spot.x, spot.z);
    const group = new THREE.Group(); group.position.set(spot.x, baseY, spot.z); group.rotation.y = terminal.heading;
    group.userData.far = true; // the airfield's skyline mark: never culled, like Ponte/Hillbrow
    const base = new THREE.Mesh(new THREE.BoxGeometry(8, 3.4, 8), this.wall); base.position.y = 1.5; base.castShadow = true; base.receiveShadow = true; group.add(base);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3, 17, 16), this.wall); shaft.position.y = 11; shaft.castShadow = true; group.add(shaft);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(4.7, 3.4, 1.6, 16), this.metal); deck.position.y = 19.7; deck.castShadow = true; group.add(deck);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(4.1, 4.5, 3, 8), this.glass); cab.position.y = 22; group.add(cab);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(4.8, 4.8, 0.5, 16), this.metal); roof.position.y = 23.8; roof.castShadow = true; group.add(roof);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.13, 5, 8), this.metal); mast.position.y = 26.5; group.add(mast);
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0xff4b3e, emissive: 0xff1f16, emissiveIntensity: 2 });
    registerPowered(beaconMat, 0xff4b3e, 0x3a1a16);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), beaconMat); beacon.position.y = 29.1; group.add(beacon);
    const sign = createSignMesh(new THREE.PlaneGeometry(6.4, 1.3), 'TOWER', '#8fd8e8', { doubleSide: true, powered: true });
    sign.position.y = 17.5; sign.position.z = 3.2; group.add(sign);
    this.host.group.add(group);
    this.host.props.register('monument', spot.x, spot.z, 4.6, 24);
  }

  private buildHangar(rect: OrientedRect, number: number): void {
    const group = new THREE.Group();
    const baseY = this.plinth(group, rect, 0.97);
    group.position.set(rect.cx, baseY, rect.cz); group.rotation.y = rect.heading;
    const s = this.sideToApron(rect);
    const hw = rect.hw * 0.96; const hd = rect.hd * 0.94; const wallH = 8;
    const shell = new THREE.MeshStandardMaterial({ color: 0xb7b3a6, map: this.host.concrete, roughness: 0.9 });
    for (const side of [-1, 1]) {
      const sideWall = new THREE.Mesh(new THREE.BoxGeometry(1, wallH, hd * 2), shell);
      sideWall.position.set(side * (hw - 0.5), wallH / 2, 0); sideWall.castShadow = true; sideWall.receiveShadow = true; group.add(sideWall);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, wallH, 1), shell);
    back.position.set(0, wallH / 2, -s * (hd - 0.5)); back.castShadow = true; back.receiveShadow = true; group.add(back);
    const door = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 * 0.88, wallH - 0.8, 0.6), new THREE.MeshStandardMaterial({ color: 0x828b8a, metalness: 0.5, roughness: 0.5 }));
    door.position.set(0, (wallH - 0.8) / 2, s * (hd - 0.4)); door.castShadow = true; group.add(door);
    for (let seam = -3; seam <= 3; seam++) { // sliding-door panel seams
      const bead = new THREE.Mesh(new THREE.BoxGeometry(0.14, wallH - 1.2, 0.12), this.metal);
      bead.position.set(seam * (hw * 0.88 / 3.6), (wallH - 1.2) / 2, s * (hd - 0.05)); group.add(bead);
    }
    const barrel = new THREE.CylinderGeometry(hw, hw, hd * 2, 26, 1, true, Math.PI / 2, Math.PI);
    barrel.rotateX(Math.PI / 2); barrel.scale(1, 0.3, 1); barrel.translate(0, wallH, 0);
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x9aa39f, metalness: 0.45, roughness: 0.5, side: THREE.DoubleSide });
    const roof = new THREE.Mesh(barrel, roofMat); roof.castShadow = true; roof.receiveShadow = true; group.add(roof);
    for (const end of [-1, 1]) { // gable half-discs close the barrel ends
      const gable = new THREE.CircleGeometry(hw, 20, 0, Math.PI);
      gable.scale(1, 0.3, 1); gable.translate(0, wallH, 0);
      const cap = new THREE.Mesh(gable, roofMat); cap.position.z = end * hd; cap.rotation.y = end > 0 ? 0 : Math.PI; group.add(cap);
    }
    const sign = createSignMesh(new THREE.PlaneGeometry(10, 2), `HANGAR ${number}`, '#d9b23c', { doubleSide: true });
    sign.position.set(0, wallH + 1.6, s * (hd - 0.2)); group.add(sign);
    this.host.group.add(group);
    this.pushCollider(rect.cx, rect.cz, rect.heading, hw, hd, baseY, wallH + hw * 0.3);
  }

  /** Sign (±1) of a rect's local v that points AT the apron. */
  private sideToApron(rect: OrientedRect): 1 | -1 {
    const dx = this.apronRect.cx - rect.cx; const dz = this.apronRect.cz - rect.cz;
    return dx * rect.vx + dz * rect.vz >= 0 ? 1 : -1;
  }

  private buildWindsock(): void {
    const runway = this.airport.runway;
    const a = runway.points[0]!; const b = runway.points.at(-1)!;
    const dx = b.x - a.x; const dz = b.z - a.z; const length = Math.hypot(dx, dz) || 1;
    const ux = dx / length; const uz = dz / length;
    // Perpendicular pointing from the runway toward the apron (see buildTaxiway geometry).
    const toApronX = this.apronRect.cx - (a.x + b.x) / 2; const toApronZ = this.apronRect.cz - (a.z + b.z) / 2;
    let nx = -uz; let nz = ux;
    if (nx * toApronX + nz * toApronZ < 0) { nx = -nx; nz = -nz; }
    const x = (a.x + b.x) / 2 + nx * 34; const z = (a.z + b.z) / 2 + nz * 34;
    const baseY = this.host.ground(x, z);
    const group = new THREE.Group(); group.position.set(x, baseY, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 7, 10), this.metal); pole.position.y = 3.5; pole.castShadow = true; group.add(pole);
    const orange = new THREE.MeshStandardMaterial({ color: 0xe07020, roughness: 0.8, side: THREE.DoubleSide });
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.42, 2.4, 10, 1, true), orange);
    sock.rotation.x = Math.PI / 2 + 0.18; sock.rotation.y = Math.atan2(ux, uz); // streams along the runway heading
    sock.position.set(ux * 1.2, 6.7, uz * 1.2); group.add(sock);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.5, 10, 1, true), new THREE.MeshStandardMaterial({ color: 0xf0ede4, roughness: 0.8, side: THREE.DoubleSide }));
    band.rotation.copy(sock.rotation); band.position.set(ux * 1.7, 6.6, uz * 1.7); group.add(band);
    this.host.group.add(group);
    this.host.props.register('post', x, z, 0.25, 7);
  }

  private buildFloodlights(): void {
    const rect = this.apronRect;
    const lamp = new THREE.MeshStandardMaterial({ color: 0x3a4144, emissive: 0xffe2a6, emissiveIntensity: 1.6, metalness: 0.4, roughness: 0.4 });
    registerPowered(lamp, 0xffe2a6, 0x2a2a26);
    for (const lx of [-rect.hw + 14, rect.hw - 14]) for (const lz of [-rect.hd + 10, rect.hd - 10]) {
      const spot = rectPoint(rect, lx, lz);
      const baseY = this.host.ground(spot.x, spot.z);
      const group = new THREE.Group(); group.position.set(spot.x, baseY, spot.z);
      group.rotation.y = Math.atan2(rect.cx - spot.x, rect.cz - spot.z); // lamps face the apron centre
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 16, 10), this.metal); pole.position.y = 8; pole.castShadow = true; group.add(pole);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.3, 0.4), this.metal); bar.position.y = 15.7; group.add(bar);
      for (const ox of [-1.2, 0, 1.2]) {
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.5), lamp); head.position.set(ox, 15.35, 0.25); head.rotation.x = 0.5; group.add(head);
      }
      this.host.group.add(group);
      this.host.props.register('post', spot.x, spot.z, 0.4, 16);
    }
  }

  /** Low perimeter fence on the aerodrome boundary polygon: posts + two rails, gapped where roads or
   *  the rail spur cross the line, with matching thin colliders chunked to follow the relief. */
  private buildFence(): void {
    const boundary: MapPolygon | undefined = AERODROME_POLYGONS.find((polygon) => pointInPolygon(polygon, this.apronRect.cx, this.apronRect.cz)) ?? AERODROME_POLYGONS[0];
    if (!boundary) return;
    const nearRail = (x: number, z: number): boolean => GENERATED_RAILWAYS.some((line) => {
      for (let i = 0; i < line.points.length - 1; i++) {
        const a = line.points[i]!; const b = line.points[i + 1]!;
        const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
        if (Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)) < 7) return true;
      }
      return false;
    });
    const runs = fenceRuns(boundary.points, 6, (x, z) => this.host.isOnRoad(x, z, 5) || nearRail(x, z));
    for (const run of runs) {
      const dx = run.bx - run.ax; const dz = run.bz - run.az; const length = Math.hypot(dx, dz);
      const dirX = dx / length; const dirZ = dz / length;
      const posts = Math.max(1, Math.round(length / 6.5));
      for (let i = 0; i <= posts; i++) {
        const d = length * i / posts;
        const x = run.ax + dirX * d; const z = run.az + dirZ * d;
        this.matrix.compose(new THREE.Vector3(x, this.host.ground(x, z) + 0.72, z), new THREE.Quaternion(), new THREE.Vector3(0.09, 1.5, 0.09));
        this.postTransforms.push(this.matrix.clone());
      }
      const chunks = Math.max(1, Math.ceil(length / 18));
      for (let i = 0; i < chunks; i++) {
        const d0 = length * i / chunks; const d1 = length * (i + 1) / chunks;
        const mx = run.ax + dirX * (d0 + d1) / 2; const mz = run.az + dirZ * (d0 + d1) / 2;
        const quaternion = this.segmentQuat(run.ax + dirX * d0, run.az + dirZ * d0, run.ax + dirX * d1, run.az + dirZ * d1);
        for (const railY of [0.62, 1.34]) {
          this.matrix.compose(new THREE.Vector3(mx, this.host.ground(mx, mz) + railY, mz), quaternion, new THREE.Vector3(0.05, 0.08, d1 - d0 + 0.2));
          this.railTransforms.push(this.matrix.clone());
        }
      }
      const heading = Math.atan2(-dirZ, dirX);
      const pieces = Math.max(1, Math.ceil(length / 120)); // chunked so the collider band tracks the relief
      for (let i = 0; i < pieces; i++) {
        const d0 = length * i / pieces; const d1 = length * (i + 1) / pieces;
        const mx = run.ax + dirX * (d0 + d1) / 2; const mz = run.az + dirZ * (d0 + d1) / 2;
        this.pushCollider(mx, mz, heading, (d1 - d0) / 2, 0.25, this.host.ground(mx, mz) - 0.8, 2.3);
      }
    }
  }

  private buildAircraft(): void {
    const rect = this.apronRect; const s = this.terminalSide;
    const stands: number[] = [-rect.hw * 0.3, 0, rect.hw * 0.3];
    // Nose pointed at the taxiway (away from the terminal row), with a little seeded scatter per stand.
    const noseX = rect.vx * -s; const noseZ = rect.vz * -s;
    stands.forEach((lx, index) => {
      const spot = rectPoint(rect, lx + (seeded(lx, index, 3) - 0.5) * 8, s * (rect.hd - 40));
      const heading = Math.atan2(noseX, noseZ) + (seeded(lx, index, 4) - 0.5) * 0.5;
      const craft = buildLightAircraft(1009 + index * 37);
      const baseY = this.host.ground(spot.x, spot.z) + APRON_LIFT;
      craft.group.position.set(spot.x, baseY, spot.z); craft.group.rotation.y = heading;
      this.host.group.add(craft.group);
      this.pushCollider(spot.x, spot.z, heading, craft.halfSpan, craft.halfLength, baseY, craft.height);
      const lead = rectPoint(rect, lx, s * (rect.hd - 40) - s * 14); // stand lead-in line toward the taxiway
      this.bar((spot.x + lead.x) / 2, (spot.z + lead.z) / 2, noseX, noseZ, 0.3, 20, APRON_LIFT + MARK_LIFT, this.yellowTransforms);
      this.bar(spot.x, spot.z, rect.ux, rect.uz, 0.3, 8, APRON_LIFT + MARK_LIFT, this.yellowTransforms); // stand T-bar
    });
  }

  /** The Lughawe Spur halt: a low concrete platform + shelter where the spur ends by the apron. */
  private buildRailHalt(): void {
    const spur = GENERATED_RAILWAYS.find((line) => /lughawe/i.test(line.name));
    if (!spur || spur.points.length < 2) return;
    const end = spur.points.at(-1)!; const prev = spur.points[spur.points.length - 2]!;
    const dx = end.x - prev.x; const dz = end.z - prev.z; const length = Math.hypot(dx, dz) || 1;
    const ux = dx / length; const uz = dz / length;
    let nx = -uz; let nz = ux; // platform on the apron side of the track
    if (nx * (this.apronRect.cx - end.x) + nz * (this.apronRect.cz - end.z) < 0) { nx = -nx; nz = -nz; }
    const cx = end.x - ux * 16 + nx * 4.4; const cz = end.z - uz * 16 + nz * 4.4;
    const baseY = this.host.ground(cx, cz);
    const heading = Math.atan2(-uz, ux); // platform long axis runs along the track
    const group = new THREE.Group(); group.position.set(cx, baseY, cz); group.rotation.y = heading;
    // Local +z under this heading maps to world (−uz, ux); flip if that isn't the away-from-track side.
    const away = -uz * nx + ux * nz > 0 ? 1 : -1;
    const platform = new THREE.Mesh(new THREE.BoxGeometry(30, 0.5, 3.2), new THREE.MeshStandardMaterial({ color: 0xc9c6bb, map: this.host.concrete, roughness: 0.94 }));
    platform.position.y = 0.25; platform.receiveShadow = true; group.add(platform);
    for (const px of [-2.4, 2.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.6, 8), this.metal); post.position.set(6 + px, 1.8, away * 0.9); group.add(post);
    }
    this.host.props.register('post', cx + ux * 6, cz + uz * 6, 1.2, 3.2); // the shelter block
    const roof = new THREE.Mesh(new THREE.BoxGeometry(7, 0.22, 2.6), this.metal); roof.position.set(6, 3.15, away * 0.5); roof.castShadow = true; group.add(roof);
    const back = new THREE.Mesh(new THREE.BoxGeometry(7, 1.5, 0.12), this.wall); back.position.set(6, 2.1, away * 1.4); group.add(back);
    const sign = createSignMesh(new THREE.PlaneGeometry(6, 1.1), 'LUGHAWE HALT', '#d9b23c', { doubleSide: true });
    sign.position.set(-6, 2.4, away * 0.9); group.add(sign);
    for (const px of [-8.5, -3.5]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4, 8), this.metal); post.position.set(px, 1.2, away * 0.9); group.add(post); }
    this.host.group.add(group);
    this.pushCollider(cx, cz, heading, 15, 1.6, baseY, 0.5); // steppable (below PLAYER.stepUp)
  }
}
