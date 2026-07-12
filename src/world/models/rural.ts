/**
 * Rural / platteland structures: the working-farm silhouette set. Long low corrugated roofs,
 * whitewashed walls, steel water infrastructure — the windpomp and water tower are deliberate
 * landmarks that read from a distance across open veld.
 */
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';

const WALLS = [M.whitewash, M.plaster, M.cream] as const;
const ROOFS = [M.galv, M.corrRed, M.corrGreen, M.corrRust] as const;

/** Windows as a white frame + dark glass inset, proud of the +z face. */
function frontWindows(kit: Kit, count: number, wallW: number, z: number, sillY = 1): void {
  for (let index = 0; index < count; index++) {
    const x = (index - (count - 1) / 2) * (wallW / count);
    kit.box(M.whiteMetal, 1.5, 1.3, 0.1, x, sillY, z, { cast: false });
    kit.box(M.glassDark, 1.2, 1, 0.16, x, sillY + 0.15, z, { cast: false });
  }
}

/** SA plaashuis: long low house, corrugated gable, shaded stoep on timber posts, chimney. */
export function buildFarmhouse(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = kit.range(3, 12.5, 16.5) + size * 2; const d = 6.8 + size * 1.4; const h = 3.1;
  const wall = kit.pick(4, WALLS); const roof = kit.pick(5, ROOFS);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(roof, w + 0.9, d + 0.8, 2.1, 0, h, 0);
  kit.box(M.redBrick, 0.8, 2.2, 0.8, -w * 0.28, h + 0.6, -d * 0.2);
  // Stoep: slab, posts and a shallow lean-to roof across the front.
  const stoepW = variant === 2 ? w : w * 0.72; const stoepD = 2.4;
  kit.box(M.paving, stoepW, 0.24, stoepD, 0, 0, d / 2 + stoepD / 2, { cast: false });
  for (let post = 0; post <= 3; post++) kit.box(M.timber, 0.14, 2.5, 0.14, -stoepW / 2 + 0.3 + post * ((stoepW - 0.6) / 3), 0.24, d / 2 + stoepD - 0.25);
  kit.box(roof, stoepW + 0.5, 0.09, stoepD + 0.7, 0, 2.86, d / 2 + stoepD / 2 - 0.1, { rx: 0.16 });
  frontWindows(kit, 3, w * 0.8, d / 2 + 0.03);
  kit.box(M.darkTimber, 1.1, 2.1, 0.1, w * 0.06, 0.24, d / 2 + 0.06, { cast: false });
  if (variant === 1) { // L-wing gable jutting toward the street
    const wingW = 4.6; const wingD = 5;
    kit.box(wall, wingW, h, wingD, -w / 2 + wingW / 2, 0, d / 2 + wingD / 2 - 1.2, { collide: true });
    kit.gable(roof, wingD + 0.8, wingW + 0.8, 1.9, -w / 2 + wingW / 2, h, d / 2 + wingD / 2 - 1.2, { ry: Math.PI / 2 });
  }
  if (variant === 2) kit.cyl(M.jojo, 1.05, 1.05, 2.1, w / 2 + 1.35, 0, -d * 0.2, { collide: true, seg: 12 });
  return kit.done();
}

