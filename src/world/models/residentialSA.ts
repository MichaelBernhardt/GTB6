/**
 * South African residential structures: face-brick suburbia behind garden walls, townhouse
 * complexes, walk-up flats, modest tin-roof houses and a Sandton modernist villa. The wall+gate
 * perimeter is the signature move — most of these ship with one.
 */
import { Kit, M, brick, paint, type BuildOptions, type BuiltModel } from './kit';

/** Perimeter garden wall with a street-facing gate gap and pillars; every segment is a collider. */
function gardenWall(kit: Kit, w: number, d: number, wallH: number, gateHalf: number, material = M.plaster): void {
  const th = 0.35;
  kit.box(material, w + th, wallH, th, 0, 0, -d / 2, { collide: true });
  for (const side of [-1, 1]) kit.box(material, th, wallH, d + th, side * w / 2, 0, 0, { collide: true });
  const run = (w - gateHalf * 2) / 2;
  for (const side of [-1, 1]) {
    kit.box(material, run, wallH, th, side * (gateHalf + run / 2), 0, d / 2, { collide: true });
    kit.box(material, 0.55, wallH + 0.6, 0.55, side * gateHalf, 0, d / 2);
  }
  kit.box(M.darkMetal, gateHalf * 2, wallH - 0.35, 0.08, 0, 0, d / 2, { cast: false });
}

/** White frame + dark glass window pair, proud of a wall face. */
function windowPane(kit: Kit, x: number, y: number, z: number, w = 1.5, h = 1.2, ry = 0): void {
  kit.box(M.whiteMetal, w, h, 0.1, x, y, z, { ry, cast: false });
  kit.box(M.glassDark, w - 0.3, h - 0.3, 0.16, x, y + 0.15 / 2, z, { ry, cast: false });
}

/** Face-brick suburban house: hip-tiled roof, garden wall, driveway and gate. The SA default. */
export function buildFaceBrickHouse(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const hw = 10.5 + size * 3.5; const hd = 7.5 + size * 2; const h = 3;
  const skin = kit.pick(3, [M.faceBrick, M.redBrick, brick(0xb5794e)]);
  const tile = kit.pick(4, [M.tileCharcoal, M.tileTerracotta]);
  const plotW = hw + 6.5; const plotD = hd + 9;

  kit.box(M.grassDry, plotW - 0.6, 0.07, plotD - 0.6, 0, 0, 0, { cast: false }); // lawn
  const houseZ = -plotD / 2 + hd / 2 + 1.6;
  kit.box(skin, hw, h, hd, 0, 0, houseZ, { collide: true });
  kit.hip(tile, hw + 1, hd + 1, 2.3, 0, h, houseZ, 0.45);
  windowPane(kit, -hw * 0.28, 1.35, houseZ + hd / 2 + 0.03);
  windowPane(kit, hw * 0.28, 1.35, houseZ + hd / 2 + 0.03);
  kit.box(M.darkTimber, 1.05, 2.1, 0.09, 0, 0, houseZ + hd / 2 + 0.05, { cast: false });
  kit.box(tile, 3, 0.12, 1.6, 0, 2.6, houseZ + hd / 2 + 0.8, { rx: 0.14 }); // door canopy
  if (variant >= 1) { // attached garage facing the gate
    const gw = 4.6;
    kit.box(skin, gw, 2.7, 5, hw / 2 - gw / 2 + 0.001, 0, houseZ + hd / 2 + 2.5, { collide: true });
    kit.hip(tile, gw + 0.8, 5.8, 1.4, hw / 2 - gw / 2, 2.7, houseZ + hd / 2 + 2.5, 0.5);
    kit.box(M.whiteMetal, gw - 0.9, 2.1, 0.1, hw / 2 - gw / 2, 0, houseZ + hd / 2 + 5.02, { cast: false }); // roll-up door
  }
  kit.box(M.paving, 3.4, 0.09, plotD / 2 - houseZ - hd / 2, hw / 2 - 2.3, 0.02, (plotD / 2 + houseZ + hd / 2) / 2, { cast: false }); // driveway
  gardenWall(kit, plotW, plotD, variant === 2 ? 2.2 : 1.7, 1.9, variant === 2 ? M.concrete : M.plaster);
  if (variant === 2) for (let strand = 0; strand < 2; strand++) kit.box(M.darkMetal, plotW, 0.03, 0.03, 0, 2.25 + strand * 0.15, -plotD / 2, { cast: false }); // electric fence
  kit.cyl(M.jojo, 0.85, 0.85, 1.8, -plotW / 2 + 1.2, 0, -plotD / 2 + 1.4, { seg: 12 });
  return kit.done();
}

