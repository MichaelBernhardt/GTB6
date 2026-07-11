/**
 * Industrial structures: warehouses, a sawtooth factory, tank farms, container stacks, a
 * scrapyard and a substation. Heavy on shared corrugated/steel materials so whole estates
 * merge into a few draw calls; container and tank tops are standable tiers.
 */
import { Kit, M, corrugated, paint, type BuildOptions, type BuiltModel } from './kit';

const CONTAINER_SKINS = [corrugated(0xa85a28), corrugated(0x35566b), corrugated(0x49664f), corrugated(0x8e4036), corrugated(0x8f8f8f)] as const;

/** Corrugated warehouse: shallow gable, roller doors, office lean-to with windows. */
export function buildWarehouse(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = 15 + size * 8; const d = 12 + size * 6; const h = 5.5 + size * 2;
  const skin = kit.pick(3, [M.galv, M.corrBlue, M.corrGreen, M.corrRust]);

  kit.box(skin, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(M.galv, w + 0.6, d + 0.5, w * 0.14, 0, h, 0);
  const doors = 1 + (variant % 2);
  for (let door = 0; door < doors; door++) {
    const x = (door - (doors - 1) / 2) * w * 0.4;
    kit.box(M.darkMetal, 4, 4, 0.12, x, 0, d / 2 + 0.07, { cast: false });
    kit.box(M.steel, 4.4, 0.3, 0.2, x, 4.05, d / 2 + 0.12, { cast: false });
  }
  if (variant >= 1) { // brick office annexe on the flank
    kit.box(M.faceBrick, w * 0.3, 3, 4, -w / 2 + w * 0.15, 0, d / 2 + 2, { collide: true });
    kit.box(M.glassDark, w * 0.22, 1.2, 0.1, -w / 2 + w * 0.15, 1.1, d / 2 + 4.05, { cast: false });
  }
  for (const side of [-1, 1]) kit.cyl(M.steel, 0.09, 0.09, h, side * (w / 2 - 0.4), 0, d / 2 + 0.12, { seg: 6 }); // downpipes
  kit.sign(kit.pick(4, ['TRANSVAAL TRANSPORT', 'BRAKPAN BEARINGS', 'VAALIE VATS', 'EISH LOGISTICS']), '#c8d6dd', w * 0.42, 0.8, 0, h - 0.9, d / 2 + 0.08);
  return kit.done();
}

/** Sawtooth-roof factory with brick stacks: the classic East Rand skyline block. */
export function buildFactory(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 20 + size * 8; const d = 13 + size * 4; const h = 5.5 + size;
  const wall = kit.pick(3, [M.redBrick, M.faceBrick, M.concrete]);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true }); // standable eaves plane
  const teeth = 3 + Math.floor(size * 2); const toothD = d / teeth;
  for (let tooth = 0; tooth < teeth; tooth++) { // slanted slab + steep glass face per tooth
    const z = -d / 2 + toothD * (tooth + 0.5);
    kit.box(M.galv, w + 0.5, 0.12, toothD * 1.06, 0, h + toothD * 0.19, z + toothD * 0.03, { rx: 0.36 });
    kit.box(M.glass, w * 0.94, toothD * 0.34, 0.1, 0, h, z - toothD * 0.44, { cast: false });
  }
  const stacks = 1 + variant;
  for (let stack = 0; stack < stacks; stack++) {
    kit.cyl(M.redBrick, 0.6, 0.85, h + 6 + stack, -w / 2 + 2 + stack * 2.4, 0, -d / 2 + 1.6, { seg: 12, collide: true });
  }
  kit.box(M.darkMetal, 3.6, 3.6, 0.12, w * 0.2, 0, d / 2 + 0.07, { cast: false }); // goods door
  kit.box(M.steel, w * 0.3, 1.2, 1, -w * 0.24, h - 1.4, d / 2 + 0.5, { cast: false }); // extraction duct
  kit.sign(kit.pick(4, ['GERMISTON GASKETS', 'VULKANISEER WERKE', 'BOKSBURG BOILERS', 'STAAL & SEUNS']), '#e0c48a', w * 0.4, 0.8, 0, h - 0.8, d / 2 + 0.08);
  return kit.done();
}

