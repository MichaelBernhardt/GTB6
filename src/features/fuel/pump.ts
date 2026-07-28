/**
 * PETROL — the forecourt itself: brands, apron geometry, the attendant's spot, the levies, the money.
 *
 * All of it LAZY. Nothing in this file is reachable until the fuel chunk lands, because none of it is
 * needed to burn a tank or draw a gauge. The eager half (src/features/fuel.state.ts) knows only that
 * a filling-station model stands at some (x, z, heading); this is where that becomes "Sasoil Melville,
 * pumps on the left, kiosk behind, R25.99 a litre".
 *
 * Pure functions over data — no scene objects, no module state. The live station list belongs to the
 * feature body, which owns its lifetime.
 */
import type { Forecourt } from '../fuel.state';
import { APRON_OFFSET } from '../fuel.state';

// ---- the levies and the money -----------------------------------------------------------------------

/** The levies inside every litre, cents. Real 2026-ish numbers: the joke lands on the state. */
export const LEVIES = { fuel: 429, raf: 225, carbon: 23 } as const;
export const LEVY_CENTS = LEVIES.fuel + LEVIES.raf + LEVIES.carbon;
/** 93 unleaded: the inland grade, and cheaper. On the Highveld it is the sensible buy, not a trap. */
export const GRADE_93_DISCOUNT_CENTS = 38;
/** Can + deposit, rand. */
export const CAN_PRICE = 175;

export const randText = (rand: number): string =>
  `R${Math.round(rand).toLocaleString('en-ZA')}`;
export const centsText = (cents: number): string => `R${(cents / 100).toFixed(2)}`;
export const litresText = (litres: number): string => `${litres.toFixed(1)} ℓ`;

/** Litres you get for a given rand at a given price, and the rand a given number of litres costs. */
export const litresFor = (rand: number, cents: number): number => (rand * 100) / cents;
export const randFor = (litres: number, cents: number): number => (litres * cents) / 100;

export function gradeCents(base: number, grade: 93 | 95): number {
  return grade === 95 ? base : base - GRADE_93_DISCOUNT_CENTS;
}

// ---- the forecourt ------------------------------------------------------------------------------------

/** Brands, in the same order buildFillingStation picks them, so the name on the prompt is the name on
 *  the sign above the pumps. Parody spellings are the model's, not ours. */
export const BRANDS: ReadonlyArray<{ name: string; accent: string }> = [
  { name: 'Engine', accent: '#d64541' },
  { name: 'Caltexx', accent: '#3d9970' },
  { name: 'Sasoil', accent: '#3f78b5' },
  { name: 'Boerepetrol', accent: '#e0a63c' },
];

export interface Station {
  readonly id: string;
  /** "Engine Melville" — brand off the sign, suburb off the district layer. */
  readonly name: string;
  readonly brand: string;
  readonly accent: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  /** Half-extents of the drivable apron in the station's own frame. */
  readonly halfW: number;
  readonly halfD: number;
  /** The apron is laid one unit forward of the model origin. */
  readonly offZ: number;
  /** Local x of each pump island; the attendant stands at the first one. */
  readonly islands: readonly number[];
}

type Hash = (seed: number, salt: number) => number;

/**
 * Turn a scattered filling-station model into a forecourt.
 *
 * Mirrors buildFillingStation exactly — size = kit.hash(seed, 2), canopy 14+4s x 9+2s, apron +6 x +8
 * at z+1 — so the rectangle the game tests against is the rectangle the player can see under their
 * wheels. `district` is passed in rather than looked up: the body has it on FeatureGameApi already.
 */
export function buildStation(hash: Hash, spot: Forecourt, district: string, label?: string): Station {
  const brand = BRANDS[Math.floor(hash(spot.seed, 3) * BRANDS.length) % BRANDS.length]!;
  const size = hash(spot.seed, 2);
  const canopyW = 14 + size * 4;
  const canopyD = 9 + size * 2;
  const islands = spot.variant % 3 === 0 ? [0] : [-canopyW * 0.18, canopyW * 0.18];
  return {
    id: spot.id, brand: brand.name, accent: brand.accent,
    name: label ?? `${brand.name} ${district}`,
    x: spot.x, z: spot.z, heading: spot.heading,
    halfW: (canopyW + 6) / 2, halfD: (canopyD + 8) / 2, offZ: APRON_OFFSET,
    islands,
  };
}

