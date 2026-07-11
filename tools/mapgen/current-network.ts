/**
 * Snapshot of the CURRENT hand-authored in-game road network, used only for
 * the preview overlay so the owner can compare old vs new.
 *
 * Intentionally a copy of the data in src/world/City.ts (ROAD_NETWORK) and
 * src/world/UrbanInfrastructure.ts (CITY_JUNCTIONS): the pipeline must not
 * import game code (the dependency is one-way, game -> generated JSON).
 * If City.ts changes, refresh this snapshot by hand.
 */

export interface CurrentRoad {
  name: string;
  width: number;
  closed?: boolean;
  points: Array<{ x: number; z: number }>;
}

export const CURRENT_ROAD_NETWORK: CurrentRoad[] = [
  { name: 'Jan Smuts Ave', width: 26, points: [{ x: -30, z: 350 }, { x: -24, z: 275 }, { x: -8, z: 205 }, { x: 14, z: 135 }, { x: 5, z: 65 }, { x: -12, z: -5 }, { x: -5, z: -80 }, { x: 22, z: -160 }, { x: 55, z: -245 }] },
  { name: 'William Nicol Dr', width: 24, points: [{ x: -350, z: 245 }, { x: -275, z: 230 }, { x: -205, z: 238 }, { x: -130, z: 225 }, { x: -50, z: 242 }, { x: 35, z: 230 }, { x: 115, z: 205 }, { x: 210, z: 190 }, { x: 300, z: 150 }, { x: 350, z: 110 }] },
  { name: 'Main Reef Rd', width: 22, points: [{ x: -350, z: 125 }, { x: -270, z: 115 }, { x: -205, z: 78 }, { x: -130, z: 50 }, { x: -60, z: 30 }, { x: 5, z: 12 }, { x: 75, z: -5 }, { x: 150, z: -35 }, { x: 225, z: -65 }, { x: 325, z: -110 }] },
  { name: 'Commissioner St', width: 26, points: [{ x: -350, z: -215 }, { x: -280, z: -198 }, { x: -210, z: -207 }, { x: -135, z: -225 }, { x: -55, z: -240 }, { x: 35, z: -252 }, { x: 130, z: -248 }, { x: 225, z: -232 }, { x: 305, z: -205 }, { x: 350, z: -175 }] },
  { name: 'Empire Rd', width: 18, points: [{ x: -190, z: 177 }, { x: -125, z: 135 }, { x: -60, z: 110 }, { x: 10, z: 105 }, { x: 80, z: 120 }, { x: 150, z: 158 }] },
  { name: 'Bree St Loop', width: 18, closed: true, points: [{ x: -122, z: 195 }, { x: -30, z: 200 }, { x: 75, z: 162 }, { x: 108, z: 82 }, { x: 82, z: 12 }, { x: 12, z: -22 }, { x: -76, z: 20 }, { x: -128, z: 98 }] },
  { name: 'Rivonia Rd', width: 18, closed: true, points: [{ x: 165, z: 265 }, { x: 250, z: 282 }, { x: 322, z: 225 }, { x: 334, z: 138 }, { x: 285, z: 65 }, { x: 220, z: 45 }, { x: 158, z: 105 }] },
  { name: 'Grayston Dr', width: 16, points: [{ x: 155, z: 5 }, { x: 215, z: -25 }, { x: 282, z: -8 }, { x: 338, z: 52 }] },
  { name: 'Louis Botha Ave', width: 21, closed: true, points: [{ x: -332, z: 58 }, { x: -262, z: 88 }, { x: -190, z: 45 }, { x: -175, z: -48 }, { x: -220, z: -132 }, { x: -310, z: -148 }, { x: -346, z: -62 }] },
  { name: 'Vilakazi St', width: 17, points: [{ x: -262, z: 88 }, { x: -278, z: 164 }, { x: -245, z: 235 }] },
  { name: 'Oxford Rd', width: 15, closed: true, points: [{ x: -88, z: 42 }, { x: -42, z: 88 }, { x: 25, z: 90 }, { x: 82, z: 46 }, { x: 84, z: -20 }, { x: 36, z: -72 }, { x: -35, z: -76 }, { x: -88, z: -35 }] },
  { name: 'Marshall St', width: 16, points: [{ x: 78, z: -246 }, { x: 138, z: -290 }, { x: 215, z: -315 }, { x: 292, z: -304 }, { x: 350, z: -268 }] },
];

export const CURRENT_JUNCTIONS: Array<{ x: number; z: number }> = [
  { x: -8, z: 205 },
  { x: 5, z: 12 },
  { x: 75, z: -5 },
  { x: -262, z: 88 },
  { x: -130, z: 50 },
  { x: 115, z: 205 },
  { x: 78, z: -246 },
];
