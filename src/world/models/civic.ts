/**
 * Civic & landmark extras — additions beyond the brief, chosen because each anchors a
 * neighbourhood the way the real things do: a kerktoring or minaret gives a suburb a skyline,
 * a school and taxi rank give it a daily rhythm, billboards and cell masts fill highway
 * verges, and the hilltop water reservoir is pure Joburg horizon.
 */
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';

/** Dorp church: steep-gabled whitewashed nave, square tower, spire and cross. NG Kerk energy. */
export function buildChurch(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const nw = 7.5 + size * 2; const nd = 14 + size * 4; const nh = 4.6;

  kit.box(M.whitewash, nw, nh, nd, 0, 0, 0, { collide: true });
  kit.gable(M.corrCharcoal, nd + 0.8, nw + 0.7, 3.2, 0, nh, 0, { ry: Math.PI / 2 });
  for (let bay = 0; bay < 3; bay++) for (const side of [-1, 1]) { // tall narrow windows
    kit.box(M.glass, 0.7, 2.4, 0.1, side * (nw / 2 + 0.01), 1.3, -nd * 0.3 + bay * nd * 0.3, { ry: Math.PI / 2, cast: false });
  }
  const tw = 3.2; const th = variant === 0 ? 8.5 : 7;
  kit.box(M.whitewash, tw, th, tw, 0, 0, nd / 2 + tw / 2 - 0.3, { collide: true });
  kit.hip(M.corrCharcoal, tw + 0.5, tw + 0.5, 3.4, 0, th, nd / 2 + tw / 2 - 0.3, 0.02); // spire
  kit.box(M.whiteMetal, 0.09, 1.3, 0.09, 0, th + 3.4, nd / 2 + tw / 2 - 0.3);
  kit.box(M.whiteMetal, 0.62, 0.09, 0.09, 0, th + 4.25, nd / 2 + tw / 2 - 0.3, { cast: false });
  kit.box(M.glassDark, 1.3, 1.3, 0.1, 0, th * 0.62, nd / 2 + tw / 2 - 0.3 + tw / 2 + 0.03, { cast: false }); // clock face plate
  kit.box(M.darkTimber, 1.5, 2.5, 0.12, 0, 0, nd / 2 + tw - 0.24, { cast: false });
  if (variant === 1) for (const side of [-1, 1]) kit.box(M.whitewash, 1, 1.6, 1.4, side * (nw / 2 + 0.5), 0, -nd * 0.25, { collide: true }); // buttress stubs
  return kit.done();
}

/** Neighbourhood mosque: green-domed hall and a slender minaret with a balcony. */
export function buildMosque(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const hw = 10 + size * 3; const hd = 10 + size * 3; const hh = 4.4;
  const dome = paint(0x3f7a5c, 0.5, 0.25);

  kit.box(M.whitewash, hw, hh, hd, 0, 0, 0, { collide: true });
  kit.box(dome, hw + 0.15, 0.5, hd + 0.15, 0, hh - 0.5, 0, { cast: false }); // trim band
  kit.cyl(M.whitewash, hw * 0.24, hw * 0.26, 1, 0, hh, 0, { seg: 14 }); // drum
  const sphere = kit.cyl(dome, 0.01, hw * 0.24, hw * 0.2, 0, hh + 1, 0, { seg: 14 });
  sphere.scale.y = 1.9; // onion-ish cap without a sphere's triangle bill
  kit.cyl(M.whiteMetal, 0.04, 0.04, 1, 0, hh + 1.6, 0, { seg: 6, cast: false });
  const mx = hw / 2 + 1.7; const mz = hd / 2 - 1;
  kit.cyl(M.whitewash, 0.75, 0.9, 11, mx, 0, mz, { seg: 10, collide: true }); // minaret
  kit.cyl(M.whitewash, 1.15, 1.15, 0.35, mx, 8.2, mz, { seg: 10, cast: false }); // balcony ring
  kit.cyl(dome, 0.02, 0.8, 1.4, mx, 11, mz, { seg: 10 });
  kit.box(M.glassDark, 2.2, 2.6, 0.1, 0, 0.4, hd / 2 + 0.04, { cast: false }); // arch doorway plate
  for (const side of [-1, 1]) kit.box(M.glass, 1, 1.7, 0.1, side * hw * 0.28, 1.2, hd / 2 + 0.03, { cast: false });
  if (variant === 1) { // wudu courtyard wall
    kit.box(M.whitewash, hw * 0.7, 1.6, 0.3, -hw * 0.15, 0, hd / 2 + 3.4, { collide: true });
    kit.box(M.paving, hw * 0.7, 0.08, 3, -hw * 0.15, 0, hd / 2 + 1.8, { cast: false });
  }
  return kit.done();
}

