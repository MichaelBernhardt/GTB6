import { WORLD_SIZE } from '../config';

export type TeleportKind = 'spawn' | 'district' | 'shop' | 'safehouse' | 'mission';
export interface TeleportTarget { name: string; x: number; z: number; kind: TeleportKind; }

/** Console-friendly name: lowercase, apostrophes dropped, every other non-alphanumeric run becomes one dash. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/['’‘]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Loose matching key: a query hits a target when their dashless slugs agree ("jozi arms" == "jozi-arms" == "joziarms"). */
const matchKey = (name: string): string => slugify(name).replace(/-/g, '');

/** One anchor per district, derived from the lookup itself: the sampled in-district point nearest that district's
 *  centroid — no hand-typed coordinates to drift out of date when the boundaries move. */
export function districtAnchors(lookup: (x: number, z: number) => string, extent = WORLD_SIZE / 2 - 30, step = 20): TeleportTarget[] {
  const districts = new Map<string, { sumX: number; sumZ: number; points: Array<{ x: number; z: number }> }>();
  for (let x = -extent; x <= extent; x += step) for (let z = -extent; z <= extent; z += step) {
    const name = lookup(x, z);
    const entry = districts.get(name) ?? { sumX: 0, sumZ: 0, points: [] };
    entry.sumX += x; entry.sumZ += z; entry.points.push({ x, z });
    districts.set(name, entry);
  }
  return [...districts.entries()].map(([name, entry]) => {
    const cx = entry.sumX / entry.points.length; const cz = entry.sumZ / entry.points.length;
    const anchor = entry.points.reduce((best, point) => (point.x - cx) ** 2 + (point.z - cz) ** 2 < (best.x - cx) ** 2 + (best.z - cz) ** 2 ? point : best);
    return { name: slugify(name), x: anchor.x, z: anchor.z, kind: 'district' as const };
  });
}

export interface TeleportSources {
  spawn: [number, number, number];
  districts: TeleportTarget[];
  shops: Array<{ name: string; pad: { x: number; z: number } }>;
  safehouses: Array<{ name: string; pad: { x: number; z: number } }>;
  missions: Array<{ id: string; start: { position: { x: number; z: number } } }>;
}

/** The whole gazetteer comes from live game data: spawn, district lookup, shop pads, safehouse pads, mission contacts. */
export function buildTeleportTargets(sources: TeleportSources): TeleportTarget[] {
  return [
    { name: 'spawn', x: sources.spawn[0], z: sources.spawn[2], kind: 'spawn' as const },
    ...sources.districts,
    ...sources.shops.map((shop) => ({ name: slugify(shop.name), x: shop.pad.x, z: shop.pad.z, kind: 'shop' as const })),
    ...sources.safehouses.map((place) => ({ name: slugify(place.name), x: place.pad.x, z: place.pad.z, kind: 'safehouse' as const })),
    ...sources.missions.map((mission) => ({ name: slugify(mission.id), x: mission.start.position.x, z: mission.start.position.z, kind: 'mission' as const })),
  ];
}

/** Exact (dash-insensitive) match first, then a prefix match — but only when the prefix is unambiguous. */
export function resolveTeleport(query: string, targets: TeleportTarget[]): TeleportTarget | undefined {
  const key = matchKey(query);
  if (!key) return undefined;
  const exact = targets.find((target) => matchKey(target.name) === key);
  if (exact) return exact;
  const prefixed = targets.filter((target) => matchKey(target.name).startsWith(key));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Coordinates the console accepts are pinned inside the playable world with a margin off the boundary wall. */
export const WORLD_LIMIT = WORLD_SIZE / 2 - 8;
export function clampToWorld(value: number): number { return Math.min(WORLD_LIMIT, Math.max(-WORLD_LIMIT, value)); }

/** Safe placement: keeps the exact spot when it is clear, otherwise walks outward ring by ring until the
 *  capsule fits — so a target inside a building nudges to its doorstep instead of embedding in the wall. */
export function safePlacement(x: number, z: number, blocked: (x: number, z: number) => boolean, maxRadius = 14, ringStep = 1.5): { x: number; z: number; clear: boolean } {
  if (!blocked(x, z)) return { x, z, clear: true };
  for (let radius = ringStep; radius <= maxRadius; radius += ringStep) {
    const spokes = Math.max(8, Math.round(radius * 4));
    for (let spoke = 0; spoke < spokes; spoke++) {
      const angle = (spoke / spokes) * Math.PI * 2;
      const px = x + Math.sin(angle) * radius; const pz = z + Math.cos(angle) * radius;
      if (!blocked(px, pz)) return { x: px, z: pz, clear: true };
    }
  }
  return { x, z, clear: false };
}
