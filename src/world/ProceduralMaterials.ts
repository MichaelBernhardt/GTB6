import * as THREE from 'three';
import { registerPowered } from './powerGrid';

type SurfaceKind = 'asphalt' | 'concrete' | 'grass' | 'sand' | 'water';

const seeded = (index: number, salt: number): number => {
  const value = Math.sin(index * 91.731 + salt * 47.233) * 43758.5453;
  return value - Math.floor(value);
};

function canvasTexture(size = 256): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  return { canvas, context };
}

function finish(canvas: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export function createSurfaceTexture(kind: SurfaceKind, repeat = 1): THREE.CanvasTexture {
  const { canvas, context } = canvasTexture();
  const palette: Record<SurfaceKind, [string, string, string]> = {
    asphalt: ['#242b2e', '#32393c', '#171d20'],
    concrete: ['#9c9d96', '#b9b7ad', '#777c79'],
    grass: ['#8a7b45', '#a3924f', '#6e6236'],
    sand: ['#c9b569', '#dcc97c', '#a08d4f'],
    water: ['#28778b', '#4e9cac', '#15566c'],
  };
  const [base, light, dark] = palette[kind]; context.fillStyle = base; context.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 4600; i++) {
    const x = seeded(i, 1) * 256; const y = seeded(i, 2) * 256;
    context.globalAlpha = 0.04 + seeded(i, 3) * 0.13; context.fillStyle = seeded(i, 4) > 0.47 ? light : dark;
    const size = kind === 'grass' ? 1 + seeded(i, 5) * 2 : 0.4 + seeded(i, 5) * 1.5;
    context.fillRect(x, y, size, kind === 'grass' ? size * 2.4 : size);
  }
  context.globalAlpha = 1;
  if (kind === 'asphalt') {
    context.strokeStyle = '#111719'; context.lineWidth = 0.7;
    for (let i = 0; i < 8; i++) {
      context.beginPath(); let x = seeded(i, 10) * 256; let y = seeded(i, 11) * 256; context.moveTo(x, y);
      for (let j = 0; j < 5; j++) { x += (seeded(i * 9 + j, 12) - 0.5) * 22; y += 8 + seeded(i * 9 + j, 13) * 15; context.lineTo(x, y); }
      context.stroke();
    }
  }
  if (kind === 'concrete') {
    context.strokeStyle = '#686d69'; context.globalAlpha = 0.42; context.lineWidth = 1;
    for (let p = 0; p <= 256; p += 32) { context.beginPath(); context.moveTo(p, 0); context.lineTo(p, 256); context.stroke(); context.beginPath(); context.moveTo(0, p); context.lineTo(256, p); context.stroke(); }
    context.globalAlpha = 1;
  }
  if (kind === 'sand') {
    context.strokeStyle = '#9f9167'; context.globalAlpha = 0.18;
    for (let y = 12; y < 256; y += 18) { context.beginPath(); for (let x = 0; x <= 256; x += 8) context.lineTo(x, y + Math.sin(x * 0.08 + y) * 2); context.stroke(); }
  }
  if (kind === 'water') {
    const gradient = context.createLinearGradient(0, 0, 256, 256); gradient.addColorStop(0, '#1e6e83'); gradient.addColorStop(0.5, '#4ca0ae'); gradient.addColorStop(1, '#246c80'); context.globalAlpha = 0.55; context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
    context.strokeStyle = '#b9e2df'; context.lineWidth = 2; context.globalAlpha = 0.22;
    for (let y = 8; y < 256; y += 17) { context.beginPath(); for (let x = 0; x <= 256; x += 8) context.lineTo(x, y + Math.sin(x * 0.065 + y * 0.2) * 3); context.stroke(); }
  }
  return finish(canvas, repeat, repeat);
}