/** Laerskool: parallel classroom blocks joined by a covered walkway, flagpole and sign. */
export function buildSchool(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const bw = 16 + size * 5; const bd = 5.5; const bh = 3.1; const gap = 6;

  for (const row of [0, 1]) {
    const z = (row - 0.5) * (bd + gap);
    kit.box(M.faceBrick, bw, bh, bd, 0, 0, z, { collide: true });
    kit.gable(M.galv, bw + 0.8, bd + 0.8, 1.3, 0, bh, z);
    for (let pane = 0; pane < 5; pane++) kit.box(M.glassDark, 1.7, 1.1, 0.08, -bw / 2 + bw * 0.12 + pane * bw * 0.19, 1.25, z + bd / 2 + 0.03, { cast: false });
  }
  kit.box(M.galv, 2.2, 0.08, gap + 1, -bw * 0.2, 2.62, 0, { rx: 0.03 }); // walkway roof
  for (const zed of [-gap / 2 + 0.6, gap / 2 - 0.6]) for (const sx of [-1, 1]) kit.box(M.steel, 0.09, 2.6, 0.09, -bw * 0.2 + sx * 0.9, 0, zed);
  kit.box(M.paving, 2.4, 0.06, gap, -bw * 0.2, 0, 0, { cast: false });
  kit.cyl(M.whiteMetal, 0.05, 0.05, 6, bw / 2 - 1, 0, bd + gap / 2 + 2, { seg: 6 }); // flagpole
  kit.box(paint(0x2e6b46, 0.8), 1.3, 0.8, 0.02, bw / 2 - 1.65, 5.1, bd + gap / 2 + 2, { cast: false });
  kit.sign(kit.pick(3, ['LAERSKOOL KOPPIEKRAAL', 'HOËRSKOOL VYFSTER', 'SUNNYSIDE PRIMARY']), '#e8dfc0', 5, 0.9, 0, 1.4, bd + gap / 2 + 3.4, { doubleSide: true, background: '#3a4a3c' });
  if (variant === 1) { // netball hoop on a dust court
    kit.box(M.dirt, 8, 0.05, 4.2, bw * 0.24, 0, bd + gap / 2 + 1.4, { cast: false });
    kit.cyl(M.steel, 0.05, 0.05, 2.6, bw * 0.24, 0, bd + gap / 2 + 1.4, { seg: 6 });
    kit.cyl(M.whiteMetal, 0.24, 0.24, 0.04, bw * 0.24, 2.6, bd + gap / 2 + 1.15, { seg: 10, cast: false });
  }
  return kit.done();
}

/** Taxi rank: long walkable canopy over benches, vendor stall, rank sign. */
export function buildTaxiRank(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 14 + size * 6; const d = 5.5; const canopyH = 3.2;

  kit.box(M.paving, w + 2, 0.1, d + 3, 0, 0, 0, { cast: false });
  for (let column = 0; column < 4; column++) for (const sz of [-1, 1]) {
    kit.box(M.steel, 0.18, canopyH, 0.18, -w / 2 + 0.8 + column * ((w - 1.6) / 3), 0.1, sz * (d / 2 - 0.4));
  }
  kit.box(M.galv, w, 0.16, d, 0, canopyH + 0.1, 0, { collide: true, rx: 0.045 }); // canopy — standable
  for (let bench = 0; bench < 3; bench++) {
    const x = -w / 2 + w * 0.2 + bench * w * 0.3;
    kit.box(M.concrete, 2.6, 0.45, 0.55, x, 0.1, -0.4, { collide: true });
    kit.box(M.concrete, 2.6, 0.6, 0.12, x, 0.55, -0.62, { cast: false });
  }
  kit.sign('TAXI RANK', '#e8c832', 3.2, 0.8, 0, canopyH + 0.85, d / 2 + 0.02, { background: '#26333a' });
  kit.sign(kit.pick(4, ['JOZI - 4 SEATS', 'KAAPSTAD SOON', 'SHORT LEFT R12', 'QUANTUM EXPRESS']), '#d0d8dd', 2.6, 0.55, -w * 0.28, canopyH + 0.75, d / 2 + 0.02);
  if (variant === 1) { // vendor stall at the end
    kit.box(M.corrBlue, 2.2, 2.2, 1.7, w / 2 + 1.6, 0.1, -0.5, { collide: true });
    kit.box(M.galv, 2.7, 0.07, 2.2, w / 2 + 1.6, 2.4, -0.3, { rx: 0.1 });
    kit.box(paint(0xb03a2e, 0.8), 0.5, 0.7, 0.34, w / 2 + 1.5, 0.1, 0.75, { cast: false }); // crate
  }
  return kit.done();
}

