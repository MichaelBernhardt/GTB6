/**
 * Offscreen model inspector — a Blender-free way to LOOK at code-built geometry.
 *
 * Served by the ordinary vite dev server (so it imports the real app modules, no bundling step)
 * and driven headlessly by tools/preview/shoot.py, which screenshots the canvas to a PNG.
 *
 * Renders one subject into a 2x2 turnaround (front-three-quarter, side, rear-three-quarter, top)
 * via scissored viewports, plus an optional interior eye view. Everything the page needs is on
 * `window.__preview` so the driver can re-shoot other subjects without a reload.
 */
import * as THREE from 'three';
import { Vehicle } from '../../src/entities/Vehicle';
import { buildCar } from '../../src/systems/TrainSystem';
import { buildLightAircraft } from '../../src/world/Airport';

type Subject = { object: THREE.Object3D; label: string; interiorEye?: THREE.Vector3; interiorLook?: THREE.Vector3 };

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2e33);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(1400, 1000, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Studio light: a warm key with shadows, a cool fill, a dome ambient. Enough contrast to read
// panel breaks and spoke gaps without blowing out the clearcoat paint.
const key = new THREE.DirectionalLight(0xfff3e0, 2.4);
key.position.set(6, 9, 7); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.00018; key.shadow.normalBias = 0.02; // match Environment.ts, or thin panels self-shadow black
const shadowCam = key.shadow.camera as THREE.OrthographicCamera;
shadowCam.left = -14; shadowCam.right = 14; shadowCam.top = 14; shadowCam.bottom = -14; shadowCam.far = 60;
scene.add(key);
scene.add(new THREE.DirectionalLight(0xbcd4ff, 0.8).translateX(-7).translateY(4).translateZ(-6));
scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x33383d, 1.1));

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x4a5057, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const stage = new THREE.Group(); scene.add(stage);

/** Build one subject by name. Vehicle kinds go through the real Vehicle constructor. */
function makeSubject(name: string): Subject {
  if (name.startsWith('traincar')) {
    const built = buildCar(true, false);
    // FLOOR_Y 1.0 + FP_EYE_FOOT 1.62 — exactly where a riding player's eye sits (TrainSystem/CameraController).
    // The seated variant is cushion top 1.47 + ~0.75, the height the window sill has to clear.
    const seated = name.includes('seat');
    const aisle = name.includes('aisle');
    return {
      object: built.group,
      label: 'train carriage',
      interiorEye: seated ? new THREE.Vector3(1.18, 2.22, -1.4) : new THREE.Vector3(0, 2.62, -2),
      interiorLook: aisle ? new THREE.Vector3(0, 2.4, 7) : seated ? new THREE.Vector3(2.6, 1.7, 5.4) : new THREE.Vector3(6, 2.4, 1.5),
    };
  }
  if (name === 'plane') return { object: buildLightAircraft(1).group, label: 'Karoo Kite' };
  const vehicle = new Vehicle(scene, name as never, new THREE.Vector3(0, 0, 0));
  vehicle.group.rotation.z = 0; // cancel the kickstand tilt so the turnaround is square
  scene.remove(vehicle.group);
  return { object: vehicle.group, label: vehicle.spec.name };
}

/** Fit the SILHOUETTE, not the bounding sphere: the box corners are projected onto the camera's own
 *  screen axes, so a side-on shot of an 11 m wingspan fills the frame with the 7 m profile instead of
 *  shrinking everything to fit a span the view cannot even see. */
function frame(camera: THREE.PerspectiveCamera, box: THREE.Box3, dir: THREE.Vector3, aspect: number): void {
  const centre = box.getCenter(new THREE.Vector3());
  const forward = dir.clone().normalize();
  const worldUp = Math.abs(forward.x) < 1e-3 && Math.abs(forward.z) < 1e-3 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, forward).normalize();
  const up = new THREE.Vector3().crossVectors(forward, right).normalize();
  let halfWidth = 0; let halfHeight = 0; let halfDepth = 0;
  const corner = new THREE.Vector3();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corner.set(x, y, z).sub(centre);
    halfWidth = Math.max(halfWidth, Math.abs(corner.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(corner.dot(up)));
    halfDepth = Math.max(halfDepth, Math.abs(corner.dot(forward)));
  }
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const radius = Math.max(halfHeight, halfWidth / Math.max(0.2, aspect)) + 0.12;
  const dist = radius / Math.tan(fov / 2) * 1.1 + halfDepth;
  camera.position.copy(centre).addScaledVector(forward, dist);
  camera.up.copy(worldUp);
  camera.lookAt(centre);
  camera.near = Math.max(0.02, dist - halfDepth * 2 - radius); camera.far = dist + halfDepth * 4 + radius * 4;
  camera.updateProjectionMatrix();
}

