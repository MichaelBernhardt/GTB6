/**
 * WHERE THE DOORS ARE — and they are where the model already drew one.
 *
 * The previous version derived doorsteps from the ROAD network and hoped a building was behind them.
 * It usually was not, which is why the owner walked up to buildings with obvious doors and got
 * nothing. The version after that read the parcel rectangle and put the step at `depth/2`, which is
 * the front wall on about two thirds of this city's massings and up to half a parcel-depth in FRONT
 * of it on the rest — a prompt hovering in somebody's front yard.
 *
 * Neither is a guess any more. BuildingArchitecture now TAGS the entrance as it plans the facade
 * (see EntranceTag): the exact wall plane, the exact width, the exact kind of opening. City hangs the
 * glazed leaf on that tag, and this file opens that same tag. The door on the model and the door in
 * the prompt are one fact, so they cannot disagree.
 *
 * `plan()` gives us the tag without building any geometry (~0.067 ms a building, against 2.7 ms to
 * draw one), so asking a whole chunk cell where its doors are costs a few milliseconds, once, and is
 * then memoised.
 *
 * This directory is never statically imported — see the chunk note at the top of ../interiors.state.ts.
 */
import * as THREE from 'three';
import { BuildingArchitecture } from '../../world/BuildingArchitecture';
import { CELL_SIZE, generateCell, type GeneratedBuilding } from '../../world/CityGen';
import { distanceToRoadEdge, landmark, nearestDistrict, pointInAnyPolygon, WATER_POLYGONS } from '../../world/mapData';
import { ARMS_SITE, BOTTLE_STORES, GARAGE_SITE, HOTDOG_SITE, SAFEHOUSE_SITE, SPRAY_SITE } from '../../world/placements';
import { stablePositionRandom } from '../../world/StableRandom';
import { DOOR_RADIUS, type InteriorDoor } from '../interiors.state';
import type { BuildingFacts } from './core';

/**
 * How far in front of the tagged wall plane the doorstep sits, in order of preference.
 *
 * THE FIRST ONE CLEARS THE COVER SNAP, and that is the whole reason it is 2.9 and not the 2.1 it
 * used to be. Game.renderHUD's on-foot ladder puts `Q  Take cover` ABOVE the feature offer, and
 * CoverSystem's COVER_ENTER_RANGE is 2.5 from the wall face — which is exactly the face this tag
 * names. A doorstep 2.1 out therefore sat inside the cover ring, so a player standing on the lit pad
 * at a door was told to take cover and never told they could go in. The E press still worked (cover
 * is Q), which is precisely how a feature comes to look broken: the door is there, the way in is
 * there, and the only thing missing is the sentence that says so. Standing off 2.9 puts the pad
 * outside the snap, so the prompt on the pad is the door's.
 *
 * The rest are fallbacks for a pavement too narrow to hold a stride. The interiors rung sits above
 * `E  Enter vehicle`, so a step in the gutter would steal E from a car at the kerb; rather than shut
 * such a building, the step tucks in against its own wall and takes the cover clash on the chin. The
 * prompt ring is 4.2 u, so a step half a metre off the leaf is still one you walk onto.
 */
const STAND_OFFS = [2.9, 2.1, 1.4, 0.8, 0.35] as const;
/** Clear of the carriageway by this much, or the doorstep and a parked car fight over one E press.
 *  The last resort is the LAST one: on a pavement too narrow for even a 0.35 u step to make the full
 *  clearance, the step goes against the wall and only has to be off the tar. A shut building fails
 *  the player every single time; a shared E press fails only when a car happens to be parked on
 *  that exact metre of kerb. */
const ROAD_CLEARANCE = 2.4;
const KERB_CLEARANCE = 0.5;
/** A doorstep this close to an existing shop/safehouse pad would fight it for the same E press. */
const PAD_CLEARANCE = 20;
/** Two doorsteps closer than this are the same step, and only the first of them is a door. */
const SAME_STEP = 2.6;

