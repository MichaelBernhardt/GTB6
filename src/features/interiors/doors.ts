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

/** How far in front of the tagged wall plane the doorstep sits. One stride: close enough that the
 *  prompt reads as "this door", far enough that the player is not standing inside the wall. */
const STAND_OFF = 2.1;
/** Share of tagged buildings that actually open. Generous on purpose — the complaint was that a
 *  player who tried a bunch of buildings found nothing, and a door you have to hunt for is not one. */
const OPEN_SHARE = 0.62;
/** Ceiling per chunk cell, so a dense CBD cell cannot make the per-frame scan expensive. */
const DOORS_PER_CELL = 30;
/** A doorstep this close to an existing shop/safehouse pad would fight it for the same E press. */
const PAD_CLEARANCE = 20;

/** Metres of building per storey — the interior's own STOREY_HEIGHT, repeated here only so the
 *  landmark filter can talk in storeys without importing the whole core. */
const MIN_LANDMARK_STOREY = 3.5;

/** A loading dock is not a way in. Everything else the facade pass draws, opens. */
const OPENS = new Set(['lobby', 'shopfront', 'porch']);

const SPAZA_NAMES = [
  'Sizwe se Spaza', 'Mama Dlamini Tuck Shop', 'Ekhaya Superette', 'Zwelethu Cash Store',
  'Kwa-Mnandi Spaza', 'Blue Sky Tuck Shop', 'Bhut Solly se Winkel', 'Corner Café',
];
const HOUSE_NAMES = ['No. 12', 'No. 7', 'No. 41', 'No. 3', 'No. 88', 'No. 26', 'No. 15', 'No. 60'];
const BLOCK_NAMES = ['Ridge Court', 'Sunnyside Mansions', 'Kopje Heights', 'Vista Flats', 'Boundary House', 'Hilltop Court'];

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

function nameFor(kind: string, x: number, z: number): string {
  const list = kind === 'shopfront' ? SPAZA_NAMES : kind === 'porch' ? HOUSE_NAMES : BLOCK_NAMES;
  return list[Math.floor(stablePositionRandom(x, z, 94) * list.length) % list.length]!;
}

/** The door this building carries, or undefined when it carries none or its step is unusable. */
export function doorFor(building: GeneratedBuilding, name?: string): InteriorDoor | undefined {
  const profile = architecture.plan({
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant: building.variant, facade: planFacade, roof: planRoof,
  });
  const tag = profile.entrance;
  if (!tag || !OPENS.has(tag.kind)) return undefined;

  const face = toWorld(building, tag.x, tag.z);
  // The step is one stride out along the building's own outward normal — local +z, which CityGen
  // aims at the street the building fronts.
  const outX = Math.sin(building.heading); const outZ = Math.cos(building.heading);
  const x = face.x + outX * STAND_OFF;
  const z = face.z + outZ * STAND_OFF;
  // The interiors rung sits ABOVE `E  Enter vehicle` in Game's on-foot ladder, so a doorstep in the
  // gutter would steal E from a car parked at the kerb. Keep the step a car's width off the road.
  if (distanceToRoadEdge(x, z) < 2.4) return undefined;
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
    name: name ?? nameFor(tag.kind, building.x, building.z),
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
 * opening building within `radius` of the pin that is at least `storeys` tall. If nothing there
 * qualifies, the landmark simply has no door and the ordinary doors around it still do.
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

  // 2. Everything else that opens, in cell order so the answer is a pure function of the map.
  for (const building of buildings) {
    if (out.length >= DOORS_PER_CELL) break;
    if (stablePositionRandom(building.x, building.z, 91) > OPEN_SHARE) continue;
    const door = doorFor(building);
    if (!door || claimed.has(door.id)) continue;
    // Two doorsteps within a stride of each other would fight over one E press.
    if (out.some((other) => Math.hypot(other.x - door.x, other.z - door.z) < DOOR_RADIUS * 2)) continue;
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