const VIEWS: Array<{ dir: THREE.Vector3; tag: string }> = [
  { dir: new THREE.Vector3(1.15, 0.55, 1.4), tag: 'front 3/4' },
  { dir: new THREE.Vector3(1, 0.06, 0), tag: 'side' },
  { dir: new THREE.Vector3(-1.15, 0.5, -1.3), tag: 'rear 3/4' },
  { dir: new THREE.Vector3(0, 1, 0.001), tag: 'top' },
];

let current: Subject | undefined;

function show(name: string): string {
  if (current) { stage.remove(current.object); }
  current = makeSubject(name);
  stage.add(current.object);
  (window as unknown as { __previewCurrent: THREE.Object3D }).__previewCurrent = current.object;
  return current.label;
}

/** Single-view directions: one subject filling the whole canvas, for judging detail honestly.
 *  `ridden` is the side view with the seated dummy switched on — the two-wheeler dummies are built
 *  from the same grip and footrest points the frozen player ride clips reach for, so seeing hands on
 *  bars and boots on pegs is the only direct check that the geometry came to the pose. */
const SOLO: Record<string, THREE.Vector3> = {
  hero: new THREE.Vector3(1.15, 0.55, 1.4),
  side: new THREE.Vector3(1, 0.06, 0),
  ridden: new THREE.Vector3(1, 0.06, 0),
  rear: new THREE.Vector3(-1.15, 0.5, -1.3),
  front: new THREE.Vector3(0.25, 0.22, 1),
  top: new THREE.Vector3(0, 1, 0.001),
};

function draw(mode: string): void {
  const rider = current!.object.getObjectByName('rider');
  if (rider) rider.visible = mode === 'ridden';
  const box = new THREE.Box3().setFromObject(current!.object);
  const w = renderer.domElement.width; const h = renderer.domElement.height;
  renderer.setScissorTest(true);
  if (SOLO[mode]) {
    const camera = new THREE.PerspectiveCamera(30, w / h, 0.05, 400);
    frame(camera, box, SOLO[mode]!, w / h);
    renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    return;
  }
  if (mode === 'interior') {
    const camera = new THREE.PerspectiveCamera(70, w / h, 0.05, 200);
    camera.position.copy(current!.interiorEye ?? box.getCenter(new THREE.Vector3()));
    camera.lookAt(current!.interiorLook ?? new THREE.Vector3(3, 2.5, 1.5));
    renderer.setViewport(0, 0, w, h); renderer.setScissor(0, 0, w, h);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    return;
  }
  const cw = w / 2; const ch = h / 2;
  VIEWS.forEach((view, index) => {
    const x = (index % 2) * cw; const y = h - ch - Math.floor(index / 2) * ch;
    const camera = new THREE.PerspectiveCamera(32, cw / ch, 0.05, 400);
    frame(camera, box, view.dir, cw / ch);
    renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch);
    renderer.render(scene, camera);
  });
  renderer.setScissorTest(false);
}