export type GrassVariant = 'lush' | 'dry';
interface GrassPalette { base: string; patches: [string, string]; blades: string[]; dry: string[]; dryChance: number; soil: string; soilChance: number; }
const GRASS_PALETTES: Record<GrassVariant, GrassPalette> = {
  // Colours are BAKED to final (materials use color: white), so blades read true regardless of the surface tint.
  lush: { base: '#41651f', patches: ['#4f7a2b', '#325217'], blades: ['#4f7d26', '#63933a', '#3d661d', '#7aa848', '#548a2c'], dry: ['#8a9a4e', '#9aa85c'], dryChance: 0.05, soil: '#3c3a1e', soilChance: 0.04 },
  dry: { base: '#8a7c44', patches: ['#9a8d51', '#6d6035'], blades: ['#9a8b4b', '#b0a05c', '#847a44', '#8f9a54', '#a8985a'], dry: ['#b6a860', '#8a7c42'], dryChance: 0.55, soil: '#5a4a2e', soilChance: 0.16 },
};

/**
 * Seamlessly-tileable procedural turf for parks and lawns. Unlike the generic `grass` surface (a flat 256px
 * fleck sheet stretched ~800u per tile on the ground plane), this bakes real grass at 512px meant to tile every
 * few metres: broad tonal patches for lawn unevenness, dense fine blades in a green ramp with occasional dry
 * strands, and a scatter of soil flecks. Every element is drawn with edge-wrap so no seam shows at the tile join.
 */
export function createGrassTexture(variant: GrassVariant, repeat: number, size = 512): THREE.CanvasTexture {
  const palette = GRASS_PALETTES[variant];
  const { canvas, context } = canvasTexture(size);
  const S = size;
  context.fillStyle = palette.base; context.fillRect(0, 0, S, S);

  // Draw an element at every wrapped position it straddles, so anything crossing an edge reappears on the far side.
  const stamp = (x: number, y: number, extent: number, draw: (px: number, py: number) => void): void => {
    const xs = [x]; if (x - extent < 0) xs.push(x + S); if (x + extent > S) xs.push(x - S);
    const ys = [y]; if (y - extent < 0) ys.push(y + S); if (y + extent > S) ys.push(y - S);
    for (const px of xs) for (const py of ys) draw(px, py);
  };

  // 1) Fine tonal flecks only — small and faint. Big/strong patches are LOW-frequency and would repeat visibly
  //    every tile; large-scale unevenness is instead supplied per-frame by the non-tiling shader macro.
  for (let i = 0; i < 70; i++) {
    const x = seeded(i, 201) * S; const y = seeded(i, 202) * S; const r = 16 + seeded(i, 203) * 42;
    const tone = seeded(i, 204) > 0.5 ? palette.patches[0] : palette.patches[1];
    const alpha = 0.03 + seeded(i, 205) * 0.05;
    stamp(x, y, r, (px, py) => {
      const g = context.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, tone); g.addColorStop(1, 'rgba(0,0,0,0)');
      context.globalAlpha = alpha; context.fillStyle = g; context.beginPath(); context.arc(px, py, r, 0, Math.PI * 2); context.fill();
    });
  }
  context.globalAlpha = 1;

  // 2) Fine blades — short near-vertical strokes; a green ramp plus a fraction of dry strands.
  const blades = Math.round(S * S * 0.11);
  for (let i = 0; i < blades; i++) {
    const x = seeded(i, 210) * S; const y = seeded(i, 211) * S;
    const ramp = seeded(i, 212) < palette.dryChance ? palette.dry : palette.blades;
    const len = 1.0 + seeded(i, 214) * 1.8; const lean = (seeded(i, 215) - 0.5) * 1.5;
    context.strokeStyle = ramp[Math.floor(seeded(i, 213) * ramp.length)] ?? palette.base;
    context.globalAlpha = 0.5 + seeded(i, 216) * 0.5; context.lineWidth = 0.5 + seeded(i, 217) * 0.35;
    stamp(x, y, len + 3, (px, py) => { context.beginPath(); context.moveTo(px, py); context.lineTo(px + lean, py - len); context.stroke(); });
  }
  context.globalAlpha = 1;

  // 3) Soil / bare flecks poking through the turf.
  for (let i = 0; i < S * 3; i++) {
    const x = seeded(i, 220) * S; const y = seeded(i, 221) * S; const sz = 0.6 + seeded(i, 222) * 1.6;
    context.globalAlpha = 0.1 + seeded(i, 223) * 0.18;
    context.fillStyle = seeded(i, 224) < palette.soilChance ? palette.soil : palette.patches[1];
    stamp(x, y, sz, (px, py) => context.fillRect(px, py, sz, sz));
  }
  context.globalAlpha = 1;

  return finish(canvas, repeat, repeat);
}

