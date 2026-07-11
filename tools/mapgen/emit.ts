import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JoburgMap } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));

export type NameOverrides = Record<string, string>;

export function loadNameOverrides(): NameOverrides {
  const raw = JSON.parse(readFileSync(join(HERE, 'names-overrides.json'), 'utf8')) as Record<string, unknown>;
  const overrides: NameOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('_') || typeof value !== 'string' || value === '' || value === key) continue;
    overrides[key] = value;
  }
  return overrides;
}

/**
 * Apply comedy/parody renames to road (and junction road-list) names.
 * Pure: returns a new map object; unmatched names keep their real OSM name.
 */
export function applyNameOverrides(map: JoburgMap, overrides: NameOverrides): JoburgMap {
  const rename = (name: string): string => overrides[name] ?? name;
  return {
    ...map,
    roads: map.roads.map((road) => ({ ...road, name: rename(road.name) })),
    junctions: map.junctions.map((junction) => ({
      ...junction,
      roads: [...new Set(junction.roads.map(rename))].sort(),
    })),
    districts: map.districts.map((district) => ({ ...district, name: rename(district.name) })),
    landmarks: map.landmarks.map((landmark) => ({ ...landmark, name: rename(landmark.name) })),
  };
}
