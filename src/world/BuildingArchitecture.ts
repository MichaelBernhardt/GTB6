import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export type BuildingStyle =
  | 'downtown'
  | 'mixed-use'
  | 'dense-residential'
  | 'suburban'
  | 'industrial'
  | 'estate'
  | 'rural';

export type ResidentialRoofPalette = 'terracotta' | 'slate' | 'corrugated-green' | 'weathered-zinc';

/** Stable variation for the pitched-roof suburbs. Keeping this pure makes generated chunks deterministic
 * while breaking up the old unbroken sea of identical red tile. */
export function residentialRoofPalette(variant: number): ResidentialRoofPalette {
  const palettes: readonly ResidentialRoofPalette[] = ['terracotta', 'slate', 'corrugated-green', 'weathered-zinc'];
  return palettes[((variant % palettes.length) + palettes.length) % palettes.length]!;
}

export const ARCHITECTURE_VARIANTS: Record<BuildingStyle, number> = {
  downtown: 11,
  'mixed-use': 5,
  'dense-residential': 6,
  suburban: 9,
  industrial: 9,
  estate: 8,
  rural: 4,
};

export interface BuildingSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  style: BuildingStyle;
  variant: number;
  facade: THREE.Material;
  roof: THREE.Material;
  /** World-space width/height represented by one repeat of the facade atlas. */
  facadeTile?: { width: number; height: number };
}

/** One solid massing volume in world XZ and building-local Y (the city lifts y by the parcel's terrain height).
 *  `kind` is 'wall' for a boundary/garden wall run — still a collider, but not part of the building, so
 *  the entrance planner never hangs a front door on one (see planEntrance). */
export interface MassingTier { minX: number; maxX: number; minZ: number; maxZ: number; y0: number; y1: number; kind?: 'wall'; }

export interface BuildingProfile {
  roofY: number;
  massing: number;
  /** Every stacked box of the massing, bottom tier first — the collision registry mirrors these exactly.
   *  Gable roofs are left out: the player stands on the eaves plane beneath them. */
  tiers: MassingTier[];
  /** Pitched roof volumes (decorative, no collider) so dressing can find the real surface under it. */
  gables: GableSpec[];
  /** Where this building's front door is — undefined when the massing offers no street-facing
   *  ground-floor wall wide enough to hang one on. See EntranceTag. */
  entrance?: EntranceTag;
}

/**
 * THE DOOR, RECORDED BY THE PASS THAT DRAWS IT.
 *
 * The facade pass already decides where a building's entrance goes — City.addEntrance hangs a glazed
 * leaf and a canopy on the front wall, and it has always known the answer at the moment it draws it.
 * It used to keep that to itself, so anything else that wanted to know where a door was had to guess
 * from the parcel rectangle, and guessing is how you end up with a doorstep floating in a front yard
 * eleven units clear of the wall it belongs to (the front plane is set back from `depth/2` on about a
 * third of this city's massings, by up to half the parcel depth).
 *
 * So the entrance is a FACT now: planned here, drawn from here, and read from here. A door cannot
 * disagree with the model that drew it, because there is only one of them.
 *
 * Coordinates are building-local, exactly like MassingTier: the chunk builder rotates the whole
 * building by its heading, and CityGen aims local +z at the street it fronts.
 */
export interface EntranceTag {
  /** Along the front wall. Zero — the centre — is where the facade pass hangs the leaf. */
  readonly x: number;
  /** The wall plane the leaf is mounted on: the real front face, not the parcel edge. */
  readonly z: number;
  /** Clear width of the opening. */
  readonly width: number;
  /** Head height of the opening. */
  readonly height: number;
  /** What the model drew there. The interior grammar reads this to decide what is behind it. */
  readonly kind: EntranceKind;
}

export type EntranceKind = 'lobby' | 'shopfront' | 'porch' | 'dock';

/** Which opening each structural family puts at street level. Mirrors the detail passes: mixed-use
 *  gets shop bays, downtown and dense-residential a glazed lobby, houses a porch, works a roller dock. */
const ENTRANCE_KIND: Record<BuildingStyle, EntranceKind> = {
  downtown: 'lobby',
  'mixed-use': 'shopfront',
  'dense-residential': 'lobby',
  suburban: 'porch',
  estate: 'porch',
  rural: 'porch',
  industrial: 'dock',
};

/** Height the leaf is centred at — the same 1.72 the facade pass has always used. */
const ENTRANCE_Y = 1.72;
/** Full head height of an opening, when the wall behind it is tall enough to carry one. */
const ENTRANCE_H = 3.1;
/** Below this the wall is a parapet, not a facade, and nothing is drawn on it. */
const MIN_ENTRANCE_H = 2.15;
/** A single leaf. Narrower than this is a hatch, and the interior's own doorway would not fit it. */
const MIN_ENTRANCE_W = 1.6;

/**
 * WHERE THIS BUILDING'S WAY IN IS. Every building has one.
 *
 * It used to have a second clause — the facade pass's own `detailed` rule (`variant % 2 === 0`
 * outside the three always-detailed families) — on the argument that a building with no drawn leaf
 * must not offer a door. That was backwards. It shut 757 of this city's 3,722 parcels, nearly all of
 * them houses, and a house is the building a player is most likely to walk up to. The tag is what
 * City draws the leaf FROM, so tagging one more building does not make a door disagree with a model:
 * it makes the model draw a door. The parity rule now governs only the ornament it was written for.
 *
 * TWO PLACES TO LOOK, in order:
 *  1. The centre line. This is where the facade pass has always hung the leaf, so every building that
 *     already had a tag keeps exactly the tag it had — byte for byte, same x, same z, same width.
 *  2. Failing that, the street-facing span that can actually carry an opening. Winged, twin-shed,
 *     split-slab and paired-cottage massings have no wall ACROSS their centre at all — the centre
 *     line is the gap between two wings — and the three-unit walk-up's centre bay is a hair narrower
 *     than the leaf it was asked to hold. Between them that left 131 buildings with a blank facade
 *     and no way in. The door goes on the frontmost, then widest, then most central of the real
 *     spans, NARROWED to the span that carries it; ties break left, so the answer is a pure function
 *     of the massing.
 *
 * Boundary walls are excluded from both. A garden wall stands in FRONT of the house it encloses, so
 * the frontmost span on an estate parcel is the wall, not the villa — and a front door hung on a
 * garden wall is the doorstep-in-the-front-yard bug this tag was introduced to kill.
 */
export function planEntrance(
  width: number, style: BuildingStyle, tiers: readonly MassingTier[],
): EntranceTag | undefined {
  const want = Math.min(5.5, width * 0.32);
  const mass = tiers.filter((tier) => tier.kind !== 'wall');
  const kind = ENTRANCE_KIND[style];
  const centre = frontFacadeZAt(mass, 0, ENTRANCE_Y, want / 2);
  if (centre !== undefined) return sized(0, centre, want, kind, mass);
  let low = Infinity; let high = -Infinity;
  for (const tier of mass) { if (tier.minX < low) low = tier.minX; if (tier.maxX > high) high = tier.maxX; }
  if (!(high > low)) return undefined;
  let best: FrontFacadeSpan | undefined;
  for (const span of frontFacadeSpansAt(mass, ENTRANCE_Y, low, high)) {
    if (span.maxX - span.minX < MIN_ENTRANCE_W + 0.3) continue;
    if (!best || better(span, best, want)) best = span;
  }
  if (!best) return undefined;
  return sized((best.minX + best.maxX) / 2, best.z, Math.min(want, best.maxX - best.minX - 0.3), kind, mass);
}

/** A span that carries the whole leaf beats one that does not — otherwise a 2 m bay window in front
 *  of a 12 m wall would take the door. Then the frontmost, the widest, the most central, and finally
 *  the left one, so a symmetrical massing still has exactly one answer. */
function better(span: FrontFacadeSpan, best: FrontFacadeSpan, want: number): boolean {
  const epsilon = 1e-4;
  const width = span.maxX - span.minX; const bestWidth = best.maxX - best.minX;
  const carries = width >= want + 0.3; const bestCarries = bestWidth >= want + 0.3;
  if (carries !== bestCarries) return carries;
  if (Math.abs(span.z - best.z) > epsilon) return span.z > best.z;
  if (Math.abs(width - bestWidth) > epsilon) return width > bestWidth;
  const centre = Math.abs(span.minX + span.maxX); const bestCentre = Math.abs(best.minX + best.maxX);
  if (Math.abs(centre - bestCentre) > epsilon) return centre < bestCentre;
  return span.minX < best.minX;
}

/** The opening, cut down to the wall that carries it: a 3.1 m head on a 2.6 m shed wall is a hole in
 *  the roof. Under MIN_ENTRANCE_H there is no facade to hang anything on and the building has no tag. */
function sized(x: number, z: number, width: number, kind: EntranceKind, mass: readonly MassingTier[]): EntranceTag | undefined {
  const top = massingTopAt(mass, x, z - 1e-3);
  const height = top === undefined ? ENTRANCE_H : Math.min(ENTRANCE_H, top - 0.35);
  if (height < MIN_ENTRANCE_H) return undefined;
  return { x, z, width, height, kind };
}

/** A gable (or thatch) roof in building-local coordinates: ridge along local z at lx=0, apex `rise`
 *  above the eaves plane `y`, optionally yawed by `ry` (only quarter turns are used). */
export interface GableSpec { x: number; z: number; width: number; depth: number; y: number; rise: number; ry: number; }

/** Top of the tallest massing box covering a local point — the flat roof surface there, if any. */
export function massingTopAt(tiers: readonly MassingTier[], x: number, z: number): number | undefined {
  const epsilon = 1e-4; let top: number | undefined;
  for (const tier of tiers) {
    if (x < tier.minX - epsilon || x > tier.maxX + epsilon || z < tier.minZ - epsilon || z > tier.maxZ + epsilon) continue;
    if (top === undefined || tier.y1 > top) top = tier.y1;
  }
  return top;
}

/** Height of the highest pitched roof surface over a local point, if any gable covers it. */
export function gableSurfaceAt(gables: readonly GableSpec[], x: number, z: number): number | undefined {
  let top: number | undefined;
  for (const gable of gables) {
    const dx = x - gable.x; const dz = z - gable.z;
    const c = Math.cos(gable.ry); const s = Math.sin(gable.ry);
    const lx = dx * c - dz * s; const lz = dx * s + dz * c;
    if (Math.abs(lx) > gable.width / 2 || Math.abs(lz) > gable.depth / 2) continue;
    const surface = gable.y + gable.rise * (1 - Math.abs(lx) / (gable.width / 2));
    if (top === undefined || surface > top) top = surface;
  }
  return top;
}

/** The actual roof surface (flat tier top or pitched gable) directly under a local point. Roof
 *  dressing must anchor here, never at the building-wide roofY — on stepped or gabled massings
 *  the tallest feature (stack, silo, ridge, tower) is far above the roof at most other spots. */
export function roofSurfaceAt(tiers: readonly MassingTier[], gables: readonly GableSpec[], x: number, z: number): number | undefined {
  const flat = massingTopAt(tiers, x, z); const pitched = gableSurfaceAt(gables, x, z);
  if (flat === undefined) return pitched;
  return pitched === undefined ? flat : Math.max(flat, pitched);
}

/** Extend only the building volumes that actually meet the ground down to a common foundation base.
 *  Keeping each footprint separate prevents the levelling foundation from becoming a parcel-sized box
 *  around stepped, winged, or otherwise irregular buildings on sloped terrain. */
export function foundationTiers(tiers: readonly MassingTier[], bottomY: number): MassingTier[] {
  if (tiers.length === 0) return [];
  const groundY = Math.min(...tiers.map((tier) => tier.y0));
  return tiers
    .filter((tier) => Math.abs(tier.y0 - groundY) < 1e-4)
    .map((tier) => ({ ...tier, y0: bottomY, y1: tier.y0 }));
}

export interface FrontFacadeSpan { minX: number; maxX: number; z: number; }

/** Street-facing (+z) surface supporting a detail at one local x/y point. Requiring the tier to cover
 *  the detail's full width prevents windows and doors from hanging across the edge of a narrow wing. */