/**
 * Shader dressing for lawn materials, injected via onBeforeCompile (no geometry; survives the static merge
 * because the material object is reused). Always adds MACRO VARIATION — large-scale world-space noise that
 * lightens/darkens the grass so the small (~6m) tile stops reading as an obvious repeat when viewed from far
 * away or high up. With `{ wind: true }` it also adds a gentle wind sway + drifting light gusts (manicured
 * lawns only). The returned handle's `.advance(dt)` ticks the wind clock; it's a no-op without wind.
 */
export function applyGrassShader(material: THREE.MeshStandardMaterial, options: { wind?: boolean } = {}): { advance(dt: number): void } {
  const wind = options.wind ?? false;
  const uniforms = { uTime: { value: 0 } };
  material.onBeforeCompile = (shader) => {
    if (wind) shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWindXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWindXZ = (modelMatrix * vec4(position, 1.0)).xz;');
    // Wind branch adds an animated sway offset; the still branch contributes none.
    const windOffBlock = wind ? `
          float wx = dot(vWindXZ, vec2(0.90, 0.42));
          float wz = dot(vWindXZ, vec2(-0.42, 0.90));
          // Irregular gusts: a slow drifting noise field swells/fades the amplitude, and a per-place noise phase
          // jitter breaks up the clean sine so the flutter reads as wind rather than a mechanical pulse.
          float env = 0.3 + 0.7 * gNoise(vWindXZ * 0.12 + vec2(uTime * 0.5, uTime * 0.35));
          float jx = gNoise(vWindXZ * 1.7) * 6.2831;
          float jz = gNoise(vWindXZ * 1.9 + 3.1) * 6.2831;
          vec2 windOff = vec2(sin(wx * 28.0 + uTime * 32.0 + jx), sin(wz * 25.0 + uTime * 25.0 + jz)) * 0.0015 * env;`
      : `
          vec2 windOff = vec2(0.0);`;
    const gustLight = wind ? `
          float gust = sin(dot(vWindXZ, vec2(0.90, 0.42)) * 0.22 + uTime * 1.4) * 0.5 + sin(dot(vWindXZ, vec2(-0.42, 0.90)) * 0.16 - uTime * 0.95) * 0.5;
          gust = mix(gust, gNoise(vWindXZ * 0.2 + vec2(uTime * 0.3, -uTime * 0.2)) * 2.0 - 1.0, 0.6); // noise-broken so bands aren't a clean sine
          diffuseColor.rgb *= 1.0 + gust * 0.06;`
      : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${wind ? 'uniform float uTime;' : ''}
        varying vec2 vWindXZ;
        float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float gNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y); }`)
      .replace('#include <map_fragment>', `
        #ifdef USE_MAP
          ${windOffBlock}
          vec4 sampledDiffuseColor = texture2D( map, vMapUv + windOff );
          diffuseColor *= sampledDiffuseColor;
          // Macro variation (the texture itself is near-homogeneous so it tiles invisibly): two world-space
          // octaves (~22m and ~9m) supply all the large-scale tonal drift, and being world-space they never repeat.
          float macro = 0.6 * gNoise(vWindXZ * 0.045) + 0.4 * gNoise(vWindXZ * 0.11);
          diffuseColor.rgb *= 0.72 + 0.56 * macro;
          ${gustLight}
        #endif`);
  };
  const speed = 0.25; // overall wind-clock rate: scales every gust/flutter/drift together
  return { advance: (dt: number) => { if (wind) uniforms.uTime.value = (uniforms.uTime.value + dt * speed) % 10000; } };
}

export function createGeneratedSurfaceTexture(url: string, fallback: SurfaceKind, repeat: number): THREE.Texture {
  const fallbackTexture = createSurfaceTexture(fallback, repeat);
  const texture = new THREE.TextureLoader().load(url, undefined, undefined, () => {
    texture.image = fallbackTexture.image; texture.needsUpdate = true;
  });
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(repeat, repeat); texture.anisotropy = 8;
  return texture;
}