/** Lattice cell mast with panel antennas, microwave drums and a fenced cabin. */
export function buildCellTower(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const mastH = 22 + size * 9; const base = 2.6;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    kit.box(M.steel, 0.16, mastH * 1.02, 0.16, sx * base / 2, 0, sz * base / 2, { rx: sz * -base * 0.014, rz: sx * base * 0.014 });
  }
  kit.tier(-base / 2, base / 2, -base / 2, base / 2, 0, mastH * 0.5);
  for (let level = 1; level <= 5; level++) {
    const t = level / 5.5; const half = base * (1 - t * 0.62) / 2;
    kit.box(M.steel, half * 2, 0.08, half * 2, 0, mastH * t * 0.9, 0, { cast: false });
  }
  for (let panel = 0; panel < 3; panel++) { // antenna triangle at the head
    const angle = panel * (Math.PI * 2 / 3);
    kit.box(M.whiteMetal, 0.35, 2.2, 0.12, Math.sin(angle) * 0.85, mastH - 2.4, Math.cos(angle) * 0.85, { ry: angle, cast: false });
  }
  for (let drum = 0; drum < 1 + variant; drum++) {
    kit.cyl(M.whiteMetal, 0.45, 0.45, 0.3, 0.5 - drum, mastH * 0.72, 0.5, { rx: Math.PI / 2, seg: 12, cast: false });
  }
  kit.box(M.concrete, 2.4, 2.3, 1.8, base / 2 + 2.2, 0, 0, { collide: true }); // equipment cabin
  for (const [fx, fz, fw, fd] of [[1.6, -2.6, 7, 0], [1.6, 2.6, 7, 0], [-1.9, 0, 0, 5.2], [5.1, 0, 0, 5.2]] as const) {
    for (const railY of [0.5, 1.3]) kit.box(M.darkMetal, fw ? fw : 0.06, 0.06, fd ? fd : 0.06, fx, railY, fz, { cast: false });
    kit.tier(fx - (fw ? fw / 2 : 0.12), fx + (fw ? fw / 2 : 0.12), fz - (fd ? fd / 2 : 0.12), fz + (fd ? fd / 2 : 0.12), 0, 1.5);
  }
  if (variant === 1) kit.sign('VODACOMB', '#d64541', 1.7, 0.6, base / 2 + 2.2, 2.6, 1, { background: '#e8e8e8' });
  return kit.done();
}

/** Roadside billboard on twin posts with a service catwalk; parody ads included. */
export function buildBillboard(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const panelW = 7 + size * 3; const panelH = panelW * 0.42; const deckY = 4.2 + variant * 0.8;
  const ad = kit.pick(2, [
    { text: 'BRAAI 24/7', accent: '#e8b84a', bg: '#7a2e1e' }, { text: 'DRINK OROSSOMETHING', accent: '#f2f2f2', bg: '#c96a1e' },
    { text: 'CASTLE LAGERISH', accent: '#e8d9a0', bg: '#1e3c28' }, { text: 'VODACOMB - MEER BARS', accent: '#f2f2f2', bg: '#a82e28' },
    { text: 'EAT MORE VETKOEK', accent: '#3a2e1e', bg: '#e8ce8a' }, { text: 'JOZI FM 94.7-ISH', accent: '#e8e8e8', bg: '#4a3080' },
  ]);

  for (const side of [-1, 1]) kit.box(M.steel, 0.4, deckY + 0.4, 0.4, side * panelW * 0.28, 0, 0, { collide: true });
  kit.box(M.darkMetal, panelW * 0.8, 0.12, 0.8, 0, deckY - 0.35, 0.45, { cast: false }); // catwalk
  kit.sign(ad.text, ad.accent, panelW, panelH, 0, deckY + panelH / 2, 0.3, { background: ad.bg });
  kit.box(M.darkMetal, panelW + 0.3, panelH + 0.3, 0.15, 0, deckY - 0.15 + 0.1, 0.1, { cast: false }); // frame behind
  for (let lamp = 0; lamp < 3; lamp++) kit.box(M.whiteMetal, 0.3, 0.12, 0.5, -panelW * 0.3 + lamp * panelW * 0.3, deckY - 0.28, 0.7, { cast: false });
  return kit.done();
}

