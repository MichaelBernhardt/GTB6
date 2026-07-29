/**
 * The unpaved ways — the map's `tracks` layer — and the two rules that keep them in the world.
 *
 * The bug these exist for: the map screen (ui/mapRender) draws EVERY entry of the tracks layer,
 * grouped by kind, filtering nothing. mapData kept only `kind === 'track'` and dropped the rest, so
 * 206 of 259 entries were dashed lines on the map and nothing at all in the world — the owner stood
 * at (2855, -821), saw a trail on his map and found bare veld. Separately, tracks were laid one
 * centimetre BELOW the park drape, so the quarter of them running through green polygons (which is
 * most of the mountain two-tracks) was painted over by the lawn.
 */
import { describe, expect, it } from 'vitest';
import rawMap from './generated/joburg-map.json';
import { GENERATED_PATHS, GENERATED_TRACKS, GENERATED_UNPAVED_COUNT } from './mapData';
import {
  FOOTPATH_SURFACE_OFFSET, FOOTPATH_WIDTH_SCALE, GROUND_COVER_LIFT, PATH_NETWORK,
  ROAD_SURFACE_OFFSET, TRACK_SURFACE_OFFSET, TRACK_NETWORK,
} from './City';

const RAW = rawMap as unknown as { tracks: Array<{ kind: string; width: number; points: [number, number][] }> };

describe('the unpaved ways of the tracks layer', () => {
  it('accounts for EVERY entry the map screen draws — none may be silently dropped', () => {
    // mapRender groups map.tracks by kind and filters nothing, so the world must partition the same
    // array exactly. If the pipeline ever emits a third kind this fails, instead of the new kind
    // quietly becoming another set of map lines with nothing under them.
    expect(GENERATED_TRACKS.length + GENERATED_PATHS.length).toBe(GENERATED_UNPAVED_COUNT);
    expect(GENERATED_UNPAVED_COUNT).toBe(RAW.tracks.length);
    expect(new Set(RAW.tracks.map((entry) => entry.kind))).toEqual(new Set(['track', 'path']));
  });

  it('carries both kinds through to a renderable network', () => {
    expect(TRACK_NETWORK.length).toBeGreaterThan(10);
    expect(PATH_NETWORK.length).toBeGreaterThan(100); // the 200-odd trails that used to render as nothing
    expect(GENERATED_TRACKS.every((track) => track.kind === 'track')).toBe(true);
    expect(GENERATED_PATHS.every((path) => path.kind === 'path')).toBe(true);
    for (const network of [TRACK_NETWORK, PATH_NETWORK]) {
      expect(network.every((way) => way.points.length >= 2)).toBe(true);
      expect(network.every((way) => way.width > 0 && way.width <= 6)).toBe(true);
    }
  });

  it('covers the owner-reported coordinate with a way that now renders', () => {
    // (2855.3, -821.254): he reported tracks on the map that were not in the world. Every nearby
    // entry is a footpath, which is exactly the set that used to be dropped.
    const near = [...GENERATED_TRACKS, ...GENERATED_PATHS].filter((way) => way.points.some(
      (point) => Math.hypot(point.x - 2855.3, point.z + 821.254) < 40,
    ));
    expect(near.length).toBeGreaterThan(0);
    expect(near.some((way) => way.kind === 'path')).toBe(true);
  });

  it('lays every unpaved way ABOVE the ground cover and BELOW the tar', () => {
    // The ordering that decides what the player sees where these surfaces overlap. Drop either
    // unpaved lift under GROUND_COVER_LIFT and the park lawn paints over it again.
    expect(FOOTPATH_SURFACE_OFFSET).toBeGreaterThan(GROUND_COVER_LIFT);
    expect(TRACK_SURFACE_OFFSET).toBeGreaterThan(FOOTPATH_SURFACE_OFFSET);
    expect(TRACK_SURFACE_OFFSET).toBeLessThan(ROAD_SURFACE_OFFSET);
  });

  it('narrows footpaths well below their nominal mapped width', () => {
    // OSM gives every path the same 3 u; at that width a trodden line reads as a dirt road.
    expect(FOOTPATH_WIDTH_SCALE).toBeLessThan(0.7);
    expect(Math.max(...PATH_NETWORK.map((path) => path.width * FOOTPATH_WIDTH_SCALE))).toBeLessThan(2.2);
  });

  it('keeps footpaths out of the road index inputs', () => {
    // PATH_NETWORK must never become TRACK_NETWORK: the road index gates tree scatter and vehicle
    // nav, both of which are baked, so a footpath joining it would perturb the city bake.
    const trackNames = new Set(TRACK_NETWORK.map((track) => track.name));
    expect(PATH_NETWORK.some((path) => trackNames.has(path.name) && path.width * FOOTPATH_WIDTH_SCALE === path.width)).toBe(false);
    expect(TRACK_NETWORK.length).toBe(GENERATED_TRACKS.length);
  });
});