export function frontFacadeZAt(tiers: readonly MassingTier[], x: number, y: number, halfWidth = 0): number | undefined {
  const epsilon = 1e-4; let front: number | undefined;
  for (const tier of tiers) {
    if (y < tier.y0 - epsilon || y > tier.y1 + epsilon) continue;
    if (x - halfWidth < tier.minX - epsilon || x + halfWidth > tier.maxX + epsilon) continue;
    if (front === undefined || tier.maxZ > front) front = tier.maxZ;
  }
  return front;
}

/** Visible street-facing spans at a height, clipped to a requested trim range. Stepped and offset
 *  massing can expose several front planes; returning them separately keeps each strip on a real wall. */
export function frontFacadeSpansAt(tiers: readonly MassingTier[], y: number, minX: number, maxX: number): FrontFacadeSpan[] {
  if (!(maxX > minX)) return [];
  const epsilon = 1e-4;
  const active = tiers.filter((tier) =>
    y >= tier.y0 - epsilon && y <= tier.y1 + epsilon && tier.maxX > minX + epsilon && tier.minX < maxX - epsilon
  );
  const edges = [minX, maxX];
  for (const tier of active) {
    edges.push(Math.max(minX, tier.minX), Math.min(maxX, tier.maxX));
  }
  edges.sort((a, b) => a - b);
  const unique = edges.filter((edge, index) => index === 0 || Math.abs(edge - edges[index - 1]!) > epsilon);
  const spans: FrontFacadeSpan[] = [];
  for (let index = 0; index < unique.length - 1; index++) {
    const left = unique[index]!; const right = unique[index + 1]!;
    if (right - left <= epsilon) continue;
    const centre = (left + right) / 2;
    const z = frontFacadeZAt(active, centre, y, Math.max(0, (right - left) / 2 - epsilon));
    if (z === undefined) continue;
    const previous = spans[spans.length - 1];
    if (previous && Math.abs(previous.maxX - left) <= epsilon && Math.abs(previous.z - z) <= epsilon) previous.maxX = right;
    else spans.push({ minX: left, maxX: right, z });
  }
  return spans;
}

/** Widest real street-facing wall at a height. Offset/stepped sheds often have no wall at local x=0,
 * so centre-probing would silently drop their loading bay and sign even though a broad wing is visible. */
export function widestFrontFacadeSpanAt(
  tiers: readonly MassingTier[], y: number, minX: number, maxX: number, minimumWidth = 0,
): FrontFacadeSpan | undefined {
  let widest: FrontFacadeSpan | undefined;
  for (const span of frontFacadeSpansAt(tiers, y, minX, maxX)) {
    const width = span.maxX - span.minX;
    if (width < minimumWidth) continue;
    const widestWidth = widest ? widest.maxX - widest.minX : -Infinity;
    // A tie goes to the wall nearest the street, which avoids dressing an exposed rear step.
    if (width > widestWidth + 1e-4 || (Math.abs(width - widestWidth) <= 1e-4 && span.z > widest!.z)) widest = span;
  }
  return widest;
}

const boxMaterials = (facade: THREE.Material, roof: THREE.Material): THREE.Material[] => [facade, facade, roof, roof, facade, facade];

/** Scale only the four wall UV groups on BoxGeometry/RoundedBoxGeometry. Roof groups retain their
 * 0..1 UVs. Both geometries dedicate vertices per face, so side/front repeats cannot fight. */