/** Metres of building per storey — the interior's own STOREY_HEIGHT, repeated here only so the
 *  landmark filter can talk in storeys without importing the whole core. */
const MIN_LANDMARK_STOREY = 3.5;

const SPAZA_NAMES = [
  'Sizwe se Spaza', 'Mama Dlamini Tuck Shop', 'Ekhaya Superette', 'Zwelethu Cash Store',
  'Kwa-Mnandi Spaza', 'Blue Sky Tuck Shop', 'Bhut Solly se Winkel', 'Corner Café',
];
const HOUSE_NAMES = ['No. 12', 'No. 7', 'No. 41', 'No. 3', 'No. 88', 'No. 26', 'No. 15', 'No. 60'];
const VILLA_NAMES = ['Kopje House', 'The Willows', 'Acacia Lodge', 'Mimosa House', 'Riverbend', 'Klipdrift House'];
const BLOCK_NAMES = ['Ridge Court', 'Sunnyside Mansions', 'Kopje Heights', 'Vista Flats', 'Boundary House', 'Hilltop Court'];
const WORKS_NAMES = [
  'Unit 4 · Bracewell Works', 'Modderfontein Cold Store', 'Meyer & Sons Panelbeaters', 'Bay 2 · Reef Freight',
  'Umgeni Steel Depot', 'Bay 7 · Kruger Haulage', 'Vaal Packaging Unit 9', 'Ndlovu Engineering',
];

// The plan-only architecture instance. It never draws, so this group stays empty forever; it exists
// only because BuildingArchitecture takes a parent in its constructor.
const architecture = new BuildingArchitecture(new THREE.Group());
const planFacade = new THREE.MeshBasicMaterial();
const planRoof = new THREE.MeshBasicMaterial();

interface Pad { x: number; z: number }

let padCache: Pad[] | undefined;
function pads(): Pad[] {
  if (!padCache) {
    padCache = [ARMS_SITE.pad, SPRAY_SITE.pad, GARAGE_SITE.pad, HOTDOG_SITE.pad, SAFEHOUSE_SITE.pad, ...BOTTLE_STORES.map((store) => store.site.pad)]
      .map((pad) => ({ x: pad.x, z: pad.z }));
  }
  return padCache;
}

/** Building-local point -> world. The chunk builder places every building this way, so a point that
 *  is on the model's front wall in local space is on the model's front wall in the street. */
function toWorld(building: GeneratedBuilding, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(building.heading); const s = Math.sin(building.heading);
  return { x: building.x + lx * c + lz * s, z: building.z - lx * s + lz * c };
}

function nameFor(building: GeneratedBuilding, kind: string): string {
  const list = kind === 'shopfront' ? SPAZA_NAMES
    : kind === 'dock' ? WORKS_NAMES
      : kind === 'porch' ? (building.style === 'estate' ? VILLA_NAMES : HOUSE_NAMES)
        : BLOCK_NAMES;
  return list[Math.floor(stablePositionRandom(building.x, building.z, 94) * list.length) % list.length]!;
}

/**
 * The door this building carries, or undefined when it carries none or its step is unusable.
 *
 * EVERY TAG OPENS NOW. There used to be two more gates here: a 0.62 lottery over tagged buildings and
 * a ban on loading docks. Between them, and the facade-parity rule in planEntrance, only 1,474 of the
 * city's 3,722 parcels let you in — so the owner's own test, walk up to buildings at random, failed
 * three times in five. Nothing is generated until somebody walks in and only one or two floors are
 * ever resident, so an unopened building saves nothing; a locked door is not a saving, it is a player
 * concluding the feature is broken. A works is not a compromise either: an empty floor plate with
 * racking and a roller door is content the city did not have.
 */
