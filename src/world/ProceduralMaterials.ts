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

export function createGeneratedSurfaceTexture(url: string, fallback: SurfaceKind, repeat: number): THREE.Texture {
  const fallbackTexture = createSurfaceTexture(fallback, repeat);
  const texture = new THREE.TextureLoader().load(url, undefined, undefined, () => {
    texture.image = fallbackTexture.image; texture.needsUpdate = true;
  });
  texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(repeat, repeat); texture.anisotropy = 8;
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