/** Storage-tank cluster inside a bund wall: flat-topped standable tanks, pipe runs, stair. */
export function buildTankFarm(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const tanks = 2 + variant; const radius = 2.6 + size * 1.2; const h = 5.5 + size * 2.5;
  const pitch = radius * 2 + 1.6; const w = tanks <= 2 ? tanks * pitch : 2 * pitch; const d = tanks <= 2 ? pitch : 2 * pitch;
  const skins = [paint(0xd8d5c8, 0.5, 0.35), M.corrRust, M.steel] as const;

  for (let tank = 0; tank < tanks; tank++) {
    const x = -w / 2 + pitch * ((tank % 2) + 0.5); const z = -d / 2 + pitch * (Math.floor(tank / 2) + 0.5);
    const skin = kit.pick(10 + tank, skins);
    kit.cyl(skin, radius, radius, h, x, 0, z, { seg: 18, collide: true }); // flat top — standable
    kit.cyl(skin, radius * 0.2, radius * 1.02, 0.35, x, h, z, { seg: 18 });
    kit.box(M.darkMetal, radius * 1.7, 0.5, 0.06, x, h - 0.25, z + radius, { cast: false }); // top rail hint
    kit.cyl(M.steel, 0.11, 0.11, radius * 1.4, x + radius * 0.7, 0.35, z + radius * 0.7, { rz: Math.PI / 2, seg: 8 }); // outlet pipe
  }
  const bundW = w + 2.4; const bundD = d + 2.4;
  for (const [bx, bz, bw, bd] of [[0, -bundD / 2, bundW, 0.35], [0, bundD / 2, bundW, 0.35], [-bundW / 2, 0, 0.35, bundD], [bundW / 2, 0, 0.35, bundD]] as const) {
    kit.box(M.concrete, bw || 0.35, 0.9, bd || 0.35, bx, 0, bz, { collide: true });
  }
  const stairRun = 3.2; // access stair stringer: foot on the ground, head at the first tank's rim
  kit.box(M.darkMetal, 1, 0.1, Math.hypot(h, stairRun), -w / 2 + pitch * 0.5 - radius - 0.6, h / 2, -d / 2 + pitch * 0.5, { rx: -Math.atan2(h, stairRun) });
  kit.box(M.steel, 0.14, 0.14, w * 0.8, 0, 0.6, 0, { ry: Math.PI / 4, cast: false }); // manifold run
  return kit.done();
}

/** Shipping-container stack: seeded colours, quarter-turn rotations, climbable tops. */
export function buildContainerStack(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const cols = 2 + (variant % 2); const rows = 1 + Math.floor(size * 1.9);
  const cw = 2.6; const ch = 2.44; const cl = 6.1;

  let index = 0;
  for (let col = 0; col < cols; col++) {
    const stackH = 1 + kit.int(30 + col, 0, rows);
    for (let level = 0; level < stackH; level++) {
      const turned = kit.rnd(40 + index) > 0.82 && level === 0;
      const x = -((cols - 1) * (cw + 0.4)) / 2 + col * (cw + 0.4) + (turned ? 1 : 0);
      const zJitter = (kit.rnd(50 + index) - 0.5) * 0.5;
      kit.box(kit.pick(60 + index, CONTAINER_SKINS), turned ? cl : cw, ch, turned ? cw : cl, x, level * ch, zJitter, { collide: true });
      index++;
    }
  }
  // Door-end dressing on the street face of the front column.
  kit.box(M.darkMetal, cw - 0.3, ch - 0.3, 0.06, -((cols - 1) * (cw + 0.4)) / 2, 0.15, cl / 2 + 0.04, { cast: false });
  for (const rod of [-0.5, 0.5]) kit.box(M.steel, 0.06, ch - 0.4, 0.06, -((cols - 1) * (cw + 0.4)) / 2 + rod, 0.2, cl / 2 + 0.1, { cast: false });
  return kit.done();
}