export function scaleBoxFacadeUvs(
  geometry: THREE.BufferGeometry, width: number, height: number, depth: number,
  tile: { width: number; height: number },
): THREE.BufferGeometry {
  const uv = geometry.getAttribute('uv');
  if (!uv || !(tile.width > 0) || !(tile.height > 0)) return geometry;
  const index = geometry.index;
  for (const group of geometry.groups) {
    const face = group.materialIndex ?? 0;
    if (face === 2 || face === 3) continue; // top / underside use the roof material
    const horizontal = face === 0 || face === 1 ? depth : width;
    const repeatX = Math.max(1, horizontal / tile.width);
    const repeatY = Math.max(1, height / tile.height);
    const seen = new Set<number>(); // indexed BoxGeometry references each corner in two triangles
    for (let cursor = group.start; cursor < group.start + group.count; cursor++) {
      const vertex = index ? index.getX(cursor) : cursor;
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      uv.setXY(vertex, uv.getX(vertex) * repeatX, uv.getY(vertex) * repeatY);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

const createGableGeometry = (width: number, depth: number, rise: number): THREE.BufferGeometry => {
  const halfW = width / 2; const halfD = depth / 2;
  const vertices = [
    -halfW, 0, -halfD, halfW, 0, -halfD, 0, rise, -halfD,
    -halfW, 0, halfD, halfW, 0, halfD, 0, rise, halfD,
  ];
  const indices = [0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 2, 1, 4, 2, 4, 5, 1, 0, 3, 1, 3, 4];
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(vertices.length / 3 * 2), 2)); geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
};

export class BuildingArchitecture {
  private stone = new THREE.MeshStandardMaterial({ color: 0xc5c2b4, roughness: 0.75 });
  private darkMetal = new THREE.MeshStandardMaterial({ color: 0x283336, metalness: 0.72, roughness: 0.34 });
  private steel = new THREE.MeshStandardMaterial({ color: 0x596568, metalness: 0.6, roughness: 0.44 });
  private glass = new THREE.MeshPhysicalMaterial({ color: 0x335f69, roughness: 0.12, metalness: 0.2, clearcoat: 0.82 });
  private timber = new THREE.MeshStandardMaterial({ color: 0x704b32, roughness: 0.82 });
  private terracotta = new THREE.MeshStandardMaterial({ color: 0xa14b36, roughness: 0.84 });
  private slateRoof = new THREE.MeshStandardMaterial({ color: 0x485255, roughness: 0.9, metalness: 0.04 });
  private greenRoof = new THREE.MeshStandardMaterial({ color: 0x496a5b, roughness: 0.68, metalness: 0.24 });
  private zincRoof = new THREE.MeshStandardMaterial({ color: 0x8a8c84, roughness: 0.7, metalness: 0.32 });
  private plaster = new THREE.MeshStandardMaterial({ color: 0xd8cdb6, roughness: 0.88 });
  private pool = new THREE.MeshStandardMaterial({ color: 0x2f8fb8, roughness: 0.18, metalness: 0.1 });
  private thatch = new THREE.MeshStandardMaterial({ color: 0x8a7648, roughness: 1 });
  private court = new THREE.MeshStandardMaterial({ color: 0x2f6a4e, roughness: 0.92 });
  private solarGlass = new THREE.MeshStandardMaterial({ color: 0x183f54, roughness: 0.22, metalness: 0.42 });
  private tankPlastic = new THREE.MeshStandardMaterial({ color: 0x203b30, roughness: 0.82 });

  private tiers: MassingTier[] = [];
  private gables: GableSpec[] = [];
  /** False while planning: the massing arithmetic runs exactly as it does for a real build, but no
   *  geometry is allocated. See plan(). */
  private drawing = true;

  constructor(private parent: THREE.Group) {}

  /** Retarget where subsequent build() output is added — the on-demand chunk builder points this at
   *  a fresh per-building group so the whole building can be rotated to face its street as a unit. */
  retarget(parent: THREE.Group): void { this.parent = parent; }

  build(spec: BuildingSpec): BuildingProfile {
    this.tiers = [];
    this.gables = [];
    const massing = spec.variant % ARCHITECTURE_VARIANTS[spec.style];
    const roofY = this.massing(spec, massing);
    if (this.drawing) this.addStructuralDetail(spec, massing, roofY);
    return {
      roofY, massing, tiers: this.tiers, gables: this.gables,
      entrance: planEntrance(spec.width, spec.style, this.tiers),
    };
  }

  /**
   * The massing and the door WITHOUT the meshes — the same arithmetic, none of the allocation.
   *
   * Anything that needs to know a building's shape before (or without) the player being close enough
   * for the chunk builder to have drawn it goes through here: the interior feature asks every parcel
   * on the block where its front door is, which at ~2.7 ms of RoundedBoxGeometry per building would
   * have been a visible hitch on every cell you walk into. Planning is arithmetic, so it is ~200×
   * cheaper, and because it is the SAME code path the plan cannot drift from the build.
   *
   * Decorative meshes are skipped wholesale (they are never collision tiers); the handful of massing
   * volumes that push a tier directly still do so, so `tiers` is identical either way — the test
   * suite holds plan() and build() to exactly equal tiers across every family and variant.
   */
  plan(spec: BuildingSpec): BuildingProfile {
    this.drawing = false;
    try { return this.build(spec); } finally { this.drawing = true; }
  }

  private massing(spec: BuildingSpec, massing: number): number {
    return spec.style === 'downtown' ? this.buildDowntown(spec, massing)
      : spec.style === 'mixed-use' ? this.buildMixedUse(spec, massing)
        : spec.style === 'dense-residential' ? this.buildDenseResidential(spec, massing)
          : spec.style === 'suburban' ? this.buildSuburban(spec, massing)
            : spec.style === 'industrial' ? this.buildIndustrial(spec, massing)
              : spec.style === 'estate' ? this.buildEstate(spec, massing)
                : this.buildRural(spec, massing);
  }

  /** Decorative mesh sink: swallowed while planning, added to the building group while drawing.
   *  Every mesh in this class goes through here or through decor(), so a plan() adds nothing to any
   *  scene — which is the whole reason the interior feature can ask a whole block for its doors. */
  private place(object: THREE.Object3D): void {
    if (this.drawing) this.parent.add(object);
  }

  /** As place(), but the mesh is not even constructed while planning. Used where construction is
   *  expensive enough to be worth the closure (gable geometry, walls). */
  private decor<T extends THREE.Object3D>(make: () => T): void {
    if (this.drawing) this.parent.add(make());
  }

  /** Every massing box doubles as a collision tier; decorative details are plain meshes and stay out of the registry. */
  private addBox(spec: BuildingSpec, width: number, height: number, depth: number, x: number, y: number, z: number, rounded = false): void {
    this.tiers.push({ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2, y0: y - height / 2, y1: y + height / 2 });
    if (!this.drawing) return;
    const radius = Math.min(1.25, width * 0.06, depth * 0.06);
    const geometry = scaleBoxFacadeUvs(
      rounded ? new RoundedBoxGeometry(width, height, depth, 5, radius) : new THREE.BoxGeometry(width, height, depth),
      width, height, depth, spec.facadeTile ?? { width: 28, height: 28 },
    );
    const mesh = new THREE.Mesh(geometry, boxMaterials(spec.facade, spec.roof)); mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; this.place(mesh);
  }

  private buildDowntown(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    if (massing === 0) {
      const podiumH = Math.min(9, h * 0.18); const middleH = h * 0.55; const upperH = h - podiumH - middleH;
      this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.86, middleH, d * 0.84, x, podiumH + middleH / 2 + 0.2, z);
      this.addBox(spec, w * 0.62, upperH, d * 0.66, x + w * 0.08, podiumH + middleH + upperH / 2 + 0.2, z - d * 0.04, true);
      this.addSetbackBand(x, z, w * 0.88, d * 0.86, podiumH + 0.22); this.addSetbackBand(x + w * 0.08, z - d * 0.04, w * 0.64, d * 0.68, podiumH + middleH + 0.22);
      return h + 0.2;
    }
    if (massing === 1) {
      const podiumH = Math.min(10, h * 0.22); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      const towerH = h - podiumH;
      this.addBox(spec, w * 0.43, towerH, d * 0.82, x - w * 0.23, podiumH + towerH / 2 + 0.2, z);
      this.addBox(spec, w * 0.37, towerH * 0.84, d * 0.72, x + w * 0.25, podiumH + towerH * 0.42 + 0.2, z + d * 0.06, true);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(w * 0.28, 3.2, d * 0.42), this.glass); bridge.position.set(x, podiumH + towerH * 0.57, z + d * 0.04); bridge.castShadow = true; this.place(bridge);
      return h + 0.2;
    }
    if (massing === 2) {
      const podiumH = Math.min(8, h * 0.16); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.72, h - podiumH, d * 0.78, x, podiumH + (h - podiumH) / 2 + 0.2, z, true);
      for (const side of [-1, 1]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.38, h - podiumH + 1.6, d * 0.83), this.stone); fin.position.set(x + side * w * 0.37, podiumH + (h - podiumH) / 2 + 0.2, z); fin.castShadow = true; this.place(fin);
      }
      return h + 0.2;
    }
    if (massing === 3) {
      const lowerH = h * 0.58;
      this.addBox(spec, w * 0.58, lowerH, d, x, lowerH / 2 + 0.2, z);
      this.addBox(spec, w, lowerH, d * 0.46, x, lowerH / 2 + 0.2, z - d * 0.04);
      this.addBox(spec, w * 0.46, h - lowerH, d * 0.58, x + w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z, true);
      this.addSetbackBand(x, z, w * 0.6, d * 1.03, lowerH + 0.2);
      return h + 0.2;
    }
    if (massing === 4) {
      const podiumH = Math.min(9, h * 0.2); this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      const radius = d * 0.39;
      const towerGeometry = new THREE.CylinderGeometry(radius, radius * 1.04, h - podiumH, 32);
      const towerUv = towerGeometry.getAttribute('uv'); const tile = spec.facadeTile ?? { width: 28, height: 28 };
      const circumference = Math.PI * (w * 0.39 + radius);
      for (let index = 0; index < towerUv.count; index++) towerUv.setXY(index, towerUv.getX(index) * Math.max(1, circumference / tile.width), towerUv.getY(index) * Math.max(1, (h - podiumH) / tile.height));
      towerUv.needsUpdate = true;
      const tower = new THREE.Mesh(towerGeometry, spec.facade); tower.scale.set(w / Math.max(d, 1), 1, 1); tower.position.set(x, podiumH + (h - podiumH) / 2 + 0.2, z); tower.castShadow = true; tower.receiveShadow = true; this.place(tower);
      this.tiers.push({ minX: x - w * 0.39, maxX: x + w * 0.39, minZ: z - radius, maxZ: z + radius, y0: podiumH + 0.2, y1: h + 0.2 }); // scaled cylinder tower, boxed
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius, 3.2, 32), spec.roof); crown.scale.x = w / Math.max(d, 1); crown.position.set(x, h + 1.8, z); crown.castShadow = true; this.place(crown);
      return h + 3.4;
    }
    if (massing === 5) {
      const podiumH = Math.min(11, h * 0.2); const towerH = h - podiumH;
      this.addBox(spec, w, podiumH, d, x, podiumH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.7, towerH, d * 0.46, x - w * 0.08, podiumH + towerH / 2 + 0.2, z - d * 0.22);
      this.addBox(spec, w * 0.38, towerH * 0.78, d * 0.76, x + w * 0.23, podiumH + towerH * 0.39 + 0.2, z + d * 0.08, true);
      this.addSetbackBand(x - w * 0.08, z - d * 0.22, w * 0.72, d * 0.48, h + 0.2);
      return h + 0.4;
    }
    if (massing === 6) {
      const baseH = h * 0.36; const middleH = h * 0.34; const topH = h - baseH - middleH;
      this.addBox(spec, w, baseH, d, x, baseH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.78, middleH, d * 0.82, x + w * 0.04, baseH + middleH / 2 + 0.2, z - d * 0.03);
      this.addBox(spec, w * 0.5, topH, d * 0.56, x - w * 0.1, baseH + middleH + topH / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x + w * 0.04, z - d * 0.03, w * 0.8, d * 0.84, baseH + middleH + 0.2);
      return h + 0.4;
    }
    if (massing === 7) {
      // Ziggurat: four stepped setback tiers, deco bands at each step — the Anstey's-era CBD profile.
      let y = 0.2; let tw = w; let td = d;
      for (const share of [0.34, 0.28, 0.22, 0.16]) {
        const tierH = h * share;
        this.addBox(spec, tw, tierH, td, x, y + tierH / 2, z, tw === w);
        y += tierH;
        if (share !== 0.16) this.addSetbackBand(x, z, tw * 1.02, td * 1.02, y);
        tw *= 0.78; td *= 0.78;
      }
      const finial = new THREE.Mesh(new THREE.BoxGeometry(1.1, 3.4, 1.1), this.stone); finial.position.set(x, h + 1.7, z); finial.castShadow = true; this.place(finial);
      return h + 0.2;
    }
    if (massing === 8) {
      // Colonnade podium: a double-height columned arcade under the podium deck, recessed glazed
      // lobby behind the columns, then a sheer rounded slab. The deck tier floats at 3.6 so the
      // player can actually walk the arcade between the columns.
      const podiumH = Math.min(11, Math.max(6, h * 0.24));
      this.addBox(spec, w * 0.9, 3.4, d * 0.66, x, 1.7 + 0.2, z - d * 0.14);
      this.addBox(spec, w, podiumH - 3.4, d, x, 3.4 + (podiumH - 3.4) / 2 + 0.2, z);
      // Arcade deck across the full footprint: the walkway and its columns get a real floor tier, and
      // foundationTiers levels it downhill — columns used to hang over the slope on tilted parcels.
      const deck = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), this.stone);
      deck.position.set(x, 0.35, z); deck.receiveShadow = true; this.place(deck);
      this.tiers.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, y0: 0.2, y1: 0.5 });
      const cols = Math.max(4, Math.min(8, Math.floor(w / 3.5)));
      for (let index = 0; index < cols; index++) {
        const px = x - w * 0.44 + index * (w * 0.88 / (cols - 1));
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 3.4, 12), this.stone); column.position.set(px, 2.15, z + d / 2 - 0.5); column.castShadow = true; this.place(column);
      }
      this.addBox(spec, w * 0.7, h - podiumH, d * 0.76, x, podiumH + (h - podiumH) / 2 + 0.2, z, true);
      this.addSetbackBand(x, z, w * 1.01, d * 1.01, podiumH + 0.22);
      return h + 0.2;
    }
    if (massing === 9) {
      // Corner tower: an L-plan block anchoring the street corner with a full-height drum-capped tower.
      const blockH = h * 0.58;
      this.addBox(spec, w, blockH, d * 0.55, x, blockH / 2 + 0.2, z - d * 0.2);
      this.addBox(spec, w * 0.5, blockH, d, x - w * 0.25, blockH / 2 + 0.2, z);
      const towerW = Math.min(w, d) * 0.42;
      const tx = x + w / 2 - towerW / 2; const tz = z + d / 2 - towerW / 2;
      this.addBox(spec, towerW, h, towerW, tx, h / 2 + 0.2, tz, true);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(towerW * 0.32, towerW * 0.44, 2.6, 18), spec.roof); cap.position.set(tx, h + 1.5, tz); cap.castShadow = true; this.place(cap);
      this.addSetbackBand(x, z - d * 0.2, w * 1.02, d * 0.57, blockH + 0.2);
      return h + 2.8;
    }
    // massing 10 — twin offset slabs joined by a service core; plant room + braced rooftop water tanks.
    this.addBox(spec, w * 0.46, h, d * 0.9, x - w * 0.24, h / 2 + 0.2, z, true);
    this.addBox(spec, w * 0.46, h * 0.78, d * 0.9, x + w * 0.24, h * 0.39 + 0.2, z);
    this.addBox(spec, w * 0.18, h * 0.88, d * 0.5, x, h * 0.44 + 0.2, z - d * 0.1);
    const plant = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, 2.3, d * 0.34), this.steel); plant.position.set(x - w * 0.24, h + 1.35, z - d * 0.14); plant.castShadow = true; this.place(plant);
    for (const dz of [-0.18, 0.16]) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.35, 2.1, 16), this.steel); tank.position.set(x + w * 0.24, h * 0.78 + 1.75, z + d * dz); tank.castShadow = true; this.place(tank);
      for (const lx of [-0.9, 0.9]) { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.9, 0.14), this.darkMetal); leg.position.set(x + w * 0.24 + lx, h * 0.78 + 0.65, z + d * dz); this.place(leg); }
    }
    return h + 0.2;
  }

  private buildMixedUse(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    const shopH = Math.min(4.4, h * 0.38);
    if (massing === 0) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.82, h - shopH, d * 0.74, x, shopH + (h - shopH) / 2 + 0.2, z - d * 0.08);
    } else if (massing === 1) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.48, h - shopH, d * 0.9, x - w * 0.25, shopH + (h - shopH) / 2 + 0.2, z);
      this.addBox(spec, w * 0.45, (h - shopH) * 0.76, d * 0.48, x + w * 0.24, shopH + (h - shopH) * 0.38 + 0.2, z - d * 0.22, true);
    } else if (massing === 2) {
      this.addBox(spec, w, h * 0.62, d * 0.72, x, h * 0.31 + 0.2, z - d * 0.14, true);
      this.addBox(spec, w * 0.42, h, d * 0.42, x + w * 0.26, h / 2 + 0.2, z + d * 0.22);
    } else if (massing === 3) {
      this.addBox(spec, w, shopH, d, x, shopH / 2 + 0.2, z, true);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.38, h - shopH, d * 0.7, x + side * w * 0.25, shopH + (h - shopH) / 2 + 0.2, z - side * d * 0.06, side > 0);
    } else {
      const lowerH = h * 0.54;
      this.addBox(spec, w, lowerH, d, x, lowerH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.68, h - lowerH, d * 0.72, x - w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x, z, w, d, lowerH + 0.2);
    }
    return h + 0.2;
  }

  private buildDenseResidential(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    if (massing === 0) {
      this.addBox(spec, w, h, d * 0.42, x, h / 2 + 0.2, z - d * 0.29, true);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.28, h * 0.82, d * 0.58, x + side * w * 0.36, h * 0.41 + 0.2, z + d * 0.18);
    } else if (massing === 1) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.2, h + 2.2, d * 0.34, x - w * 0.34, (h + 2.2) / 2 + 0.2, z + d * 0.2);
    } else if (massing === 2) {
      this.addBox(spec, w * 0.62, h, d * 0.72, x - w * 0.12, h / 2 + 0.2, z - d * 0.08);
      this.addBox(spec, w * 0.5, h * 0.66, d * 0.54, x + w * 0.25, h * 0.33 + 0.2, z + d * 0.22, true);
    } else if (massing === 3) {
      const units = 3; const unitW = w / units;
      for (let unit = 0; unit < units; unit++) this.addBox(spec, unitW * 0.92, h * (0.78 + unit * 0.11), d * 0.82, x - w / 2 + unitW * (unit + 0.5), h * (0.78 + unit * 0.11) / 2 + 0.2, z + (unit % 2) * d * 0.08, unit === 1);
    } else if (massing === 4) {
      const floorH = h * 0.46;
      this.addBox(spec, w, floorH, d, x, floorH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.84, h - floorH, d * 0.76, x + w * 0.04, floorH + (h - floorH) / 2 + 0.2, z - d * 0.08);
      this.addSetbackBand(x, z, w, d, floorH + 0.2);
    } else {
      // Three-storey walk-up flats: flat roof behind a parapet, external stair tower, open walkway slabs.
      const blockH = Math.max(h, 8.6);
      this.addBox(spec, w, blockH, d * 0.8, x, blockH / 2 + 0.2, z - d * 0.06, true);
      this.addBox(spec, w * 0.22, blockH + 1.1, d * 0.32, x - w * 0.29, (blockH + 1.1) / 2 + 0.2, z + d * 0.28);
      const parapet = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.5, d * 0.8 + 0.3), this.plaster); parapet.position.set(x, blockH + 0.4, z - d * 0.06); parapet.castShadow = true; this.place(parapet);
      for (let level = 1; level * 2.9 < blockH - 1.2; level++) {
        const slab = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.14, 1.15), this.stone); slab.position.set(x, level * 2.9 + 0.2, z - d * 0.06 + d * 0.4 + 0.58); slab.castShadow = true; this.place(slab);
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.08, 0.06), this.darkMetal); rail.position.set(x, level * 2.9 + 1.15, z - d * 0.06 + d * 0.4 + 1.1); this.place(rail);
      }
      return blockH + 1.3 + 0.2;
    }
    return h + (massing === 1 ? 2.4 : 0.2);
  }

  private buildSuburban(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h, variant } = spec; const roofRise = Math.min(4.2, Math.max(2.2, w * 0.16));
    if (massing === 0) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z, true);
      this.addGableRoof(spec, x, z, w + 0.7, d + 0.8, h + 0.2, roofRise);
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.15, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.42, h * 0.72, d * 0.72, x + w * 0.29, h * 0.36 + 0.2, z + d * 0.12, true);
      this.addGableRoof(spec, x - w * 0.15, z, w * 0.72, d + 0.7, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.29, z + d * 0.12, w * 0.47, d * 0.77, h * 0.72 + 0.2, roofRise * 0.72);
    } else if (massing === 2) {
      const floorH = h * 0.54; this.addBox(spec, w, floorH, d, x, floorH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.84, h - floorH, d * 0.84, x, floorH + (h - floorH) / 2 + 0.2, z - d * 0.04);
      this.addGableRoof(spec, x, z - d * 0.04, w * 0.9, d * 0.9, h + 0.2, roofRise);
      this.addSetbackBand(x, z, w * 1.02, d * 1.02, floorH + 0.2);
    } else if (massing === 3) {
      this.addBox(spec, w, h, d * 0.72, x, h / 2 + 0.2, z - d * 0.12, true);
      const frontWingH = h * 0.82; this.addBox(spec, w * 0.42, frontWingH, d * 0.56, x + w * 0.22, frontWingH / 2 + 0.2, z + d * 0.28);
      this.addGableRoof(spec, x, z - d * 0.12, w + 0.6, d * 0.78, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.22, z + d * 0.28, w * 0.47, d * 0.62, frontWingH + 0.2, roofRise * 0.72);
    } else if (massing === 4) {
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.47, h * (side > 0 ? 0.86 : 1), d * 0.82, x + side * w * 0.255, h * (side > 0 ? 0.86 : 1) / 2 + 0.2, z + side * d * 0.05, true);
        this.addGableRoof(spec, x + side * w * 0.255, z + side * d * 0.05, w * 0.5, d * 0.88, h * (side > 0 ? 0.86 : 1) + 0.2, roofRise * 0.82);
      }
    } else if (massing === 5) {
      const lowerH = h * 0.58;
      this.addBox(spec, w, lowerH, d, x, lowerH / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.62, h - lowerH, d * 0.68, x - w * 0.08, lowerH + (h - lowerH) / 2 + 0.2, z - d * 0.08, true);
      this.addSetbackBand(x, z, w, d, lowerH + 0.2);
    } else if (massing === 6) {
      // Stoep house in a low walled yard — the SA suburb vernacular: raised veranda across the
      // street face under a lean-to roof, boundary wall with a front gap for the path.
      this.addBox(spec, w * 0.86, h, d * 0.76, x, h / 2 + 0.2, z - d * 0.1, true);
      this.addGableRoof(spec, x, z - d * 0.1, w * 0.9, d * 0.82, h + 0.2, roofRise);
      const stoepD = Math.min(2.6, d * 0.24);
      this.addBox(spec, w * 0.86, 0.5, stoepD, x, 0.2, z + d * 0.28 + stoepD / 2 - d * 0.1);
      const stoepZ = z + d * 0.28 + stoepD / 2 - d * 0.1;
      const stoepRoof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.16, stoepD + 0.6), variant % 2 ? this.terracotta : this.darkMetal); stoepRoof.position.set(x, h * 0.66 + 0.2, stoepZ); stoepRoof.rotation.x = -0.09; stoepRoof.castShadow = true; this.place(stoepRoof);
      for (const px of [-w * 0.36, -w * 0.12, w * 0.12, w * 0.36]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, h * 0.62, 10), this.timber); post.position.set(x + px, h * 0.31 + 0.6, stoepZ + stoepD / 2 - 0.2); post.castShadow = true; this.place(post); }
      const wx = w * 0.5 + 0.9; const wz = d * 0.5 + 0.9; const wallH = 1.4; const th = 0.32;
      this.addWall(x, wallH, z - wz, wx * 2 + th, wallH, th);
      for (const side of [-1, 1]) this.addWall(x + side * wx, wallH, z, th, wallH, wz * 2 + th);
      const gap = Math.min(2.2, w * 0.14); const run = (wx * 2 - gap * 2) / 2;
      for (const side of [-1, 1]) this.addWall(x + side * (gap + run / 2), wallH, z + wz, run, wallH, th);
    } else if (massing === 7) {
      // L-plan: two perpendicular gabled wings hugging a front yard corner.
      this.addBox(spec, w, h, d * 0.55, x, h / 2 + 0.2, z - d * 0.2);
      this.addBox(spec, w * 0.42, h, d * 0.88, x + w * 0.26, h / 2 + 0.2, z + d * 0.02, true);
      this.addGableRoof(spec, x, z - d * 0.2, w + 0.6, d * 0.6, h + 0.2, roofRise);
      this.addGableRoof(spec, x + w * 0.26, z + d * 0.02, d * 0.93, w * 0.47, h + 0.2, roofRise * 0.85, Math.PI / 2);
    } else {
      // massing 8 — double-storey with a first-floor balcony over the entrance.
      const lower = h * 0.52;
      this.addBox(spec, w, lower, d, x, lower / 2 + 0.2, z, true);
      this.addBox(spec, w * 0.86, h - lower, d * 0.8, x, lower + (h - lower) / 2 + 0.2, z - d * 0.06);
      this.addGableRoof(spec, x, z - d * 0.06, w * 0.9, d * 0.86, h + 0.2, roofRise);
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(w * 0.44, 0.14, 1.5), this.stone); balcony.position.set(x, lower + 0.3, z + d / 2 + 0.72); balcony.castShadow = true; this.place(balcony);
      for (const px of [-w * 0.2, 0, w * 0.2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1, 0.07), this.darkMetal); post.position.set(x + px, lower + 0.85, z + d / 2 + 1.4); this.place(post); }
      const handRail = new THREE.Mesh(new THREE.BoxGeometry(w * 0.44, 0.07, 0.07), this.darkMetal); handRail.position.set(x, lower + 1.35, z + d / 2 + 1.4); this.place(handRail);
    }
    return massing === 5 ? h + 0.2 : h + roofRise + 0.2;
  }

  private buildIndustrial(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = 2.4 + massing * 0.3;
    if (massing === 0 || massing === 3) {
      const bodyW = massing === 3 ? w * 0.74 : w; const bodyX = massing === 3 ? x - w * 0.13 : x;
      this.addBox(spec, bodyW, h, d, bodyX, h / 2 + 0.2, z);
      const bays = Math.max(2, Math.min(5, Math.floor(bodyW / 8))); const bayWidth = bodyW / bays;
      for (let bay = 0; bay < bays; bay++) this.addGableRoof(spec, bodyX - bodyW / 2 + bayWidth * (bay + 0.5), z, bayWidth + 0.16, d + 0.5, h + 0.2, roofRise);
      if (massing === 3) this.addBox(spec, w * 0.22, h * 0.6, d * 0.7, x + w * 0.38, h * 0.3 + 0.2, z - d * 0.08); // sawtooth works + flat-roof annex
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.16, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.38, h * 0.66, d * 0.72, x + w * 0.31, h * 0.33 + 0.2, z + d * 0.1);
      this.addGableRoof(spec, x - w * 0.16, z, w * 0.72, d + 0.5, h + 0.2, roofRise);
    } else if (massing === 2) {
      this.addBox(spec, w, h * 0.72, d, x, h * 0.36 + 0.2, z, true);
      const officeH = h * 0.9; this.addBox(spec, w * 0.3, officeH, d * 0.48, x - w * 0.3, officeH / 2 + 0.2, z + d * 0.2);
      this.addGableRoof(spec, x, z, w + 0.6, d + 0.5, h * 0.72 + 0.2, roofRise);
    } else if (massing === 4) {
      this.addBox(spec, w * 0.72, h, d, x - w * 0.14, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.28, h * 1.18, d * 0.58, x + w * 0.34, h * 0.59 + 0.2, z + d * 0.16, true);
      this.addGableRoof(spec, x - w * 0.14, z, w * 0.76, d + 0.5, h + 0.2, roofRise);
    } else if (massing === 5) {
      // Clerestory hall: tall central nave with a raised glazed light strip, low lean-to side aisles.
      const naveH = h * 1.1; const aisleH = h * 0.55;
      this.addBox(spec, w * 0.5, naveH, d, x, naveH / 2 + 0.2, z);
      for (const side of [-1, 1]) this.addBox(spec, w * 0.25, aisleH, d * 0.94, x + side * w * 0.375, aisleH / 2 + 0.2, z);
      const clerestory = new THREE.Mesh(new THREE.BoxGeometry(w * 0.42, 1.1, d * 0.9), this.glass); clerestory.position.set(x, naveH - 0.9, z); this.place(clerestory);
      this.addGableRoof(spec, x, z, w * 0.54, d + 0.5, naveH + 0.2, roofRise * 0.8);
      return naveH + roofRise * 0.8 + 0.2;
    } else if (massing === 6) {
      // Silo battery: the works shed feeding a row of three cylindrical silos over a catwalk.
      this.addBox(spec, w * 0.55, h, d, x - w * 0.2, h / 2 + 0.2, z);
      this.addGableRoof(spec, x - w * 0.2, z, w * 0.6, d + 0.5, h + 0.2, roofRise);
      const siloR = Math.min(w * 0.11, d * 0.16); const siloH = h * 1.35; const sx = x + w * 0.33;
      for (const dz of [-0.3, 0, 0.3]) {
        const silo = new THREE.Mesh(new THREE.CylinderGeometry(siloR, siloR, siloH, 18), this.steel); silo.position.set(sx, siloH / 2 + 0.2, z + d * dz); silo.castShadow = true; silo.receiveShadow = true; this.place(silo);
        this.tiers.push({ minX: sx - siloR, maxX: sx + siloR, minZ: z + d * dz - siloR, maxZ: z + d * dz + siloR, y0: 0.2, y1: siloH + 0.2 });
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.24, siloR, siloR * 1.1, 18), this.steel); cone.position.set(sx, siloH + siloR * 0.55 + 0.2, z + d * dz); cone.castShadow = true; this.place(cone);
      }
      const catwalk = new THREE.Mesh(new THREE.BoxGeometry(w * 0.45, 0.16, 1.1), this.darkMetal); catwalk.position.set(x + w * 0.08, h + 0.4, z); catwalk.castShadow = true; this.place(catwalk);
      return siloH + 0.4;
    } else if (massing === 7) {
      // Twin long sheds: two parallel gabled halls with a service lane and a gantry frame between them.
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.38, h, d, x + side * w * 0.29, h / 2 + 0.2, z);
        this.addGableRoof(spec, x + side * w * 0.29, z, w * 0.42, d + 0.5, h + 0.2, roofRise * 0.9);
      }
      for (const dz of [-0.32, 0.32]) {
        // Posts run 3u below grade so the service-lane gantry still reaches the ground on the
        // downhill side of a sloped parcel (the building itself sits on the highest corner).
        for (const side of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, h + 4.6, 0.22), this.steel); post.position.set(x + side * w * 0.09, (h - 1) / 2, z + d * dz); post.castShadow = true; this.place(post); }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.2, 0.3, 0.3), this.steel); beam.position.set(x, h + 1.5, z + d * dz); beam.castShadow = true; this.place(beam);
      }
      return h + roofRise + 0.2;
    } else if (massing === 8) {
      // Chimney works: main hall, attached boiler house, tall brick stack and a pipe rack run.
      this.addBox(spec, w * 0.62, h, d, x - w * 0.15, h / 2 + 0.2, z);
      this.addGableRoof(spec, x - w * 0.15, z, w * 0.66, d + 0.5, h + 0.2, roofRise);
      const boilerH = h * 0.78; this.addBox(spec, w * 0.28, boilerH, d * 0.6, x + w * 0.3, boilerH / 2 + 0.2, z - d * 0.14);
      const stackR = Math.min(1.6, w * 0.05); const stackH = h * 2.1; const kx = x + w * 0.3; const kz = z + d * 0.28;
      const stack = new THREE.Mesh(new THREE.CylinderGeometry(stackR * 0.72, stackR, stackH, 16), this.terracotta); stack.position.set(kx, stackH / 2 + 0.2, kz); stack.castShadow = true; this.place(stack);
      this.tiers.push({ minX: kx - stackR, maxX: kx + stackR, minZ: kz - stackR, maxZ: kz + stackR, y0: 0.2, y1: stackH + 0.2 });
      const band = new THREE.Mesh(new THREE.CylinderGeometry(stackR * 0.78, stackR * 0.82, 0.5, 16), this.stone); band.position.set(kx, stackH - 1.4, kz); this.place(band);
      for (let py = 1.4; py < boilerH; py += 1.6) { const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, w * 0.42, 10), this.steel); pipe.rotation.z = Math.PI / 2; pipe.position.set(x + w * 0.07, py, z - d * 0.14); this.place(pipe); }
      return stackH + 0.2;
    }
    return massing === 2 ? Math.max(h * 0.72 + roofRise, h * 0.9) + 0.2 : massing === 4 ? h * 1.18 + 0.2 : h + roofRise + 0.2;
  }

  /** Low walled villa: a wide plastered house, a pool in the front yard, and a perimeter wall with a
   *  street-facing gate. The house boxes are collision tiers; the wall is four collider segments with
   *  a gap for the gate. Everything is built at the spec origin so the chunk builder can rotate it to
   *  the street. Fully procedural — no hand coordinates. */
  private buildEstate(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec;
    const roofRise = Math.min(3.4, Math.max(2, w * 0.05));
    if (massing === 3) {
      this.addBox(spec, w * 0.62, h * 0.58, d * 0.68, x - w * 0.08, h * 0.29 + 0.2, z - d * 0.04, true);
      this.addBox(spec, w * 0.48, h * 0.42, d * 0.5, x + w * 0.1, h * 0.79 + 0.2, z - d * 0.08, true);
      this.addBox(spec, w * 0.26, h * 0.46, d * 0.36, x + w * 0.32, h * 0.23 + 0.2, z + d * 0.2);
      const pool = new THREE.Mesh(new THREE.BoxGeometry(Math.min(w * 0.32, 13), 0.3, Math.min(d * 0.24, 8)), this.pool); pool.position.set(x - w * 0.2, 0.12, z + d * 0.3); pool.receiveShadow = true; this.place(pool);
      return h + 0.4;
    }
    const wingSide = massing === 1 ? -1 : 1;
    const mainW = w * 0.6; const mainD = d * 0.66;
    let roofY = h + roofRise + 0.2;
    if (massing <= 2) {
      this.addBox(spec, mainW, h, mainD, x - w * 0.02, h / 2 + 0.2, z - d * 0.04, true);
      const wingH = h * (massing === 2 ? 1 : 0.82);
      this.addBox(spec, w * 0.3, wingH, d * 0.5, x + wingSide * w * 0.26, wingH / 2 + 0.2, z + d * 0.12, true);
      this.addGableRoof(spec, x - w * 0.02, z - d * 0.04, mainW + 0.6, mainD + 0.6, h + 0.2, roofRise);
    } else if (massing === 4) {
      // U-plan villa: the main house with matched wings both sides framing the pool court.
      this.addBox(spec, mainW, h, d * 0.5, x, h / 2 + 0.2, z - d * 0.14, true);
      this.addGableRoof(spec, x, z - d * 0.14, mainW + 0.6, d * 0.56, h + 0.2, roofRise);
      for (const side of [-1, 1]) {
        this.addBox(spec, w * 0.24, h * 0.82, d * 0.52, x + side * w * 0.3, h * 0.41 + 0.2, z + d * 0.08, true);
        this.addGableRoof(spec, x + side * w * 0.3, z + d * 0.08, d * 0.57, w * 0.28, h * 0.82 + 0.2, roofRise * 0.8, Math.PI / 2);
      }
    } else if (massing === 5) {
      // Modern flat-roof double storey: stacked offset boxes, cantilevered upper floor, glass band.
      this.addBox(spec, mainW, h * 0.55, mainD, x, h * 0.275 + 0.2, z - d * 0.04, true);
      this.addBox(spec, mainW * 0.86, h * 0.5, mainD * 0.92, x + w * 0.06, h * 0.55 + h * 0.25 + 0.2, z + d * 0.02, true);
      const glassBand = new THREE.Mesh(new THREE.BoxGeometry(mainW * 0.8, 1.1, 0.1), this.glass); glassBand.position.set(x + w * 0.06, h * 0.72, z + d * 0.02 + mainD * 0.46 + 0.06); this.place(glassBand);
      const brise = new THREE.Mesh(new THREE.BoxGeometry(mainW * 0.9, 0.14, 2), this.timber); brise.position.set(x + w * 0.06, h * 1.05 + 0.35, z + d * 0.02 + mainD * 0.3); brise.castShadow = true; this.place(brise);
      roofY = h * 1.05 + 0.2;
    } else if (massing === 6) {
      // Thatch-look lodge: steep grass-brown gables over a plastered body, plus a rondavel-ish lapa.
      this.addBox(spec, mainW, h * 0.86, mainD, x - w * 0.02, h * 0.43 + 0.2, z - d * 0.04, true);
      const thatchRise = Math.max(roofRise * 1.7, h * 0.5);
      const thatchRoof = new THREE.Mesh(createGableGeometry(mainW + 0.8, mainD + 0.8, thatchRise), this.thatch); thatchRoof.position.set(x - w * 0.02, h * 0.86 + 0.2, z - d * 0.04); thatchRoof.castShadow = true; thatchRoof.receiveShadow = true; this.place(thatchRoof);
      this.gables.push({ x: x - w * 0.02, z: z - d * 0.04, width: mainW + 0.8, depth: mainD + 0.8, y: h * 0.86 + 0.2, rise: thatchRise, ry: 0 });
      const lapaR = Math.min(3.2, w * 0.12); const lx = x + w * 0.28; const lz = z + d * 0.18;
      const lapa = new THREE.Mesh(new THREE.CylinderGeometry(lapaR, lapaR, 2.4, 14), this.plaster); lapa.position.set(lx, 1.4, lz); lapa.castShadow = true; this.place(lapa);
      this.tiers.push({ minX: lx - lapaR, maxX: lx + lapaR, minZ: lz - lapaR, maxZ: lz + lapaR, y0: 0.2, y1: 2.6 });
      const lapaRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.2, lapaR + 0.7, 2.2, 14), this.thatch); lapaRoof.position.set(lx, 3.7, lz); lapaRoof.castShadow = true; this.place(lapaRoof);
      roofY = h * 0.86 + thatchRise + 0.2;
    } else {
      // massing 7 — tennis-court estate: compact double villa beside a fenced practice court.
      this.addBox(spec, w * 0.44, h, mainD, x - w * 0.24, h / 2 + 0.2, z - d * 0.04, true);
      this.addGableRoof(spec, x - w * 0.24, z - d * 0.04, w * 0.48, mainD + 0.6, h + 0.2, roofRise);
      const courtW = Math.min(w * 0.4, 15); const courtD = Math.min(d * 0.52, 8.2); const cx = x + w * 0.22; const czz = z - d * 0.08;
      const court = new THREE.Mesh(new THREE.BoxGeometry(courtW, 0.14, courtD), this.court); court.position.set(cx, 0.28, czz); court.receiveShadow = true; this.place(court);
      const netLine = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, courtD), this.plaster); netLine.position.set(cx, 0.8, czz); this.place(netLine);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.8, 0.1), this.darkMetal); post.position.set(cx + sx * courtW / 2, 1.6, czz + sz * courtD / 2); this.place(post); }
    }

    // Perimeter garden wall (kept inside the reserved building radius), gated on the +z street face.
    const wx = w * 0.5 + 1.2; const wz = d * 0.5 + 1.2; const wallH = 2.3; const th = 0.4;
    this.addWall(x, wallH, z - wz, wx * 2 + th, wallH, th);                // back
    this.addWall(x - wx, wallH, z, th, wallH, wz * 2 + th);               // left
    this.addWall(x + wx, wallH, z, th, wallH, wz * 2 + th);               // right
    const gateHalf = Math.min(3, w * 0.14);                               // gate opening on the street side
    const frontRun = (wx * 2 - gateHalf * 2) / 2;
    for (const side of [-1, 1]) this.addWall(x + side * (gateHalf + frontRun / 2), wallH, z + wz, frontRun, wallH, th);
    for (const side of [-1, 1]) { const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.8, 3, 0.8), this.stone); pillar.position.set(x + side * gateHalf, 1.5, z + wz); pillar.castShadow = true; this.place(pillar); }
    const gate = new THREE.Mesh(new THREE.BoxGeometry(gateHalf * 2, 2, 0.12), this.darkMetal); gate.position.set(x, 1, z + wz); this.place(gate);

    // Pool in the front yard, between house and gate.
    const poolW = Math.min(w * 0.34, 12); const poolD = Math.min(d * 0.3, 8);
    const pool = new THREE.Mesh(new THREE.BoxGeometry(poolW, 0.3, poolD), this.pool); pool.position.set(x + wingSide * -w * 0.16, 0.12, z + d * 0.24); pool.receiveShadow = true; this.place(pool);
    const coping = new THREE.Mesh(new THREE.BoxGeometry(poolW + 0.8, 0.16, poolD + 0.8), this.plaster); coping.position.set(pool.position.x, 0.06, pool.position.z); coping.receiveShadow = true; this.place(coping);
    return roofY;
  }

  private buildRural(spec: BuildingSpec, massing: number): number {
    const { x, z, width: w, depth: d, height: h } = spec; const roofRise = Math.min(2.8, Math.max(1.4, w * 0.12));
    if (massing === 0) {
      this.addBox(spec, w, h, d, x, h / 2 + 0.2, z);
      this.addGableRoof(spec, x, z, w + 0.8, d + 1, h + 0.2, roofRise);
    } else if (massing === 1) {
      this.addBox(spec, w * 0.68, h, d, x - w * 0.16, h / 2 + 0.2, z);
      this.addBox(spec, w * 0.38, h * 0.72, d * 0.72, x + w * 0.31, h * 0.36 + 0.2, z + d * 0.12);
      this.addGableRoof(spec, x - w * 0.16, z, w * 0.72, d + 0.8, h + 0.2, roofRise);
    } else if (massing === 2) {
      for (const side of [-1, 1]) {
        const cottageH = h * (side > 0 ? 0.88 : 1);
        this.addBox(spec, w * 0.46, cottageH, d * 0.82, x + side * w * 0.26, cottageH / 2 + 0.2, z + side * d * 0.06);
        this.addGableRoof(spec, x + side * w * 0.26, z + side * d * 0.06, w * 0.5, d * 0.9, cottageH + 0.2, roofRise * 0.8);
      }
    } else {
      this.addBox(spec, w, h * 0.72, d, x, h * 0.36 + 0.2, z, true);
      this.addBox(spec, w * 0.34, h, d * 0.6, x - w * 0.28, h / 2 + 0.2, z - d * 0.12);
      this.addGableRoof(spec, x - w * 0.28, z - d * 0.12, w * 0.38, d * 0.66, h + 0.2, roofRise);
    }
    return h + roofRise + 0.2;
  }

  /** A plastered wall segment that is both a mesh and an axis-aligned collision tier (grounded at +0.2). */
  private addWall(cx: number, _cy: number, cz: number, w: number, h: number, d: number): void {
    this.tiers.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, y0: 0.2, y1: h + 0.2, kind: 'wall' });
    this.decor(() => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.plaster);
      wall.position.set(cx, h / 2 + 0.2, cz); wall.castShadow = true; wall.receiveShadow = true; return wall;
    });
  }

  private addGableRoof(spec: BuildingSpec, x: number, z: number, width: number, depth: number, y: number, rise: number, ry = 0): void {
    this.gables.push({ x, z, width, depth, y, rise, ry });
    this.decor(() => {
      const tiled = spec.style === 'suburban' || spec.style === 'estate';
      const palette = residentialRoofPalette(spec.variant);
      const material = !tiled ? spec.roof
        : palette === 'terracotta' ? this.terracotta
          : palette === 'slate' ? this.slateRoof
            : palette === 'corrugated-green' ? this.greenRoof
              : this.zincRoof;
      const roof = new THREE.Mesh(createGableGeometry(width, depth, rise), material); roof.position.set(x, y, z); roof.rotation.y = ry; roof.castShadow = true; roof.receiveShadow = true; return roof;
    });
  }

  private addSetbackBand(x: number, z: number, width: number, depth: number, y: number): void {
    this.decor(() => {
      const band = new THREE.Mesh(new THREE.BoxGeometry(width, 0.28, depth), this.stone); band.position.set(x, y, z); band.castShadow = true; return band;
    });
  }

  private addStructuralDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    if (spec.style === 'downtown') this.addDowntownDetail(spec, massing, roofY);
    else if (spec.style === 'mixed-use') this.addMixedUseDetail(spec, massing);
    else if (spec.style === 'dense-residential') this.addDenseResidentialDetail(spec, massing);
    else if (spec.style === 'suburban' || spec.style === 'rural') this.addResidentialDetail(spec, massing);
    else if (spec.style === 'estate') this.addResidentialDetail(spec, massing); // villa porch/chimney/dormers
    else this.addIndustrialDetail(spec, massing, roofY);
  }

  private addMixedUseDetail(spec: BuildingSpec, massing: number): void {
    const { x, z, width: w, depth: d, variant } = spec;
    const canopyW = w * 0.74; const canopyZ = frontFacadeZAt(this.tiers, x, 3.25, canopyW / 2);
    if (canopyZ !== undefined) {
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(canopyW, 0.18, 1.5), variant % 2 ? this.darkMetal : this.terracotta);
      canopy.position.set(x, 3.25, canopyZ + 0.7); canopy.castShadow = true; this.place(canopy);
    }
    const bays = Math.max(2, Math.min(5, Math.floor(w / 5)));
    for (let bay = 0; bay < bays; bay++) {
      const px = x - w * 0.36 + bay * (w * 0.72 / Math.max(1, bays - 1));
      const shopW = Math.min(3.2, w / bays * 0.72); const shopZ = frontFacadeZAt(this.tiers, px, 1.35, shopW / 2); if (shopZ === undefined) continue;
      const shop = new THREE.Mesh(new THREE.BoxGeometry(shopW, 2.2, 0.12), this.glass); shop.position.set(px, 1.35, shopZ + 0.02); this.place(shop);
    }
    if (massing === 4) this.addSetbackBand(x, z, w * 0.7, d * 0.74, spec.height + 0.3);
  }

  private addDenseResidentialDetail(spec: BuildingSpec, massing: number): void {
    const { x, z, width: w, depth: d, height: h } = spec;
    for (let y = 4; y < h - 1; y += 3.1) {
      const balconyX = x + (massing % 2 ? w * 0.08 : 0); const balconyW = w * 0.56;
      const facadeZ = frontFacadeZAt(this.tiers, balconyX, y, balconyW / 2); if (facadeZ === undefined) continue;
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(balconyW, 0.14, 1.05), this.stone); balcony.position.set(balconyX, y, facadeZ + 0.45); balcony.castShadow = true; this.place(balcony);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(balconyW, 0.65, 0.06), this.darkMetal); rail.position.set(balconyX, y + 0.42, facadeZ + 0.95); this.place(rail);
    }
    const tankX = x - w * 0.25; const tankZ = z - d * 0.18;
    const tankBase = massingTopAt(this.tiers, tankX, tankZ); if (tankBase === undefined) return;
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.8, 1.5, 14), this.darkMetal); tank.position.set(tankX, tankBase + 0.75, tankZ); tank.castShadow = true; this.place(tank);
  }

  private addDowntownDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    if (massing === 4) {
      this.addCylindricalDowntownDetail(spec);
    } else {
      if (variant % 2 === 0) {
        const finCount = Math.max(3, Math.min(7, Math.floor(w / 4)));
        const bottom = h * 0.15; const top = h * 0.87;
        const edges = [bottom, top, ...this.tiers.flatMap((tier) => [tier.y0, tier.y1]).filter((y) => y > bottom && y < top)].sort((a, b) => a - b);
        for (let index = 0; index < finCount; index++) {
          const px = x - w * 0.38 + index * (w * 0.76 / Math.max(1, finCount - 1));
          const segments: Array<{ y0: number; y1: number; z: number }> = [];
          for (let edge = 0; edge < edges.length - 1; edge++) {
            const y0 = edges[edge]!; const y1 = edges[edge + 1]!; if (y1 - y0 < 1e-4) continue;
            const facadeZ = frontFacadeZAt(this.tiers, px, (y0 + y1) / 2, 0.08); if (facadeZ === undefined) continue;
            const previous = segments[segments.length - 1];
            if (previous && Math.abs(previous.y1 - y0) < 1e-4 && Math.abs(previous.z - facadeZ) < 1e-4) previous.y1 = y1;
            else segments.push({ y0, y1, z: facadeZ });
          }
          for (const segment of segments) {
            const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, segment.y1 - segment.y0, 0.16), this.stone);
            fin.position.set(px, (segment.y0 + segment.y1) / 2, segment.z + 0.04); fin.castShadow = true;
            fin.name = 'planar-facade-mullion'; fin.userData.planarFacadeDetail = 'mullion'; this.place(fin);
          }
        }
      }
      for (let y = 11; y < h - 5; y += Math.max(10, h / 5)) {
        for (const span of frontFacadeSpansAt(this.tiers, y, x - w * 0.41, x + w * 0.41)) {
          const band = new THREE.Mesh(new THREE.BoxGeometry(span.maxX - span.minX, 0.18, 0.16), this.darkMetal);
          band.position.set((span.minX + span.maxX) / 2, y, span.z + 0.04);
          band.name = 'planar-facade-band'; band.userData.planarFacadeDetail = 'band'; this.place(band);
        }
      }
      if (variant % 3 === 0 && h > 30) this.addFireEscape(x, z, w, d, h);
    }
    if (massing === 2 || massing === 4) {
      const crown = new THREE.Group(); crown.position.set(x, roofY, z);
      for (const px of [-w * 0.2, w * 0.2]) { const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 3.5, 0.16), this.darkMetal); post.position.set(px, 1.75, 0); crown.add(post); }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 0.52, 0.18, 0.18), this.darkMetal); beam.position.y = 3.45; crown.add(beam); this.place(crown);
    }
    this.addDowntownCrown(spec, massing, roofY);
    this.addDowntownStreetBase(spec, massing);
  }

  /**
   * WHERE A TOWER IS ACTUALLY LOOKED AT: its outline against the sky, and its first five metres.
   *
   * Every flat-topped downtown variant used to stop dead on its own roof plane, so a 110 m shaft met
   * the sky on a bare cut edge — the strongest "extruded rectangle" cue there is — and met the
   * pavement on a bare seam. The shaft between them is the part nobody reads: the facade atlas and the
   * mullion/spandrel rhythm above already carry it, and a window per window on thirty storeys would
   * cost hundreds of quads for detail two pixels wide.
   *
   * So this buys the two ends and nothing else. On the roof: a cornice, a parapet on every roof open
   * to the sky, and one of four crowns chosen by the building's own hash — a plant room with a lift
   * overrun, tanks on a stand, a stepped cap with corner piers, or a mast and dish. At the kerb: a
   * plinth, shopfront piers, a header closing the base off from the shaft, corner pilasters on the
   * variants that get no mullions, and a roller shutter on a third of them.
   *
   * THREE THINGS IT DELIBERATELY DOES NOT DO. It pushes no tier, so the collision registry, the
   * foundations and the oriented colliders are untouched. It does not move roofY. And it runs only
   * through place(), which addStructuralDetail already gates on `drawing` — so plan() cannot see any
   * of it, and plan/build parity (and with it every front door in the city) holds by construction.
   *
   * It also costs no draw calls. Only `stone`, `darkMetal` and the building's own `spec.roof` are
   * used, all three already on every downtown building (setback bands, spandrel bands, mullions,
   * crown masts, the roof plane itself), and GeometryBaker buckets by material PROPERTIES rather than
   * identity — so all of this merges into meshes the cell already had.
   *
   * WHERE EACH VALUE GOES, because getting this wrong is what makes a crown look cheap: `stone` and
   * `darkMetal` are the two extremes of the palette and are spent only on THIN pieces — the parapet
   * lip, the cornice, a coping, corner piers, tanks, masts. Every LARGE new face (the roof deck, the
   * plant-room and lift-overrun bodies, the first step of the deco cap, the elliptical lantern, the
   * street plinth) takes `spec.roof`, the tone the building already wears. A bright volume or a black
   * plate at this size reads as a graphic decal stuck on the massing, not as architecture.
   */
  private addDowntownCrown(spec: BuildingSpec, massing: number, roofY: number): void {
    if (massing === 4) { this.addEllipticalCrown(spec, roofY); return; }
    const { width: w, depth: d, variant } = spec;
    const roofs = this.exposedRoofs(Math.max(12, w * d * 0.05)).slice(0, 2);
    const main = roofs[0];
    if (!main) return;
    const cap = variant % 3 === 0 ? this.darkMetal : this.stone;
    const thickness = 0.38;
    for (let index = 0; index < roofs.length; index++) {
      // The main roof carries the tall parapet; a secondary roof (a twin slab, a lower wing, a lift
      // core) gets a shorter one, so a stepped massing reads as steps and not as a repeated stencil.
      this.addParapet(roofs[index]!, index === 0 ? 1.25 + (variant % 3) * 0.45 : 0.85, thickness, cap);
      // The deck, sunk inside the parapet, in the building's OWN roof tone. It is here because
      // downtown roofs were reading as white icing — the setback band several massings wear AT their
      // roof line is pale stone and covers most of the deck — and re-laying that area in roof grey
      // both fixes it and gives the pale parapet something to be pale against.
      //
      // It is spec.roof and not a dark membrane on purpose. Bitumen is the honest material, but at
      // this albedo a 200 m² plate ringed in pale coping stops reading as a roof and reads as a hole
      // with a bathtub rim — and because every downtown roof would get it, the whole roofscape turns
      // into one repeated black-and-white tile. The frugal rule is to spend the bright accent on the
      // thin EDGE and leave the big face in the family tone; see the parapet and cornice below.
      const deck = roofs[index]!;
      const inset = thickness * 2 + 0.2;
      if (deck.maxX - deck.minX > inset + 1 && deck.maxZ - deck.minZ > inset + 1) {
        // The deck is a SLAB, not a sheet, and its thickness is what keeps it out of two fights at once.
        // Several massings wear a setback band at their own roof line whose top face sits at y1 + 0.14, so
        // a 0.18-tall plate centred at y1 + 0.05 put its top on exactly that plane — 478 u² of coincident
        // face between the palette's two extremes, which fights hard and is overlooked from every
        // neighbouring tower. Raising it alone would then bring its underside up onto the roof plate at
        // y1 and simply move the fight. So it is deep enough to clear the band above (top y1 + 0.24) and
        // stay buried in the plate below (bottom y1 - 0.06), with real margin on both sides rather than a
        // couple of centimetres that some other massing's band could close again.
        const membrane = new THREE.Mesh(new THREE.BoxGeometry(deck.maxX - deck.minX - inset, 0.3, deck.maxZ - deck.minZ - inset), spec.roof);
        membrane.position.set((deck.minX + deck.maxX) / 2, deck.y1 + 0.09, (deck.minZ + deck.maxZ) / 2);
        membrane.receiveShadow = true; membrane.name = 'downtown-roof-deck'; this.place(membrane);
      }
    }
    // The cornice: one box, and the hard shadow line that stops a facade running straight off the top
    // of the frame. Kept shallow on purpose — projected far it stops being a cornice and becomes a
    // brim — and always the opposite value to the parapet, so the crown never flattens into one tone.
    const cornice = new THREE.Mesh(new THREE.BoxGeometry(
      main.maxX - main.minX + 0.48, 0.24, main.maxZ - main.minZ + 0.48,
    ), cap === this.stone ? this.darkMetal : this.stone);
    cornice.position.set((main.minX + main.maxX) / 2, main.y1 - 0.62, (main.minZ + main.maxZ) / 2);
    cornice.castShadow = true; cornice.name = 'downtown-cornice'; this.place(cornice);
    // Two massings already own their roof: 10 has the plant room and braced tanks it was authored
    // with, and 2's gantry straddles the roof centre, so it takes only the corner-seated crowns.
    const kind = massing === 10 ? -1 : massing === 2 ? variant % 2 : variant % 4;
    if (kind >= 0 && main.maxX - main.minX > 6.5 && main.maxZ - main.minZ > 6.5) this.addRoofCrown(spec, main, kind, cap);
  }

  /** Tier tops open to the sky, tallest first. A centre probe is enough: every downtown massing that
   *  stacks a volume on a lower one covers that one's centre, so what comes back is the set of roofs
   *  you can actually see — the exposed ring behind a setback already wears its own band. The sort is
   *  a total order on the massing, so the crown a building gets never depends on the order its tiers
   *  happened to be pushed in. */
  private exposedRoofs(minArea: number): MassingTier[] {
    const roofs: MassingTier[] = [];
    for (const tier of this.tiers) {
      if (tier.kind === 'wall') continue;
      const width = tier.maxX - tier.minX; const depth = tier.maxZ - tier.minZ;
      if (width < 2.6 || depth < 2.6 || width * depth < minArea) continue;
      const top = massingTopAt(this.tiers, (tier.minX + tier.maxX) / 2, (tier.minZ + tier.maxZ) / 2);
      if (top === undefined || top > tier.y1 + 1e-3) continue;
      roofs.push(tier);
    }
    return roofs.sort((a, b) => (b.y1 - a.y1) || (a.minX - b.minX) || (a.minZ - b.minZ));
  }

  /** A parapet: four thin upstands round a roof edge. A slab across the top would not read — what
   *  changes the outline is the LIP, seen from the street as a shadowed band and from above as a rim
   *  with the roof deck sunk inside it. Decorative: the player still stands on the roof tier. */
  private addParapet(roof: MassingTier, height: number, thickness: number, material: THREE.Material): void {
    const width = roof.maxX - roof.minX; const depth = roof.maxZ - roof.minZ;
    const cx = (roof.minX + roof.maxX) / 2; const cz = (roof.minZ + roof.maxZ) / 2;
    const y = roof.y1 + height / 2;
    const inner = Math.max(0.1, depth - thickness * 2);
    for (const side of [-1, 1]) {
      const run = new THREE.Mesh(new THREE.BoxGeometry(width, height, thickness), material);
      run.position.set(cx, y, cz + side * (depth - thickness) / 2);
      run.castShadow = true; run.name = 'downtown-parapet'; this.place(run);
      const flank = new THREE.Mesh(new THREE.BoxGeometry(thickness, height, inner), material);
      flank.position.set(cx + side * (width - thickness) / 2, y, cz);
      flank.castShadow = true; flank.name = 'downtown-parapet'; this.place(flank);
    }
  }

  /** Four rooftop crowns, one per building by hash — the cheapest way to stop a skyline being a row
   *  of identical flat cuts, because every one of them changes the OUTLINE. Each piece is seated
   *  inside the roof rectangle it was handed, so nothing probes and nothing can overhang an edge. */
  private addRoofCrown(spec: BuildingSpec, roof: MassingTier, kind: number, cap: THREE.Material): void {
    const width = roof.maxX - roof.minX; const depth = roof.maxZ - roof.minZ;
    const cx = (roof.minX + roof.maxX) / 2; const cz = (roof.minZ + roof.maxZ) / 2;
    const box = (bw: number, bh: number, bd: number, px: number, pz: number, material: THREE.Material, base = roof.y1): void => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), material);
      mesh.position.set(px, base + bh / 2, pz);
      mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'downtown-roof-crown'; this.place(mesh);
    };
    if (kind === 0) {
      // Plant room and lift overrun: the two volumes every real office roof carries, and the pair
      // that most cheaply turns a flat top into a stepped one.
      const roomW = Math.min(width * 0.44, 10); const roomD = Math.min(depth * 0.4, 8);
      box(roomW, 3, roomD, roof.minX + roomW / 2 + 0.7, roof.minZ + roomD / 2 + 0.7, spec.roof);
      const shaftW = Math.min(width * 0.24, 4.6); const shaftD = Math.min(depth * 0.26, 4.4);
      const sx = roof.maxX - shaftW / 2 - 0.9; const sz = roof.minZ + shaftD / 2 + 1.2;
      box(shaftW, 5.6, shaftD, sx, sz, spec.roof);
      box(shaftW * 0.72, 0.34, shaftD * 0.72, sx, sz, this.darkMetal, roof.y1 + 5.6);
      return;
    }
    if (kind === 1) {
      // The Joburg roof: a pair of tanks up on a stand, above the parapet where you can see them.
      const standW = Math.min(width * 0.42, 8.4); const standD = Math.min(depth * 0.3, 5.2);
      const sx = cx + width * 0.12; const sz = roof.minZ + standD / 2 + 0.9;
      box(standW, 1.2, standD, sx, sz, this.darkMetal);
      const radius = Math.min(1.5, standW * 0.2, standD * 0.42);
      for (const side of [-1, 1]) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 2.4, 10), this.stone);
        tank.position.set(sx + side * (standW / 2 - radius - 0.3), roof.y1 + 2.4, sz);
        tank.castShadow = true; tank.name = 'downtown-roof-crown'; this.place(tank);
      }
      box(0.34, 2.6, 0.34, sx, sz + standD / 2 - 0.3, this.darkMetal, roof.y1 + 1.2);
      return;
    }
    if (kind === 2) {
      // A stepped cap with corner piers: the deco crown the older CBD blocks wear, and the profile
      // that carries furthest — two shrinking volumes plus four verticals on the parapet line.
      box(width * 0.66, 2.8, depth * 0.66, cx, cz, spec.roof);
      box(width * 0.38, 2.4, depth * 0.38, cx, cz, cap, roof.y1 + 2.8);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        box(1, 1.6, 1, cx + sx * (width - 1) / 2, cz + sz * (depth - 1) / 2, cap);
      }
      return;
    }
    // A mast with its gantry and a dish — the tallest, thinnest silhouette break available, and the
    // one that reads furthest across a skyline for twelve triangles.
    const mastH = Math.min(16, Math.max(9, spec.height * 0.16));
    box(0.4, mastH, 0.4, cx, cz - depth * 0.12, this.darkMetal);
    for (const level of [0.52, 0.78]) {
      box(Math.min(width * 0.3, 4.4), 0.2, 0.2, cx, cz - depth * 0.12, this.darkMetal, roof.y1 + mastH * level);
    }
    const dishR = Math.min(1.3, width * 0.1);
    const dishX = cx + dishR + 0.5; const dishZ = cz - depth * 0.12;
    box(0.28, 1.9, 0.28, dishX, dishZ, this.darkMetal);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(dishR * 0.2, dishR, 0.4, 10), this.stone);
    dish.rotation.z = 0.5; dish.position.set(dishX, roof.y1 + 2.15, dishZ);
    dish.castShadow = true; dish.name = 'downtown-roof-crown'; this.place(dish);
  }

  /** The elliptical tower keeps its own vocabulary: a turned lantern on the drum and a mast, both
   *  inside the parcel envelope. A rectangular parapet on a curved facade is precisely the detached
   *  trim that addCylindricalDowntownDetail exists to avoid. */
  private addEllipticalCrown(spec: BuildingSpec, roofY: number): void {
    const { x, z, width: w, depth: d } = spec;
    const radius = d * 0.39; const stretch = w / Math.max(d, 1);
    const lantern = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.5, radius * 0.64, 3.4, 20), spec.roof);
    lantern.scale.x = stretch; lantern.position.set(x, roofY + 1.7, z);
    lantern.castShadow = true; lantern.name = 'downtown-roof-crown'; this.place(lantern);
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.2, radius * 0.5, 1.7, 20), this.darkMetal);
    drum.scale.x = stretch; drum.position.set(x, roofY + 4.25, z);
    drum.castShadow = true; drum.name = 'downtown-roof-crown'; this.place(drum);
    const mast = new THREE.Mesh(new THREE.BoxGeometry(0.36, 9, 0.36), this.darkMetal);
    mast.position.set(x, roofY + 9.6, z);
    mast.castShadow = true; mast.name = 'downtown-roof-crown'; this.place(mast);
  }

  /**
   * THE FIRST FIVE METRES, where the player is standing.
   *
   * A plinth so the wall lands on something instead of meeting the pavement on a bare seam; piers
   * across the shopfront so the glazing stops being a flush sticker; a header band closing the base
   * off from the shaft; corner pilasters for the odd variants, which get no mullions at all today and
   * so read as exactly the blank extrusion this pass is about; and on a third of them a roller
   * shutter pulled down over one bay, which is what a Joburg street corner actually looks like.
   *
   * Every piece rides a REAL front span (frontFacadeSpansAt), so a setback, an arcade or a narrow
   * wing never gets a band floating in front of it.
   *
   * The plinth is the DARK one (spec.roof) and the piers and header are pale. With all three in pale
   * stone the base became a white trellis bolted to the wall — four pale horizontals stacked with the
   * ledge the glazing pass already hangs. A dark base course is what a Joburg shopfront actually has,
   * and it gives the pale verticals a bottom to stand on.
   */
  private addDowntownStreetBase(spec: BuildingSpec, massing: number): void {
    if (massing === 4) return; // the elliptical facade is not a plane; see addEllipticalCrown
    const { x, width: w, height: h, variant } = spec;
    const left = x - w / 2; const right = x + w / 2;
    // Probed at 0.7, not at the plinth's own mid-height: the colonnade variant's arcade DECK stops at
    // 0.5, and a base course hung on the front of a walkway slab is a kerb across the arcade mouth.
    for (const span of frontFacadeSpansAt(this.tiers, 0.7, left, right)) {
      if (span.maxX - span.minX < 2.6) continue;
      const plinth = new THREE.Mesh(new THREE.BoxGeometry(span.maxX - span.minX, 0.7, 0.34), spec.roof);
      plinth.position.set((span.minX + span.maxX) / 2, 0.55, span.z + 0.11);
      plinth.receiveShadow = true; plinth.name = 'downtown-plinth'; this.place(plinth);
    }
    if (h > 14) {
      for (const span of frontFacadeSpansAt(this.tiers, 5.15, left, right)) {
        const width = span.maxX - span.minX;
        if (width < 2.6) continue;
        const header = new THREE.Mesh(new THREE.BoxGeometry(width, 0.5, 0.5), this.stone);
        header.position.set((span.minX + span.maxX) / 2, 5.15, span.z + 0.15);
        header.castShadow = true; header.name = 'downtown-header'; this.place(header);
        // Piers between plinth and header. The glazing pass hangs flat panes on this wall; a vertical
        // every few metres in front of them is what turns a painted-on shopfront into a built one.
        const piers = Math.max(2, Math.min(6, Math.round(width / 6)));
        for (let pier = 0; pier < piers; pier++) {
          const px = span.minX + (width * (pier + 0.5)) / piers;
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.3), this.stone);
          post.position.set(px, 2.9, span.z + 0.09);
          post.castShadow = true; post.name = 'downtown-shopfront-pier'; this.place(post);
        }
      }
    }
    if (variant % 2 !== 0) {
      let shaft: MassingTier | undefined;
      for (const tier of this.tiers) if (tier.kind !== 'wall' && (!shaft || tier.y1 > shaft.y1)) shaft = tier;
      if (shaft && shaft.y1 - shaft.y0 > 9 && shaft.maxX - shaft.minX > 4) {
        for (const side of [-1, 1]) {
          const pilaster = new THREE.Mesh(new THREE.BoxGeometry(0.8, shaft.y1 - shaft.y0 - 0.5, 0.3), this.stone);
          pilaster.position.set(side < 0 ? shaft.minX + 0.4 : shaft.maxX - 0.4, (shaft.y0 + shaft.y1) / 2, shaft.maxZ + 0.09);
          pilaster.castShadow = true; pilaster.name = 'downtown-pilaster'; this.place(pilaster);
        }
      }
    }
    if (variant % 3 === 1) {
      const bay = widestFrontFacadeSpanAt(this.tiers, 1.6, left, right, 4.4);
      if (bay) {
        const shutterW = Math.min(4.6, (bay.maxX - bay.minX) * 0.36);
        const wanted = bay.minX + (bay.maxX - bay.minX) * (variant % 2 ? 0.24 : 0.76);
        const px = THREE.MathUtils.clamp(wanted, bay.minX + shutterW / 2 + 0.25, bay.maxX - shutterW / 2 - 0.25);
        const shutter = new THREE.Mesh(new THREE.BoxGeometry(shutterW, 2.5, 0.14), this.darkMetal);
        shutter.position.set(px, 1.75, bay.z + 0.2); shutter.name = 'downtown-shutter'; this.place(shutter);
        for (const ry of [1, 1.75, 2.5]) {
          const rib = new THREE.Mesh(new THREE.BoxGeometry(shutterW - 0.14, 0.1, 0.1), this.darkMetal);
          rib.position.set(px, ry, bay.z + 0.28); this.place(rib);
        }
      }
    }
  }

  /** Trim for the tapered elliptical downtown tower. The old shared downtown pass placed a flat
   *  grid at the rectangular parcel edge, leaving its ends visibly detached from this narrower
   *  massing. Rings and mullions instead use the cylinder's exact 4% bottom-to-top taper. */
  private addCylindricalDowntownDetail(spec: BuildingSpec): void {
    const { x, z, width: w, height: h, variant } = spec;
    const podiumH = Math.min(9, h * 0.2); const towerBottom = podiumH + 0.2; const towerTop = h + 0.2;
    const ringHeights: number[] = [];
    for (let y = Math.max(11, towerBottom + 2.5); y < h - 5; y += Math.max(10, h / 5)) {
      ringHeights.push(y);
      const { rx, rz } = this.cylindricalTowerRadii(spec, y);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rz - 0.07, 0.09, 6, 32), this.darkMetal);
      ring.position.set(x, y, z); ring.rotation.x = Math.PI / 2; ring.scale.x = rx / rz;
      ring.castShadow = true; ring.name = 'cylindrical-facade-ring'; ring.userData.curvedFacadeDetail = 'ring'; this.place(ring);
    }

    if (variant % 2 !== 0) return;
    const finCount = Math.max(3, Math.min(7, Math.floor(w / 4)));
    const segmentEdges = [towerBottom + 0.8, ...ringHeights, towerTop - 4.7];
    for (let segment = 0; segment < segmentEdges.length - 1; segment++) {
      const y0 = segmentEdges[segment]! + (segment === 0 ? 0 : 0.25);
      const y1 = segmentEdges[segment + 1]! - (segment === segmentEdges.length - 2 ? 0 : 0.25);
      if (y1 - y0 < 0.6) continue;
      const cy = (y0 + y1) / 2; const { rx, rz } = this.cylindricalTowerRadii(spec, cy);
      for (let index = 0; index < finCount; index++) {
        // Keep the original street-facing spread, but solve each point and its normal on the ellipse.
        const u = finCount === 1 ? 0 : -0.92 + index * (1.84 / (finCount - 1));
        const px = u * rx; const pz = Math.sqrt(1 - u * u) * rz;
        const normal = new THREE.Vector2(px / (rx * rx), pz / (rz * rz)).normalize();
        const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.18, y1 - y0, 0.28), this.stone);
        mullion.position.set(x + px - normal.x * 0.1, cy, z + pz - normal.y * 0.1);
        mullion.rotation.y = Math.atan2(normal.x, normal.y); mullion.castShadow = true;
        mullion.name = 'cylindrical-facade-mullion'; mullion.userData.curvedFacadeDetail = 'mullion'; this.place(mullion);
      }
    }
  }

  private cylindricalTowerRadii(spec: BuildingSpec, y: number): { rx: number; rz: number } {
    const podiumH = Math.min(9, spec.height * 0.2); const towerH = spec.height - podiumH;
    const t = THREE.MathUtils.clamp((y - podiumH - 0.2) / towerH, 0, 1);
    const taper = THREE.MathUtils.lerp(1.04, 1, t); const rz = spec.depth * 0.39 * taper;
    return { rx: rz * spec.width / Math.max(spec.depth, 1), rz };
  }

  private addFireEscape(x: number, z: number, w: number, d: number, h: number): void {
    const sideX = x + w / 2 + 0.55;
    for (let y = 8; y < h - 3; y += 10) {
      const platform = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 3.1), this.darkMetal); platform.position.set(sideX, y, z + d * 0.16); this.place(platform);
      for (const pz of [-1.35, 1.35]) { const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.9, 0.07), this.darkMetal); rail.position.set(sideX + 0.55, y + 0.45, z + d * 0.16 + pz); this.place(rail); }
      const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.08, 8.7, 0.08), this.darkMetal); ladder.position.set(sideX + 0.55, y + 4.35, z + d * 0.16 + 1.25); this.place(ladder);
      for (let rung = 0; rung < 5; rung++) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.05), this.darkMetal); bar.position.set(sideX + 0.55, y + 0.8 + rung * 1.75, z + d * 0.16 + 1.25); this.place(bar); }
    }
  }

  private addResidentialDetail(spec: BuildingSpec, massing: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    const porchW = w * 0.48; const facadeZ = frontFacadeZAt(this.tiers, x, 1.8, porchW / 2);
    if (facadeZ !== undefined) {
      const porch = new THREE.Mesh(new THREE.BoxGeometry(porchW, 0.28, 2.3), this.timber); porch.position.set(x, 0.45, facadeZ + 1); porch.castShadow = true; this.place(porch);
      const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(w * 0.56, 0.18, 2.55), variant % 2 ? this.terracotta : this.darkMetal); porchRoof.position.set(x, 3.15, facadeZ + 1); porchRoof.rotation.x = -0.08; porchRoof.castShadow = true; this.place(porchRoof);
      for (const px of [-w * 0.2, w * 0.2]) { const column = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.15, 2.7, 14), this.stone); column.position.set(x + px, 1.8, facadeZ + 1.75); column.castShadow = true; this.place(column); }
    }
    // Chimney rises out of the actual roof under it (pitched or flat) — never the building-wide roofY,
    // which on winged massings is the tallest ridge, leaving a chimney over a lower wing hanging in air.
    if (variant % 3 !== 1) {
      const chimneyX = x - w * 0.25; const chimneyZ = z - d * 0.18;
      const chimneySurface = roofSurfaceAt(this.tiers, this.gables, chimneyX, chimneyZ);
      if (chimneySurface !== undefined) {
        const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.2, 0.9), this.terracotta); chimney.position.set(chimneyX, chimneySurface + 0.4, chimneyZ); chimney.castShadow = true; chimney.name = 'residential-chimney'; this.place(chimney);
      }
    }
    if (massing !== 2 && h > 8) {
      for (const side of [-1, 1]) {
        // Dormers belong on a pitched roof: seat each one in the gable surface at its own spot and
        // skip spots no gable covers (flat-roof massings used to leave them floating beside the box).
        const dormerX = x + side * w * 0.22; const dormerZ = z + d * 0.28;
        const surface = gableSurfaceAt(this.gables, dormerX, dormerZ); if (surface === undefined) continue;
        const dormer = new THREE.Mesh(new THREE.BoxGeometry(Math.min(2.4, w * 0.2), 1.75, 1.35), boxMaterials(spec.facade, spec.roof)); dormer.position.set(dormerX, surface + 0.5, dormerZ); dormer.castShadow = true; this.place(dormer);
        const window = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.92), this.glass); window.position.set(dormer.position.x, dormer.position.y, dormer.position.z + 0.681); this.place(window);
      }
    }

    // Mutually recognisable roof/utility stories instead of the old universal red chimney.
    if (variant % 4 === 1) {
      const panelX = x + w * 0.14; const panelZ = z - d * 0.1;
      const surface = roofSurfaceAt(this.tiers, this.gables, panelX, panelZ);
      if (surface !== undefined) {
        const panel = new THREE.Mesh(new THREE.BoxGeometry(Math.min(3.1, w * 0.24), 0.1, 1.45), this.solarGlass);
        panel.position.set(panelX, surface + 0.12, panelZ); panel.rotation.z = -0.08; panel.castShadow = true; panel.name = 'residential-solar-panel'; this.place(panel);
        const geyser = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 1.55, 14), this.zincRoof);
        geyser.rotation.x = Math.PI / 2; geyser.position.set(panelX - 1.05, surface + 0.58, panelZ - 0.45); geyser.castShadow = true; geyser.name = 'residential-solar-geyser'; this.place(geyser);
      }
    } else if (variant % 4 === 2) {
      const dishX = x + w * 0.23; const dishZ = z - d * 0.08;
      const surface = roofSurfaceAt(this.tiers, this.gables, dishX, dishZ);
      if (surface !== undefined) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.07, 1.15, 8), this.darkMetal); pole.position.set(dishX, surface + 0.56, dishZ); pole.name = 'residential-satellite-mount'; this.place(pole);
        const dishMaterial = new THREE.MeshStandardMaterial({ color: 0xb7bbb7, roughness: 0.7, metalness: 0.18, side: THREE.DoubleSide });
        const dish = new THREE.Mesh(new THREE.CircleGeometry(0.68, 18), dishMaterial); dish.position.set(dishX, surface + 1.12, dishZ); dish.rotation.set(-0.72, variant * 0.37, 0); dish.castShadow = true; dish.name = 'residential-satellite-dish'; this.place(dish);
      }
    } else if (variant % 4 === 3 && spec.style === 'suburban' && (massing === 3 || massing === 7)) {
      // The L/front-wing massings leave this opposite front corner as yard. Keep the tank wholly
      // inside the authored parcel envelope so its real collider never steals pavement or a neighbour.
      const radius = 0.92; const tankX = x - w * 0.38; const tankZ = z + d / 2 - radius - 0.25;
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 2.35, 18), this.tankPlastic); tank.position.set(tankX, 1.375, tankZ); tank.castShadow = true; tank.name = 'residential-backup-tank'; this.place(tank);
      const lid = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.78, 0.16, 18), this.darkMetal); lid.position.set(tankX, 2.62, tankZ); lid.name = 'residential-backup-tank-lid'; this.place(lid);
    }
  }

  private addIndustrialDetail(spec: BuildingSpec, massing: number, roofY: number): void {
    const { x, z, width: w, depth: d, height: h, variant } = spec;
    const dockW = w * 0.58; const dockZ = frontFacadeZAt(this.tiers, x, 0.7, dockW / 2);
    if (dockZ !== undefined) {
      const dock = new THREE.Mesh(new THREE.BoxGeometry(dockW, 1.1, 2.4), this.steel); dock.position.set(x, 0.7, dockZ + 1.1); dock.castShadow = true; this.place(dock);
    }
    const pipeHeight = Math.min(8, h * 0.65);
    for (const side of [-1, 1]) {
      const pipeX = x + side * w * 0.36; const pipeY = pipeHeight / 2 + 0.5; const pipeZ = frontFacadeZAt(this.tiers, pipeX, pipeY, 0.17); if (pipeZ === undefined) continue;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, pipeHeight, 12), this.steel); pipe.position.set(pipeX, pipeY, pipeZ + 0.1); pipe.castShadow = true; this.place(pipe);
    }
    const ductW = w * 0.42; const ductY = h * 0.62; const ductZ = frontFacadeZAt(this.tiers, x, ductY, ductW / 2);
    if (ductZ !== undefined) { const duct = new THREE.Mesh(new THREE.BoxGeometry(ductW, 0.8, 0.85), this.steel); duct.position.set(x, ductY, ductZ + 0.36); this.place(duct); }
    if (variant % 2 === 1) {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.25, Math.min(8, h * 0.65), 24), this.steel); tank.position.set(x + w * 0.28, Math.min(8, h * 0.65) / 2 + 0.25, z - d * 0.22); tank.castShadow = true; this.place(tank);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(2.1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), this.steel); dome.position.set(tank.position.x, tank.position.y + Math.min(8, h * 0.65) / 2, tank.position.z); dome.castShadow = true; this.place(dome);
      // Concrete ring foundation running 3u below grade: the yard tank stands outside the massing, so
      // on a sloped parcel this fills the gap under its downhill rim instead of leaving it airborne.
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(2.35, 2.55, 3.2, 24), this.stone); pad.position.set(tank.position.x, -1.3, tank.position.z); pad.receiveShadow = true; this.place(pad);
    }
    if (massing === 3) {
      const monitor = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 1.5, d * 0.24), this.glass); monitor.position.set(x, roofY - 0.7, z); monitor.castShadow = true; this.place(monitor);
    }
  }
}
