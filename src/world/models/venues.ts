/**
 * Seafront venue family: small procedural restaurants, bars and cafes for the beachfront strips —
 * striped awnings, signage boards, terrace decks with tables/chairs/umbrellas and warm string
 * lights. The layout (footprint, dressing picks, non-overlapping table arrangement) is the PURE
 * venuePlan in beachfront.ts so vitest asserts it headlessly; this file only turns a plan into kit
 * geometry. Registered in the catalog, so the crafted strips place them explicitly and ModelScatter
 * reuses the same models on any beach frontage (Sea Point) — and anywhere else a zone wants them.
 */
import * as THREE from 'three';
import { Kit, M, paint, type BuildOptions, type BuiltModel } from './kit';
import { venuePlan, type VenueKind } from '../beachfront';
import { cafeTable, umbrella } from './coastal';

/** Awning stripe pairs (canvas colour / off-white), indexed by the plan's awningIndex. */
const AWNINGS = [
  [paint(0xc24a38, 0.8), paint(0xf0e8d8, 0.8)],
  [paint(0x2f6f78, 0.8), paint(0xf2f2ea, 0.8)],
  [paint(0x32476e, 0.8), paint(0xeadfc8, 0.8)],
  [paint(0x5c7a4a, 0.8), paint(0xf0e8d8, 0.8)],
] as const;
const ACCENTS = ['#f2e2b8', '#8fd8d4', '#f0b8c8', '#d8e8a0'] as const;
const WALLS = [paint(0xf2efe6, 0.88), paint(0xe8e2d2, 0.9), paint(0xdde8e4, 0.88), paint(0xe8ddc8, 0.88)] as const;
/** Warm festoon bulbs — emissive so the strips glow after the sun drops behind the sea. */
const bulbGlow = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffb45e, emissiveIntensity: 1.8, roughness: 0.4 });

