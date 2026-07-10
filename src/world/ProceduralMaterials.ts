import * as THREE from 'three';

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

export function createFacadeTexture(style: number): THREE.CanvasTexture {
  const { canvas, context } = canvasTexture(512);
  const wall = ['#88949a', '#9c5a43', '#b7aa88', '#8a5a4a'][style % 4];
  const wallDark = ['#5f696e', '#6b3a2c', '#7e755f', '#57352a'][style % 4];
  const gradient = context.createLinearGradient(0, 0, 512, 0); gradient.addColorStop(0, wallDark); gradient.addColorStop(0.12, wall); gradient.addColorStop(0.88, wall); gradient.addColorStop(1, wallDark);
  context.fillStyle = gradient; context.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 2200; i++) { context.globalAlpha = seeded(i, style + 20) * 0.09; context.fillStyle = seeded(i, style + 21) > 0.5 ? '#fff' : '#172024'; context.fillRect(seeded(i, 22) * 512, seeded(i, 23) * 512, 1.2, 1.2); }
  context.globalAlpha = 1;
  const columns = style % 2 === 0 ? 6 : 5; const rows = 9;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const cellW = 512 / columns; const cellH = 512 / rows; const x = column * cellW + 15; const y = row * cellH + 13;
    context.fillStyle = '#3e4c52'; context.fillRect(x - 4, y - 4, cellW - 22, cellH - 18);
    const lit = seeded(row * columns + column, style + 31) > 0.68;
    const glass = context.createLinearGradient(x, y, x + cellW - 30, y + cellH - 25);
    glass.addColorStop(0, lit ? '#dfc982' : '#70929a'); glass.addColorStop(0.5, lit ? '#bea55f' : '#314a54'); glass.addColorStop(1, lit ? '#8e7847' : '#182a32');
    context.fillStyle = glass; context.fillRect(x, y, cellW - 30, cellH - 26);
    context.fillStyle = '#bdc5c1'; context.globalAlpha = 0.45; context.fillRect(x + 4, y + 3, 2, cellH - 32); context.globalAlpha = 1;
    context.fillStyle = wallDark; context.fillRect(column * cellW, y + cellH - 18, cellW, 4);
  }
  const texture = finish(canvas);
  return texture;
}

export function createSignTexture(text: string, accent: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
  const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas 2D is unavailable');
  context.fillStyle = '#10191c'; context.fillRect(0, 0, 512, 128);
  context.strokeStyle = accent; context.lineWidth = 9; context.strokeRect(8, 8, 496, 112);
  context.fillStyle = accent; context.font = '700 60px Arial'; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(text, 256, 66, 470);
  return finish(canvas);
}
