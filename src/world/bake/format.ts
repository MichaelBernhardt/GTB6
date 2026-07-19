/**
 * City-bake artifact format (shared by tools/bake, the boot loader and the staleness test).
 *
 * The bake captures the expensive DETERMINISTIC boot derivations — the citywide parcel layout
 * (CityGen), the model scatter (ModelScatter) and the directed vehicle nav graph's edge topology —
 * exactly as the live passes produce them, so a hydrated boot is bit-for-bit the same world as a
 * derived one. Layout:
 *
 *   public/baked/city-manifest.json — counts, string tables, hashes, format version
 *   public/baked/city.bin           — structure-of-arrays sections, in DESCENDING element-size
 *                                     order (f64 → u32 → u16 → u8) so every typed-array view is
 *                                     naturally aligned with no padding
 *
 * Coordinates and headings are Float64 — the exact doubles the derivation computed — because the
 * determinism gate (bake.test.ts) demands hydrated === live-derived, not merely close.
 *
 * What is deliberately NOT baked: nav NODE positions (a ~20ms resample of the road network —
 * City rebuilds them live and pairs them with the baked edge lists, saving ~1.5MB of artifact)
 * and the ped nav graph (its ungated build is ~100ms — cheap enough to stay live). The vehicle
 * graph's EDGES are the expensive part: every junction turn is gated by on-tar sampling against
 * a road index, which is most of a second even on desktop.
 *
 * Everything here is pure data (no THREE, no DOM, no fs) so the same code runs in Node, the
 * browser and vitest.
 */
import type { GeneratedBuilding } from '../CityGen';
import type { ScatteredModel } from '../ModelScatter';
import type { NavGraph } from '../../systems/NavGraph';
import type { BuildingStyle } from '../BuildingArchitecture';
import type { Zone } from '../data/zoning';

/** Bump when the packed layout or the hydration contract changes — a mismatched artifact is
 *  ignored at boot (live derivation runs) and fails the staleness gate until re-baked. */
export const BAKE_FORMAT_VERSION = 1;

/** What the generator packs: the full live-derived state (nodes are recorded only as a count). */
export interface CityBakeInput {
  buildings: readonly GeneratedBuilding[];
  scatter: readonly ScatteredModel[];
  vehicleNav: NavGraph;
}

/** What a reader gets back: parcels, scatter and the vehicle edge lists. The edge lists pair with
 *  live-rebuilt lane nodes (City.installBakedVehicleNav) — vehicleNodeCount guards the pairing. */
export interface CityBakeData {
  buildings: GeneratedBuilding[];
  scatter: ScatteredModel[];
  vehicleNodeCount: number;
  vehicleEdges: number[][];
}

export interface BakeManifest {
  formatVersion: number;
  /** Hash of the map data both sides can compute identically (JSON.stringify of the imported map
   *  module) — a boot whose shipped map JSON no longer matches the bake falls back to live derivation. */
  mapDataHash: string;
  /** Hash over the derivation source files (diagnostics only — the CI gate compares CONTENT). */
  sourcesHash: string;
  counts: { buildings: number; scatter: number; vehicleNodes: number; vehicleEdges: number };
  /** String tables — packed records store u8/u16 indices into these. */
  styles: string[];
  zones: string[];
  models: string[];
  binBytes: number;
}

