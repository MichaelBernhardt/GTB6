import * as THREE from 'three';

export interface EnvironmentHandle { sun: THREE.DirectionalLight; updateShadowFocus(focus: THREE.Vector3): void; }

const SHADOW_SPAN = 80;
const SUN_OFFSET = new THREE.Vector3(165, 185, 110).normalize().multiplyScalar(240);

export function buildEnvironment(scene: THREE.Scene, quality: 'low' | 'medium' | 'high'): EnvironmentHandle {
  const shadows = quality !== 'low';
  scene.background = new THREE.Color(0x79aebd);
  scene.fog = new THREE.FogExp2(0x9dbfc0, quality === 'low' ? 0.00175 : 0.00145);

  const hemisphere = new THREE.HemisphereLight(0xd9edf0, 0x59634d, 1.6); scene.add(hemisphere);
  const ambient = new THREE.AmbientLight(0xffead0, 0.28); scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffe4b4, 4.1); sun.position.copy(SUN_OFFSET); sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_SPAN; sun.shadow.camera.right = SHADOW_SPAN; sun.shadow.camera.top = SHADOW_SPAN; sun.shadow.camera.bottom = -SHADOW_SPAN;
  sun.shadow.camera.near = 60; sun.shadow.camera.far = 460; sun.shadow.bias = -0.00018; sun.shadow.normalBias = 0.02;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffdf9d, fog: false })); sunDisc.position.set(330, 370, -520); sunDisc.name = 'Sun'; scene.add(sunDisc);

  const texel = (SHADOW_SPAN * 2) / 2048; const snapped = new THREE.Vector3();
  const updateShadowFocus = (focus: THREE.Vector3): void => {
    snapped.set(Math.round(focus.x / texel) * texel, 0, Math.round(focus.z / texel) * texel);
    sun.position.copy(snapped).add(SUN_OFFSET);
    sun.target.position.copy(snapped);
  };
  updateShadowFocus(new THREE.Vector3());
  return { sun, updateShadowFocus };
}