export function doorFor(building: GeneratedBuilding, name?: string): InteriorDoor | undefined {
  const profile = architecture.plan({
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant: building.variant, facade: planFacade, roof: planRoof,
  });
  const tag = profile.entrance;
  if (!tag) return undefined;

  const face = toWorld(building, tag.x, tag.z);
  // The step is a stride out along the building's own outward normal — local +z, which CityGen aims
  // at the street the building fronts — tucking closer to the wall rather than giving up when a
  // building stands hard against the kerb.
  const outX = Math.sin(building.heading); const outZ = Math.cos(building.heading);
  let x = 0; let z = 0; let stepped = false;
  for (const standOff of STAND_OFFS) {
    x = face.x + outX * standOff; z = face.z + outZ * standOff;
    const clearance = standOff === STAND_OFFS[STAND_OFFS.length - 1] ? KERB_CLEARANCE : ROAD_CLEARANCE;
    if (distanceToRoadEdge(x, z) >= clearance) { stepped = true; break; }
  }
  if (!stepped) return undefined;
  if (pointInAnyPolygon(WATER_POLYGONS, x, z)) return undefined;
  for (const pad of pads()) if (Math.hypot(pad.x - x, pad.z - z) < PAD_CLEARANCE) return undefined;

  const facts: BuildingFacts = {
    id: `${Math.round(building.x)}:${Math.round(building.z)}`,
    x: building.x, z: building.z, heading: building.heading,
    width: building.width, depth: building.depth, height: building.height,
    style: building.style, entrance: tag.kind,
  };
  return {
    id: facts.id,
    name: name ?? nameFor(building, tag.kind),
    x, z,
    faceX: face.x, faceZ: face.z,
    heading: building.heading,
    openWidth: tag.width,
    facts,
  };
}

const cells = new Map<string, InteriorDoor[]>();

/**
 * Landmarks that get their name put over a door — but only over a building that can carry it.
 *
 * The map pins Ponte Tower, and the parcel pass puts whatever the zoning asked for on that spot. On
 * the current map that is a three-storey block, and calling a three-storey block Ponte Tower is a
 * lie the player catches in four seconds. So an anchor states the least it will accept: the tallest
 * opening building in the pin's own chunk cell, within `radius` of it, that is at least `storeys`
 * tall. If nothing there qualifies the landmark simply has no door, and the ordinary doors around it
 * still do.
 */
function anchors(): { at: { x: number; z: number }; name: string; radius: number; storeys: number }[] {
  const out: { at: { x: number; z: number }; name: string; radius: number; storeys: number }[] = [];
  const ponte = landmark('Ponte Tower') ?? landmark('Hillbrow tower');
  if (ponte) out.push({ at: ponte, name: 'Ponte Tower', radius: 420, storeys: 12 });
  return out;
}

function doorsInCell(cellX: number, cellZ: number): InteriorDoor[] {
  const key = `${cellX},${cellZ}`;
  const cached = cells.get(key);
  if (cached) return cached;
  const buildings = generateCell(cellX, cellZ);
  const out: InteriorDoor[] = [];
  const claimed = new Set<string>();

  // 1. Landmark doors first, so a rolled-out parcel can never take the Ponte slot.
  for (const anchor of anchors()) {
    if (Math.floor(anchor.at.x / CELL_SIZE) !== cellX || Math.floor(anchor.at.z / CELL_SIZE) !== cellZ) continue;
    // The TALLEST qualifying building near the pin, not merely the nearest: a landmark name belongs
    // on a landmark, and the parcel that happens to sit on the pin is usually a shop.
    let best: InteriorDoor | undefined; let bestHeight = anchor.storeys * MIN_LANDMARK_STOREY;
    for (const building of buildings) {
      if (Math.hypot(building.x - anchor.at.x, building.z - anchor.at.z) > anchor.radius) continue;
      if (building.height <= bestHeight) continue;
      const door = doorFor(building, anchor.name);
      if (door) { bestHeight = building.height; best = door; }
    }
    if (best && !claimed.has(best.id)) { claimed.add(best.id); out.push(best); }
  }

  // 2. EVERY OTHER PARCEL IN THE CELL, in cell order so the answer is a pure function of the map.
  // There is no per-cell ceiling: a cell holds at most CELL_BUILDING_CAP parcels by construction, the
  // table is memoised per cell, and only STREAM_CAP of them are ever drawn as doorways, so the cap
  // this used to carry bought nothing but 156 buildings a player could not walk into.
  for (const building of buildings) {
    const door = doorFor(building);
    if (!door || claimed.has(door.id)) continue;
    // Two steps on the SAME spot are one doorstep with two names; anything further apart resolves
    // by nearest through doorNear(), so the second one is a door, not a conflict.
    if (out.some((other) => Math.hypot(other.x - door.x, other.z - door.z) < SAME_STEP)) continue;
    claimed.add(door.id);
    out.push(door);
  }
  cells.set(key, out);
  return out;
}

