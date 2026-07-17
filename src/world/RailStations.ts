/**
 * Procedural rail stations at every generated stop (mapData.STATIONS — OSM names where the data
 * had them, synthesized district names elsewhere; every line ends in one).
 *
 * Generalizes the Lughawe halt pattern from Airport.ts: a low concrete platform along the track
 * side (clear of the loading gauge), a shelter with a bench, a name board and a pair of platform
 * lamps. Everything is deterministic, built from committed map data, lands in the host group
 * BEFORE the static merge (so it chunks/distance-culls with the world) and gets a steppable
 * platform collider. The airport's own halt is skipped here — Airport.ts already builds it.
 */
import * as THREE from 'three';
import {
  AERODROME_POLYGONS,
  GENERATED_RAILWAYS,
  RAIL_BALLAST_WIDTH,
  STATIONS,
  distanceToRoadEdge,
  pointInAnyPolygon,
  type MapPt,
  type MapStation,
} from './mapData';
import { createSignMesh } from './ProceduralMaterials';
import { registerPowered } from './powerGrid';
import type { Collider } from './City';
import type { PropRegistry } from '../systems/PropSystem';

/** Platform slab: long axis along the track. The inner edge sits ~0.2u beyond the ballast so the
 *  consist (3.0-wide body on a 5.2 bed) sweeps past with clearance while E-board stays in reach. */
export const PLATFORM_LENGTH = 34;
export const PLATFORM_WIDTH = 3.2;
export const PLATFORM_HEIGHT = 0.5; // below PLAYER.stepUp: walk straight on
/** Track centreline → platform centre. Inner edge = OFFSET − W/2 = 2.8 (> ballast half 2.6). */
export const PLATFORM_OFFSET = RAIL_BALLAST_WIDTH / 2 + PLATFORM_WIDTH / 2 + 0.2;
/** Two station entries closer than this are the same physical stop (shared interchange point). */
const DEDUPE_DISTANCE = 40;

/** Unit track direction at the polyline point nearest to (x, z). Pure — unit-testable. */
export function trackDirectionAt(points: MapPt[], x: number, z: number): { ux: number; uz: number } {
  let best = { ux: 1, uz: 0 }; let bestD = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!; const b = points[i]!;
    const dx = b.x - a.x; const dz = b.z - a.z; const lengthSq = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + ((z - a.z) * dz)) / lengthSq));
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < bestD) { const len = Math.sqrt(lengthSq); bestD = d; best = { ux: dx / len, uz: dz / len }; }
  }
  return best;
}

/** Which side of the track gets the platform: the one with more room to the nearest road (a level
 *  crossing must never get a platform across the carriageway). Ties break to +1 — deterministic. */
export function pickPlatformSide(x: number, z: number, ux: number, uz: number, roadDistance: (x: number, z: number) => number = distanceToRoadEdge): 1 | -1 {
  const nx = -uz; const nz = ux;
  const clearPlus = roadDistance(x + nx * PLATFORM_OFFSET, z + nz * PLATFORM_OFFSET);
  const clearMinus = roadDistance(x - nx * PLATFORM_OFFSET, z - nz * PLATFORM_OFFSET);
  return clearPlus >= clearMinus ? 1 : -1;
}

/** The unique physical stops to build: same-name entries within DEDUPE_DISTANCE collapse (a spur
 *  junction shares the mainline's station), and stops inside the aerodrome keep the airport halt. */
export function uniqueStationSites(stations: readonly MapStation[] = STATIONS): MapStation[] {
  const sites: MapStation[] = [];
  for (const station of stations) {
    if (/^lughawe halt$/i.test(station.name) || pointInAnyPolygon(AERODROME_POLYGONS, station.x, station.z)) continue; // Airport.ts builds the halt
    if (sites.some((prior) => Math.hypot(prior.x - station.x, prior.z - station.z) < DEDUPE_DISTANCE)) continue;
    sites.push(station);
  }
  return sites;
}

/** Everything the station builder needs from City — mirrors AirportHost so City internals stay put. */
export interface StationHost {
  group: THREE.Group;
  colliders: Collider[];
  props: PropRegistry;
  concrete: THREE.Texture;
  ground(x: number, z: number): number;
}

