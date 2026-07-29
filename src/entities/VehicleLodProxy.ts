import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VehicleSpec } from '../config';

/** One neutral lit material for the whole distant fleet. Per-car paint and glass are baked into the tiny
 *  vertex-colour geometry, avoiding a material/state-change explosion while keeping every proxy one draw. */
const PROXY_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
PROXY_MATERIAL.name = 'shared-vehicle-lod';
const geometryCache = new Map<string, THREE.BufferGeometry>();

function colouredBox(
  width: number,
  height: number,
  length: number,
  x: number,
  y: number,
  z: number,
  colour: THREE.ColorRepresentation,
): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, length);
  geometry.translate(x, y, z);
  const positions = geometry.getAttribute('position');
  const rgb = new THREE.Color(colour); const colours = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    colours[i * 3] = rgb.r; colours[i * 3 + 1] = rgb.g; colours[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function buildTwoWheeler(spec: VehicleSpec): THREE.BufferGeometry[] {
  const [width, height, length] = spec.size;
  const tyre = 0x171b1c; const paint = spec.color; const rider = 0x30363a;
  return [
    colouredBox(width * 0.9, 0.68, 0.13, 0, 0.36, length * 0.34, tyre),
    colouredBox(width * 0.9, 0.68, 0.13, 0, 0.36, -length * 0.34, tyre),
    colouredBox(width * 0.42, 0.32, length * 0.7, 0, 0.58, 0, paint),
    colouredBox(width * 0.58, height * 0.7, length * 0.23, 0, 0.76 + height * 0.28, -length * 0.05, rider),
  ];
}

function buildRoadVehicle(spec: VehicleSpec): THREE.BufferGeometry[] {
  const [width, height, length] = spec.size;
  const wheelRadius = spec.kind === 'van' || spec.kind === 'taxi' ? 0.42 : 0.37;
  const bodyHeight = Math.min(height * 0.48, spec.kind === 'taxi' ? 0.86 : 0.7);
  const bodyY = wheelRadius + bodyHeight * 0.48;
  const taxi = spec.kind === 'taxi'; const bakkie = spec.kind === 'van';
  const cabinHeight = Math.max(0.34, height - bodyY);
  const cabinLength = length * (taxi ? 0.69 : bakkie ? 0.4 : 0.48);
  const cabinZ = bakkie ? length * 0.17 : taxi ? -length * 0.03 : -length * 0.05;
  const parts = [
    colouredBox(width * 0.98, bodyHeight, length * 0.96, 0, bodyY, 0, spec.color),
    colouredBox(width * 0.79, cabinHeight, cabinLength, 0, bodyY + bodyHeight * 0.42 + cabinHeight * 0.5, cabinZ, 0x24343a),
    // Axle-shaped dark slabs read as four wheels at silhouette scale without another material or draw.
    colouredBox(width * 1.04, wheelRadius * 1.65, 0.34, 0, wheelRadius, length * 0.31, 0x15191a),
    colouredBox(width * 1.04, wheelRadius * 1.65, 0.34, 0, wheelRadius, -length * 0.31, 0x15191a),
  ];
  if (spec.kind === 'police') {
    const lightY = bodyY + bodyHeight * 0.42 + cabinHeight + 0.08;
    parts.push(
      colouredBox(width * 0.34, 0.13, 0.18, -width * 0.19, lightY, cabinZ, 0x2874ff),
      colouredBox(width * 0.34, 0.13, 0.18, width * 0.19, lightY, cabinZ, 0xff3328),
    );
  }
  return parts;
}

function geometryFor(spec: VehicleSpec): THREE.BufferGeometry {
  const key = `${spec.kind}:${spec.color.toString(16)}`;
  const cached = geometryCache.get(key); if (cached) return cached;
  const parts = spec.twoWheeler ? buildTwoWheeler(spec) : buildRoadVehicle(spec);
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error(`Unable to build ${spec.kind} vehicle LOD proxy.`);
  geometry.name = `vehicle-lod-${key}`; geometry.computeBoundingSphere(); geometryCache.set(key, geometry);
  return geometry;
}

export interface VehicleLodProxy {
  mesh: THREE.Mesh;
  sharedGeometry: THREE.BufferGeometry;
}

/** Builds a one-draw, 48–72 triangle silhouette. Geometry and material are shared across matching fleet paint. */
export function instantiateVehicleLodProxy(spec: VehicleSpec): VehicleLodProxy {
  const geometry = geometryFor(spec);
  const mesh = new THREE.Mesh(geometry, PROXY_MATERIAL);
  mesh.name = 'vehicle-lod-proxy'; mesh.visible = false; mesh.castShadow = false; mesh.receiveShadow = false;
  return { mesh, sharedGeometry: geometry };
}

/** Test/debug observability without exposing the cache for mutation. */
export function vehicleLodProxyStats(): { variants: number; material: THREE.Material } {
  return { variants: geometryCache.size, material: PROXY_MATERIAL };
}
