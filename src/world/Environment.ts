import * as THREE from 'three';

export function buildEnvironment(scene: THREE.Scene, quality: 'low' | 'high'): THREE.DirectionalLight {
  const skyCanvas = document.createElement('canvas'); skyCanvas.width = 2; skyCanvas.height = 512;
  const skyContext = skyCanvas.getContext('2d');
  if (skyContext) {
    const gradient = skyContext.createLinearGradient(0, 0, 0, 512); gradient.addColorStop(0, '#4789a4'); gradient.addColorStop(0.62, '#9fc5c5'); gradient.addColorStop(1, '#d7caa7'); skyContext.fillStyle = gradient; skyContext.fillRect(0, 0, 2, 512);
    const skyTexture = new THREE.CanvasTexture(skyCanvas); skyTexture.colorSpace = THREE.SRGBColorSpace; scene.background = skyTexture;
  } else scene.background = new THREE.Color(0x9fc7cf);
  scene.fog = new THREE.FogExp2(0x9dbfc0, quality === 'high' ? 0.00145 : 0.00175);

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
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 192;
  const context = canvas.getContext('2d'); if (!context) return;
  const puffs: Array<[number, number, number]> = [[90, 118, 66], [165, 92, 84], [250, 105, 96], [340, 88, 78], [420, 120, 62]];
  for (const [x, y, radius] of puffs) {
    const gradient = context.createRadialGradient(x, y, radius * 0.12, x, y, radius); gradient.addColorStop(0, '#f4f7f2dd'); gradient.addColorStop(0.55, '#e8efecb8'); gradient.addColorStop(1, '#dce9e500');
    context.fillStyle = gradient; context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const clouds: Array<[number, number, number, number]> = [[-300, 300, -520, 150], [210, 335, -610, 190], [430, 280, -360, 130], [-440, 290, -80, 160], [30, 370, -720, 175]];
  for (const [x, y, z, scale] of clouds) {
    const cloud = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.5, depthWrite: false, fog: false })); cloud.position.set(x, y, z); cloud.scale.set(scale, scale * 0.36, 1); scene.add(cloud);
  }
}
