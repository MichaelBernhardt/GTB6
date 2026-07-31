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
 * AND THE CITY HAS TWO BUILDING SYSTEMS, WHICH IS WHY THE FIRST VERSION OF THIS FILE LOOKED BROKEN.
 * CityGen lays out 3,722 PARCELS; ModelScatter then places 13,900 catalog MODELS — farmhouses,
 * face-brick houses, spazas, warehouses, churches — along every verge and across every farm and
 * park. They are a different pass with a different data structure and they are most of what a player
 * walks past outside the CBD. A report that said "3,721 of 3,722 open" was counting one of the two.
 * So the scatter is a second door source here, on the same terms: the model's own builder TAGS the
 * leaf it draws (Kit.door), the catalog says which models a person would live or work in, and
 * everything downstream cannot tell the two apart. See scatterDoorsInTile for the cost.
 *
 * This directory is never statically imported — see the chunk note at the top of ../interiors.state.ts.
 */
import * as THREE from 'three';
import { BuildingArchitecture, type EntranceTag, type MassingTier } from '../../world/BuildingArchitecture';
import { CELL_SIZE, generateCell, type GeneratedBuilding } from '../../world/CityGen';
import { distanceToRoadEdge, nearestDistrict, pointInAnyPolygon, WATER_POLYGONS } from '../../world/mapData';
import { buildModel, MODEL_INDEX } from '../../world/models/catalog';
import { scatterCell, type ScatteredModel } from '../../world/ModelScatter';
import { ARMS_SITE, BOTTLE_STORES, GARAGE_SITE, HOTDOG_SITE, SAFEHOUSE_SITE, SPRAY_SITE } from '../../world/placements';
import { landmarkAnchors, landmarkParcelName, parcelBuildingName, scatterBuildingName } from '../../world/buildingIdentity';
import { neighbourhoodBuildingVariant } from '../../world/data/neighbourhoods';
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

// THE NAMES LIVE IN src/world/buildingIdentity.ts NOW — one module both this file and the facade
// painters read, so the board on the wall and the name on the prompt are the same fact. The pools
// and salts moved verbatim, so every name a prompt showed before the move is the name it shows after.

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

/** Building-local point -> world. City.tierToWorldCollider places every parcel AND every scattered
 *  model through this exact transform, so a point on the model's front wall in local space is on the
 *  model's front wall in the street. */
function toWorld(at: { x: number; z: number; heading: number }, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(at.heading); const s = Math.sin(at.heading);
  return { x: at.x + lx * c + lz * s, z: at.z - lx * s + lz * c };
}

/**
 * The doorstep in front of a tagged wall plane, or undefined when there is nowhere to stand.
 *
 * A stride out along the building's own outward normal — local +z, which both CityGen and
 * ModelScatter aim at the street the thing fronts — tucking closer to the wall rather than giving up
 * when a building stands hard against the kerb. Shared by both door sources so a scattered house and
 * a parcel house put their step in the same place relative to their own front wall.
 */
function stepOut(face: { x: number; z: number }, heading: number): { x: number; z: number } | undefined {
  const outX = Math.sin(heading); const outZ = Math.cos(heading);
  for (const standOff of STAND_OFFS) {
    const x = face.x + outX * standOff; const z = face.z + outZ * standOff;
    const clearance = standOff === STAND_OFFS[STAND_OFFS.length - 1] ? KERB_CLEARANCE : ROAD_CLEARANCE;
    if (distanceToRoadEdge(x, z) < clearance) continue;
    if (pointInAnyPolygon(WATER_POLYGONS, x, z)) return undefined;
    for (const pad of pads()) if (Math.hypot(pad.x - x, pad.z - z) < PAD_CLEARANCE) return undefined;
    return { x, z };
  }
  return undefined;
}

function nameFor(building: GeneratedBuilding, kind: string): string {
  return parcelBuildingName(building.x, building.z, building.style, kind);
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
  // City applies the same district shift before drawing its massing. Planning with the transformed
  // variant keeps this tag byte-for-byte on the visible door even when neighbourhood silhouettes differ.
  const variant = neighbourhoodBuildingVariant(nearestDistrict(building.x, building.z).name, building.variant);
  const profile = architecture.plan({
    x: 0, z: 0, width: building.width, depth: building.depth, height: building.height,
    style: building.style, variant, facade: planFacade, roof: planRoof,
  });
  const tag = profile.entrance;
  if (!tag) return undefined;

  const face = toWorld(building, tag.x, tag.z);
  const step = stepOut(face, building.heading);
  if (!step) return undefined;

  const facts: BuildingFacts = {
    id: `${Math.round(building.x)}:${Math.round(building.z)}`,
    x: building.x, z: building.z, heading: building.heading,
    width: building.width, depth: building.depth, height: building.height,
    style: building.style, entrance: tag.kind, doorX: tag.x,
  };
  return {
    id: facts.id,
    name: name ?? nameFor(building, tag.kind),
    x: step.x, z: step.z,
    faceX: face.x, faceZ: face.z,
    heading: building.heading,
    openWidth: tag.width,
    openHeight: tag.height,
    roof: roofOf(profile.tiers),
    facts,
  };
}