export function buildRailStations(host: StationHost): void {
  const concrete = new THREE.MeshStandardMaterial({ color: 0xc9c6bb, map: host.concrete, roughness: 0.94 });
  const wall = new THREE.MeshStandardMaterial({ color: 0xd6d2c6, map: host.concrete, roughness: 0.88 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x5e6868, metalness: 0.55, roughness: 0.45 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6d4f33, roughness: 0.9 });
  const lampHead = new THREE.MeshStandardMaterial({ color: 0x3a4144, emissive: 0xffe2a6, emissiveIntensity: 1.5, metalness: 0.4, roughness: 0.4 });
  registerPowered(lampHead, 0xffe2a6, 0x2a2a26);
  for (const station of uniqueStationSites()) {
    const line = GENERATED_RAILWAYS.find((railway) => railway.name === station.line);
    if (!line || line.points.length < 2) continue;
    const { ux, uz } = trackDirectionAt(line.points, station.x, station.z);
    const side = pickPlatformSide(station.x, station.z, ux, uz);
    const nx = -uz * side; const nz = ux * side; // unit normal toward the platform side
    const cx = station.x + nx * PLATFORM_OFFSET; const cz = station.z + nz * PLATFORM_OFFSET;
    const baseY = host.ground(cx, cz);
    const heading = Math.atan2(-uz, ux); // platform long axis along the track (City collider convention)
    const group = new THREE.Group(); group.position.set(cx, baseY, cz); group.rotation.y = heading;
    // Local +z under this heading maps to world (−uz, ux); `away` flips it to the off-track side.
    const away = -uz * nx + ux * nz > 0 ? 1 : -1;
    const platform = new THREE.Mesh(new THREE.BoxGeometry(PLATFORM_LENGTH, PLATFORM_HEIGHT, PLATFORM_WIDTH), concrete);
    platform.position.y = PLATFORM_HEIGHT / 2; platform.receiveShadow = true; group.add(platform);
    // Shelter: roof on two posts with a back panel and a bench, off-centre so the name board reads clear.
    for (const px of [3.5, 10.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 2.6, 8), metal); post.position.set(px, 1.8, away * 0.9); group.add(post);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8, 0.22, 2.6), metal); roof.position.set(7, 3.15, away * 0.5); roof.castShadow = true; group.add(roof);
    const back = new THREE.Mesh(new THREE.BoxGeometry(8, 1.5, 0.12), wall); back.position.set(7, 2.1, away * 1.4); group.add(back);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(5.4, 0.12, 0.55), wood); seat.position.set(7, 1.0, away * 1.0); group.add(seat);
    for (const px of [4.8, 9.2]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.5, 0.5), metal); leg.position.set(px, 0.75, away * 1.0); group.add(leg);
    }
    // Name board on its own posts at the other end of the platform.
    const label = station.name.toUpperCase();
    const sign = createSignMesh(new THREE.PlaneGeometry(Math.min(12, Math.max(6, label.length * 0.42)), 1.1), label, '#d9b23c', { doubleSide: true });
    sign.position.set(-7, 2.4, away * 0.9); group.add(sign);
    for (const px of [-9.5, -4.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.4, 8), metal); post.position.set(px, 1.2, away * 0.9); group.add(post);
    }
    // A platform lamp at each end (powered: they brown out with the grid like the streetlights).
    for (const px of [-14, 14]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 4.4, 8), metal); pole.position.set(px, 2.7, away * 1.05); pole.castShadow = true; group.add(pole);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.22, 0.4), lampHead); head.position.set(px, 4.95, away * 0.85); group.add(head);
    }
    host.group.add(group);
    // Steppable platform collider (oriented box, same convention as Airport.pushCollider).
    const c = Math.cos(heading); const s = Math.sin(heading);
    const hw = PLATFORM_LENGTH / 2; const hd = PLATFORM_WIDTH / 2;
    const boxX = Math.abs(hw * c) + Math.abs(hd * s); const boxZ = Math.abs(hw * s) + Math.abs(hd * c);
    const collider: Collider = { minX: cx - boxX, maxX: cx + boxX, minZ: cz - boxZ, maxZ: cz + boxZ, y0: baseY, height: PLATFORM_HEIGHT };
    if (Math.abs(c) > 1e-4 && Math.abs(s) > 1e-4) { collider.heading = heading; collider.hw = hw; collider.hd = hd; }
    host.colliders.push(collider);
    host.props.register('post', cx + ux * 7, cz + uz * 7, 1.4, 3.2); // the shelter block
  }
}