/** Townhouse / cluster-complex row: repeated gabled units behind one complex wall. */
export function buildTownhouseRow(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const units = 3 + variant; const unitW = 5.4 + size; const unitD = 8; const h = 5.4;
  const w = units * unitW;
  const skin = kit.pick(3, [M.plaster, M.tan, M.faceBrick]);
  const tile = kit.pick(4, [M.tileCharcoal, M.tileTerracotta]);

  for (let unit = 0; unit < units; unit++) {
    const x = -w / 2 + unitW * (unit + 0.5); const stagger = (unit % 2) * 0.7;
    kit.box(skin, unitW, h, unitD, x, 0, stagger, { collide: true });
    kit.gable(tile, unitD + 0.7, unitW + 0.3, 1.9, x, h, stagger, { ry: Math.PI / 2 });
    windowPane(kit, x - unitW * 0.18, 3.9, unitD / 2 + stagger + 0.03, 1.2, 1.1);
    kit.box(M.darkTimber, 0.95, 2.05, 0.08, x + unitW * 0.2, 0, unitD / 2 + stagger + 0.05, { cast: false });
    kit.box(M.paving, 2, 0.08, 2.6, x + unitW * 0.2, 0.01, unitD / 2 + stagger + 1.5, { cast: false });
  }
  const plotW = w + 3; const plotD = unitD + 8;
  gardenWall(kit, plotW, plotD, 2.1, 2.1, M.plaster);
  kit.sign(kit.pick(5, ['VILLA MIA ESTATE', 'DIE EIKE KOMPLEKS', 'SUNSET RIDGE 2', 'KIEPERSOL CLOSE']), '#d8c8a0', 3.4, 0.6, 2.8, 1.5, plotD / 2 + 0.06, { background: '#3a4436' });
  return kit.done();
}

/** Three-to-four-storey walk-up flats: balcony grid, stair tower, washing on the roof. */
export function buildApartmentBlock(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const floors = 3 + variant; const floorH = 2.9; const h = floors * floorH + 0.9;
  const w = 13 + size * 5; const d = 9.5 + size * 2;
  const skin = kit.pick(3, [M.plaster, M.tan, M.faceBrick, paint(0xc4b49a, 0.9)]);

  kit.box(skin, w, h, d, 0, 0, 0, { collide: true }); // flat roof — standable
  const bays = 3;
  for (let floor = 1; floor <= floors; floor++) for (let bay = 0; bay < bays; bay++) {
    const x = (bay - (bays - 1) / 2) * (w / bays); const y = floor * floorH - 0.6;
    kit.box(M.concrete, w / bays - 1.4, 0.14, 1.3, x, y, d / 2 + 0.65, { cast: false, collide: true }); // balcony floor — standable
    kit.box(M.darkMetal, w / bays - 1.4, 0.75, 0.06, x, y + 0.14, d / 2 + 1.28, { cast: false });
    kit.box(M.glassDark, w / bays - 2, 1.6, 0.1, x, y + 0.2, d / 2 + 0.04, { cast: false });
  }
  kit.box(skin, 3.2, h + 2, 3.2, -w / 2 - 1.4, 0, -d * 0.1, { collide: true }); // stair tower
  for (const post of [-1, 1]) kit.box(M.steel, 0.08, 1.7, 0.08, post * w * 0.25, h, -d * 0.2); // roof washing lines
  for (let line = 0; line < 3; line++) kit.box(M.whiteMetal, w * 0.5, 0.02, 0.02, 0, h + 1.4 - line * 0.25, -d * 0.2 - line * 0.28, { cast: false });
  kit.box(M.concrete, 3.6, 0.18, 1.7, w * 0.12, 2.85, d / 2 + 0.85, { cast: false }); // entrance canopy
  kit.sign(kit.pick(4, ['JACARANDA COURT', 'PROTEA MANSIONS', 'HILLBROW HEIGHTS LITE', 'EKHAYA FLATS']), '#d8d0b8', w * 0.4, 0.65, w * 0.12, 4, d / 2 + 0.07, { background: '#33403c' });
  return kit.done();
}

