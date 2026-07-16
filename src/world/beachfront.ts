/**
 * Beachfront plan (pure data + pure layout, no three.js): the Kaapstad Quay pleasure pier, the
 * seafront venue strips (restaurants / bars / cafes) at Kaapstad Quay and Bantry Bay, beach
 * clutter (loungers, towels, lifeguard tower) and moored boats. Everything derives from committed
 * map data — the coastline polyline, the harbour point and district centres — never hand-typed
 * coordinates, and all variation comes from position hashes, so CityGen / ModelScatter honour the
 * claims (see BEACHFRONT_PADS → RESERVED_PADS) and vitest asserts the layout headlessly.
 */
import { COASTLINE, districtCenter, distanceToRoadEdge, HARBOUR_POINT, type MapPt } from './mapData';

/** Sand-crest inland offset — MUST equal City.BEACH_INLAND (asserted by beachfront.test). */
export const CREST_INLAND = 40;
/** Dry sand runs ~26u seaward of the crest before the waterline (City's beach slope profile). */
const SAND_BAND = 24;

const coastByZ: readonly MapPt[] = COASTLINE.length ? [...COASTLINE].sort((a, b) => a.z - b.z) : [];

/** Coastline x at world z (interpolated) — same lookup City's terrain uses, kept pure here. */
export function coastXAt(z: number): number {
  const pts = coastByZ; const n = pts.length;
  if (n === 0) return Number.NEGATIVE_INFINITY;
  if (z <= pts[0]!.z) return pts[0]!.x;
  if (z >= pts[n - 1]!.z) return pts[n - 1]!.x;
  let lo = 0; let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid]!.z <= z) lo = mid; else hi = mid; }
  const a = pts[lo]!; const b = pts[hi]!;
  return a.x + (b.x - a.x) * ((z - a.z) / (b.z - a.z || 1));
}

/** Heading whose local +z (a model's front) points seaward, following the coast's meander. */
export function seawardHeading(z: number): number {
  const ahead = coastXAt(z + 8) - coastXAt(z - 8); // coast tangent is (ahead, 16); its -x normal faces the sea
  return Math.atan2(-16, ahead);
}

const rnd = (x: number, z: number, salt: number): number => {
  const value = Math.sin(x * 12.9898 + z * 78.233 + salt * 41.17) * 43758.5453;
  return value - Math.floor(value);
};

// ---- Venue layout (consumed by models/venues.ts) ------------------------------------------------

export type VenueKind = 'restaurant' | 'bar' | 'cafe';
export const VENUE_KINDS: readonly VenueKind[] = ['restaurant', 'bar', 'cafe'];

export interface VenueTable { x: number; z: number; umbrella: boolean; chairs: number[]; }
export interface VenuePlan {
  hallW: number; hallD: number; hallH: number;
  terraceW: number; terraceD: number; deckH: number;
  /** Index into the awning stripe palettes + number of stripes across the front. */
  awningIndex: number; stripes: number;
  signText: string; accentIndex: number;
  tables: VenueTable[];
  /** String-light posts across the terrace front (bulb catenaries span between them). */
  lightPosts: number;
}

const SIGNS: Record<VenueKind, readonly string[]> = {
  restaurant: ['DIE KREEFPOT', 'THE SNOEK & FORK', 'MAMA AFRIKA SEAFOOD', 'PERLEMOEN PALACE'],
  bar: ['DIE DRONK SEEMEEU', 'SUNDOWNER DECK', 'THE SALTY DOG', 'KAAPSTAD KUIER BAR'],
  cafe: ['VETKOEK & KOFFIE', 'SEEPUNT ESPRESSO', 'MILKTART MARIA', 'KOEKSISTER KAFEE'],
};
const TABLE_GAP = 2.0;

const kitHash = (seed: number, salt: number): number => {
  const value = Math.sin(seed * 127.1 + salt * 311.7 + 74.7) * 43758.5453;
  return value - Math.floor(value);
};