/**
 * Large-format municipal paving for the sidewalk ribbons.  This deliberately lives in its own
 * texture instead of reusing the generic concrete photograph: the old 10x repeat made the paving
 * look like a noisy graph-paper sheet from normal play height.  One tile is sixteen 3u-deep bays,
 * with staggered joints, aggregate and a few subtly replaced slabs, so repetition only becomes
 * apparent across a much longer walk.
 */
export function createSidewalkTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 1024;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');

  context.fillStyle = '#aaa99f'; context.fillRect(0, 0, canvas.width, canvas.height);
  const rows = 16; const rowHeight = canvas.height / rows;
  for (let row = 0; row < rows; row++) {
    const tone = 157 + Math.round(seeded(row, 81) * 13);
    context.fillStyle = `rgb(${tone + 4}, ${tone + 3}, ${tone - 3})`;
    context.fillRect(2, row * rowHeight + 2, canvas.width - 4, rowHeight - 4);

    // Two broad flags across the walking width; alternate the joint slightly to avoid a rigid grid.
    const joint = 124 + (seeded(row, 82) - 0.5) * 12;
    context.fillStyle = 'rgba(74, 76, 72, 0.34)';
    context.fillRect(joint, row * rowHeight + 3, 2, rowHeight - 6);
    context.fillStyle = 'rgba(232, 229, 215, 0.2)';
    context.fillRect(joint + 2, row * rowHeight + 3, 1, rowHeight - 6);
  }

  // Recessed transverse expansion joints with a slim sun-catching lip.
  for (let row = 0; row <= rows; row++) {
    const y = row * rowHeight;
    context.fillStyle = 'rgba(67, 70, 68, 0.5)'; context.fillRect(0, y, canvas.width, 2);
    context.fillStyle = 'rgba(232, 229, 216, 0.24)'; context.fillRect(0, y + 2, canvas.width, 1);
  }

  // Fine stone aggregate and restrained staining keep close-up pavement from reading as flat paint.
  for (let i = 0; i < 7200; i++) {
    const x = seeded(i, 83) * canvas.width; const y = seeded(i, 84) * canvas.height;
    const light = seeded(i, 85) > 0.48;
    context.globalAlpha = 0.035 + seeded(i, 86) * 0.11;
    context.fillStyle = light ? '#f0eee3' : '#464c49';
    const size = 0.4 + seeded(i, 87) * 1.4; context.fillRect(x, y, size, size);
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

export const FACADE_VARIANTS = 12;
interface FacadeStyle { wall: string; dark: string; frame: string; lit: number; columns: number; rows: number; band: boolean; }
const FACADE_STYLES: FacadeStyle[] = [
  { wall: '#88949a', dark: '#5f696e', frame: '#3e4c52', lit: 0.32, columns: 6, rows: 9, band: true },
  { wall: '#7c8b96', dark: '#525e68', frame: '#2b3a44', lit: 0.48, columns: 8, rows: 11, band: false },
  { wall: '#9c5a43', dark: '#6b3a2c', frame: '#463631', lit: 0.24, columns: 5, rows: 8, band: true },
  { wall: '#9aa39a', dark: '#6d766e', frame: '#37454b', lit: 0.4, columns: 7, rows: 10, band: false },
  { wall: '#b7aa88', dark: '#7e755f', frame: '#4a4436', lit: 0.2, columns: 5, rows: 9, band: true },
  { wall: '#778080', dark: '#51595c', frame: '#232d31', lit: 0.55, columns: 6, rows: 10, band: false },
  { wall: '#d3a482', dark: '#9c7458', frame: '#54402f', lit: 0.16, columns: 4, rows: 6, band: true },
  { wall: '#c9b891', dark: '#94835f', frame: '#4c4231', lit: 0.22, columns: 5, rows: 6, band: false },
  { wall: '#aebfae', dark: '#7b8d7c', frame: '#3c4a40', lit: 0.13, columns: 4, rows: 5, band: true },
  { wall: '#8a5a4a', dark: '#57352a', frame: '#4a332c', lit: 0.19, columns: 5, rows: 7, band: false },
  { wall: '#8d918d', dark: '#636763', frame: '#31383a', lit: 0.1, columns: 4, rows: 5, band: false },
  { wall: '#98917f', dark: '#6b6558', frame: '#3a382e', lit: 0.14, columns: 5, rows: 6, band: true },
];

export function createFacadeTexture(style: number): THREE.CanvasTexture {
  const { canvas, context } = canvasTexture(512);
  const spec = FACADE_STYLES[style % FACADE_STYLES.length] ?? FACADE_STYLES[0]!;
  const { wall, dark: wallDark, frame, lit: litDensity, columns, rows } = spec;
  const gradient = context.createLinearGradient(0, 0, 512, 0); gradient.addColorStop(0, wallDark); gradient.addColorStop(0.12, wall); gradient.addColorStop(0.88, wall); gradient.addColorStop(1, wallDark);
  context.fillStyle = gradient; context.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2200; i++) { context.globalAlpha = seeded(i, style + 20) * 0.09; context.fillStyle = seeded(i, style + 21) > 0.5 ? '#fff' : '#172024'; context.fillRect(seeded(i, 22) * 512, seeded(i, 23) * 512, 1.2, 1.2); }
  context.globalAlpha = 1;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const cellW = 512 / columns; const cellH = 512 / rows; const x = column * cellW + 15; const y = row * cellH + 13;
    context.fillStyle = frame; context.fillRect(x - 4, y - 4, cellW - 22, cellH - 18);
    const lit = seeded(row * columns + column, style + 31) > 1 - litDensity;
    const glass = context.createLinearGradient(x, y, x + cellW - 30, y + cellH - 25);
    glass.addColorStop(0, lit ? '#f5dd92' : '#70929a'); glass.addColorStop(0.5, lit ? '#d3b465' : '#314a54'); glass.addColorStop(1, lit ? '#9c824b' : '#182a32');
    context.fillStyle = glass; context.fillRect(x, y, cellW - 30, cellH - 26);
    context.fillStyle = '#bdc5c1'; context.globalAlpha = 0.45; context.fillRect(x + 4, y + 3, 2, cellH - 32); context.globalAlpha = 1;
    if (spec.band) { context.fillStyle = wallDark; context.fillRect(column * cellW, y + cellH - 18, cellW, 4); }
  }
  const texture = finish(canvas);
  return texture;
}

