/**
 * Commercial structures: shopping strips, spazas, forecourts and office boxes, signed in the
 * game's parody-brand register. Flat roofs are collider tiers so players can get up there.
 */
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';

const SHOP_NAMES = ['OK-ISH FOODS', 'MR PRICELESS', 'LEKKER LIQUOR', 'BUNNY CHOW NOW', 'VETKOEK PALACE', 'HAIR 2 STAY', 'CELL C U LATER', 'PIK-N-SPRAY', 'CHICKEN LEKKER', 'BILTONG BARON'];
const ACCENTS = ['#e8b84a', '#d9634a', '#7fc4c9', '#c9de78', '#e88ab0', '#9fd18a'];

/** Row of shopfronts under one parapet: continuous canopy walkway, per-unit signs. */
export function buildStripMall(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const units = 3 + variant; const unitW = 5.6 + size * 1.2; const w = units * unitW; const d = 9.5 + size * 2; const h = 4.2;
  const wall = kit.pick(3, [M.tan, M.plaster, M.faceBrick]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true }); // flat roof — standable via the tier top
  kit.box(wall, w, 1, 0.3, 0, h, d / 2 - 0.15, { cast: false }); // parapet lip
  kit.box(M.concrete, w + 0.4, 0.22, 2.6, 0, 3.1, d / 2 + 1.3, { cast: false }); // walkway canopy
  kit.box(M.paving, w, 0.14, 3, 0, 0, d / 2 + 1.5, { cast: false });
  for (let unit = 0; unit <= units; unit++) kit.box(M.steel, 0.14, 3.1, 0.14, -w / 2 + unit * unitW, 0, d / 2 + 2.4);
  for (let unit = 0; unit < units; unit++) {
    const x = -w / 2 + unitW * (unit + 0.5);
    kit.box(M.glassDark, unitW - 1.1, 2.5, 0.12, x, 0.14, d / 2 + 0.05, { cast: false });
    kit.sign(kit.pick(10 + unit, SHOP_NAMES), kit.pick(20 + unit, ACCENTS), unitW - 1.4, 0.85, x, 3.85, d / 2 + 0.32);
  }
  for (let vent = 0; vent < units - 1; vent++) kit.box(M.steel, 1.1, 0.7, 1.1, -w / 2 + unitW * (vent + 1), h, -d * 0.2); // roof plant
  return kit.done();
}