interface PreviewApi {
  render: (name: string, mode?: string) => { label: string; tris: number };
  /** Build the subject TWICE and report how much is shared — the geometry-cache regression check. */
  sharing: (name: string) => { meshes: number; geometries: number; materials: number; sharedGeometries: number; sharedMaterials: number; tris: number };
  /** What a ray from `origin` along `dir` hits, nearest first — the honest answer to "can the rider see out?". */
  probe: (origin: [number, number, number], dir: [number, number, number]) => Array<{ mesh: string; colour: string; transparent: boolean; side: number; distance: number }>;
  ready: boolean;
}
const api: PreviewApi = {
  ready: true,
  sharing(name) {
    const collect = (root: THREE.Object3D): { g: string[]; m: string[]; tris: number } => {
      const g: string[] = []; const m: string[] = []; let tris = 0;
      root.traverse((object) => {
        const mesh = object as THREE.Mesh & { isMesh?: boolean; count?: number };
        if (!mesh.isMesh) return;
        g.push(mesh.geometry.uuid);
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.push(material.uuid);
        const attr = mesh.geometry.attributes.position;
        tris += ((mesh.geometry.index ? mesh.geometry.index.count : attr.count) / 3) * (mesh.count ?? 1);
      });
      return { g, m, tris };
    };
    const a = collect(makeSubject(name).object);
    const b = collect(makeSubject(name).object);
    const setB = new Set(b.g); const matB = new Set(b.m);
    return {
      meshes: a.g.length,
      geometries: new Set(a.g).size,
      materials: new Set(a.m).size,
      sharedGeometries: new Set(a.g.filter((uuid) => setB.has(uuid))).size,
      sharedMaterials: new Set(a.m.filter((uuid) => matB.has(uuid))).size,
      tris: Math.round(a.tris),
    };
  },
  probe(origin, dir) {
    const ray = new THREE.Raycaster(new THREE.Vector3(...origin), new THREE.Vector3(...dir).normalize(), 0, 60);
    (ray.params as { Mesh?: unknown }).Mesh = {};
    const hits = ray.intersectObject(current!.object, true);
    return hits.map((hit) => {
      const material = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
      return {
        mesh: `${hit.object.type}:${((hit.object as THREE.Mesh).geometry.type)}`,
        colour: `#${material.color.getHexString()}`,
        transparent: material.transparent || material.opacity < 1,
        side: material.side,
        distance: Number(hit.distance.toFixed(3)),
      };
    });
  },
  render(name, mode = 'turnaround') {
    const label = show(name.replace(/[:@].*$/, ''));
    draw(mode);
    let tris = 0;
    current!.object.traverse((object) => {
      const mesh = object as THREE.Mesh & { count?: number };
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      const count = geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3;
      tris += count * (mesh.count ?? 1);
    });
    return { label, tris: Math.round(tris) };
  },
};
(window as unknown as { __preview: PreviewApi }).__preview = api;

// ---- Human-facing chrome. The API above is driven by tools/preview/shoot.py; this makes the same
// page browsable by hand so the models can be reviewed without a screenshot run.
const SUBJECTS = ['bicycle', 'motorbike', 'courier', 'superbike', 'traincar', 'traincar-seat', 'traincar-aisle', 'plane'];
const MODES = ['turnaround', 'hero', 'side', 'ridden', 'front', 'rear', 'top', 'interior'];
let pickedSubject = SUBJECTS[0]!; let pickedMode = MODES[0]!;

const bar = document.createElement('div');
bar.style.cssText = 'position:fixed;top:0;left:0;right:0;padding:8px 10px;background:#12141699;backdrop-filter:blur(6px);'
  + 'font:13px system-ui,sans-serif;color:#dfe5ea;display:flex;gap:14px;align-items:center;flex-wrap:wrap;z-index:9';
document.body.appendChild(bar);
const readout = document.createElement('span');
readout.style.cssText = 'margin-left:auto;opacity:.75;font-variant-numeric:tabular-nums';

function group(items: string[], get: () => string, set: (v: string) => void): HTMLElement {
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
  const paint = (): void => {
    [...wrap.children].forEach((child, index) => {
      const on = items[index] === get();
      (child as HTMLElement).style.cssText = 'padding:4px 9px;border-radius:5px;cursor:pointer;border:1px solid '
        + (on ? '#6ea8fe' : '#ffffff22') + ';background:' + (on ? '#6ea8fe22' : 'transparent') + ';color:inherit';
    });
  };
  for (const item of items) {
    const button = document.createElement('button'); button.textContent = item;
    button.onclick = () => { set(item); paint(); refresh(); };
    wrap.appendChild(button);
  }
  paint(); return wrap;
}

function refresh(): void {
  try {
    const { label, tris } = api.render(pickedSubject, pickedMode);
    readout.textContent = `${label} — ${tris.toLocaleString()} tris`;
  } catch (error) {
    readout.textContent = String(error);
  }
}

bar.append(group(SUBJECTS, () => pickedSubject, (v) => { pickedSubject = v; }), group(MODES, () => pickedMode, (v) => { pickedMode = v; }), readout);
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight, false); refresh(); });
renderer.setSize(innerWidth, innerHeight, false);
refresh();
