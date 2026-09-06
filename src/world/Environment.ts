import * as THREE from 'three';
import { createAmbientSkyTraffic, type AmbientSkyTrafficHandle } from './AmbientSkyTraffic';
import { createAtmosphericSky, type AtmosphericSkyHandle } from './AtmosphericSky';

export interface EnvironmentHandle {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  ambient: THREE.AmbientLight;
  sunDisc: THREE.Mesh;
  sky: AtmosphericSkyHandle;
  skyTraffic: AmbientSkyTrafficHandle;
  updateShadowFocus(focus: THREE.Vector3): void;
  setSunDirection(direction: THREE.Vector3): void;
}

const SHADOW_SPAN = 80;
const SUN_DISTANCE = 240;

/** Haze density per tier, tuned around the 1500u facade-streaming ring while cheaper roads and iconic
 *  skyline silhouettes carry to 2500u. The thicker Joburg horizon masks cell transitions without turning
 *  the immediate neighbourhood grey. Potato remains a genuinely smoggy day around its tighter ring. */
export function fogDensity(quality: 'potato' | 'low' | 'medium' | 'high'): number {
  return quality === 'potato' ? 0.0011 : quality === 'low' ? 0.0005 : 0.00038;
}

export function buildEnvironment(scene: THREE.Scene, quality: 'low' | 'medium' | 'high'): EnvironmentHandle {
  const shadows = quality !== 'low';
  scene.background = new THREE.Color(0x6fa8dd); // clear-colour fallback behind the atmospheric dome
  scene.fog = new THREE.FogExp2(0xc4b48c, fogDensity(quality)); // player-relative haze (see fogDensity)

  const sky = createAtmosphericSky(quality); scene.add(sky.mesh);
  const skyTraffic = createAmbientSkyTraffic(quality); scene.add(skyTraffic.group);

  const hemisphere = new THREE.HemisphereLight(0xcfe4f5, 0x8a7c4d, 1.6); scene.add(hemisphere);
  const ambient = new THREE.AmbientLight(0xffead0, 0.28); scene.add(ambient);
  const sunOffset = new THREE.Vector3(165, 185, 110).normalize().multiplyScalar(SUN_DISTANCE);
  const sun = new THREE.DirectionalLight(0xffd9a0, 4.4); sun.position.copy(sunOffset); sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_SPAN; sun.shadow.camera.right = SHADOW_SPAN; sun.shadow.camera.top = SHADOW_SPAN; sun.shadow.camera.bottom = -SHADOW_SPAN;
  sun.shadow.camera.near = 60; sun.shadow.camera.far = 460; sun.shadow.bias = -0.00018; sun.shadow.normalBias = 0.02;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffdf9d, fog: false })); sunDisc.position.set(330, 370, -520); sunDisc.name = 'Sun'; scene.add(sunDisc);

  const focusPoint = new THREE.Vector3(); const snapped = new THREE.Vector3();
  const basis = new THREE.Matrix4(); const origin = new THREE.Vector3();
  const right = new THREE.Vector3(); const up = new THREE.Vector3();
  const updateShadowFocus = (focus: THREE.Vector3): void => {
    focusPoint.copy(focus);
    // Snap in the shadow camera's plane. Snapping world X/Z still slides geometry between shadow
    // texels when the sun is oblique, and pinning Y=0 leaves roofs/elevated districts out of range.
    basis.lookAt(sunOffset, origin, sun.shadow.camera.up);
    right.setFromMatrixColumn(basis, 0); up.setFromMatrixColumn(basis, 1);
    const texelX = (sun.shadow.camera.right - sun.shadow.camera.left) / sun.shadow.camera.zoom / sun.shadow.mapSize.x;
    const texelY = (sun.shadow.camera.top - sun.shadow.camera.bottom) / sun.shadow.camera.zoom / sun.shadow.mapSize.y;
    const x = focus.dot(right); const y = focus.dot(up);
    snapped.copy(focus)
      .addScaledVector(right, Math.round(x / texelX) * texelX - x)
      .addScaledVector(up, Math.round(y / texelY) * texelY - y);
    sun.position.copy(snapped).add(sunOffset);
    sun.target.position.copy(snapped);
    sky.mesh.position.copy(focus); // the dome follows the player so its horizon can never be reached
  };
  const setSunDirection = (direction: THREE.Vector3): void => {
    sunOffset.copy(direction).normalize().multiplyScalar(SUN_DISTANCE);
    updateShadowFocus(focusPoint);
  };
  updateShadowFocus(new THREE.Vector3());
  return { sun, hemisphere, ambient, sunDisc, sky, skyTraffic, updateShadowFocus, setSunDirection };
}