/** Pure venue layout: footprint, dressing picks and a non-overlapping outdoor table arrangement. */
export function venuePlan(seed: number, kind: VenueKind): VenuePlan {
  const r = (salt: number): number => kitHash(seed, salt);
  const scale = kind === 'restaurant' ? 1 : kind === 'bar' ? 0.82 : 0.68;
  const hallW = (11 + r(1) * 3.5) * scale;
  const hallD = (7.5 + r(2) * 1.8) * scale;
  const hallH = kind === 'cafe' ? 3.1 : 3.4 + r(3) * 0.5;
  const terraceW = hallW + 2.4;
  const terraceD = (6.4 + r(4) * 2) * (kind === 'cafe' ? 0.85 : 1);
  const deckH = 0.3;
  const signs = SIGNS[kind];
  const target = kind === 'restaurant' ? 7 : kind === 'bar' ? 5 : 4;
  const tables: VenueTable[] = [];
  for (let attempt = 0; attempt < target * 6 && tables.length < target; attempt++) {
    const x = (r(20 + attempt) - 0.5) * (terraceW - 2.2);
    const z = 0.9 + r(50 + attempt) * (terraceD - 2.4);
    if (tables.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < TABLE_GAP * TABLE_GAP)) continue;
    const chairCount = 2 + Math.floor(r(80 + attempt) * 2);
    const base = r(110 + attempt) * Math.PI * 2;
    tables.push({ x, z, umbrella: r(140 + attempt) < 0.55, chairs: Array.from({ length: chairCount }, (_, c) => base + (c * Math.PI * 2) / chairCount) });
  }
  return {
    hallW, hallD, hallH, terraceW, terraceD, deckH,
    awningIndex: Math.floor(r(5) * 4), stripes: 6 + Math.floor(r(6) * 4),
    signText: signs[Math.floor(r(7) * signs.length) % signs.length]!, accentIndex: Math.floor(r(8) * 4),
    tables, lightPosts: kind === 'cafe' ? 2 : 3,
  };
}

// ---- Pier layout (consumed by models/pier.ts) ----------------------------------------------------

export interface PierPlan {
  length: number; width: number; deckY: number;
  /** Deck bays: local z spans (0 = shore end, -length = sea end). */
  bays: Array<{ z0: number; z1: number }>;
  /** Pylon pair stations (local z) — a pile either side of the deck at each. */
  pylons: number[];
  /** Lamp stations, alternating sides. */
  lamps: Array<{ z: number; side: 1 | -1 }>;
  /** Railing post stations (both sides). */
  posts: number[];
  /** Sea-end pavilion apron: wider platform for the kiosk. */
  pavilion: { z: number; w: number; d: number };
}

/** Pure pier layout: bays, pylon/lamp/post stations, sea-end pavilion apron. Shore end at z=0. */
export function pierPlan(length: number, width: number): PierPlan {
  const bayLength = 6;
  const bays: Array<{ z0: number; z1: number }> = [];
  const pylons: number[] = [];
  const lamps: Array<{ z: number; side: 1 | -1 }> = [];
  const posts: number[] = [];
  for (let z = 0; z < length; z += bayLength) {
    bays.push({ z0: -z, z1: -Math.min(z + bayLength, length) });
    pylons.push(-z - Math.min(bayLength, length - z) / 2);
  }
  for (let z = 9, i = 0; z < length - 10; z += 17, i++) lamps.push({ z: -z, side: i % 2 ? 1 : -1 });
  for (let z = 0; z <= length; z += 4) posts.push(-z);
  return { length, width, deckY: 2.35, bays, pylons, lamps, posts, pavilion: { z: -length - 4, w: width + 7, d: 12 } };
}

// ---- Beachfront placement (consumed by City.buildBeachfront + RESERVED_PADS) ---------------------

export interface BeachSpot { name: string; x: number; z: number; heading: number; seed: number; variant: number; }
export interface TowelSpot { x: number; z: number; heading: number; color: number; }
export interface BeachfrontPlan {
  /** Pleasure pier: shore-end root on the sand crest, running seaward (west). */
  pier?: { x: number; z: number; length: number; width: number; sign: string };
  /** Paved quay apron behind the pier root (draped rectangle, venue forecourt). */
  apron?: { minX: number; maxX: number; minZ: number; maxZ: number };
  venues: BeachSpot[];
  clutter: BeachSpot[];
  boats: BeachSpot[];
  towels: TowelSpot[];
  pads: Array<{ x: number; z: number; radius: number }>;
}

/** Max half-diagonal of the venue footprints (see catalog maxFootprint) + breathing room. */
const VENUE_PAD_RADIUS = 15;
const VENUE_ROAD_CLEARANCE = 4;

const spotSeed = (x: number, z: number): number => Math.floor(rnd(x, z, 91) * 1_000_003);

function venueStrip(zMin: number, zMax: number, count: number, setback: number, skipMid = 0, kindShift = 0): BeachSpot[] {
  const out: BeachSpot[] = [];
  const mid = (zMin + zMax) / 2; const slot = (zMax - zMin) / count;
  for (let i = 0; i < count; i++) {
    const z = zMin + (i + 0.5) * slot + (rnd(zMin, i, 11) - 0.5) * slot * 0.4;
    if (skipMid > 0 && Math.abs(z - mid) < skipMid) continue;
    const x = coastXAt(z) + CREST_INLAND + setback + rnd(zMax, i, 12) * 4;
    if (distanceToRoadEdge(x, z) < VENUE_ROAD_CLEARANCE + VENUE_PAD_RADIUS * 0.6) continue;
    const kind = VENUE_KINDS[(i + kindShift) % VENUE_KINDS.length]!;
    out.push({ name: `seafront-${kind}`, x, z, heading: seawardHeading(z), seed: spotSeed(x, z), variant: Math.floor(rnd(x, z, 13) * 3) });
  }
  return out;
}

