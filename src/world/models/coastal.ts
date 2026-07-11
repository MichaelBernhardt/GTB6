/**
 * Beachfront / promenade structures: breezy Cape-coast entertainment set. Bleached timber,
 * whitewash, striped umbrellas, and a lifeguard tower you can climb.
 */
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';

const UMBRELLAS = [paint(0xd9634a, 0.75), paint(0x3e8ca8, 0.75), paint(0xe0c23c, 0.75), paint(0x69a58e, 0.75), paint(0xd88ab0, 0.75)] as const;

function umbrella(kit: Kit, salt: number, x: number, z: number, scale = 1): void {
  kit.cyl(M.bleached, 0.05 * scale, 0.05 * scale, 2.2 * scale, x, 0, z, { seg: 6 });
  kit.cyl(kit.pick(salt, UMBRELLAS), 0.02, 1.35 * scale, 0.55 * scale, x, 2.2 * scale, z, { seg: 10, cast: false });
}

function table(kit: Kit, x: number, z: number, y: number): void {
  kit.cyl(M.bleached, 0.42, 0.42, 0.05, x, y + 0.72, z, { seg: 10, cast: false });
  kit.cyl(M.darkTimber, 0.05, 0.07, 0.72, x, y, z, { seg: 6, cast: false });
}

/** Beachfront cafe: raised timber deck on piles, umbrella terrace, big glazed front. */
export function buildBeachCafe(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const deckW = 13 + size * 4; const deckD = 9 + size * 3; const deckH = 0.55;

  for (let pile = 0; pile < 6; pile++) kit.cyl(M.darkTimber, 0.14, 0.14, deckH, -deckW / 2 + 1 + (pile % 3) * ((deckW - 2) / 2), 0, -deckD / 2 + 1 + Math.floor(pile / 3) * (deckD - 2), { seg: 8 });
  kit.box(M.bleached, deckW, 0.18, deckD, 0, deckH, 0, { collide: true }); // deck — standable
  for (const [rx, rz, rw, rd] of [[0, deckD / 2, deckW, 0], [-deckW / 2, 0, 0, deckD], [deckW / 2, 0, 0, deckD]] as const) {
    kit.box(M.bleached, rw ? rw : 0.08, 0.1, rd ? rd : 0.08, rx, deckH + 1.05, rz, { cast: false });
    for (let post = 0; post < 4; post++) {
      kit.box(M.bleached, 0.07, 1, 0.07, rw ? rx - rw / 2 + 0.3 + post * ((rw - 0.6) / 3) : rx, deckH + 0.18, rd ? rz - rd / 2 + 0.3 + post * ((rd - 0.6) / 3) : rz, { cast: false });
    }
  }
  const cafeW = deckW * 0.62; const cafeD = deckD * 0.5; const cafeZ = -deckD / 2 + cafeD / 2 + 0.4;
  kit.box(M.whitewash, cafeW, 3, cafeD, -deckW * 0.14, deckH + 0.18, cafeZ, { collide: true });
  kit.box(M.glass, cafeW * 0.8, 2.1, 0.12, -deckW * 0.14, deckH + 0.42, cafeZ + cafeD / 2 + 0.02, { cast: false });
  if (variant === 1) kit.hip(M.thatch, cafeW + 1.2, cafeD + 1.2, 2.2, -deckW * 0.14, deckH + 3.18, cafeZ, 0.3);
  else kit.box(M.bleached, cafeW + 0.9, 0.14, cafeD + 0.9, -deckW * 0.14, deckH + 3.3, cafeZ, { rx: 0.05 });
  kit.sign(kit.pick(3, ['SNOEK & CHIPS', 'DIE STRAND KAFEE', 'SEA BREEZE - EST 1994', 'KREEF & CO']), '#f2e2b8', cafeW * 0.8, 0.72, -deckW * 0.14, deckH + 2.55, cafeZ + cafeD / 2 + 0.14, { background: '#2e5560' });
  for (let seat = 0; seat < 2 + variant; seat++) {
    const x = deckW * 0.18 + (seat % 2) * 2.6 - 1; const z = deckD * 0.05 + Math.floor(seat / 2) * 2.8;
    umbrella(kit, 20 + seat, x, z);
    table(kit, x + 0.7, z + 0.3, deckH + 0.09);
  }
  kit.box(M.bleached, 1.6, 0.16, 2.4, deckW * 0.3, 0.28, deckD / 2 + 1.15, { rx: -0.22 }); // beach steps
  return kit.done();
}

