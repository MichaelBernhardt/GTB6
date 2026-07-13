import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import type { BaseQuality } from '../types';
import { wrapHour } from './DayNight';
import { createSurfaceTexture } from './ProceduralMaterials';

/** Water render tiers by graphics quality: 'planar' mirrors the real scene on the harbour plane, 'physical'
 *  rides the env-map with the same waves and ripples, 'flat' keeps the cheap scrolling texture. */
export type WaterTier = 'planar' | 'physical' | 'flat';
export function waterTier(quality: BaseQuality): WaterTier {
  return quality === 'high' ? 'planar' : quality === 'medium' ? 'physical' : 'flat';
}

const TAU = Math.PI * 2;

export interface WaveSpec { dirX: number; dirZ: number; amplitude: number; wavelength: number; speed: number; }
/** Harbour swell (vertex displacement + fragment normals): a long primary set, a diagonal secondary, short chop. */
export const OCEAN_WAVES: WaveSpec[] = [
  { dirX: 0.83, dirZ: 0.56, amplitude: 0.17, wavelength: 31, speed: 1.05 },
  { dirX: -0.44, dirZ: 0.9, amplitude: 0.1, wavelength: 16, speed: 1.65 },
  { dirX: 0.97, dirZ: -0.24, amplitude: 0.055, wavelength: 7.5, speed: 2.5 },
];
/** Fragment-only sparkle: too short to spend vertices on, these only bend the shading normal. */
export const DETAIL_WAVES: WaveSpec[] = [
  { dirX: 0.71, dirZ: 0.71, amplitude: 0.02, wavelength: 3.1, speed: 3.4 },
  { dirX: -0.9, dirZ: 0.42, amplitude: 0.014, wavelength: 1.7, speed: 4.6 },
];

/** Sum-of-sines swell height at (x, z); the vertex shader runs the identical expression via waveHeightGlsl. */
export function waveHeight(x: number, z: number, time: number, waves: readonly WaveSpec[] = OCEAN_WAVES): number {
  let height = 0;
  for (const wave of waves) height += wave.amplitude * Math.sin((x * wave.dirX + z * wave.dirZ) * (TAU / wave.wavelength) + time * wave.speed);
  return height;
}

/** Analytic (∂h/∂x, ∂h/∂z) of waveHeight: fragment normals come from this same math, so shading always matches displacement. */
export function waveSlope(x: number, z: number, time: number, waves: readonly WaveSpec[] = OCEAN_WAVES): [number, number] {
  let sx = 0; let sz = 0;
  for (const wave of waves) {
    const k = TAU / wave.wavelength;
    const crest = wave.amplitude * k * Math.cos((x * wave.dirX + z * wave.dirZ) * k + time * wave.speed);
    sx += crest * wave.dirX; sz += crest * wave.dirZ;
  }
  return [sx, sz];
}

const glsl = (value: number): string => { const text = String(value); return /[.e]/.test(text) ? text : `${text}.0`; };

/** GLSL twin of waveHeight, generated from the same wave table so shader and tests cannot drift. */
export function waveHeightGlsl(x: string, z: string, time: string, waves: readonly WaveSpec[] = OCEAN_WAVES): string {
  return waves.map((w) => `${glsl(w.amplitude)} * sin((${x} * ${glsl(w.dirX)} + ${z} * ${glsl(w.dirZ)}) * ${glsl(TAU / w.wavelength)} + ${time} * ${glsl(w.speed)})`).join(' + ');
}

/** GLSL twin of waveSlope: a vec2 expression summing per-wave gradients. */
export function waveSlopeGlsl(x: string, z: string, time: string, waves: readonly WaveSpec[] = OCEAN_WAVES): string {
  return waves.map((w) => {
    const k = TAU / w.wavelength;
    return `${glsl(w.amplitude * k)} * cos((${x} * ${glsl(w.dirX)} + ${z} * ${glsl(w.dirZ)}) * ${glsl(k)} + ${time} * ${glsl(w.speed)}) * vec2(${glsl(w.dirX)}, ${glsl(w.dirZ)})`;
  }).join(' + ');
}

