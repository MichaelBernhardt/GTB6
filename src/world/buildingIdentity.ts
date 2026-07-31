/**
 * ONE NAME PER BUILDING — the single source both halves of a building's identity read.
 *
 * The owner's first bullet this round was "exit name doesn't match entry name. They seem completely
 * unrelated", and the audit behind it found why: the name PAINTED on a facade came from the painters'
 * own vocabularies (City.addStreetLevelDetail / addIndustrialDetail on parcels, each model builder's
 * private kit.sign list on scattered models), while the name on the E prompt, the entry toast and the
 * HUD chip came from the interiors feature's own pools. Two generators, two vocabularies, one
 * building — measured at 43 of 4,267 painted buildings agreeing (1.0%), and every one of the 43 a
 * coincidence.
 *
 * This module is that one name. It derives a building's display name deterministically from the same
 * facts both sides already hold — position, family, the kind of opening the model tagged — and BOTH
 * sides consume it: the painters put boardText() on the wall, the interiors feature puts the display
 * form on the prompt. They cannot disagree because neither invents anything.
 *
 * Direction of truth: PAINTERS FOLLOW IDENTITY. The door code never re-derives what a painter chose
 * to draw (that is drift waiting to happen); the painter asks this module what the building is called
 * and letters the board accordingly.
 *
 * CHUNK NOTE. This lives in src/world/ (eager, swept into the world chunk) on purpose: City's
 * painters are eager, so the names must be. The lazy interiors chunk importing an eager leaf is
 * fine. This file imports only world-chunk siblings that never import it back (StableRandom,
 * CityGen, BuildingArchitecture, mapData, neighbourhoods), so it cannot form a chunk cycle.
 *
 * Determinism: stablePositionRandom only. The salts (94 parcels, 95 scatter) are the ones doors.ts
 * always used, so every prompt name that existed before this module keeps its exact name.
 */
import * as THREE from 'three';
import { BuildingArchitecture } from './BuildingArchitecture';
import { CELL_SIZE, generateCell } from './CityGen';
import { landmark, nearestDistrict } from './mapData';
import { neighbourhoodBuildingVariant } from './data/neighbourhoods';
import { stablePositionRandom } from './StableRandom';

// ---- the vocabularies ---------------------------------------------------------------------------

export const SPAZA_NAMES = [
  'Sizwe se Spaza', 'Mama Dlamini Tuck Shop', 'Ekhaya Superette', 'Zwelethu Cash Store',
  'Kwa-Mnandi Spaza', 'Blue Sky Tuck Shop', 'Bhut Solly se Winkel', 'Corner Café',
] as const;
export const HOUSE_NAMES = ['No. 12', 'No. 7', 'No. 41', 'No. 3', 'No. 88', 'No. 26', 'No. 15', 'No. 60'] as const;
export const VILLA_NAMES = ['Kopje House', 'The Willows', 'Acacia Lodge', 'Mimosa House', 'Riverbend', 'Klipdrift House'] as const;
export const BLOCK_NAMES = ['Ridge Court', 'Sunnyside Mansions', 'Kopje Heights', 'Vista Flats', 'Boundary House', 'Hilltop Court'] as const;
export const WORKS_NAMES = [
  'Unit 4 · Bracewell Works', 'Modderfontein Cold Store', 'Meyer & Sons Panelbeaters', 'Bay 2 · Reef Freight',
  'Umgeni Steel Depot', 'Bay 7 · Kruger Haulage', 'Vaal Packaging Unit 9', 'Ndlovu Engineering',
] as const;
export const PLOT_NAMES = ['Kleinfontein', 'Doringkraal', 'Rietvlei Plaas', 'Waterval Plot 14', 'Skuilkrans', 'Vergenoegd'] as const;
export const SHED_NAMES = ['Die Skuur', 'Implement Shed', 'Hay Store', 'Bait & Ski Shed', 'Plot 9 Store', 'Loods 3'] as const;
export const CAFE_NAMES = ['Die Strand Kafee', 'Vaalwater Grill', 'Sundowner Bar', 'Kaia Coffee', 'Bunny Chow Now', 'Snoek & Chips'] as const;
export const OFFICE_NAMES = ['Sanlamb House', 'Reef Chambers', 'Protea Place', 'Mediocre Holdings', 'Kopje Chambers', 'Bracewell House'] as const;