/** Every door whose step is within `radius` of a point. Used both by the prompt (a tight ring) and
 *  by the doorway streamer (a wide one). */
export function doorsNear(x: number, z: number, radius: number): InteriorDoor[] {
  const out: InteriorDoor[] = [];
  const minX = Math.floor((x - radius) / CELL_SIZE); const maxX = Math.floor((x + radius) / CELL_SIZE);
  const minZ = Math.floor((z - radius) / CELL_SIZE); const maxZ = Math.floor((z + radius) / CELL_SIZE);
  for (let cellX = minX; cellX <= maxX; cellX++) {
    for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
      for (const door of doorsInCell(cellX, cellZ)) {
        if (Math.hypot(door.x - x, door.z - z) <= radius) out.push(door);
      }
    }
  }
  return out;
}

/** The doorstep under a point, or undefined. The prompt and the E press resolve through this one
 *  call, so the ring you see is the ring that acts. */
export function doorNear(x: number, z: number): InteriorDoor | undefined {
  let best: InteriorDoor | undefined; let bestDistance = DOOR_RADIUS;
  for (const door of doorsNear(x, z, DOOR_RADIUS)) {
    const distance = Math.hypot(door.x - x, door.z - z);
    if (distance < bestDistance) { best = door; bestDistance = distance; }
  }
  return best;
}

/** The door nearest a point at any distance, for the console and the QA driver. Searches outward so
 *  an empty neighbourhood still answers. */
export function nearestDoor(x: number, z: number): InteriorDoor | undefined {
  for (const radius of [CELL_SIZE / 2, CELL_SIZE, CELL_SIZE * 2, CELL_SIZE * 4]) {
    let best: InteriorDoor | undefined; let bestDistance = Infinity;
    for (const door of doorsNear(x, z, radius)) {
      const distance = Math.hypot(door.x - x, door.z - z);
      if (distance < bestDistance) { bestDistance = distance; best = door; }
    }
    if (best) return best;
  }
  return undefined;
}

/** The tallest door within reach of a point — what `feature interiors go tall` heads for, and the
 *  one worth photographing, because it is the one with a lift in it. */
export function tallestDoorNear(x: number, z: number, radius: number): InteriorDoor | undefined {
  let best: InteriorDoor | undefined;
  for (const door of doorsNear(x, z, radius)) {
    if (!best || door.facts.height > best.facts.height) best = door;
  }
  return best;
}

/** The named door for a landmark anchor, for the console (`feature interiors go ponte`). */
export function landmarkDoor(name = 'Ponte Tower'): InteriorDoor | undefined {
  for (const anchor of anchors()) {
    if (anchor.name !== name) continue;
    const cellX = Math.floor(anchor.at.x / CELL_SIZE); const cellZ = Math.floor(anchor.at.z / CELL_SIZE);
    const found = doorsInCell(cellX, cellZ).find((door) => door.name === anchor.name);
    if (found) return found;
  }
  return undefined;
}

/** The district a door stands in — flavour for the HUD chip and the notification. */
export function doorDistrict(door: InteriorDoor): string {
  return nearestDistrict(door.x, door.z).name;
}

/** Test seam: drops the memoised per-cell tables. */
export function resetDoorCache(): void { cells.clear(); padCache = undefined; }