/** Modest tin-roof house: small plastered box, corrugated roof, wire fence, JoJo tank, dirt yard. */
export function buildTinRoofHouse(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const hw = 6 + size * 1.6; const hd = 5 + size; const h = 2.5;
  const wall = kit.pick(3, [paint(0xbfae8a, 0.92), paint(0x9db2ac, 0.92), paint(0xc99a8a, 0.92), M.plaster]);
  const plotW = hw + 5; const plotD = hd + 6.5;

  kit.box(M.dirt, plotW - 0.5, 0.06, plotD - 0.5, 0, 0, 0, { cast: false });
  const houseZ = -plotD / 2 + hd / 2 + 1.2;
  kit.box(wall, hw, h, hd, 0, 0, houseZ, { collide: true });
  if (variant === 0) kit.gable(M.galv, hw + 0.9, hd + 0.9, 1.1, 0, h, houseZ);
  else kit.box(kit.pick(5, [M.galv, M.corrRust]), hw + 1, 0.08, hd + 1.1, 0, h + 0.22, houseZ, { rx: 0.1 });
  kit.box(M.darkTimber, 0.95, 2, 0.08, -hw * 0.18, 0, houseZ + hd / 2 + 0.05, { cast: false });
  windowPane(kit, hw * 0.24, 1.25, houseZ + hd / 2 + 0.03, 1.2, 1);
  kit.box(M.paving, 2.2, 0.12, 1.4, -hw * 0.18, 0, houseZ + hd / 2 + 0.75, { cast: false }); // stoep slab
  // Wire fence: corner posts + two strands, gate gap in front.
  const strand = (x0: number, z0: number, x1: number, z1: number): void => {
    const length = Math.hypot(x1 - x0, z1 - z0);
    for (const y of [0.5, 1]) kit.box(M.darkMetal, length, 0.025, 0.025, (x0 + x1) / 2, y, (z0 + z1) / 2, { ry: -Math.atan2(z1 - z0, x1 - x0), cast: false });
  };
  for (const [px, pz] of [[-plotW / 2, -plotD / 2], [plotW / 2, -plotD / 2], [-plotW / 2, plotD / 2], [plotW / 2, plotD / 2], [1.2, plotD / 2], [-1.2, plotD / 2]] as const) {
    kit.box(M.timber, 0.09, 1.25, 0.09, px, 0, pz);
  }
  strand(-plotW / 2, -plotD / 2, plotW / 2, -plotD / 2);
  strand(-plotW / 2, -plotD / 2, -plotW / 2, plotD / 2);
  strand(plotW / 2, -plotD / 2, plotW / 2, plotD / 2);
  strand(-plotW / 2, plotD / 2, -1.2, plotD / 2); strand(1.2, plotD / 2, plotW / 2, plotD / 2);
  if (variant !== 1) kit.cyl(M.jojo, 0.8, 0.8, 1.7, hw / 2 + 1.1, 0, houseZ, { seg: 12, collide: true });
  if (variant === 2) kit.box(M.corrRust, 1.3, 2, 1.3, plotW / 2 - 1.1, 0, -plotD / 2 + 1.1, { collide: true }); // outhouse
  return kit.done();
}

/** Sandton-ish modernist villa: stacked white boxes, cantilever, glass bands, high wall. */
export function buildSandtonVilla(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const gw = 12 + size * 3; const gd = 8 + size * 2; // ground volume
  const plotW = gw + 10; const plotD = gd + 11;

  kit.box(M.grassDry, plotW - 0.6, 0.07, plotD - 0.6, 0, 0, 0, { cast: false });
  const houseZ = -plotD / 2 + gd / 2 + 5.6; // back yard deep enough for the pool terrace
  kit.box(M.whitewash, gw, 3.4, gd, 0, 0, houseZ, { collide: true });
  kit.box(M.glass, gw * 0.7, 2.2, 0.14, -gw * 0.1, 0.5, houseZ + gd / 2 + 0.04, { cast: false });
  const uw = gw * 0.72; const ud = gd * 0.85; const upperX = variant === 0 ? gw * 0.14 : -gw * 0.14;
  kit.box(M.whitewash, uw, 3, ud, upperX, 3.4, houseZ + 1.1, { collide: true }); // cantilevered upper — standable tiers both levels
  kit.box(M.glassDark, uw * 0.85, 1.5, 0.12, upperX, 4.2, houseZ + 1.1 + ud / 2 + 0.04, { cast: false });
  kit.box(M.darkTimber, uw + 0.6, 0.25, ud + 0.6, upperX, 6.4, houseZ + 1.1, { cast: false }); // roof fascia
  // Floating carport slab on two blades.
  kit.box(M.whitewash, 5.4, 0.28, 5.6, gw / 2 + 2.4, 2.6, houseZ + gd / 2 + 1.4);
  kit.box(M.whitewash, 0.25, 2.6, 5, gw / 2 + 4.6, 0, houseZ + gd / 2 + 1.4, { collide: true });
  kit.box(M.paving, 3.6, 0.09, plotD / 2 - houseZ - gd / 2, gw / 2 + 2.2, 0.02, (plotD / 2 + houseZ + gd / 2) / 2, { cast: false });
  // Pool and deck in the back garden.
  kit.box(M.pool, Math.min(6.5, gw * 0.5), 0.25, 3, -gw * 0.15, 0.1, houseZ - gd / 2 - 2.4, { cast: false });
  kit.box(M.bleached, Math.min(8, gw * 0.6), 0.12, 4.4, -gw * 0.15, 0.01, houseZ - gd / 2 - 2.4, { cast: false });
  gardenWall(kit, plotW, plotD, 2.5, 2.2, M.whitewash);
  for (let strand = 0; strand < 3; strand++) kit.box(M.darkMetal, plotW, 0.025, 0.025, 0, 2.6 + strand * 0.14, -plotD / 2, { cast: false }); // electric fence
  kit.sign('CAVEO ARMED RESPONSE', '#c8d6dd', 1.4, 0.55, plotW / 2 - 1.6, 1.6, plotD / 2 + 0.05, { background: '#2c3440' });
  return kit.done();
}
