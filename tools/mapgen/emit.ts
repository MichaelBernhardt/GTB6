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
    // Stations follow their namesakes: exact matches first, then a renamed district/road PREFIX
    // ('Marshalltown Station' must read 'Joburg CBD Station' once Marshalltown itself is renamed).
    stations: map.stations.map((station) => {
      let name = rename(station.name);
      if (name === station.name) {
        for (const [from, to] of Object.entries(overrides)) {
          if (name.startsWith(`${from} `) || name.startsWith(`${from}-`)) { name = to + name.slice(from.length); break; }
        }
      }
      return { ...station, name };
    }),
    landmarks: map.landmarks.map((landmark) => ({ ...landmark, name: rename(landmark.name) })),
    ...(map.rural ? { rural: { ...map.rural, padstal: { ...map.rural.padstal, name: rename(map.rural.padstal.name) } } } : {}),
    ...(map.airport ? { airport: { ...map.airport, name: rename(map.airport.name) } } : {}),
    ...(map.port ? { port: { ...map.port, name: rename(map.port.name) } } : {}),
  };
}