export interface RippleSpec { wavelength: number; speed: number; amplitude: number; }
/** Fountain basins get tight fast rings radiating from the splash column; ponds broader, lazier ones. */
export const FOUNTAIN_RIPPLE: RippleSpec = { wavelength: 1.15, speed: 1.35, amplitude: 0.42 };
export const POND_RIPPLE: RippleSpec = { wavelength: 2.4, speed: 0.55, amplitude: 0.11 };

/** Radial ripple phase: crests move outward at spec.speed world units per second. */
export const ripplePhase = (distance: number, time: number, spec: RippleSpec, offset = 0): number =>
  (distance - time * spec.speed) * (TAU / spec.wavelength) + offset;
/** Ripples die off linearly toward the basin rim so the waterline stays still. */
export const rippleEnvelope = (distance: number, radius: number): number => Math.max(0, 1 - distance / radius);
/** Radial normal slope magnitude at a distance from the basin centre. */
export const rippleSlope = (distance: number, time: number, radius: number, spec: RippleSpec, offset = 0): number =>
  spec.amplitude * rippleEnvelope(distance, radius) * Math.cos(ripplePhase(distance, time, spec, offset));

/** GLSL twin of rippleSlope with constants baked per basin. */
export function rippleSlopeGlsl(distance: string, time: string, radius: number, spec: RippleSpec, offset = 0): string {
  return `${glsl(spec.amplitude)} * max(0.0, 1.0 - ${distance} / ${glsl(radius)}) * cos((${distance} - ${time} * ${glsl(spec.speed)}) * ${glsl(TAU / spec.wavelength)} + ${glsl(offset)})`;
}

export interface WaterKeyframe { hour: number; color: number; }
const NIGHT_WATER = 0x101f38;
/** Hours line up with SKY_KEYFRAMES so the water always agrees with the sky above it:
 *  deep blue nights, olive dawn glint, teal days, copper dusk. */
export const WATER_KEYFRAMES: WaterKeyframe[] = [
  { hour: 0, color: NIGHT_WATER },
  { hour: 4.6, color: NIGHT_WATER },
  { hour: 6.1, color: 0x6b6e50 },
  { hour: 8, color: 0x2c6d80 },
  { hour: 12, color: 0x2f7589 },
  { hour: 16.5, color: 0x2e6879 },
  { hour: 18.2, color: 0x715743 },
  { hour: 19.6, color: 0x25304e },
  { hour: 21, color: NIGHT_WATER },
];

const COLOR_TMP = new THREE.Color();
export function sampleWaterColor(hour: number, out: THREE.Color): THREE.Color {
  const frames = WATER_KEYFRAMES; const h = wrapHour(hour);
  let index = frames.length - 1;
  while (index > 0 && frames[index]!.hour > h) index--;
  const a = frames[index]!; const b = frames[(index + 1) % frames.length]!;
  const span = (index + 1 === frames.length ? 24 : b.hour) - a.hour;
  return out.setHex(a.color).lerp(COLOR_TMP.setHex(b.color), span > 0 ? (h - a.hour) / span : 0);
}

/** Squared distance from (x, z) to an axis-aligned rectangle centred on (cx, cz): 0 inside. */
export function rectDistanceSq(x: number, z: number, cx: number, cz: number, width: number, depth: number): number {
  const dx = Math.max(0, Math.abs(x - cx) - width / 2); const dz = Math.max(0, Math.abs(z - cz) - depth / 2);
  return dx * dx + dz * dz;
}

/** The planar mirror re-renders the whole scene: full rate within REFLECTOR_RANGE of the harbour,
 *  one refresh every REFLECTOR_FAR_INTERVAL frames beyond it (a stale mirror is invisible from that far). */
export const REFLECTOR_RANGE = 120;
export const REFLECTOR_FAR_INTERVAL = 24;
export function reflectorShouldRender(distanceSq: number, frame: number, lastRendered: number): boolean {
  if (lastRendered < 0) return true; // never let the mirror show its uninitialised black texture
  if (frame === lastRendered) return false; // one reflection per frame, however many passes draw the mesh (GTAO + beauty)
  return distanceSq <= REFLECTOR_RANGE * REFLECTOR_RANGE || frame - lastRendered >= REFLECTOR_FAR_INTERVAL;
}