/** Big corrugated barn: tall gable, sliding door on a rail, optional lean-to. */
export function buildBarn(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = 10 + size * 3.5; const d = 14 + size * 5; const h = 4.6 + size;
  const skin = kit.pick(3, [M.galv, M.corrRust, M.corrRed]);

  kit.box(skin, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(kit.pick(4, [M.galv, M.corrCharcoal]), w + 0.7, d + 0.6, w * 0.34, 0, h, 0);
  // Sliding door proud of the gable end, hanging off a rail beam.
  kit.box(M.darkTimber, w * 0.42, h * 0.78, 0.14, -w * 0.08, 0, d / 2 + 0.14, { cast: false });
  kit.box(M.darkMetal, w * 0.9, 0.16, 0.2, 0, h * 0.82, d / 2 + 0.18, { cast: false });
  kit.box(M.glassDark, 1.2, 1.1, 0.1, w * 0.3, h * 0.55, d / 2 + 0.06, { cast: false }); // hay-loft window
  if (variant === 1) { // open lean-to along one flank
    kit.box(skin, 3.4, 0.1, d * 0.7, w / 2 + 1.7, h * 0.62, 0, { rz: 0.22 });
    for (const zed of [-d * 0.3, d * 0.3]) kit.box(M.timber, 0.16, h * 0.5, 0.16, w / 2 + 3.1, 0, zed);
  }
  if (variant === 2) for (const side of [-1, 1]) kit.cyl(M.steel, 0.35, 0.35, 2.6, side * w * 0.28, 0, -d / 2 - 1.1, { seg: 10 }); // feed hoppers behind
  return kit.done();
}

/** Elevated farm water tower: braced steel legs, walkable platform, riveted tank. A landmark. */
export function buildWaterTower(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const legH = 8.5 + size * 4; const span = 3.4;
  const legMat = variant === 0 ? M.steel : M.timber;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) kit.box(legMat, 0.24, legH, 0.24, sx * span / 2, 0, sz * span / 2);
  for (const level of [0.3, 0.62]) { // X-braces on two faces per level (cheap: front/back only)
    for (const sz of [-1, 1]) for (const lean of [-1, 1]) {
      kit.box(legMat, 0.1, span * 1.25, 0.1, 0, legH * level - span * 0.5, sz * span / 2, { rz: lean * 0.72 });
    }
  }
  kit.box(M.darkMetal, span + 1.2, 0.22, span + 1.2, 0, legH, 0, { collide: true }); // platform — standable
  kit.cyl(M.galv, 1.85, 1.85, 2.9, 0, legH + 0.22, 0, { seg: 18, collide: true });
  kit.cyl(M.darkMetal, 0.25, 1.9, 0.9, 0, legH + 3.12, 0, { seg: 18 });
  kit.cyl(M.steel, 0.09, 0.09, legH, span / 2 - 0.2, 0, span / 2 + 0.35, { seg: 6 }); // riser pipe
  for (let rung = 0; rung < 2; rung++) kit.box(M.darkMetal, 0.08, legH, 0.08, -span / 2 + 0.3 + rung * 0.5, 0, span / 2 + 0.3); // ladder rails
  return kit.done();
}

/** Grain silo battery: one to three galvanised bins with cone caps and a top catwalk. */
export function buildSilo(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const count = variant + 1; const radius = 2 + size * 0.7; const h = 8 + size * 3.5;
  for (let bin = 0; bin < count; bin++) {
    const x = (bin - (count - 1) / 2) * (radius * 2 + 0.7);
    kit.cyl(M.galv, radius, radius, h, x, 0, 0, { seg: 16, collide: true });
    kit.cyl(M.steel, 0.18, radius + 0.08, radius * 0.8, x, h, 0, { seg: 16 });
  }
  if (count > 1) { // catwalk connecting the caps
    kit.box(M.darkMetal, (count - 1) * (radius * 2 + 0.7) + 1, 0.14, 1, 0, h + radius * 0.8, 0, { collide: true });
    kit.box(M.darkMetal, (count - 1) * (radius * 2 + 0.7) + 1, 0.08, 0.08, 0, h + radius * 0.8 + 0.9, 0.5, { cast: false });
  }
  kit.cyl(M.steel, 0.16, 0.16, h * 1.15, count * radius + 0.6, 0, 0.8, { rz: -0.38, seg: 8 }); // loading auger
  for (let rung = 0; rung < 2; rung++) kit.box(M.darkMetal, 0.07, h, 0.07, -(count - 1) / 2 * (radius * 2 + 0.7) - radius - 0.15 + rung * 0.4, 0, 0.2);
  return kit.done();
}