/** The building's flat top, off the SAME massing tiers City pushes as colliders: the tallest
 *  non-wall tier, when it is big enough to stand a player on. Roof entry and exit both read this
 *  one rectangle, so where you drop in is exactly where the hatch puts you out. */
function roofOf(tiers: readonly MassingTier[]): InteriorDoor['roof'] {
  let top: MassingTier | undefined;
  for (const tier of tiers) {
    if (tier.kind === 'wall') continue;
    if (!top || tier.y1 > top.y1) top = tier;
  }
  if (!top) return undefined;
  if (top.maxX - top.minX < 2.4 || top.maxZ - top.minZ < 2.4) return undefined;
  return { minX: top.minX, maxX: top.maxX, minZ: top.minZ, maxZ: top.maxZ, topY: top.y1 };
}

// ---- the other half of the city: the scattered catalog models ----------------------------------

/**
 * The door on ONE scattered model, or undefined when the catalog says it has no inside (a silo, a
 * pylon, a tree) or its step lands somewhere unusable.
 *
 * The tag comes from the builder itself — the same fact, in the same shape, as a parcel's — so the
 * only work here is the transform and the same doorstep test the parcels get. Building the model is
 * how we read the tag, which is the one cost this pass has that the parcel pass does not; see
 * scatterDoorsInTile for what that comes to and why it is spent on a fine grid.
 */
export function scatterDoorFor(model: ScatteredModel): InteriorDoor | undefined {
  const def = MODEL_INDEX.get(model.name);
  if (!def?.interior) return undefined;
  const built = buildModel(model.name, model.seed, { variant: model.variant });
  const tag: EntranceTag | undefined = built.entrance;
  if (!tag) return undefined;

  const face = toWorld(model, tag.x, tag.z);
  const step = stepOut(face, model.heading);
  if (!step) return undefined;

  // Height off the model's own colliders — the same thing City pushes into the world, so the storey
  // count matches the bands of windows the player counted from the street.
  let top = 0;
  for (const tier of built.tiers) if (tier.y1 > top) top = tier.y1;
  const facts: BuildingFacts = {
    // `s` prefixes the id so a scattered model can never collide with a parcel's saved visit.
    id: `s${Math.round(model.x)}:${Math.round(model.z)}`,
    x: model.x, z: model.z, heading: model.heading,
    width: built.footprint.w, depth: built.footprint.d,
    height: Math.max(tag.height + 0.6, top),
    style: def.interior.family, entrance: tag.kind, doorX: tag.x,
  };
  return {
    id: facts.id,
    name: scatterName(model, def.interior.family, tag.kind),
    x: step.x, z: step.z,
    faceX: face.x, faceZ: face.z,
    heading: model.heading,
    openWidth: tag.width,
    openHeight: tag.height,
    roof: roofOf(built.tiers),
    facts,
  };
}

/** The name over a scattered model's door: the shared identity, off its own position. */
function scatterName(model: ScatteredModel, family: string, kind: string): string {
  return scatterBuildingName(model.x, model.z, family, kind, model.name);
}

const cells = new Map<string, InteriorDoor[]>();