/** Scrapyard: corrugated fence, junk mounds, tyre stacks, a dead bakkie and an office container. */
export function buildScrapyard(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 16 + size * 6; const d = 13 + size * 5; const fenceH = 2.5;

  kit.box(M.dirt, w - 0.4, 0.08, d - 0.4, 0, 0, 0, { cast: false });
  const gateHalf = 2.2; const frontRun = (w - gateHalf * 2) / 2;
  kit.box(M.corrRust, w, fenceH, 0.14, 0, 0, -d / 2, { collide: true });
  for (const side of [-1, 1]) {
    kit.box(M.corrRust, 0.14, fenceH, d, side * w / 2, 0, 0, { collide: true });
    kit.box(M.galv, frontRun, fenceH, 0.14, side * (gateHalf + frontRun / 2), 0, d / 2, { collide: true });
  }
  kit.box(M.darkMetal, gateHalf * 2, fenceH - 0.3, 0.1, 0, 0, d / 2, { cast: false }); // gate (visual only — drivable-through when open later)
  kit.sign('SKROOT & SPARES', '#e0a63c', 4.4, 0.9, gateHalf + 1.4, fenceH + 0.5, d / 2 + 0.05);
  for (let mound = 0; mound < 2 + variant; mound++) { // junk mounds: three tumbled boxes each
    const mx = kit.range(70 + mound, -w * 0.3, w * 0.3); const mz = kit.range(80 + mound, -d * 0.32, -d * 0.05);
    const mw = kit.range(90 + mound, 2.2, 3.6);
    kit.box(M.corrRust, mw, 1.2, mw * 0.8, mx, 0, mz, { ry: kit.rnd(100 + mound) * 0.8 });
    kit.box(M.steel, mw * 0.7, 0.9, mw * 0.6, mx + 0.6, 1, mz - 0.3, { ry: kit.rnd(110 + mound) * 0.8 });
    kit.box(M.darkMetal, mw * 0.5, 0.7, mw * 0.5, mx - 0.5, 1.7, mz + 0.2, { ry: kit.rnd(120 + mound) * 0.8 });
    kit.tier(mx - mw * 0.7, mx + mw * 0.7, mz - mw * 0.6, mz + mw * 0.6, 0, 2);
  }
  for (let stack = 0; stack < 3; stack++) kit.cyl(M.tar, 0.5, 0.5, 0.9 + (stack % 2) * 0.3, w * 0.32, 0.08, d * 0.12 + stack * 1.2, { seg: 10 });
  kit.box(M.corrRust, 3.4, 1.3, 1.6, -w * 0.28, 0.08, d * 0.2, { collide: true }); // dead bakkie shell
  kit.box(M.corrRust, 1.7, 0.8, 1.5, -w * 0.28 - 0.5, 1.38, d * 0.2, { cast: false });
  kit.box(kit.pick(6, CONTAINER_SKINS), 6.1, 2.44, 2.6, w * 0.24, 0.08, -d * 0.34, { collide: true }); // office container
  return kit.done();
}

/** Electrical substation: palisade yard, transformers with bushings, gantry and danger sign. */
export function buildSubstation(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 11 + size * 4; const d = 9 + size * 3;

  kit.box(M.paving, w, 0.12, d, 0, 0, 0, { cast: false });
  for (const [fx, fz, fw, fd] of [[0, -d / 2, w, 0], [0, d / 2, w, 0], [-w / 2, 0, 0, d], [w / 2, 0, 0, d]] as const) {
    for (const railY of [0.5, 1.2, 1.9]) kit.box(M.darkMetal, fw ? fw : 0.07, 0.07, fd ? fd : 0.07, fx, railY, fz, { cast: false });
    kit.tier(fx - (fw ? fw / 2 : 0.15), fx + (fw ? fw / 2 : 0.15), fz - (fd ? fd / 2 : 0.15), fz + (fd ? fd / 2 : 0.15), 0, 2.1);
  }
  const postsX = Math.round(w / 2.2);
  for (let post = 0; post <= postsX; post++) for (const sz of [-1, 1]) kit.box(M.steel, 0.1, 2.1, 0.1, -w / 2 + post * (w / postsX), 0, sz * d / 2);
  const units = 1 + variant;
  for (let unit = 0; unit < units; unit++) {
    const x = (unit - (units - 1) / 2) * 4.2;
    kit.box(M.steel, 2.6, 2.2, 1.8, x, 0.12, -d * 0.12, { collide: true });
    for (let bushing = 0; bushing < 3; bushing++) kit.cyl(M.whiteMetal, 0.09, 0.13, 0.9, x - 0.8 + bushing * 0.8, 2.32, -d * 0.12, { seg: 8 });
    for (const fin of [-1, 1]) kit.box(M.darkMetal, 0.2, 1.6, 1.4, x + fin * 1.5, 0.4, -d * 0.12, { cast: false });
  }
  for (const side of [-1, 1]) kit.box(M.steel, 0.16, 4.6, 0.16, side * w * 0.3, 0.12, d * 0.24); // gantry
  kit.box(M.steel, w * 0.6 + 0.4, 0.16, 0.16, 0, 4.55, d * 0.24, { cast: false });
  for (let string = 0; string < 3; string++) kit.cyl(M.whiteMetal, 0.07, 0.11, 0.7, -w * 0.18 + string * w * 0.18, 3.8, d * 0.24, { seg: 8 });
  kit.sign('GEVAAR - DANGER', '#e8c832', 2.6, 0.8, 0, 1.55, d / 2 + 0.08, { background: '#28303a' });
  return kit.done();
}
