import * as THREE from 'three';

export function buildEnvironment(scene: THREE.Scene, quality: 'low' | 'high'): THREE.DirectionalLight {
  scene.background = new THREE.Color(0x9fc7cf);
  scene.fog = new THREE.FogExp2(0x9dbfc0, quality === 'high' ? 0.00145 : 0.00175);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(820, 32, 18),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x4385a0) },
        horizonColor: { value: new THREE.Color(0xbad4cd) },
        groundColor: { value: new THREE.Color(0xd5c59f) },
        offset: { value: 45 },
        exponent: { value: 0.72 },
      },
      vertexShader: 'varying vec3 vWorldPosition; void main(){ vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 groundColor; uniform float offset; uniform float exponent; varying vec3 vWorldPosition; void main(){ float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y; float skyMix = pow(max(h, 0.0), exponent); vec3 horizon = mix(groundColor, horizonColor, smoothstep(-0.14, 0.08, h)); gl_FragColor = vec4(mix(horizon, topColor, skyMix), 1.0); }',
    }),
  );
  sky.name = 'Atmosphere'; scene.add(sky);

  const hemisphere = new THREE.HemisphereLight(0xd9edf0, 0x59634d, 1.75); scene.add(hemisphere);
  const ambient = new THREE.AmbientLight(0xffead0, 0.32); scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffe4b4, 4.1); sun.position.set(165, 270, 110); sun.castShadow = quality === 'high';
  sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
  sun.shadow.camera.left = -360; sun.shadow.camera.right = 360; sun.shadow.camera.top = 360; sun.shadow.camera.bottom = -360; sun.shadow.camera.near = 20; sun.shadow.camera.far = 620; sun.shadow.bias = -0.00018; sun.shadow.normalBias = 0.025;
  scene.add(sun);

  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(14, 24, 16), new THREE.MeshBasicMaterial({ color: 0xffdf9d, fog: false })); sunDisc.position.set(330, 370, -520); sunDisc.name = 'Sun'; scene.add(sunDisc);
  addClouds(scene);
  return sun;
}

function addClouds(scene: THREE.Scene): void {
  const material = new THREE.MeshStandardMaterial({ color: 0xe7efed, roughness: 1, transparent: true, opacity: 0.72, depthWrite: false });
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const clouds: Array<[number, number, number, number]> = [[-300, 210, -430, 30], [190, 245, -500, 42], [390, 190, -260, 26], [-420, 180, 60, 34], [40, 270, -650, 36]];
  for (const [x, y, z, scale] of clouds) {
    const cloud = new THREE.Group(); cloud.position.set(x, y, z);
    for (let part = 0; part < 5; part++) {
      const puff = new THREE.Mesh(geometry, material); puff.position.set((part - 2) * scale * 0.55, Math.sin(part * 1.8) * scale * 0.12, (part % 2) * scale * 0.1); puff.scale.set(scale * (0.7 + part % 2 * 0.2), scale * 0.25, scale * 0.4); cloud.add(puff);
    }
    scene.add(cloud);
  }
}