const seededNoise = (index: number, salt: number): number => { const value = Math.sin(index * 127.1 + salt * 311.7) * 43758.5453; return value - Math.floor(value); };
const fade = (t: number): number => t * t * (3 - 2 * t);

/** Tileable value noise in [0, 1]: the lattice wraps every 1/cells of u and v so the texture repeats seamlessly. */
export function tileableNoise(u: number, v: number, cells: number, salt = 0): number {
  const x = u * cells; const y = v * cells; const x0 = Math.floor(x); const y0 = Math.floor(y);
  const fx = fade(x - x0); const fy = fade(y - y0);
  const at = (ix: number, iy: number): number => seededNoise((((ix % cells) + cells) % cells) + (((iy % cells) + cells) % cells) * 61, salt);
  const top = THREE.MathUtils.lerp(at(x0, y0), at(x0 + 1, y0), fx);
  const bottom = THREE.MathUtils.lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx);
  return THREE.MathUtils.lerp(top, bottom, fy);
}

/** Three octaves of tileable noise: the heightfield behind the procedural water normal map. */
export const waterNoiseHeight = (u: number, v: number): number =>
  0.55 * tileableNoise(u, v, 6, 1) + 0.3 * tileableNoise(u, v, 12, 2) + 0.15 * tileableNoise(u, v, 24, 3);

/** Procedural stand-in for the classic waternormals.jpg (repo rule: no downloaded assets):
 *  tileable multi-octave noise turned into a linear-space tangent normal map. */
export function createWaterNormalTexture(size = 256): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4); const step = 1 / size; const strength = 0.09;
  const normal = new THREE.Vector3();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size; const v = y / size;
    const dhdu = (waterNoiseHeight(u + step, v) - waterNoiseHeight(u - step, v)) / (2 * step);
    const dhdv = (waterNoiseHeight(u, v + step) - waterNoiseHeight(u, v - step)) / (2 * step);
    normal.set(-dhdu * strength, -dhdv * strength, 1).normalize();
    const offset = (y * size + x) * 4;
    data[offset] = Math.round((normal.x * 0.5 + 0.5) * 255); data[offset + 1] = Math.round((normal.y * 0.5 + 0.5) * 255);
    data[offset + 2] = Math.round((normal.z * 0.5 + 0.5) * 255); data[offset + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.needsUpdate = true;
  return texture;
}

export interface OceanSite {
  kind: 'ocean';
  x: number; y: number; z: number;
  width: number; depth: number;
  /** Optional absolute-coordinate shoreline polygon (generated lakes/dams); omitted = rectangular plane. */
  shape?: ReadonlyArray<{ x: number; z: number }>;
}
export interface BasinSite { kind: 'fountain' | 'pond'; x: number; y: number; z: number; radius: number; }
export type WaterSite = OceanSite | BasinSite;

/** Site-local XY shape for an ocean polygon (matches the -PI/2 X-rotation applied to water planes). */
function oceanShapeGeometry(site: OceanSite): THREE.ShapeGeometry {
  const shape = new THREE.Shape(site.shape!.map((point) => new THREE.Vector2(point.x - site.x, -(point.z - site.z))));
  return new THREE.ShapeGeometry(shape);
}

/** Geometry for an ocean site in the XY plane (callers rotate mesh or geometry by -PI/2 about X). */
function oceanGeometryXY(site: OceanSite, segments?: [number, number]): THREE.BufferGeometry {
  return site.shape ? oceanShapeGeometry(site) : new THREE.PlaneGeometry(site.width, site.depth, ...(segments ?? [1, 1]));
}

export interface WaterHandle {
  group: THREE.Group;
  tier: WaterTier;
  update(dt: number): void;
  setMood(hour: number, sunDirection: THREE.Vector3, sunColor: THREE.Color): void;
  dispose(): void;
}

