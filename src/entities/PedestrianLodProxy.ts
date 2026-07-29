import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { NpcCharacterId } from './NpcCatalog';

interface Palette { top: number; skin: number; trousers: number }

/** Matches the readable outfit blocks in the authored cast. At proxy distance silhouette and colour are
 *  more useful than texture detail: police navy, car-guard lime and each neighbourhood cast stay legible. */
const CAST_PALETTES: Record<NpcCharacterId, Palette> = {
  'braamfontein-creative': { top: 0xa84f35, skin: 0x6d4634, trousers: 0x23464b },
  'sandton-professional': { top: 0x5b304f, skin: 0xa66b4f, trousers: 0x302d39 },
  'rosebank-athlete': { top: 0xd46658, skin: 0xa96e51, trousers: 0x343940 },
  'melville-creative': { top: 0xc98b32, skin: 0xd0a17d, trousers: 0x2b394b },
  'newtown-producer': { top: 0x365584, skin: 0x65402f, trousers: 0x34383b },
  'fordsburg-restaurateur': { top: 0x66704b, skin: 0xa66f50, trousers: 0x343630 },
  'maboneng-courier': { top: 0x3566b7, skin: 0x704733, trousers: 0x343940 },
  'parkhurst-architect': { top: 0xb49a6b, skin: 0xd1a27d, trousers: 0x303b4b },
  'auntie-portia': { top: 0x8b3e58, skin: 0x6b4432, trousers: 0x343438 },
  'bra-vusi': { top: 0x477376, skin: 0x704833, trousers: 0x403a37 },
  'candice-boksburg': { top: 0x35614b, skin: 0xae765a, trousers: 0x30383a },
  'thandi-arms': { top: 0x4d5547, skin: 0x684130, trousers: 0x303438 },
  'jmpd-patrol-officer': { top: 0x263b54, skin: 0x684331, trousers: 0x202d40 },
  'bree-rank-enforcer': { top: 0x51433e, skin: 0x67402e, trousers: 0x29313a },
  'yeoville-car-guard': { top: 0xb8dd2e, skin: 0x704833, trousers: 0x26384d },
  'joburg-driver': { top: 0x5b7481, skin: 0xab7254, trousers: 0x34383c },
};
const FALLBACK_TOPS = [0x375e70, 0x9d5d55, 0xd1a343, 0x536f4a, 0x725887] as const;
const FALLBACK_SKINS = [0x613e30, 0x8b5b43, 0xb77a58, 0xd2a078] as const;
const SHARED_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true, fog: true });
SHARED_MATERIAL.name = 'shared-pedestrian-lod';
const geometryCache = new Map<string, THREE.BufferGeometry>();

function paint(geometry: THREE.BufferGeometry, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position'); const rgb = new THREE.Color(colour);
  const colours = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    colours[i * 3] = rgb.r; colours[i * 3 + 1] = rgb.g; colours[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  return geometry;
}

function box(width: number, height: number, depth: number, x: number, y: number, z: number, colour: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(width, height, depth).toNonIndexed(); geometry.translate(x, y, z);
  return paint(geometry, colour);
}

function palette(index: number, hostile: boolean, police: boolean, variant?: NpcCharacterId): Palette {
  if (variant) return CAST_PALETTES[variant];
  return {
    top: police ? 0x263b54 : hostile ? 0x6e3b35 : FALLBACK_TOPS[index % FALLBACK_TOPS.length]!,
    skin: FALLBACK_SKINS[index % FALLBACK_SKINS.length]!,
    trousers: police ? 0x202d40 : 0x282d36,
  };
}

function geometryFor(colours: Palette): THREE.BufferGeometry {
  const key = `${colours.top.toString(16)}:${colours.skin.toString(16)}:${colours.trousers.toString(16)}`;
  const cached = geometryCache.get(key); if (cached) return cached;
  const parts = [
    box(0.48, 0.68, 0.28, 0, 1.05, 0, colours.top),
    paint(new THREE.IcosahedronGeometry(0.21, 0).translate(0, 1.57, 0), colours.skin),
    box(0.13, 0.58, 0.15, -0.13, 0.43, 0, colours.trousers),
    box(0.13, 0.58, 0.15, 0.13, 0.43, 0, colours.trousers),
    box(0.12, 0.57, 0.14, -0.3, 1.08, 0, colours.top),
    box(0.12, 0.57, 0.14, 0.3, 1.08, 0, colours.skin),
  ];
  const geometry = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!geometry) throw new Error('Unable to build pedestrian LOD proxy.');
  geometry.name = `pedestrian-lod-${key}`; geometry.computeBoundingSphere(); geometryCache.set(key, geometry);
  return geometry;
}

export function instantiatePedestrianLodProxy(index: number, hostile: boolean, police: boolean, variant?: NpcCharacterId): THREE.Mesh {
  const proxy = new THREE.Mesh(geometryFor(palette(index, hostile, police, variant)), SHARED_MATERIAL);
  proxy.name = 'pedestrian-lod-proxy'; proxy.visible = false; proxy.castShadow = false; proxy.receiveShadow = false;
  return proxy;
}
