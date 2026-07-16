/**
 * Pleasure-pier builder: a planked timber deck on pylon pairs stepping out over the water, white
 * railings, storm lamps, entrance steps + portal sign, and a sea-end pavilion apron with a striped
 * roomys kiosk and benches. The stations come from the PURE pierPlan (beachfront.ts) so vitest can
 * assert the layout headlessly; this file only turns a plan into kit geometry.
 *
 * Local space: y=0 is the WATERLINE (place the group at OCEAN_Y-ish, not on terrain), the shore
 * root sits at z=0 with the entrance facing +z (land) and the deck running to z=-length. Unlike
 * catalog models the group is NOT recentred, so City can anchor the root exactly on the sand crest;
 * tiers use the usual MassingTier convention for City.tierToWorldCollider.
 */
import * as THREE from 'three';
import type { MassingTier } from '../BuildingArchitecture';
import { pierPlan, type PierPlan } from '../beachfront';
import { Kit, M, paint } from './kit';

export interface PierOptions { length?: number; width?: number; sign?: string; }
export interface PierBuild { group: THREE.Group; tiers: MassingTier[]; plan: PierPlan; }

const DECK_A = paint(0xbfae94, 0.85);
const DECK_B = paint(0xb1a084, 0.85);
const KIOSK_ROOFS = [paint(0xc24a38, 0.75), paint(0x2f6f78, 0.75), paint(0x32476e, 0.75)] as const;
/** Emissive lamp heads so the pier reads at night without real lights. */
const lampGlow = new THREE.MeshStandardMaterial({ color: 0xfff0c8, emissive: 0xffcf7a, emissiveIntensity: 2.2, roughness: 0.35 });
const PYLON_DEPTH = 8.5; // pylons sink well below the near-shore seabed slope