/** One seafront venue (front faces +z — point it at the sea). Reusable anywhere via the catalog. */
export function buildVenue(seed: number, kind: VenueKind, options: BuildOptions = {}): BuiltModel {
  const kit = new Kit(seed);
  const variant = (options.variant ?? kit.int(1, 0, 2)) % 3;
  const plan = venuePlan(seed, kind);
  const { hallW, hallD, hallH, terraceW, terraceD, deckH } = plan;
  const hallZ = -hallD / 2; // hall behind the origin, terrace deck in front
  const wall = WALLS[(plan.accentIndex + variant) % WALLS.length]!;
  const [stripeA, stripeB] = AWNINGS[plan.awningIndex % AWNINGS.length]!;

  kit.box(wall, hallW, hallH, hallD, 0, 0, hallZ, { collide: true });
  if (variant === 1) kit.gable(M.tileTerracotta, hallW + 0.7, hallD + 0.6, 1.3, 0, hallH, hallZ);
  else if (variant === 2) kit.box(M.corrCharcoal, hallW + 0.7, 0.1, hallD + 0.8, 0, hallH + 0.14, hallZ - 0.1, { rx: 0.08 });
  else kit.box(wall, hallW + 0.3, 0.35, hallD + 0.3, 0, hallH, hallZ, { cast: false }); // parapet
  kit.box(M.glass, hallW * 0.6, hallH * 0.52, 0.1, -hallW * 0.12, 0.75, -0.04, { cast: false }); // glazed front
  kit.box(M.darkTimber, 1, 2.1, 0.1, hallW * 0.33, 0, -0.03, { cast: false }); // door
  const drop = 1.7; const stripeW = (hallW + 0.6) / plan.stripes;
  for (let s = 0; s < plan.stripes; s++) { // striped canvas awning sloping over the terrace edge
    kit.box(s % 2 ? stripeB! : stripeA!, stripeW, 0.06, drop, -(hallW + 0.6) / 2 + (s + 0.5) * stripeW, hallH * 0.78, drop / 2 - 0.15, { rx: 0.38, cast: false });
  }
  for (const sx of [-1, 1]) kit.cyl(M.darkMetal, 0.04, 0.04, hallH * 0.72, sx * (hallW / 2 - 0.2), deckH, drop * 0.82, { seg: 6, cast: false });
  kit.sign(plan.signText, ACCENTS[plan.accentIndex % ACCENTS.length]!, hallW * 0.82, 0.62, 0, hallH * 0.82 + 0.62, 0.08, { background: '#31404a' });

  kit.box(M.bleached, terraceW, deckH, terraceD, 0, 0, terraceD / 2, { collide: true }); // terrace deck (step-up height)
  for (const sx of [-1, 1]) kit.box(M.bleached, 0.08, 0.5, terraceD, sx * (terraceW / 2 - 0.06), deckH, terraceD / 2, { cast: false });
  plan.tables.forEach((table, i) => {
    cafeTable(kit, table.x, table.z, deckH);
    for (const a of table.chairs) {
      const cx = table.x + Math.sin(a) * 0.78; const cz = table.z + Math.cos(a) * 0.78;
      kit.box(M.darkTimber, 0.42, 0.45, 0.42, cx, deckH, cz, { ry: a, cast: false });
      kit.box(M.darkTimber, 0.42, 0.52, 0.06, cx + Math.sin(a) * 0.19, deckH + 0.45, cz + Math.cos(a) * 0.19, { ry: a, cast: false });
    }
    if (table.umbrella) umbrella(kit, 60 + i, table.x, table.z, 0.92);
  });

  const frontZ = terraceD - 0.35; // string-light posts along the terrace front, bulb catenaries between
  const postXs = Array.from({ length: plan.lightPosts }, (_, p) => -terraceW / 2 + 0.35 + (p * (terraceW - 0.7)) / (plan.lightPosts - 1));
  for (const px of postXs) kit.cyl(M.darkMetal, 0.045, 0.055, 2.7, px, deckH, frontZ, { seg: 6, cast: false });
  for (let p = 0; p + 1 < postXs.length; p++) {
    for (let b = 0; b < 6; b++) {
      const t = (b + 0.5) / 6; const sag = 0.5 * (1 - (2 * t - 1) ** 2);
      kit.box(bulbGlow, 0.09, 0.13, 0.09, postXs[p]! + (postXs[p + 1]! - postXs[p]!) * t, deckH + 2.62 - sag, frontZ, { cast: false });
    }
  }

  if (kind === 'bar') { // barrels + chalkboard
    kit.cyl(M.timber, 0.34, 0.38, 0.85, terraceW / 2 - 0.75, deckH, 0.8, { seg: 10 });
    kit.cyl(M.timber, 0.34, 0.38, 0.85, terraceW / 2 - 1.5, deckH, 1.4, { seg: 10 });
    kit.box(M.tar, 0.72, 1.05, 0.08, -terraceW / 2 + 0.85, deckH, 0.4, { rz: 0.05, cast: false });
  } else if (kind === 'cafe') { // A-board menu
    kit.box(M.tar, 0.62, 0.85, 0.06, terraceW / 2 - 0.7, deckH, frontZ - 0.62, { ry: 0.3, rx: 0.16, cast: false });
    kit.box(M.tar, 0.62, 0.85, 0.06, terraceW / 2 - 0.7, deckH, frontZ - 0.84, { ry: 0.3, rx: -0.16, cast: false });
  } else { // planters flanking the sea-side step
    for (const sx of [-1, 1]) {
      kit.box(M.concrete, 0.9, 0.5, 0.9, sx * (terraceW / 2 - 0.7), deckH, frontZ - 0.25, { cast: false });
      kit.box(paint(0x4a6b3f, 0.95), 0.72, 0.42, 0.72, sx * (terraceW / 2 - 0.7), deckH + 0.5, frontZ - 0.25, { cast: false });
    }
  }
  kit.box(M.bleached, 1.7, 0.14, 1.1, 0, 0.05, terraceD + 0.5, { rx: -0.1, cast: false }); // step down to the sand
  return kit.done();
}

export const buildSeafrontRestaurant = (seed: number, options?: BuildOptions): BuiltModel => buildVenue(seed, 'restaurant', options);
export const buildSeafrontBar = (seed: number, options?: BuildOptions): BuiltModel => buildVenue(seed, 'bar', options);
export const buildSeafrontCafe = (seed: number, options?: BuildOptions): BuiltModel => buildVenue(seed, 'cafe', options);