/** Civic scatter used to draw from ONE mixed pool, so a school could be prompted as a mosque and a
 *  kerk as a community centre. The pool is split by what the model actually is; the vocabulary is
 *  the old pool's plus each builder's own painted register, so the split stays in voice. */
export const KERK_NAMES = ['NG Kerk Koppiekraal', 'St Andrews Church', 'Ebenhaeser Gemeente', 'All Nations Chapel'] as const;
export const MASJID_NAMES = ['Masjid al-Noor', 'Masjid us-Salaam', 'Nurul Islam Masjid'] as const;
export const SKOOL_NAMES = ['Laerskool Kopanong', 'Hoërskool Vyfster', 'Sunnyside Primary', 'Laerskool Koppiekraal'] as const;
export const SAAL_NAMES = ['Gemeenskapsaal', 'Ekhaya Community Centre', 'St Andrews Hall', 'Dienssentrum'] as const;

/** Townhouse complexes wear an estate-gate board, not a house number — the vocabulary the builder
 *  always painted, now also the name on the prompt. */
export const COMPLEX_NAMES = ['Villa Mia Estate', 'Die Eike Kompleks', 'Sunset Ridge 2', 'Kiepersol Close'] as const;
/** A hypermarket is a brand, not a tuck shop. Same list the big-box builder always painted. */
export const MALL_NAMES = ['Groot Mall', 'Maakro', 'Game Over Stores', 'Hyper-ish'] as const;

const pickName = (list: readonly string[], x: number, z: number, salt: number): string =>
  list[Math.floor(stablePositionRandom(x, z, salt) * list.length) % list.length]!;

// ---- landmarks ----------------------------------------------------------------------------------

/** A facade storey, for talking about landmark height gates without importing the interiors core. */
const LANDMARK_STOREY = 3.5;

/** Map-pinned landmarks that put their NAME over a parcel door — but only over a building that can
 *  carry it: the tallest tagged building in the pin's own chunk cell, within `radius`, at least
 *  `storeys` tall. The table is the one doors.ts used to keep privately; it lives here now because a
 *  name override known only to the prompt side is exactly how a board and a prompt drift apart —
 *  Ponte Tower's prompt said Ponte while its painted board said RIDGE COURT. */
export function landmarkAnchors(): { at: { x: number; z: number }; name: string; radius: number; storeys: number }[] {
  const out: { at: { x: number; z: number }; name: string; radius: number; storeys: number }[] = [];
  const ponte = landmark('Ponte Tower') ?? landmark('Hillbrow tower');
  if (ponte) out.push({ at: ponte, name: 'Ponte Tower', radius: 420, storeys: 12 });
  return out;
}

export const LANDMARK_NAMES = ['Ponte Tower'] as const;

/** building id (`round(x):round(z)`) -> landmark name, computed once. Selection is plan-level only
 *  (entrance tag + height), the same facts doors.ts reads; if the winner's doorstep later proves
 *  unusable the board still carries the landmark's name — an honest board on a doorless landmark
 *  beats a board that disagrees with the prompt next door. */
let landmarkTable: Map<string, string> | undefined;

function landmarkParcels(): Map<string, string> {
  if (landmarkTable) return landmarkTable;
  landmarkTable = new Map();
  const architecture = new BuildingArchitecture(new THREE.Group());
  const planMaterial = new THREE.MeshBasicMaterial();
  for (const anchor of landmarkAnchors()) {
    const buildings = generateCell(Math.floor(anchor.at.x / CELL_SIZE), Math.floor(anchor.at.z / CELL_SIZE));
    let best: { x: number; z: number } | undefined; let bestHeight = anchor.storeys * LANDMARK_STOREY;
    for (const building of buildings) {
      if (Math.hypot(building.x - anchor.at.x, building.z - anchor.at.z) > anchor.radius) continue;
      if (building.height <= bestHeight) continue;
      const variant = neighbourhoodBuildingVariant(nearestDistrict(building.x, building.z).name, building.variant);
      const profile = architecture.plan({
        x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
        style: building.style, variant, facade: planMaterial, roof: planMaterial,
      });
      if (!profile.entrance) continue;
      bestHeight = building.height; best = building;
    }
    if (best) landmarkTable.set(`${Math.round(best.x)}:${Math.round(best.z)}`, anchor.name);
  }
  return landmarkTable;
}