export function buildPleasurePier(seed: number, options: PierOptions = {}): PierBuild {
  const kit = new Kit(seed);
  const plan = pierPlan(options.length ?? 120, options.width ?? 8.5);
  const { width, deckY } = plan; const half = width / 2;

  for (let i = 0; i < plan.bays.length; i++) { // planked deck, alternating weathered tones per bay
    const bay = plan.bays[i]!;
    kit.box(i % 2 ? DECK_B : DECK_A, width, 0.16, bay.z0 - bay.z1 - 0.05, 0, deckY - 0.16, (bay.z0 + bay.z1) / 2, { receive: true });
  }
  kit.tier(-half, half, -plan.length, 0, deckY - 0.3, deckY); // one standable deck tier
  for (const pz of plan.pylons) {
    for (const side of [-1, 1]) kit.cyl(M.darkTimber, 0.17, 0.2, deckY + PYLON_DEPTH - 0.2, side * (half - 0.3), -PYLON_DEPTH, pz, { seg: 8 });
    kit.box(M.darkTimber, width - 0.5, 0.12, 0.14, 0, deckY - 0.5, pz, { cast: false }); // bearer
  }
  for (const side of [-1, 1]) { // railings: posts + double rails, with a tier so cars can't drive off
    for (const pz of plan.posts) kit.box(M.whitewash, 0.09, 1.05, 0.09, side * (half - 0.12), deckY, pz, { cast: false });
    kit.box(M.whitewash, 0.07, 0.08, plan.length, side * (half - 0.12), deckY + 1.02, -plan.length / 2, { cast: false });
    kit.box(M.whitewash, 0.06, 0.06, plan.length, side * (half - 0.12), deckY + 0.55, -plan.length / 2, { cast: false });
    const inner = side * (half - 0.32); const outer = side * half;
    kit.tier(Math.min(inner, outer), Math.max(inner, outer), -plan.length, -1, deckY, deckY + 1.1);
  }
  for (const lamp of plan.lamps) { // storm lamps, alternating sides
    kit.cyl(M.darkMetal, 0.05, 0.07, 3.1, lamp.side * (half - 0.6), deckY, lamp.z, { seg: 8 });
    kit.box(lampGlow, 0.26, 0.34, 0.26, lamp.side * (half - 0.6), deckY + 3.08, lamp.z, { cast: false });
    kit.box(M.darkMetal, 0.36, 0.06, 0.36, lamp.side * (half - 0.6), deckY + 3.42, lamp.z, { cast: false });
  }
  for (let s = 0; s < 3; s++) { // entrance steps up from the sand crest (~1.5) to the deck (2.35)
    const top = deckY - 0.2 - 0.3 * (2 - s); // 1.55, 1.85, 2.15 — every rise within PLAYER.stepUp
    kit.box(M.paving, width - 1.6, top, 1, 0, 0, 3.05 - s, { collide: true });
  }
  for (const side of [-1, 1]) kit.box(M.whitewash, 0.5, deckY + 2.7, 0.5, side * (half - 0.3), 0, 3.4, { collide: true }); // portal pylons
  kit.box(M.whitewash, width, 0.5, 0.6, 0, deckY + 2.45, 3.4, { cast: false });
  kit.sign(options.sign ?? 'PLEASURE PIER', '#f2e2b8', width * 0.82, 0.58, 0, deckY + 2.5, 3.74, { doubleSide: true, background: '#2e5560' });

  const pav = plan.pavilion; // sea-end pavilion: wider apron, kiosk, benches, perimeter rail
  kit.box(DECK_A, pav.w, 0.16, pav.d, 0, deckY - 0.16, pav.z, { receive: true });
  kit.tier(-pav.w / 2, pav.w / 2, pav.z - pav.d / 2, pav.z + pav.d / 2, deckY - 0.3, deckY);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    kit.cyl(M.darkTimber, 0.17, 0.2, deckY + PYLON_DEPTH - 0.2, sx * (pav.w / 2 - 0.4), -PYLON_DEPTH, pav.z + sz * (pav.d / 2 - 0.5), { seg: 8 });
  }
  const seaEdge = pav.z - pav.d / 2;
  for (let x = -pav.w / 2 + 0.15; x <= pav.w / 2 - 0.1; x += 2) kit.box(M.whitewash, 0.09, 1.05, 0.09, x, deckY, seaEdge + 0.12, { cast: false });
  kit.box(M.whitewash, pav.w, 0.08, 0.07, 0, deckY + 1.02, seaEdge + 0.12, { cast: false });
  kit.tier(-pav.w / 2, pav.w / 2, seaEdge, seaEdge + 0.35, deckY, deckY + 1.1);
  for (const side of [-1, 1]) {
    for (let z = seaEdge + 2; z < pav.z + pav.d / 2; z += 2.4) kit.box(M.whitewash, 0.09, 1.05, 0.09, side * (pav.w / 2 - 0.12), deckY, z, { cast: false });
    kit.box(M.whitewash, 0.08, 0.08, pav.d, side * (pav.w / 2 - 0.12), deckY + 1.02, pav.z, { cast: false });
    kit.tier(Math.min(side * (pav.w / 2 - 0.32), side * (pav.w / 2)), Math.max(side * (pav.w / 2 - 0.32), side * (pav.w / 2)), seaEdge, pav.z + pav.d / 2, deckY, deckY + 1.1);
    kit.box(M.darkTimber, 0.5, 0.42, 2.4, side * (pav.w / 2 - 1.05), deckY, pav.z, { collide: true }); // bench
  }
  const kioskR = 2.1;
  kit.cyl(M.whitewash, kioskR, kioskR, 2.5, 0, deckY, pav.z, { seg: 8, collide: true });
  kit.cyl(kit.pick(9, KIOSK_ROOFS), 0.05, kioskR + 0.6, 1.3, 0, deckY + 2.5, pav.z, { seg: 8 });
  kit.cyl(M.whiteMetal, 0.05, 0.05, 0.6, 0, deckY + 3.8, pav.z, { seg: 6, cast: false });
  kit.box(M.glassDark, kioskR * 1.05, 0.8, 0.1, 0, deckY + 1, pav.z + kioskR - 0.02, { cast: false }); // hatch faces up the deck
  kit.box(M.bleached, kioskR * 1.2, 0.07, 0.4, 0, deckY + 0.92, pav.z + kioskR + 0.18, { cast: false }); // counter
  kit.sign('ROOMYS & SLAP CHIPS', '#f2e2b8', 2.9, 0.45, 0, deckY + 2.15, pav.z + kioskR + 0.12, { background: '#a84860' });

  return { group: kit.group, tiers: kit.tiers, plan };
}