/** Windpomp: the iconic multi-blade windmill pump over a round concrete stock dam. */
export function buildWindpomp(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const mastH = 7.5 + size * 3; const base = 1.9;

  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // legs lean in toward the head
    kit.box(M.steel, 0.12, mastH * 1.04, 0.12, sx * base / 2, 0, sz * base / 2, { rx: sz * -base * 0.045, rz: sx * base * 0.045 });
  }
  kit.tier(-base / 2, base / 2, -base / 2, base / 2, 0, mastH * 0.6); // one tapering mast collider
  for (const level of [0.35, 0.68]) kit.box(M.steel, base * (1 - level * 0.6), 0.08, base * (1 - level * 0.6), 0, mastH * level, 0, { cast: false });
  kit.box(M.darkMetal, 0.5, 0.5, 0.9, 0, mastH, 0); // gearbox head
  const hubZ = 0.62;
  kit.cyl(M.darkMetal, 0.16, 0.16, 0.24, 0, mastH + 0.13, hubZ, { rx: Math.PI / 2, seg: 10 });
  for (let blade = 0; blade < 9; blade++) { // sails fanned in the XY plane, facing the street
    const angle = (blade / 9) * Math.PI * 2;
    const mesh = kit.box(M.galv, 0.5, 1.35, 0.05, Math.sin(angle) * 0.95, mastH - 0.42 + Math.cos(angle) * 0.95, hubZ, { cast: false });
    mesh.rotation.z = -angle;
  }
  kit.box(M.galv, 1.4, 0.75, 0.06, 0, mastH - 0.15, -1.15, { ry: Math.PI / 2, cast: false }); // tail vane
  kit.cyl(M.steel, 0.06, 0.06, mastH, 0, 0, 0, { seg: 6 }); // pump rod
  // Round stock dam beside the mast.
  const damR = 2.6 + size; const damX = base / 2 + damR + (variant ? 1.4 : 0.6);
  kit.cyl(M.concrete, damR, damR, 1, damX, 0, 0.4, { seg: 18, collide: true });
  kit.cyl(M.pool, damR - 0.3, damR - 0.3, 0.12, damX, 0.92, 0.4, { seg: 18, cast: false });
  if (variant === 1) kit.cyl(M.jojo, 1.05, 1.05, 2.1, damX + damR + 1.3, 0, -0.6, { seg: 12, collide: true });
  return kit.done();
}

/** Open-front tractor shed: three corrugated walls, pole-held skillion roof, drums inside. */
export function buildTractorShed(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 9.5 + size * 3.5; const d = 7 + size * 1.5; const hBack = 3; const hFront = 3.9;
  const skin = kit.pick(3, [M.galv, M.corrRust]);

  kit.box(M.paving, w, 0.14, d, 0, 0, 0, { cast: false });
  kit.box(skin, w, hBack, 0.16, 0, 0, -d / 2 + 0.08, { collide: true });
  for (const side of [-1, 1]) kit.box(skin, 0.16, hBack, d - 0.3, side * (w / 2 - 0.08), 0, -0.15, { collide: true });
  for (let post = 0; post <= 2; post++) kit.box(M.timber, 0.18, hFront, 0.18, -w / 2 + 0.4 + post * ((w - 0.8) / 2), 0, d / 2 - 0.25);
  kit.box(skin, w + 0.7, 0.1, d + 0.9, 0, (hFront + hBack) / 2 - 0.05, 0.15, { rx: (hFront - hBack) / d }); // skillion resting back wall → front posts
  for (let drum = 0; drum < 2 + variant; drum++) kit.cyl(paint(0x35566b, 0.6, 0.3), 0.32, 0.32, 0.95, -w / 2 + 1 + drum * 0.75, 0.14, -d / 2 + 1, { seg: 10 });
  if (variant === 1) kit.box(M.corrRust, 2.6, 1.5, 1.4, w * 0.24, 0.14, -d * 0.12, { collide: true }); // dead bakkie under a tarp shape
  return kit.done();
}