/** Emissive companion to createFacadeTexture: black except lit windows, sampled with the same seed so every
 *  day-lit window stays lit at night and extra windows join in (night density > day density). */
export function createFacadeGlowTexture(style: number): THREE.CanvasTexture {
  const { canvas, context } = canvasTexture(512);
  const spec = FACADE_STYLES[style % FACADE_STYLES.length] ?? FACADE_STYLES[0]!;
  const { lit: litDensity, columns, rows } = spec;
  context.fillStyle = '#000'; context.fillRect(0, 0, 512, 512);
  const nightDensity = Math.min(0.85, litDensity * 2 + 0.3);
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    if (seeded(row * columns + column, style + 31) <= 1 - nightDensity) continue;
    const cellW = 512 / columns; const cellH = 512 / rows; const x = column * cellW + 15; const y = row * cellH + 13;
    const warmth = 0.72 + seeded(row * columns + column, style + 57) * 0.28;
    const glass = context.createLinearGradient(x, y, x + cellW - 30, y + cellH - 25);
    glass.addColorStop(0, `rgba(255, 214, 138, ${warmth.toFixed(3)})`); glass.addColorStop(1, `rgba(196, 141, 64, ${warmth.toFixed(3)})`);
    context.fillStyle = glass; context.fillRect(x, y, cellW - 30, cellH - 26);
  }
  return finish(canvas);
}

// 512 slots (8 cols × 64 rows) in a single 2048×4096 texture (~32MB). The whole 1:1 map has a FIXED ~470
// unique signs (372 street names + shop/model boards), so this holds them all with headroom — no wrapping.
const SIGN_ATLAS = { width: 2048, height: 4096, slotW: 256, slotH: 64 };
interface SignSlot { u0: number; v0: number; u1: number; v1: number; }
let signAtlas: { context: CanvasRenderingContext2D; texture: THREE.CanvasTexture; next: number } | undefined;
const signSlots = new Map<string, SignSlot>();
const signMaterials = new Map<string, THREE.MeshBasicMaterial>();