/** The landmark name a parcel building carries, if it is one of the chosen few. Consulted by BOTH
 *  sides: doors.ts puts it on the prompt, City's painters letter it on the board. */
export function landmarkParcelName(x: number, z: number): string | undefined {
  return landmarkParcels().get(`${Math.round(x)}:${Math.round(z)}`);
}

// ---- the two derivations ------------------------------------------------------------------------

/** The name of a PARCEL building (CityGen), from the same facts doors.ts always hashed (salt 94).
 *  `kind` is the entrance kind the architecture tagged; `style` the parcel's structural family.
 *  A landmark parcel answers its landmark's name — to BOTH sides, which is the point. */
export function parcelBuildingName(x: number, z: number, style: string, kind: string): string {
  const landmarkName = landmarkParcelName(x, z);
  if (landmarkName) return landmarkName;
  const list = kind === 'shopfront' ? SPAZA_NAMES
    : kind === 'dock' ? WORKS_NAMES
      : kind === 'porch' ? (style === 'estate' ? VILLA_NAMES : HOUSE_NAMES)
        : BLOCK_NAMES;
  return pickName(list, x, z, 94);
}

/** The name of a SCATTERED catalog model, from its own position (salt 95), routed by its catalog
 *  interior family, its tagged entrance kind and — where the family is too coarse — the model name. */
export function scatterBuildingName(x: number, z: number, family: string, kind: string, modelName: string): string {
  const list = modelName === 'big-box' ? MALL_NAMES
    : modelName === 'townhouse-row' ? COMPLEX_NAMES
      : family === 'rural' ? (kind === 'shopfront' ? SPAZA_NAMES : PLOT_NAMES)
        : family === 'civic' ? civicList(modelName)
          : family === 'industrial' ? (modelName === 'barn' || modelName === 'tractor-shed' || modelName === 'boat-shed' ? SHED_NAMES : WORKS_NAMES)
            : family === 'estate' ? VILLA_NAMES
              : family === 'dense-residential' ? BLOCK_NAMES
                : family === 'downtown' ? OFFICE_NAMES
                  : kind === 'shopfront' ? (modelName.startsWith('seafront') || modelName === 'beach-cafe' ? CAFE_NAMES : SPAZA_NAMES)
                    : HOUSE_NAMES;
  return pickName(list, x, z, 95);
}

function civicList(modelName: string): readonly string[] {
  return modelName === 'church' ? KERK_NAMES
    : modelName === 'mosque' ? MASJID_NAMES
      : modelName === 'school' ? SKOOL_NAMES
        : SAAL_NAMES;
}

/** The display name in signwriter's capitals — what the painters letter onto the board. */
export function boardText(name: string): string {
  return name.toUpperCase();
}

/** Every distinct board text this module can put on a wall — the sign-atlas budget test sums these
 *  against the atlas capacity, so growing a pool without re-checking the budget fails a test instead
 *  of silently repainting somebody's board. */
export function identityBoardTexts(): string[] {
  const all = [
    ...SPAZA_NAMES, ...HOUSE_NAMES, ...VILLA_NAMES, ...BLOCK_NAMES, ...WORKS_NAMES, ...PLOT_NAMES,
    ...SHED_NAMES, ...CAFE_NAMES, ...OFFICE_NAMES, ...KERK_NAMES, ...MASJID_NAMES, ...SKOOL_NAMES,
    ...SAAL_NAMES, ...COMPLEX_NAMES, ...MALL_NAMES, ...LANDMARK_NAMES,
  ];
  return [...new Set(all.map(boardText))];
}