function doorsInCell(cellX: number, cellZ: number): InteriorDoor[] {
  const key = `${cellX},${cellZ}`;
  const cached = cells.get(key);
  if (cached) return cached;
  const buildings = generateCell(cellX, cellZ);
  const out: InteriorDoor[] = [];
  const claimed = new Set<string>();

  // 1. Landmark doors first, so a rolled-out parcel can never take the Ponte slot. WHICH building
  // carries a landmark's name is buildingIdentity's call now (landmarkParcelName), made from the
  // same plan-level facts on BOTH sides — the selection used to live here, prompt-side only, which
  // is exactly how the tower's prompt said 'Ponte Tower' while its painted board said 'RIDGE
  // COURT'. nameFor() -> parcelBuildingName() answers the landmark name by itself; this pass only
  // preserves the claim ORDER, so a neighbouring parcel's step can never shadow the landmark door.
  for (const building of buildings) {
    if (!landmarkParcelName(building.x, building.z)) continue;
    const door = doorFor(building);
    if (door && !claimed.has(door.id)) { claimed.add(door.id); out.push(door); }
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

/**
 * Scattered doors are derived on a QUARTER-CELL tile, and the reason is cost.
 *
 * A parcel's tag comes out of a plan-only pass at 0.067 ms; a scattered model's comes out of its own
 * builder, because the builder is the only thing that knows where it drew the leaf, and that is
 * 0.17 ms of mesh a model. The densest chunk cell holds 169 scattered structures, so asking a whole
 * 976 u cell would be a 28 ms stall the moment a player crossed a cell line. On a 244 u tile the
 * same question is 2–7 ms, it is memoised, and — the real win — only the tiles within the streaming
 * radius are ever asked, rather than the whole cell the player happens to be standing in.
 */
const SCATTER_TILE = CELL_SIZE / 4;
/** How far a model's doorstep can fall outside the tile its centre sits in — a big-box portal is the
 *  worst case at ~14 u. Scans widen by this so a step near a tile line is never missed. */
const SCATTER_REACH = 30;

const tiles = new Map<string, InteriorDoor[]>();

function scatterDoorsInTile(tileX: number, tileZ: number): InteriorDoor[] {
  const key = `${tileX},${tileZ}`;
  const cached = tiles.get(key);
  if (cached) return cached;
  const out: InteriorDoor[] = [];
  // A tile nests exactly inside one chunk cell (SCATTER_TILE divides CELL_SIZE), so one memoised
  // scatter bucket holds every candidate.
  for (const model of scatterCell(Math.floor(tileX / 4), Math.floor(tileZ / 4))) {
    if (Math.floor(model.x / SCATTER_TILE) !== tileX || Math.floor(model.z / SCATTER_TILE) !== tileZ) continue;
    const door = scatterDoorFor(model);
    if (!door) continue;
    if (out.some((other) => Math.hypot(other.x - door.x, other.z - door.z) < SAME_STEP)) continue;
    out.push(door);
  }
  tiles.set(key, out);
  return out;
}

/** How far a PARCEL's doorstep can stand from the building-centre cell it is stored under. A door
 *  lives in the cell of its building's CENTRE (doorsInCell), but the step is out past the facade —
 *  up to half the deepest parcel plus the stand-off. The cell scan widens by this, or a step across
 *  a chunk-cell line is a lit marker that never answers: 65 of 7,415 doorsteps citywide were exactly
 *  that — a prompt radius of 4.2 u opened only the step's own cell, never the building's. */
const PARCEL_REACH = 45;

/** Every door whose step is within `radius` of a point — both systems, in one list. Used by the
 *  prompt (a tight ring) and by the doorway streamer (a wide one). */
export function doorsNear(x: number, z: number, radius: number): InteriorDoor[] {
  const out: InteriorDoor[] = [];
  const parcelReach = radius + PARCEL_REACH;
  const minX = Math.floor((x - parcelReach) / CELL_SIZE); const maxX = Math.floor((x + parcelReach) / CELL_SIZE);
  const minZ = Math.floor((z - parcelReach) / CELL_SIZE); const maxZ = Math.floor((z + parcelReach) / CELL_SIZE);
  for (let cellX = minX; cellX <= maxX; cellX++) {
    for (let cellZ = minZ; cellZ <= maxZ; cellZ++) {
      for (const door of doorsInCell(cellX, cellZ)) {
        if (Math.hypot(door.x - x, door.z - z) <= radius) out.push(door);
      }
    }
  }
  const parcels = out.length;
  const reach = radius + SCATTER_REACH;
  const tileMinX = Math.floor((x - reach) / SCATTER_TILE); const tileMaxX = Math.floor((x + reach) / SCATTER_TILE);
  const tileMinZ = Math.floor((z - reach) / SCATTER_TILE); const tileMaxZ = Math.floor((z + reach) / SCATTER_TILE);
  for (let tileX = tileMinX; tileX <= tileMaxX; tileX++) {
    for (let tileZ = tileMinZ; tileZ <= tileMaxZ; tileZ++) {
      for (const door of scatterDoorsInTile(tileX, tileZ)) {
        if (Math.hypot(door.x - x, door.z - z) > radius) continue;
        // Scatter flows around the parcels, so two steps on one spot is rare — but a parcel's
        // doorstep is the older claim, and two frames of one doorway is better than two of two.
        let clash = false;
        for (let i = 0; i < parcels; i++) if (Math.hypot(out[i]!.x - door.x, out[i]!.z - door.z) < SAME_STEP) { clash = true; break; }
        if (!clash) out.push(door);
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
  for (const anchor of landmarkAnchors()) {
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

/** Test seam: drops the memoised per-cell and per-tile tables. */
export function resetDoorCache(): void { cells.clear(); tiles.clear(); padCache = undefined; }