/** Column/row layout of the sign atlas; capacity is the last-usable index (one slot reserved for overflow). */
export function signAtlasLayout(): { columns: number; rows: number; capacity: number } {
  const columns = Math.floor(SIGN_ATLAS.width / SIGN_ATLAS.slotW);
  const rows = Math.floor(SIGN_ATLAS.height / SIGN_ATLAS.slotH);
  return { columns, rows, capacity: columns * rows };
}

/** Next atlas slot for the Nth distinct sign. Fills sequentially and, once full, parks every further sign on
 *  the single last slot instead of wrapping back over slot 0 — so an already-drawn sign (a landmark board, a
 *  street name) is NEVER overwritten with someone else's text. Pure + exported for the allocation test. */
export function signSlotIndex(order: number, capacity: number): number {
  return order < capacity - 1 ? order : capacity - 1;
}

function signSlot(text: string, accent: string, background: string): SignSlot {
  const key = `${text}|${accent}|${background}`;
  const existing = signSlots.get(key); if (existing) return existing;
  if (!signAtlas) {
    const canvas = document.createElement('canvas'); canvas.width = SIGN_ATLAS.width; canvas.height = SIGN_ATLAS.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable');
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
    signAtlas = { context, texture, next: 0 };
  }
  const { columns, capacity } = signAtlasLayout();
  const index = signSlotIndex(signAtlas.next, capacity);
  if (signAtlas.next < capacity - 1) signAtlas.next++;
  const x = (index % columns) * SIGN_ATLAS.slotW; const y = Math.floor(index / columns) * SIGN_ATLAS.slotH;
  const context = signAtlas.context;
  context.fillStyle = background; context.fillRect(x, y, SIGN_ATLAS.slotW, SIGN_ATLAS.slotH);
  context.strokeStyle = accent; context.lineWidth = 5; context.strokeRect(x + 4, y + 4, SIGN_ATLAS.slotW - 8, SIGN_ATLAS.slotH - 8);
  context.fillStyle = accent; context.font = '700 30px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, x + SIGN_ATLAS.slotW / 2, y + SIGN_ATLAS.slotH / 2 + 1, SIGN_ATLAS.slotW - 20);
  signAtlas.texture.needsUpdate = true;
  const slot: SignSlot = { u0: x / SIGN_ATLAS.width, v0: 1 - (y + SIGN_ATLAS.slotH) / SIGN_ATLAS.height, u1: (x + SIGN_ATLAS.slotW) / SIGN_ATLAS.width, v1: 1 - y / SIGN_ATLAS.height };
  signSlots.set(key, slot); return slot;
}

export function createSignMesh(geometry: THREE.BufferGeometry, text: string, accent: string, options: { background?: string; doubleSide?: boolean; powered?: boolean } = {}): THREE.Mesh {
  if (typeof document === 'undefined') return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x222831, side: options.doubleSide ? THREE.DoubleSide : THREE.FrontSide }));
  const slot = signSlot(text, accent, options.background ?? '#10191c');
  const uv = geometry.getAttribute('uv');
  for (let index = 0; index < uv.count; index++) uv.setXY(index, THREE.MathUtils.lerp(slot.u0, slot.u1, uv.getX(index)), THREE.MathUtils.lerp(slot.v0, slot.v1, uv.getY(index)));
  const materialKey = `${options.doubleSide ? 'double' : 'front'}-${options.powered ? 'powered' : 'plain'}`;
  let material = signMaterials.get(materialKey);
  if (!material) {
    material = new THREE.MeshBasicMaterial({ map: signAtlas!.texture, side: options.doubleSide ? THREE.DoubleSide : THREE.FrontSide });
    if (options.powered) registerPowered(material, 0xffffff, 0x2a2d2f);
    signMaterials.set(materialKey, material);
  }
  return new THREE.Mesh(geometry, material);
}