/** Round roomys kiosk with a striped cone roof and serving hatch. */
export function buildIceCreamKiosk(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const radius = 1.5 + (options.size ?? kit.rnd(2)) * 0.4;
  const bodyColor = kit.pick(3, [M.whitewash, paint(0xe8c9d4, 0.85), paint(0xcfe4e0, 0.85)]);

  kit.cyl(bodyColor, radius, radius, 2.35, 0, 0, 0, { seg: 10, collide: true });
  kit.cyl(kit.pick(4, UMBRELLAS), 0.06, radius + 0.45, 1.1, 0, 2.35, 0, { seg: 10 });
  kit.cyl(M.whiteMetal, 0.1, 0.1, 0.5, 0, 3.45, 0, { seg: 6, cast: false });
  kit.box(M.glassDark, radius * 1.1, 0.85, 0.1, 0, 1.05, radius - 0.03, { cast: false });
  kit.box(M.bleached, radius * 1.3, 0.08, 0.42, 0, 0.95, radius + 0.18, { cast: false }); // counter
  kit.sign(kit.pick(5, ['ROOMYS', 'SOFT SERVE R10', 'GRANADILLA LOLLY', 'ICE KOUD']), '#f2e2b8', radius * 1.5, 0.5, 0, 2.05, radius + 0.08, { background: '#a84860' });
  if (variant > 0) umbrella(kit, 6, radius + 1.3, 0.4, 0.9);
  if (variant === 2) { kit.box(M.tar, 0.5, 1.1, 0.5, -radius - 0.9, 0, 0.2, { cast: false }); } // bin
  return kit.done();
}