/** A forecourt standing on a site the MAP names — the dam-shore station, today — takes the map's
 *  name rather than "<Brand> <district>", so the label on the pump prompt is the label on the gold
 *  star the player drove towards. Generous reach: the scatter sets the forecourt beside the nearest
 *  road, which can be tens of units off the surveyed pin. */
export const LANDMARK_NAME_REACH = 90;

/** Every scattered forecourt, named. */
export function buildStations(
  spots: readonly Forecourt[], hash: Hash, district: (x: number, z: number) => string,
  named: ReadonlyArray<{ name: string; x: number; z: number }> = [],
): Station[] {
  return spots.map((spot) => {
    const pin = named.find((entry) => Math.hypot(entry.x - spot.x, entry.z - spot.z) <= LANDMARK_NAME_REACH);
    return buildStation(hash, spot, district(spot.x, spot.z), pin?.name);
  });
}

/** Squared distance helper that keeps the hot path allocation-free. */
function localOffset(site: Station, x: number, z: number): { lx: number; lz: number } {
  const dx = x - site.x; const dz = z - site.z;
  const c = Math.cos(-site.heading); const s = Math.sin(-site.heading);
  return { lx: dx * c + dz * s, lz: -dx * s + dz * c };
}

/** True when (x, z) is standing on this forecourt's apron. */
export function onApron(site: Station, x: number, z: number, slack = 0): boolean {
  if (Math.abs(x - site.x) > site.halfW + site.halfD + slack) return false; // cheap bbox reject
  const { lx, lz } = localOffset(site, x, z);
  return Math.abs(lx) <= site.halfW + slack && Math.abs(lz - site.offZ) <= site.halfD + slack;
}

/** The forecourt the given point is standing on, if any. */
export function stationAt(sites: readonly Station[], x: number, z: number, slack = 0): Station | undefined {
  for (const site of sites) if (onApron(site, x, z, slack)) return site;
  return undefined;
}

/** Nearest forecourt to a point, for the "your nearest garage is…" toast. */
export function nearestStation(sites: readonly Station[], x: number, z: number): { site: Station; distance: number } | undefined {
  let best: { site: Station; distance: number } | undefined;
  for (const site of sites) {
    const distance = Math.hypot(site.x - x, site.z - z);
    if (!best || distance < best.distance) best = { site, distance };
  }
  return best;
}

/** A point on the apron, in the station's own frame — used for the price-hike queue. */
export function apronPoint(site: Station, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(site.heading); const s = Math.sin(site.heading);
  return { x: site.x + lx * c + lz * s, z: site.z - lx * s + lz * c };
}

/** World position of the attendant's spot: beside the first pump island, on the driver's side. */
export function attendantSpot(site: Station): { x: number; z: number } {
  return apronPoint(site, (site.islands[0] ?? 0) - 2.6, site.offZ - 1.4);
}

/**
 * The kiosk door — where you buy the can, the Steri Stumpie and the airtime.
 *
 * Deliberately a tight ring rather than the whole apron: `Game.updateOnFoot` runs the feature ladder
 * one rung ABOVE "enter the nearest vehicle", so an on-foot offer that covered the forecourt would
 * stop you getting back into your own car at the pumps. Cars park at the pumps; the shop is behind
 * them. Mirrors buildFillingStation, which sets the kiosk at z = -canopyD/2 - 3.4.
 */
export function shopSpot(site: Station): { x: number; z: number } {
  const canopyD = site.halfD * 2 - 8;
  return apronPoint(site, 0, -canopyD / 2 - 0.9);
}
export const SHOP_REACH = 3.4;
