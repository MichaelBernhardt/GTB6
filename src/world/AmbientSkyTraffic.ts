import * as THREE from 'three';
import type { BaseQuality } from '../types';

export const SKY_TRAFFIC_COUNT: Record<BaseQuality, number> = { low: 1, medium: 2, high: 3 };
export const SKY_TRAFFIC_SPAN = 2400;

interface FlightLane {
  dx: number;
  dz: number;
  altitude: number;
  offset: number;
  phase: number;
  speed: number;
}

const FLIGHT_LANES: FlightLane[] = [
  { dx: 0.970, dz: 0.243, altitude: 340, offset: -520, phase: 600, speed: 34 },
  { dx: -0.330, dz: 0.944, altitude: 460, offset: 420, phase: 1810, speed: 29 },
  { dx: 0.718, dz: -0.696, altitude: 300, offset: 170, phase: 480, speed: 41 },
];

export interface SkyTrafficPose { x: number; y: number; z: number; heading: number }

/** Deterministic player-relative lane pose. Flights cross the whole visible sky, then wrap far behind it. */
export function skyTrafficPose(index: number, time: number, focus: THREE.Vector3, out: SkyTrafficPose): SkyTrafficPose {
  const lane = FLIGHT_LANES[index % FLIGHT_LANES.length]!;
  const along = ((time * lane.speed + lane.phase) % SKY_TRAFFIC_SPAN + SKY_TRAFFIC_SPAN) % SKY_TRAFFIC_SPAN - SKY_TRAFFIC_SPAN / 2;
  const sideX = -lane.dz; const sideZ = lane.dx;
  out.x = focus.x + lane.dx * along + sideX * lane.offset;
  out.y = focus.y + lane.altitude;
  out.z = focus.z + lane.dz * along + sideZ * lane.offset;
  out.heading = Math.atan2(lane.dx, lane.dz);
  return out;
}

export interface AmbientSkyTrafficHandle {
  group: THREE.Group;
  aircraft: THREE.Group[];
  setMood(focus: THREE.Vector3, time: number, night: number, sunColor: THREE.Color): void;
  setQuality(quality: BaseQuality): void;
}

interface AircraftMaterials {
  body: THREE.MeshBasicMaterial;
  contrail: THREE.MeshBasicMaterial;
}

const FUSELAGE = new THREE.CylinderGeometry(0.72, 0.88, 19, 8); FUSELAGE.rotateX(Math.PI / 2);
const NOSE = new THREE.ConeGeometry(0.74, 2.6, 8); NOSE.rotateX(Math.PI / 2);
const CONTRAIL = new THREE.CylinderGeometry(0.08, 0.42, 88, 6, 1, true); CONTRAIL.rotateX(Math.PI / 2);

function flatGeometry(vertices: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const WINGS = flatGeometry([
  0, 0, 4, -9, 0, -1.2, 0, 0, -3.2,
  0, 0, 4, 0, 0, -3.2, 9, 0, -1.2,
  0, 0, -6.4, -3.4, 0, -8.7, 0, 0, -8.1,
  0, 0, -6.4, 0, 0, -8.1, 3.4, 0, -8.7,
]);
const TAIL = flatGeometry([0, 0, -6.0, 0, 3.1, -8.5, 0, 0, -8.8]);

function buildAircraft(index: number): { group: THREE.Group; materials: AircraftMaterials } {
  const group = new THREE.Group(); group.name = `Ambient Flight ${index + 1}`; group.scale.setScalar(1.35);
  const body = new THREE.MeshBasicMaterial({ color: 0xe7e8e5, transparent: true, side: THREE.DoubleSide, fog: false });
  const dark = new THREE.MeshBasicMaterial({ color: 0x59616b, transparent: true, side: THREE.DoubleSide, fog: false });
  const contrail = new THREE.MeshBasicMaterial({ color: 0xf3f6fb, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false });
  const fuselage = new THREE.Mesh(FUSELAGE, body); group.add(fuselage);
  const nose = new THREE.Mesh(NOSE, body); nose.position.z = 10.7; group.add(nose);
  const wings = new THREE.Mesh(WINGS, dark); wings.position.y = -0.08; group.add(wings);
  const tail = new THREE.Mesh(TAIL, dark); group.add(tail);
  for (const x of [-2.7, 2.7]) {
    const trail = new THREE.Mesh(CONTRAIL, contrail); trail.position.set(x, 0.05, -47); group.add(trail);
  }
  group.traverse((object) => { object.renderOrder = -100; });
  group.userData.darkMaterial = dark;
  return { group, materials: { body, contrail } };
}

/** Distant, non-colliding airline traffic: simple silhouettes and twin contrails, never gameplay aircraft. */
export function createAmbientSkyTraffic(quality: BaseQuality): AmbientSkyTrafficHandle {
  const group = new THREE.Group(); group.name = 'Ambient Sky Traffic';
  const aircraft: THREE.Group[] = []; const materials: AircraftMaterials[] = [];
  const pose: SkyTrafficPose = { x: 0, y: 0, z: 0, heading: 0 };
  const bodyTint = new THREE.Color(); const darkTint = new THREE.Color(); const trailTint = new THREE.Color();
  let activeCount = SKY_TRAFFIC_COUNT[quality];
  for (let index = 0; index < SKY_TRAFFIC_COUNT.high; index++) {
    const built = buildAircraft(index); aircraft.push(built.group); materials.push(built.materials); group.add(built.group);
  }

  return {
    group,
    aircraft,
    setMood(focus: THREE.Vector3, time: number, night: number, sunColor: THREE.Color): void {
      const daylight = Math.max(0, 1 - night);
      bodyTint.setHex(0xe7e8e5).lerp(sunColor, 0.16);
      darkTint.setHex(0x59616b).lerp(sunColor, 0.08);
      trailTint.setHex(0xf3f6fb).lerp(sunColor, 0.20);
      for (let index = 0; index < aircraft.length; index++) {
        const plane = aircraft[index]!; const enabled = index < activeCount && daylight > 0.025;
        plane.visible = enabled;
        if (!enabled) continue;
        skyTrafficPose(index, time, focus, pose);
        plane.position.set(pose.x, pose.y, pose.z); plane.rotation.y = pose.heading;
        const planeMaterials = materials[index]!;
        planeMaterials.body.color.copy(bodyTint); planeMaterials.body.opacity = daylight;
        const dark = plane.userData.darkMaterial as THREE.MeshBasicMaterial; dark.color.copy(darkTint); dark.opacity = daylight;
        planeMaterials.contrail.color.copy(trailTint); planeMaterials.contrail.opacity = daylight * 0.42;
      }
    },
    setQuality(tier: BaseQuality): void {
      activeCount = SKY_TRAFFIC_COUNT[tier];
      for (let index = activeCount; index < aircraft.length; index++) aircraft[index]!.visible = false;
    },
  };
}