const OCEAN_ALPHA = 0.8; const BASIN_ALPHA = 0.82;
const REFLECTOR_TEXTURE_SIZE = 512; const REFLECTOR_DISTORTION = 3.4;
const OCEAN_SEGMENTS: [number, number] = [110, 22];

/** GLSL for the two scrolled detail-texture taps shared by the planar and physical ocean shaders. */
const detailSlopeGlsl = (): string =>
  `(texture2D(uDetail, vWaterPos * 0.041 + uTime * vec2(0.013, 0.019)).rg * 2.0 - 1.0) * 0.05
   + (texture2D(uDetail, vWaterPos * 0.093 - uTime * vec2(0.021, 0.011)).rg * 2.0 - 1.0) * 0.03`;

/** Fades fragment normal wobble with view distance: far water shades calmly instead of strobing between sky and scatter. */
const slopeFadeGlsl = (distanceExpr: string): string => `waterSlope *= 1.0 / (1.0 + ${distanceExpr} * 0.016);`;

/** View-space normal from a world-space (∂h/∂x, ∂h/∂z) slope of a horizontal surface. */
const slopeToViewNormalGlsl = 'normal = normalize((viewMatrix * vec4(normalize(vec3(-waterSlope.x, 1.0, -waterSlope.y)), 0.0)).xyz);';