/** Beach ablutions / changing rooms: plain municipal block, DAMES and MANS doors. */
export function buildAblutions(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 7 + size * 2; const d = 4.5 + size; const h = 2.9;
  const wall = kit.pick(3, [M.concrete, M.plaster, paint(0xbcd0cb, 0.9)]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.box(M.concrete, w + 0.6, 0.12, d + 0.6, 0, h + 0.1, 0, { rx: 0.04 });
  kit.box(M.glassDark, w * 0.7, 0.4, 0.08, 0, h - 0.75, d / 2 + 0.03, { cast: false }); // vent strip
  for (const side of [-1, 1]) {
    kit.box(M.darkTimber, 0.95, 2.05, 0.08, side * w * 0.28, 0, d / 2 + 0.05, { cast: false });
    kit.sign(side < 0 ? 'DAMES' : 'MANS', '#e8e8e8', 1.15, 0.42, side * w * 0.28, 2.35, d / 2 + 0.07, { background: '#31555e' });
  }
  if (variant === 1) { // outdoor shower on the beach side
    kit.box(M.steel, 0.09, 2.6, 0.09, -w / 2 - 0.9, 0, d * 0.1);
    kit.box(M.steel, 0.5, 0.06, 0.06, -w / 2 - 0.7, 2.5, d * 0.1, { cast: false });
    kit.box(M.paving, 1.2, 0.08, 1.2, -w / 2 - 0.9, 0, d * 0.1, { cast: false });
  }
  return kit.done();
}

/** Victorian-ish promenade pavilion: raised slab, slender columns, green hip roof. */
export function buildPavilion(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 8.5 + size * 3; const d = 6.5 + size * 2; const slabH = 0.5;

  kit.box(M.paving, w, slabH, d, 0, 0, 0, { collide: true }); // plinth — standable
  kit.box(M.paving, w * 0.4, 0.25, 1.1, 0, 0, d / 2 + 0.55, { cast: false }); // step
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.cyl(M.whitewash, 0.12, 0.15, 2.9, sx * (w / 2 - 0.5), slabH, sz * (d / 2 - 0.5), { seg: 10 });
  for (const sx of [-1, 1]) kit.cyl(M.whitewash, 0.12, 0.15, 2.9, sx * (w / 2 - 0.5), slabH, 0, { seg: 10 });
  kit.hip(variant === 0 ? M.corrGreen : M.corrRed, w + 1, d + 1, 1.9, 0, slabH + 2.9, 0.4);
  for (const [rx, rz, rw, rd] of [[0, -d / 2 + 0.25, w - 1, 0], [-w / 2 + 0.25, 0, 0, d - 1], [w / 2 - 0.25, 0, 0, d - 1]] as const) {
    kit.box(M.whitewash, rw ? rw : 0.07, 0.55, rd ? rd : 0.07, rx, slabH + 0.35, rz, { cast: false }); // balustrade
  }
  kit.box(M.darkTimber, 2.2, 0.45, 0.5, 0, slabH + 0.25, -d * 0.22, { cast: false }); // bench
  if (variant === 1) kit.cyl(M.whiteMetal, 0.32, 0.05, 3.2, w / 2 + 1.2, 0, d / 2 - 0.6, { seg: 8 }); // promenade lamp
  return kit.done();
}

/** Surf shack: bleached-timber hut, leaning boards, hire rack. */
export function buildSurfShack(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = 4.6 + size * 1.4; const d = 3.8 + size; const h = 2.5;
  const wall = kit.pick(3, [M.bleached, paint(0x8fb0a8, 0.85), paint(0xc4a86a, 0.85)]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.box(M.galv, w + 0.8, 0.09, d + 0.9, 0, h + 0.28, 0.1, { rx: 0.14 });
  kit.box(M.darkTimber, 0.9, 1.9, 0.08, -w * 0.22, 0, d / 2 + 0.05, { cast: false });
  kit.box(M.glassDark, 1, 0.8, 0.08, w * 0.22, 1, d / 2 + 0.04, { cast: false });
  kit.sign(kit.pick(4, ['HANG TEN HUUR', 'SURF SAKE', 'VIS & BAIT', 'BOARDS R50/DAG']), '#8fd8d4', w * 0.85, 0.55, 0, h - 0.35, d / 2 + 0.07, { background: '#3a4a54' });
  for (let board = 0; board < 2 + (variant % 2); board++) { // boards leaning on the flank
    kit.box(kit.pick(20 + board, UMBRELLAS), 0.5, 2.1, 0.07, w / 2 + 0.15 + board * 0.28, 0, -d * 0.1 + board * 0.5, { rz: 0.24 });
  }
  if (variant === 2) { // hire rack
    for (const zed of [-1, 1]) kit.box(M.timber, 0.1, 1.5, 0.1, -w / 2 - 1.4, 0, zed * 1);
    kit.box(M.timber, 0.08, 0.08, 2.3, -w / 2 - 1.4, 1.4, 0, { cast: false });
    kit.box(kit.pick(9, UMBRELLAS), 0.45, 1.9, 0.06, -w / 2 - 1.5, 0.05, -0.4, { rz: 0.18 });
  }
  return kit.done();
}

/** Lifeguard tower: cabin on stilts with a viewing deck, ramp and flag. Climbable. */
export function buildLifeguardTower(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const legH = 2.8 + (options.size ?? kit.rnd(2)) * 0.8;
  const cabin = variant === 0 ? paint(0xd9634a, 0.8) : paint(0xe0c23c, 0.8);

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.box(M.bleached, 0.16, legH, 0.16, sx * 1.1, 0, sz * 1.1, { rx: sz * -0.08, rz: sx * 0.08 });
  kit.box(M.bleached, 3.4, 0.16, 3.4, 0, legH, 0, { collide: true }); // deck — standable
  kit.box(cabin, 2.5, 2.1, 2.2, 0, legH + 0.16, -0.4, { collide: true });
  kit.box(M.glassDark, 2.1, 0.8, 0.08, 0, legH + 1.15, 0.73, { cast: false });
  kit.box(M.whitewash, 2.9, 0.1, 2.7, 0, legH + 2.42, -0.4, { rx: 0.09 });
  kit.box(M.bleached, 3.4, 0.09, 0.08, 0, legH + 1.1, 1.66, { cast: false }); // deck rail
  kit.box(M.bleached, 1, 0.12, legH * 2.3, 0, legH * 0.48, 1.6 + legH * 0.9, { rx: -Math.atan2(legH, legH * 2.2) }); // ramp
  kit.cyl(M.whiteMetal, 0.05, 0.05, 2.4, 1.5, legH + 0.16, -1.3, { seg: 6 });
  kit.sign('NO SWIM GEVAAR', '#e84a3c', 1.4, 0.5, 1.5, legH + 2.2, -1.3, { doubleSide: true, background: '#f2ead0' });
  return kit.done();
}

/** Umbrella-and-lounger cluster: pure beach dressing, loungers collide low. */
export function buildBeachLoungers(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const pairs = 2 + variant;
  for (let pair = 0; pair < pairs; pair++) {
    const x = kit.range(10 + pair, -3.4, 3.4); const z = -3 + (pair % 2) * 4 + kit.rnd(20 + pair) * 1.4;
    umbrella(kit, 30 + pair, x, z);
    const ly = 0.18;
    kit.box(M.bleached, 0.75, ly, 1.9, x + 1.1, 0, z + 0.4, { collide: true });
    kit.box(kit.pick(40 + pair, UMBRELLAS), 0.75, 0.09, 0.8, x + 1.1, ly + 0.28, z - 0.32, { rx: 0.6, cast: false });
    if (pair % 2 === 0) kit.box(M.bleached, 0.45, 0.4, 0.45, x - 0.9, 0, z + 0.7, { cast: false }); // side table
  }
  return kit.done();
}

/** Pier-end kiosk: slap-chips hatch, bench and a storm lamp — promenade furniture scale. */
export function buildPierKiosk(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const w = 3.4 + (options.size ?? kit.rnd(2)) * 0.8; const d = 2.8; const h = 2.6;

  kit.box(M.whitewash, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(M.corrRed, w + 0.5, d + 0.5, 0.9, 0, h, 0);
  kit.box(M.glassDark, w * 0.6, 0.9, 0.08, 0, 1.05, d / 2 + 0.03, { cast: false });
  kit.box(M.bleached, w * 0.75, 0.07, 0.4, 0, 0.95, d / 2 + 0.22, { cast: false });
  kit.sign(kit.pick(3, ['SLAP CHIPS', 'SNOEKWORS ROLLS', 'KOFFIE & KOEK']), '#f2e2b8', w * 0.9, 0.5, 0, h - 0.35, d / 2 + 0.06, { background: '#7a3a2e' });
  kit.box(M.darkTimber, 1.9, 0.42, 0.5, -w / 2 - 1.3, 0, 0.3, { collide: true }); // bench
  kit.box(M.darkTimber, 1.9, 0.5, 0.09, -w / 2 - 1.3, 0.42, 0.52, { cast: false });
  if (variant === 1) kit.cyl(M.darkMetal, 0.25, 0.05, 3, w / 2 + 1, 0, -0.4, { seg: 8 }); // storm lamp
  return kit.done();
}