/** Stock kraal: post-and-rail pen with a gate gap; variant adds a second smaller pen. */
export function buildKraal(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 1)) % 2;
  const size = options.size ?? kit.rnd(2);
  const w = 10 + size * 5; const d = 8 + size * 4; const railH = 1.3;

  const pen = (cx: number, cz: number, pw: number, pd: number, gate: boolean): void => {
    for (const [dx, dz, len, vertical] of [[0, -pd / 2, pw, 0], [-pw / 2, 0, pd, 1], [pw / 2, 0, pd, 1]] as const) {
      for (const y of [0.55, 1.15]) kit.box(M.darkTimber, vertical ? 0.09 : len, 0.09, vertical ? len : 0.09, cx + dx, y, cz + dz, { cast: false });
      kit.tier(cx + dx - (vertical ? 0.1 : len / 2), cx + dx + (vertical ? 0.1 : len / 2), cz + dz - (vertical ? len / 2 : 0.1), cz + dz + (vertical ? len / 2 : 0.1), 0, railH);
    }
    const gapHalf = gate ? 1.4 : 0; const run = (pw - gapHalf * 2) / 2;
    for (const side of [-1, 1]) {
      for (const y of [0.55, 1.15]) kit.box(M.darkTimber, run, 0.09, 0.09, cx + side * (gapHalf + run / 2), y, cz + pd / 2, { cast: false });
      kit.tier(cx + side * gapHalf + (side > 0 ? 0 : -run), cx + side * gapHalf + (side > 0 ? run : 0), cz + pd / 2 - 0.1, cz + pd / 2 + 0.1, 0, railH);
    }
    const postsPerSide = Math.max(3, Math.round(pw / 2.4));
    for (let post = 0; post < postsPerSide; post++) {
      const x = cx - pw / 2 + post * (pw / (postsPerSide - 1));
      for (const sz of [-1, 1]) kit.box(M.timber, 0.14, railH + 0.15, 0.14, x, 0, cz + sz * pd / 2);
    }
    for (const sx of [-1, 1]) for (let post = 1; post < 3; post++) kit.box(M.timber, 0.14, railH + 0.15, 0.14, cx + sx * pw / 2, 0, cz - pd / 2 + post * (pd / 3));
  };
  pen(0, 0, w, d, true);
  if (variant === 1) pen(w / 2 + 3.2, d * 0.08, 5.5, d * 0.7, true);
  kit.box(M.dirt, w - 0.5, 0.06, d - 0.5, 0, 0, 0, { cast: false });
  return kit.done();
}

/** Padstal (farm stall): tiny roadside shop, veranda, hand-painted sign, produce crates. */
export function buildPadstal(seed: number, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const size = options.size ?? kit.rnd(2);
  const w = 6 + size * 2; const d = 4.8 + size; const h = 2.8;
  const wall = kit.pick(3, WALLS); const roof = kit.pick(4, ROOFS);

  kit.box(wall, w, h, d, 0, 0, 0, { collide: true });
  kit.gable(roof, w + 0.7, d + 0.6, 1.4, 0, h, 0);
  kit.box(M.paving, w * 0.9, 0.2, 2, 0, 0, d / 2 + 1, { cast: false });
  for (const side of [-1, 1]) kit.box(M.timber, 0.13, 2.4, 0.13, side * w * 0.36, 0.2, d / 2 + 1.7);
  kit.box(roof, w * 0.95, 0.08, 2.5, 0, 2.72, d / 2 + 1.05, { rx: 0.14 });
  kit.sign(kit.pick(5, ['PADSTAL', 'PLAASWINKEL', 'DROËWORS 100M', 'MOER KOFFIE']), '#e8d9a0', w * 0.8, 0.7, 0, h + 0.9, d / 2 + 0.36, { background: '#4a3a20' });
  kit.box(M.glassDark, w * 0.4, 1, 0.1, -w * 0.18, 0.9, d / 2 + 0.04, { cast: false }); // serving hatch
  for (let crate = 0; crate < 2 + variant; crate++) kit.box(M.timber, 0.55, 0.4, 0.55, w / 2 - 0.6 - crate * 0.7, 0.2, d / 2 + 1.4, { cast: false });
  if (variant === 2) kit.cyl(M.jojo, 0.85, 0.85, 1.8, -w / 2 - 1.05, 0, -d * 0.2, { seg: 12, collide: true });
  return kit.done();
}