/** Builds every water surface for one tier. City owns the returned handle and rebuilds it on quality change. */
export function createWater(sites: readonly WaterSite[], tier: WaterTier): WaterHandle {
  const group = new THREE.Group(); group.name = 'Water';
  const timeUniform = { value: 0 };
  const moodMaterials: THREE.MeshPhysicalMaterial[] = [];
  const textures: THREE.Texture[] = [];
  const scrollTextures: THREE.Texture[] = [];
  let reflector: Reflector | undefined; let reflectorUniforms: Record<string, THREE.IUniform> | undefined;
  let frame = 0; let lastReflection = -1;
  const detail = tier === 'flat' ? undefined : createWaterNormalTexture();
  if (detail) textures.push(detail);
  const cameraPosition = new THREE.Vector3();

  /** MeshPhysicalMaterial with injected time-driven waves/ripples: env-map reflections and lights come free. */
  const wavyMaterial = (key: string, vertexChunk: string, fragmentChunk: string, opacity: number, envMapIntensity = 0.85): THREE.MeshPhysicalMaterial => {
    const material = new THREE.MeshPhysicalMaterial({ color: 0x2f7589, roughness: 0.16, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.25, transparent: true, opacity, envMapIntensity });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = timeUniform;
      if (detail) shader.uniforms.uDetail = { value: detail };
      shader.vertexShader = `uniform float uTime;\nvarying vec2 vWaterPos;\n${shader.vertexShader.replace('#include <begin_vertex>', vertexChunk)}`;
      shader.fragmentShader = `uniform float uTime;\nvarying vec2 vWaterPos;\n${detail ? 'uniform sampler2D uDetail;\n' : ''}${shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${fragmentChunk}`)
        .replace('#include <clearcoat_normal_fragment_begin>', '#ifdef USE_CLEARCOAT\n\tvec3 clearcoatNormal = normal;\n#endif')}`;
    };
    material.customProgramCacheKey = () => key;
    moodMaterials.push(material);
    return material;
  };

  const addMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, site: WaterSite): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(site.x, site.y, site.z); mesh.receiveShadow = true; mesh.userData.dynamic = true;
    group.add(mesh);
    return mesh;
  };

  const buildOcean = (site: OceanSite): void => {
    if (tier === 'flat') {
      const texture = createSurfaceTexture('water', 7); textures.push(texture); scrollTextures.push(texture);
      const material = new THREE.MeshPhysicalMaterial({ color: 0x2f7589, map: texture, roughness: 0.16, metalness: 0.05, clearcoat: 0.85, clearcoatRoughness: 0.16, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
      moodMaterials.push(material);
      addMesh(oceanGeometryXY(site).rotateX(-Math.PI / 2), material, site);
      return;
    }
    if (tier === 'physical') {
      const vertexChunk = `vec3 transformed = vec3( position );\n\tvWaterPos = transformed.xz;\n\ttransformed.y += ${waveHeightGlsl('vWaterPos.x', 'vWaterPos.y', 'uTime')};`;
      const fragmentChunk = `\tvec2 waterSlope = ${waveSlopeGlsl('vWaterPos.x', 'vWaterPos.y', 'uTime', [...OCEAN_WAVES, ...DETAIL_WAVES])};\n\twaterSlope += ${detailSlopeGlsl()};\n\t${slopeFadeGlsl('length(vViewPosition)')}\n\t${slopeToViewNormalGlsl}`;
      const material = wavyMaterial('water-ocean', vertexChunk, fragmentChunk, OCEAN_ALPHA);
      material.side = THREE.DoubleSide; // visible from underwater too (looking up at the surface)
      addMesh(oceanGeometryXY(site, OCEAN_SEGMENTS).rotateX(-Math.PI / 2), material, site);
      return;
    }
    // Planar tier: a Reflector with a custom wave shader — the mirror texture shows the real skyline, sun and moon.
    // Reflector expects an unrotated XY plane; local (x, y, z) maps to world (x, -z, y).
    const vertexShader = `
      uniform mat4 textureMatrix;
      uniform float uTime;
      varying vec4 vMirrorCoord;
      varying vec3 vWorldPos;
      varying vec2 vWaterPos;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vWaterPos = vec2(position.x, -position.y);
        vec3 displaced = position;
        displaced.z += ${waveHeightGlsl('vWaterPos.x', 'vWaterPos.y', 'uTime')};
        vMirrorCoord = textureMatrix * vec4(displaced, 1.0);
        vec4 worldPosition = modelMatrix * vec4(displaced, 1.0);
        vWorldPos = worldPosition.xyz;
        vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`;
    const fragmentShader = `
      uniform sampler2D tDiffuse;
      uniform sampler2D uDetail;
      uniform vec3 uColor;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uAlpha;
      uniform float uDistortion;
      varying vec4 vMirrorCoord;
      varying vec3 vWorldPos;
      varying vec2 vWaterPos;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec2 waterSlope = ${waveSlopeGlsl('vWaterPos.x', 'vWaterPos.y', 'uTime', [...OCEAN_WAVES, ...DETAIL_WAVES])};
        waterSlope += ${detailSlopeGlsl()};
        vec3 toEye = cameraPosition - vWorldPos;
        float eyeDistance = length(toEye);
        ${slopeFadeGlsl('eyeDistance')}
        vec3 waterNormal = normalize(vec3(-waterSlope.x, 1.0, -waterSlope.y));
        vec3 eyeDir = toEye / max(eyeDistance, 0.001);
        vec2 distortion = waterNormal.xz * (0.001 + 1.0 / eyeDistance) * uDistortion;
        vec3 reflection = texture2D(tDiffuse, vMirrorCoord.xy / vMirrorCoord.w + distortion).rgb;
        float facing = max(dot(eyeDir, waterNormal), 0.0);
        float reflectance = 0.22 + 0.78 * pow(1.0 - facing, 5.0);
        float sunDiffuse = max(dot(waterNormal, uSunDir), 0.0);
        float sunSpec = pow(max(dot(eyeDir, reflect(-uSunDir, waterNormal)), 0.0), 180.0);
        vec3 scatter = uColor * (0.5 + 0.5 * sunDiffuse) * mix(vec3(1.0), uSunColor, 0.4);
        vec3 outgoingLight = mix(scatter, reflection * 0.95 + reflection * sunSpec, reflectance) + uSunColor * sunSpec * 0.7;
        gl_FragColor = vec4(outgoingLight, uAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`;
    reflector = new Reflector(oceanGeometryXY(site, OCEAN_SEGMENTS), {
      textureWidth: REFLECTOR_TEXTURE_SIZE, textureHeight: REFLECTOR_TEXTURE_SIZE, clipBias: 0.015, multisample: 0,
      shader: {
        name: 'HarbourWater',
        uniforms: {
          color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, // slots Reflector assigns
          uDetail: { value: null }, uTime: { value: 0 }, uAlpha: { value: OCEAN_ALPHA }, uDistortion: { value: REFLECTOR_DISTORTION },
          uColor: { value: new THREE.Color(0x2f7589) }, uSunColor: { value: new THREE.Color(0xffd9a0) }, uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0) },
          ...THREE.UniformsLib.fog,
        },
        vertexShader, fragmentShader,
      },
    });
    const material = reflector.material as THREE.ShaderMaterial;
    material.uniforms.uTime = timeUniform; material.uniforms.uDetail!.value = detail;
    material.transparent = true; material.fog = true; material.side = THREE.DoubleSide; // seen from underwater too
    reflectorUniforms = material.uniforms;
    reflector.rotation.x = -Math.PI / 2; reflector.position.set(site.x, site.y, site.z); reflector.userData.dynamic = true;
    const render = reflector.onBeforeRender;
    reflector.onBeforeRender = (renderer, scene, camera, geometry, mat, renderGroup): void => {
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      if (!reflectorShouldRender(rectDistanceSq(cameraPosition.x, cameraPosition.z, site.x, site.z, site.width, site.depth), frame, lastReflection)) return;
      lastReflection = frame;
      render.call(reflector, renderer, scene, camera, geometry, mat, renderGroup);
    };
    group.add(reflector);
  };

  const buildBasin = (site: BasinSite): void => {
    const geometry = new THREE.CircleGeometry(site.radius, 40).rotateX(-Math.PI / 2);
    if (tier === 'flat') {
      const material = new THREE.MeshPhysicalMaterial({ color: 0x2f7589, roughness: 0.1, clearcoat: 1, transparent: true, opacity: 0.85 });
      moodMaterials.push(material);
      addMesh(geometry, material, site);
      return;
    }
    const spec = site.kind === 'fountain' ? FOUNTAIN_RIPPLE : POND_RIPPLE;
    const counter: RippleSpec = { wavelength: spec.wavelength * 0.57, speed: spec.speed * 1.6, amplitude: spec.amplitude * 0.55 };
    const vertexChunk = 'vec3 transformed = vec3( position );\n\tvWaterPos = transformed.xz;';
    const fragmentChunk = [
      '\tfloat rippleDist = length(vWaterPos);',
      'vec2 rippleDir = vWaterPos / max(rippleDist, 0.001);',
      `vec2 waterSlope = rippleDir * (${rippleSlopeGlsl('rippleDist', 'uTime', site.radius, spec)} + ${rippleSlopeGlsl('rippleDist', 'uTime', site.radius, counter, 1.7)});`,
      slopeToViewNormalGlsl,
    ].join('\n\t');
    addMesh(geometry, wavyMaterial(`water-${site.kind}-${site.radius}`, vertexChunk, fragmentChunk, BASIN_ALPHA, 0.55), site); // basins sit on pale stone: less env wash so the ripples read
  };

  for (const site of sites) { if (site.kind === 'ocean') buildOcean(site); else buildBasin(site); }

  return {
    group, tier,
    update(dt: number): void {
      timeUniform.value += dt; frame++;
      for (const texture of scrollTextures) texture.offset.x = (texture.offset.x + dt * 0.006) % 1;
    },
    setMood(hour: number, sunDirection: THREE.Vector3, sunColor: THREE.Color): void {
      sampleWaterColor(hour, COLOR_TMP);
      for (const material of moodMaterials) material.color.copy(COLOR_TMP);
      if (reflectorUniforms) {
        (reflectorUniforms.uColor!.value as THREE.Color).copy(COLOR_TMP);
        (reflectorUniforms.uSunColor!.value as THREE.Color).copy(sunColor);
        (reflectorUniforms.uSunDir!.value as THREE.Vector3).copy(sunDirection);
      }
    },
    dispose(): void {
      group.removeFromParent();
      group.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.dispose(); });
      for (const material of moodMaterials) material.dispose();
      reflector?.dispose(); // frees the mirror render target and its ShaderMaterial
      for (const texture of textures) texture.dispose();
    },
  };
}