function beachClutter(zMin: number, zMax: number, names: readonly string[]): BeachSpot[] {
  const out: BeachSpot[] = [];
  names.forEach((name, i) => {
    const z = zMin + ((i + 0.5) / names.length) * (zMax - zMin) + (rnd(zMin, i, 21) - 0.5) * 14;
    const x = coastXAt(z) + CREST_INLAND - 6 - rnd(z, i, 22) * (SAND_BAND - 10); // on the dry sand below the crest
    out.push({ name, x, z, heading: rnd(x, z, 23) * Math.PI * 2, seed: spotSeed(x, z), variant: Math.floor(rnd(x, z, 24) * 3) });
  });
  return out;
}

/** Computes the full beachfront plan from map data. Exported for tests; BEACHFRONT memoizes it. */
export function computeBeachfront(): BeachfrontPlan {
  const empty: BeachfrontPlan = { venues: [], clutter: [], boats: [], towels: [], pads: [] };
  if (!HARBOUR_POINT || coastByZ.length < 2) return empty;

  // -- Kaapstad Quay: the pleasure pier + a venue arc around a paved quay apron ------------------
  const quayZ = HARBOUR_POINT.z;
  const crestX = coastXAt(quayZ) + CREST_INLAND;
  const pier = { x: crestX, z: quayZ, length: 120, width: 8.5, sign: 'KAAPSTAD QUAY' };
  const apron = { minX: crestX - 2, maxX: crestX + 42, minZ: quayZ - 34, maxZ: quayZ + 34 };
  const venues = venueStrip(quayZ - 95, quayZ + 95, 6, 13, 24);
  const boats: BeachSpot[] = [];
  for (let i = 0; i < 4; i++) {
    const z = quayZ - 76 + i * 44 + rnd(quayZ, i, 31) * 12;
    if (Math.abs(z - quayZ) < 16) continue; // keep the pier's water clear
    const x = coastXAt(z) - 12 - rnd(z, i, 32) * 18;
    boats.push({ name: 'moored-boat', x, z, heading: seawardHeading(z) + (rnd(x, z, 33) - 0.5) * 1.2, seed: spotSeed(x, z), variant: Math.floor(rnd(x, z, 34) * 3) });
  }
  const quayClutter = beachClutter(quayZ - 90, quayZ - 40, ['beach-loungers', 'ice-cream-kiosk']);

  // -- Bantry Bay: a venue arc following the bay + a lively beach below it ------------------------
  const bantry = districtCenter('Bantry Bay');
  const bayZ = bantry ? bantry.z : quayZ - 4000;
  const bayVenues = venueStrip(bayZ - 130, bayZ + 130, 7, 11, 0, 1);
  const bayClutter = beachClutter(bayZ - 120, bayZ + 120, ['lifeguard-tower', 'beach-loungers', 'surf-shack', 'beach-loungers', 'ice-cream-kiosk', 'beach-loungers']);
  const towels: TowelSpot[] = [];
  for (let i = 0; i < 22; i++) {
    const z = bayZ - 95 + (i / 22) * 190 + (rnd(bayZ, i, 41) - 0.5) * 9;
    const x = coastXAt(z) + CREST_INLAND - 5 - rnd(z, i, 42) * (SAND_BAND - 12);
    towels.push({ x, z, heading: rnd(x, z, 43) * Math.PI * 2, color: Math.floor(rnd(x, z, 44) * 4) });
  }

  const allVenues = [...venues, ...bayVenues];
  const allClutter = [...quayClutter, ...bayClutter];
  const pads = [
    { x: pier.x + 20, z: pier.z, radius: 42 }, // pier root + quay apron forecourt
    ...allVenues.map((v) => ({ x: v.x, z: v.z, radius: VENUE_PAD_RADIUS })),
    ...allClutter.map((c) => ({ x: c.x, z: c.z, radius: 9 })),
  ];
  return { pier, apron, venues: allVenues, clutter: allClutter, boats, towels, pads };
}

export const BEACHFRONT: BeachfrontPlan = computeBeachfront();
/** Crafted claims for RESERVED_PADS: procedural buildings + scatter keep clear of the beachfront. */
export const BEACHFRONT_PADS = BEACHFRONT.pads;