/** cyrb53-derived 64-bit hash, hex string. Deterministic across JS engines (pure ES arithmetic). */
export function hashString(text: string): string {
  let h1 = 0xdeadbeef; let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Total edge count of a nav graph's adjacency lists. */
export const edgeCount = (edges: readonly number[][]): number => edges.reduce((sum, list) => sum + list.length, 0);

interface Section { array: Float64Array | Uint32Array | Uint16Array | Uint8Array }

/** Sections in pack order — f64 blocks first, then u32, u16, u8, so offsets stay aligned. */
function buildSections(bake: CityBakeInput, manifest: BakeManifest): Section[] {
  const { buildings, scatter, vehicleNav } = bake;
  const styleIndex = new Map(manifest.styles.map((name, index) => [name, index]));
  const zoneIndex = new Map(manifest.zones.map((name, index) => [name, index]));
  const modelIndex = new Map(manifest.models.map((name, index) => [name, index]));

  const pickF64 = <T>(items: readonly T[], pick: (item: T) => number): Float64Array =>
    Float64Array.from(items, pick);
  const nodeCount = vehicleNav.nodes.length;
  const offsets = new Uint32Array(nodeCount + 1);
  const targets = new Uint32Array(edgeCount(vehicleNav.edges));
  let cursor = 0;
  for (let i = 0; i < nodeCount; i++) {
    offsets[i] = cursor;
    for (const target of vehicleNav.edges[i]!) targets[cursor++] = target;
  }
  offsets[nodeCount] = cursor;

  return [
    // f64 —
    { array: pickF64(buildings, (b) => b.x) }, { array: pickF64(buildings, (b) => b.z) },
    { array: pickF64(buildings, (b) => b.heading) }, { array: pickF64(buildings, (b) => b.width) },
    { array: pickF64(buildings, (b) => b.depth) }, { array: pickF64(buildings, (b) => b.height) },
    { array: pickF64(scatter, (m) => m.x) }, { array: pickF64(scatter, (m) => m.z) }, { array: pickF64(scatter, (m) => m.heading) },
    // u32 —
    { array: Uint32Array.from(scatter, (model) => model.seed) },
    { array: offsets }, { array: targets },
    // u16 —
    { array: Uint16Array.from(buildings, (b) => b.variant) },
    { array: Uint16Array.from(scatter, (model) => model.variant) },
    { array: Uint16Array.from(scatter, (model) => modelIndex.get(model.name)!) },
    // u8 —
    { array: Uint8Array.from(buildings, (b) => styleIndex.get(b.style)!) },
    { array: Uint8Array.from(buildings, (b) => zoneIndex.get(b.zone)!) },
  ];
}

/** Build the manifest for a bake (string tables sorted so identical inputs give identical bytes). */
export function buildManifest(bake: CityBakeInput, mapDataHash: string, sourcesHash: string): BakeManifest {
  const styles = [...new Set(bake.buildings.map((b) => b.style))].sort();
  const zones = [...new Set(bake.buildings.map((b) => b.zone))].sort();
  const models = [...new Set(bake.scatter.map((model) => model.name))].sort();
  const manifest: BakeManifest = {
    formatVersion: BAKE_FORMAT_VERSION,
    mapDataHash, sourcesHash,
    counts: {
      buildings: bake.buildings.length,
      scatter: bake.scatter.length,
      vehicleNodes: bake.vehicleNav.nodes.length,
      vehicleEdges: edgeCount(bake.vehicleNav.edges),
    },
    styles, zones, models,
    binBytes: 0,
  };
  manifest.binBytes = buildSections(bake, manifest).reduce((sum, section) => sum + section.array.byteLength, 0);
  return manifest;
}

/** Serialize the bake into the manifest's binary layout. */
export function packBake(bake: CityBakeInput, manifest: BakeManifest): Uint8Array {
  const sections = buildSections(bake, manifest);
  const out = new Uint8Array(sections.reduce((sum, section) => sum + section.array.byteLength, 0));
  let offset = 0;
  for (const section of sections) {
    out.set(new Uint8Array(section.array.buffer, section.array.byteOffset, section.array.byteLength), offset);
    offset += section.array.byteLength;
  }
  return out;
}

/** Deserialize a packed bake. Throws on any structural mismatch — callers treat that as "no bake". */
export function unpackBake(manifest: BakeManifest, bin: ArrayBuffer): CityBakeData {
  if (manifest.formatVersion !== BAKE_FORMAT_VERSION) throw new Error(`bake format ${manifest.formatVersion}, runtime expects ${BAKE_FORMAT_VERSION}`);
  if (bin.byteLength !== manifest.binBytes) throw new Error(`bake bin is ${bin.byteLength} bytes, manifest says ${manifest.binBytes}`);
  const { buildings: B, scatter: S, vehicleNodes, vehicleEdges } = manifest.counts;
  let offset = 0;
  const f64 = (length: number): Float64Array => { const view = new Float64Array(bin, offset, length); offset += length * 8; return view; };
  const u32 = (length: number): Uint32Array => { const view = new Uint32Array(bin, offset, length); offset += length * 4; return view; };
  const u16 = (length: number): Uint16Array => { const view = new Uint16Array(bin, offset, length); offset += length * 2; return view; };
  const u8 = (length: number): Uint8Array => { const view = new Uint8Array(bin, offset, length); offset += length; return view; };

  const bx = f64(B); const bz = f64(B); const bheading = f64(B); const bwidth = f64(B); const bdepth = f64(B); const bheight = f64(B);
  const sx = f64(S); const sz = f64(S); const sheading = f64(S);
  const seed = u32(S);
  const offsets = u32(vehicleNodes + 1); const targets = u32(vehicleEdges);
  const bvariant = u16(B); const svariant = u16(S); const snameIdx = u16(S);
  const bstyleIdx = u8(B); const bzoneIdx = u8(B);
  if (offset !== manifest.binBytes) throw new Error(`bake sections end at ${offset}, manifest says ${manifest.binBytes}`);

  const buildings: GeneratedBuilding[] = Array.from({ length: B }, (_, i) => ({
    x: bx[i]!, z: bz[i]!, heading: bheading[i]!, width: bwidth[i]!, depth: bdepth[i]!, height: bheight[i]!,
    style: manifest.styles[bstyleIdx[i]!]! as BuildingStyle,
    zone: manifest.zones[bzoneIdx[i]!]! as Zone,
    variant: bvariant[i]!,
  }));
  const scatter: ScatteredModel[] = Array.from({ length: S }, (_, i) => ({
    name: manifest.models[snameIdx[i]!]!,
    x: sx[i]!, z: sz[i]!, heading: sheading[i]!, seed: seed[i]!, variant: svariant[i]!,
  }));
  return {
    buildings, scatter,
    vehicleNodeCount: vehicleNodes,
    vehicleEdges: Array.from({ length: vehicleNodes }, (_, i) => Array.from(targets.subarray(offsets[i]!, offsets[i + 1]!))),
  };
}