/** Community hall: gabled civic box with a porch, notice board and gemeenskapsaal sign. */
export function buildCommunityHall(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 12 + size * 4; const d = 9 + size * 3; const h = 3.9;
  const wall = kit.pick(3, [M.tan, M.plaster, M.faceBrick]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(kit.pick(4, [M.galv, M.corrGreen]), w + 0.8, d + 0.7, 1.9, 0, h, 0);
  kit.box(wall, w * 0.3, 3, 2.2, 0, 0, d / 2 + 1.1, { collide: true }); // porch
  kit.gable(M.galv, w * 0.34, 2.6, 0.9, 0, 3, d / 2 + 1.1);
  kit.box(M.darkTimber, 1.7, 2.4, 0.1, 0, 0, d / 2 + 2.16, { cast: false });
  for (const side of [-1, 1]) for (let pane = 0; pane < 2; pane++) {
    kit.box(M.glassDark, 1.3, 1.5, 0.08, side * (w / 2 + 0.01), 1.5, -d * 0.28 + pane * d * 0.36, { ry: Math.PI / 2, cast: false });
  }
  kit.sign(kit.pick(5, ['GEMEENSKAPSAAL', 'COMMUNITY HALL', 'DIENSSENTRUM', 'BINGO VRYDAE 7NM']), '#e8dfc0', w * 0.42, 0.75, w * 0.24, 2.3, d / 2 + 0.06, { background: '#454238' });
  kit.box(M.darkTimber, 1.8, 1.2, 0.12, -w * 0.3, 0.8, d / 2 + 0.7, { cast: false }); // notice board
  if (variant === 1) kit.cyl(M.jojo, 1.05, 1.05, 2.1, -w / 2 - 1.3, 0, -d * 0.2, { seg: 12, collide: true });
  return kit.done();
}

/** Dusty sports ground: rugby posts, three-step bleacher (climbable), floodlights. */
export function buildSportsGround(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const fieldW = 44 + size * 14; const fieldD = 26 + size * 8;

  kit.box(variant === 0 ? M.grassDry : M.dirt, fieldW, 0.06, fieldD, 0, 0, 0, { cast: false });
  for (const end of [-1, 1]) { // rugby posts
    const x = end * (fieldW / 2 - 2);
    for (const sz of [-1, 1]) kit.cyl(M.whiteMetal, 0.07, 0.09, 7, x, 0, sz * 2.4, { seg: 8 });
    kit.box(M.whiteMetal, 0.09, 0.09, 4.8, x, 2.6, 0, { cast: false });
  }
  for (let step = 0; step < 3; step++) { // bleacher bank on the touchline
    kit.box(M.concrete, fieldW * 0.4, 0.45, 0.9, 0, step * 0.45, fieldD / 2 + 1.2 + step * 0.9, { collide: true });
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // corner floodlights
    const x = sx * (fieldW / 2 - 0.8); const z = sz * (fieldD / 2 - 0.8);
    kit.cyl(M.steel, 0.12, 0.18, 9, x, 0, z, { seg: 8, collide: true });
    kit.box(M.whiteMetal, 1.3, 0.9, 0.2, x, 9, z, { cast: false });
  }
  kit.box(M.corrGreen, 3.2, 2.3, 1.9, -fieldW * 0.28, 0, fieldD / 2 + 2.2, { collide: true }); // clubhouse container
  kit.sign(kit.pick(3, ['KOPPIEKRAAL RFC', 'DIE BULLE-TJIES', 'REAL HOUGHTON FC']), '#e8dfc0', 2.8, 0.7, -fieldW * 0.28, 2.5, fieldD / 2 + 3.16, { background: '#2e4432' });
  return kit.done();
}

/** Municipal hilltop water reservoir: broad concrete drum, domed cap, ladder. Pure Joburg skyline. */
export function buildReservoir(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const radius = 5.5 + size * 2.5; const h = 5 + size * 2;

  kit.cyl(M.concrete, radius, radius + 0.3, h, 0, 0, 0, { seg: 22, collide: true }); // drum — standable rim
  kit.cyl(M.concrete, 0.4, radius * 1.01, h * 0.22, 0, h, 0, { seg: 22 }); // shallow cap
  for (let rib = 0; rib < 4; rib++) {
    const angle = rib * (Math.PI / 2) + 0.4;
    kit.box(M.paving, 0.35, h, 0.35, Math.sin(angle) * radius, 0, Math.cos(angle) * radius, { cast: false });
  }
  for (let rail = 0; rail < 2; rail++) kit.box(M.darkMetal, 0.07, h + 1, 0.07, radius - 0.1 + rail * 0.45, 0, radius * 0.15); // ladder rails
  kit.cyl(M.steel, 0.14, 0.14, 2.2, 0, h + h * 0.22, 0, { seg: 8 }); // vent
  if (variant === 1) kit.sign('JOBURG WATER', '#7fc4c9', radius * 0.9, 0.8, 0, h * 0.62, radius + 0.12, { background: '#243438' });
  return kit.done();
}