/** Standalone spaza / tuck shop / bottle store: bright painted box, burglar bars, crate stack. */
export function buildSpazaShop(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = 4.8 + size * 1.6; const d = 4.2 + size; const h = 2.7;
  const wall = kit.pick(3, [paint(0xc9b23c, 0.9), paint(0x69a58e, 0.9), paint(0xbf6a52, 0.9), M.corrBlue]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.box(M.galv, w + 0.7, 0.1, d + 0.8, 0, h + 0.18, 0.1, { rx: 0.06 });
  const name = kit.pick(4, ['KWIK SPAZA', 'BLESSINGS TUCK SHOP', 'KOTA KING', 'TOPS-ISH BOTTLE STORE', 'SLAP CHIPS HERE']);
  kit.sign(name, kit.pick(5, ACCENTS), w * 0.92, 0.72, 0, h - 0.42, d / 2 + 0.07);
  kit.box(M.glassDark, w * 0.42, 1.1, 0.1, -w * 0.2, 0.85, d / 2 + 0.03, { cast: false });
  for (let bar = 0; bar < 3; bar++) kit.box(M.darkMetal, 0.04, 1.15, 0.06, -w * 0.2 - w * 0.14 + bar * w * 0.14, 0.83, d / 2 + 0.1, { cast: false });
  kit.box(M.darkTimber, 0.95, 2, 0.08, w * 0.26, 0, d / 2 + 0.05, { cast: false });
  for (let crate = 0; crate < 2 + variant; crate++) {
    kit.box(paint(0xb03a2e, 0.8), 0.5, 0.35, 0.34, w / 2 + 0.45, crate * 0.35, d * 0.1 - 0.4 * (crate % 2), { cast: false });
  }
  if (variant === 2) kit.sign('COCA-COLASTIC', '#e8e8e8', 1.6, 0.55, w / 2 + 0.04, 1.7, -d * 0.1, { ry: Math.PI / 2, background: '#8e1f14' });
  return kit.done();
}

/** Filling station: kiosk shop, pump islands under a walkable canopy slab, price totem. */
export function buildFillingStation(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const brand = kit.pick(3, [
    { name: 'ENGINE', accent: '#d64541', trim: paint(0xa8352e, 0.6, 0.2) },
    { name: 'CALTEXX', accent: '#3d9970', trim: paint(0x2c7a55, 0.6, 0.2) },
    { name: 'SASOIL', accent: '#3f78b5', trim: paint(0x2f5d8e, 0.6, 0.2) },
    { name: 'BOEREPETROL', accent: '#e0a63c', trim: paint(0xb5842c, 0.6, 0.2) },
  ]);
  const canopyW = 14 + size * 4; const canopyD = 9 + size * 2; const canopyH = 4.7;

  kit.box(M.tar, canopyW + 6, 0.1, canopyD + 8, 0, 0, 1, { cast: false }); // forecourt apron
  const kioskW = 7 + size * 2;
  kit.box(M.plaster, kioskW, 3.4, 5.5, 0, 0, -canopyD / 2 - 3.4, { collide: true });
  kit.box(M.glassDark, kioskW * 0.7, 2.2, 0.12, 0, 0.1, -canopyD / 2 - 0.62, { cast: false });
  kit.sign(`${brand.name} SHOP`, brand.accent, kioskW * 0.8, 0.7, 0, 2.6, -canopyD / 2 - 0.55);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.box(M.steel, 0.45, canopyH, 0.45, sx * canopyW * 0.32, 0, sz * canopyD * 0.28);
  kit.box(M.whiteMetal, canopyW, 0.45, canopyD, 0, canopyH, 0, { collide: true }); // canopy slab — standable
  kit.box(brand.trim, canopyW + 0.1, 0.5, canopyD + 0.1, 0, canopyH + 0.45, 0, { cast: false }); // fascia band
  kit.sign(brand.name, brand.accent, canopyW * 0.4, 0.5, 0, canopyH + 0.7, canopyD / 2 + 0.06);
  const islands = variant === 0 ? 1 : 2;
  for (let island = 0; island < islands; island++) {
    const x = (island - (islands - 1) / 2) * canopyW * 0.36;
    kit.box(M.concrete, 4.2, 0.24, 1.5, x, 0.1, 0, { cast: false });
    for (const side of [-1, 1]) {
      kit.box(brand.trim, 0.65, 1.6, 0.5, x + side * 1.2, 0.34, 0, { collide: true });
      kit.box(M.glassDark, 0.5, 0.4, 0.05, x + side * 1.2, 1.25, 0.29, { cast: false });
    }
  }
  kit.box(M.steel, 0.35, 6, 0.35, canopyW / 2 + 2.2, 0, canopyD / 2 + 1.5); // price totem
  kit.sign(`${brand.name} 95: R25.99`, brand.accent, 2.6, 1.5, canopyW / 2 + 2.2, 6.9, canopyD / 2 + 1.5, { doubleSide: true });
  if (variant === 2) kit.box(M.corrBlue, 2.2, 2.2, 1.6, -canopyW / 2 - 2.4, 0, -canopyD / 2 - 2, { collide: true }); // car-wash bay hint
  return kit.done();
}

/** Small suburban office block: two to four storeys, glass bands, roof plant, brass-plate sign. */
export function buildOfficeBlock(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const floors = 2 + variant; const floorH = 3.1; const h = floors * floorH + 0.8;
  const w = 11 + size * 5; const d = 9 + size * 3;
  const wall = kit.pick(3, [M.plaster, M.tan, M.faceBrick, M.concrete]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true }); // flat roof — standable
  for (let floor = 0; floor < floors; floor++) { // wrap-around glass band per storey
    const y = 0.9 + floor * floorH;
    kit.box(M.glass, w + 0.14, 1.5, d + 0.14, 0, y, 0, { cast: false });
  }
  kit.box(wall, w * 0.24, h + 1, d * 0.3, -w * 0.34, 0, 0.1, { collide: true }); // stair/lift core proud of the face
  kit.box(M.concrete, 4.4, 0.2, 1.8, w * 0.12, 3, d / 2 + 0.9, { cast: false }); // entrance canopy
  kit.box(M.glassDark, 3.4, 2.6, 0.12, w * 0.12, 0, d / 2 + 0.06, { cast: false });
  kit.sign(kit.pick(4, ['SANLAMB', 'OLD NEUTRAL', 'MEDIOCRE HOLDINGS', 'PRICEY WATERHOUSE', 'DISCOVERY CHANNEL MEDICAL']), '#c8d6dd', w * 0.5, 0.7, 0, h - 0.6, d / 2 + 0.08);
  for (let unit = 0; unit < 2; unit++) kit.box(M.steel, 1.4, 0.9, 1.1, -w * 0.1 + unit * 3, h, -d * 0.18);
  return kit.done();
}

/** Mall-ish big box: one huge volume, entrance portal, pylon sign, roof HVAC field. */
export function buildBigBox(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 28 + size * 10; const d = 20 + size * 8; const h = 7.5 + size * 1.5;
  const wall = kit.pick(3, [M.tan, M.concrete, M.plaster]);
  const brand = kit.pick(4, [
    { name: 'GROOT MALL', accent: '#e0a63c' }, { name: 'MAAKRO', accent: '#4a90d9' },
    { name: 'GAME OVER STORES', accent: '#d64541' }, { name: 'HYPER-ISH', accent: '#7fc46a' },
  ]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true }); // standable roof slab
  kit.box(paint(0x8e8c82, 0.9), w, 1.6, d * 0.02 + 0.3, 0, h * 0.55, d / 2 + 0.12, { cast: false }); // fascia stripe
  kit.box(wall, w * 0.28, h + 1.6, 2.2, 0, 0, d / 2 + 0.9, { collide: true }); // entrance portal
  kit.box(M.glassDark, w * 0.2, 3.6, 0.14, 0, 0, d / 2 + 2.05, { cast: false });
  kit.sign(brand.name, brand.accent, w * 0.24, 1.3, 0, h + 0.5, d / 2 + 2.02);
  kit.box(M.steel, 0.5, 8.5, 0.5, w / 2 + 2.6, 0, d / 2 - 1); // pylon
  kit.sign(brand.name, brand.accent, 3.6, 1.7, w / 2 + 2.6, 9.6, d / 2 - 1, { doubleSide: true });
  for (let unit = 0; unit < 4 + variant * 2; unit++) {
    kit.box(M.steel, 1.6, 1, 1.3, -w * 0.3 + (unit % 3) * w * 0.3, h, -d * 0.28 + Math.floor(unit / 3) * d * 0.3);
  }
  kit.box(M.paving, w * 0.8, 0.12, 5, 0, 0, d / 2 + 4.4, { cast: false }); // apron + trolley bay
  kit.box(M.steel, 2.4, 1.1, 1.1, w * 0.28, 0.12, d / 2 + 4, { cast: false });
  return kit.done();
}
