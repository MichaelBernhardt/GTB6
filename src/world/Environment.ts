import * as THREE from 'three';

export function buildEnvironment(scene: THREE.Scene, quality: 'low' | 'high'): THREE.DirectionalLight {
  scene.background = new THREE.Color(0x6fa8dd);
  scene.fog = new THREE.FogExp2(0xc4b48c, quality === 'high' ? 0.0012 : 0.0015);

  const hemisphere = new THREE.HemisphereLight(0xcfe4f5, 0x8a7c4d, 1.75); scene.add(hemisphere);
  const ambient = new THREE.AmbientLight(0xffead0, 0.32); scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffd9a0, 4.4); sun.position.set(165, 270, 110); sun.castShadow = quality === 'high';
  sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
  sun.shadow.camera.left = -360; sun.shadow.camera.right = 360; sun.shadow.camera.top = 360; sun.shadow.camera.bottom = -360; sun.shadow.camera.near = 20; sun.shadow.camera.far = 620; sun.shadow.bias = -0.00018; sun.shadow.normalBias = 0.025;
  scene.add(sun);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffdf9d, fog: false })); sunDisc.position.set(330, 370, -520); sunDisc.name = 'Sun'; scene.add(sunDisc);
  return sun;
}
