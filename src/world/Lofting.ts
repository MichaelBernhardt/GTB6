/**
 * Lofting: sweep a closed cross-section along a list of stations and skin it.
 *
 * This is the one primitive that produces a CONTINUOUS surface from code. A body assembled from
 * separate boxes can never have a continuous line — the seams are the shape. A body built by
 * sweeping a changing cross-section along a path does, because every station shares its ring of
 * vertices with the next one, so a taper in plan and a curve in side view are the same operation.
 *
 * Everything here is deterministic, allocation-cheap and merge-friendly: the output is indexed and
 * carries position/normal/uv, which is what BufferGeometryUtils.mergeGeometries and the city's
 * static-merge pass both require.
 *
 * Two rules the callers must honour, or the surface renders inside-out:
 *  - section points wind COUNTER-CLOCKWISE in the station's (right, up) plane;
 *  - stations advance along right × up.
 * `sweepZ` and the section builders below are already set up that way.
 */
import * as THREE from 'three';

/** One ring of the sweep: a closed section placed by an origin plus a right/up basis. */
export interface LoftStation {
  origin: THREE.Vector3;
  /** The section's local +x. */
  right: THREE.Vector3;
  /** The section's local +y. */
  up: THREE.Vector3;
  /** Closed loop, CCW in (right, up); every station must have the same point count. */
  section: THREE.Vector2[];
}

/**
 * Skin a run of stations. Caps are built from their OWN copy of the end ring so the rim stays a
 * crease — sharing the ring would let computeVertexNormals smear the cap into the flank and round
 * off wingtips and nose faces that should be sharp.
 */
export function loft(stations: LoftStation[], capStart = true, capEnd = true): THREE.BufferGeometry {
  const rings = stations.length;
  const n = stations[0]!.section.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const place = (station: LoftStation, point: THREE.Vector2): [number, number, number] => [
    station.origin.x + station.right.x * point.x + station.up.x * point.y,
    station.origin.y + station.right.y * point.x + station.up.y * point.y,
    station.origin.z + station.right.z * point.x + station.up.z * point.y,
  ];
  for (let ring = 0; ring < rings; ring++) {
    const station = stations[ring]!;
    for (let index = 0; index < n; index++) {
      positions.push(...place(station, station.section[index]!));
      uvs.push(index / n, rings > 1 ? ring / (rings - 1) : 0);
    }
  }
  for (let ring = 0; ring < rings - 1; ring++) for (let index = 0; index < n; index++) {
    const next = (index + 1) % n;
    const a = ring * n + index; const b = ring * n + next;
    const c = (ring + 1) * n + next; const d = (ring + 1) * n + index;
    indices.push(a, b, c, a, c, d);
  }
  const cap = (ring: number, outward: boolean): void => {
    const station = stations[ring]!;
    const base = positions.length / 3;
    let cx = 0; let cy = 0; let cz = 0;
    for (const point of station.section) {
      const p = place(station, point);
      positions.push(...p); uvs.push(0.5, 0.5);
      cx += p[0]; cy += p[1]; cz += p[2];
    }
    positions.push(cx / n, cy / n, cz / n); uvs.push(0.5, 0.5);
    const centre = base + n;
    for (let index = 0; index < n; index++) {
      const next = (index + 1) % n;
      if (outward) indices.push(centre, base + index, base + next);
      else indices.push(centre, base + next, base + index);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(rings - 1, true);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const RIGHT_X = new THREE.Vector3(1, 0, 0);
const UP_Y = new THREE.Vector3(0, 1, 0);

/** A station for the common case: sections stacked up the +Z axis, upright. */
export interface ZStation { z: number; y: number; section: THREE.Vector2[]; }

/** Sweep upright sections along +Z (stations must be ordered front-to-back or back-to-front by z). */
export function sweepZ(stations: ZStation[], capStart = true, capEnd = true): THREE.BufferGeometry {
  return loft(stations.map((station) => ({
    origin: new THREE.Vector3(0, station.y, station.z), right: RIGHT_X, up: UP_Y, section: station.section,
  })), capStart, capEnd);
}

/**
 * A rounded closed section. `fill` bends it between an ellipse (1) and a rounded rectangle (>1),
 * and the top and bottom half-heights are independent so a tank can be domed above and flat below.
 */
export function ovalSection(halfWidth: number, above: number, below: number, points = 14, fill = 1.3): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  const power = 1 / Math.max(0.4, fill);
  for (let index = 0; index < points; index++) {
    const angle = (index / points) * Math.PI * 2;
    const c = Math.cos(angle); const s = Math.sin(angle);
    out.push(new THREE.Vector2(
      halfWidth * Math.sign(c) * Math.abs(c) ** power,
      (s >= 0 ? above : below) * Math.sign(s) * Math.abs(s) ** power,
    ));
  }
  return out;
}

/**
 * A "U" shell: the outer arc from the left rim, under the belly, round to the right rim, then the
 * inner arc back — a closed loop, so lofting it gives a panel that WRAPS, has real thickness and
 * open top edges. This is what a fairing flank or a belly pan actually is; a flat slab with hard
 * vertical edges is the tell that it was faked with a box.
 *
 * `rimFrac` is what stops it being a slab: below 1 the rim tucks inward so the widest point of the
 * section sits BELOW the top edge. That single shoulder is the difference between a panel that
 * catches light along a curve and a vertical wall with a hard edge.
 */
export function ushellSection(halfWidth: number, depth: number, thickness: number, points = 7, rimFrac = 1): THREE.Vector2[] {
  const outer: THREE.Vector2[] = []; const inner: THREE.Vector2[] = [];
  const shrink = Math.max(0.1, 1 - thickness / Math.max(thickness, halfWidth));
  const id = Math.max(depth * 0.25, depth - thickness);
  for (let index = 0; index < points; index++) {
    const angle = Math.PI * (1 + index / (points - 1));
    const c = Math.cos(angle); const s = Math.sin(angle);
    const wrap = halfWidth * c * (rimFrac + (1 - rimFrac) * Math.abs(s) ** 0.6);
    outer.push(new THREE.Vector2(wrap, depth * s));
    inner.push(new THREE.Vector2(wrap * shrink, id * s));
  }
  return [...outer, ...inner.reverse()];
}

/** The same shell arched the other way — a canopy, a roof, a screen. */
export function capSection(halfWidth: number, height: number, thickness: number, points = 7, rimFrac = 1): THREE.Vector2[] {
  return ushellSection(halfWidth, height, thickness, points, rimFrac).map((p) => new THREE.Vector2(p.x, -p.y)).reverse();
}

/**
 * A real aerofoil: NACA four-digit thickness over a two-part camber line, cosine-spaced so the
 * leading edge gets the points it needs. Rounded leading edge, thick forward section, camber over
 * the top, flat-ish underside, sharp trailing edge — the whole reason a wing reads as a wing rather
 * than a plank, and it costs about ten points.
 *
 * Returned in chord units scaled by `chord`, running trailing edge → upper surface → leading edge →
 * lower surface, which is CCW in (chord-aft, section-up).
 */
export function aerofoilSection(chord: number, thickness = 0.12, camber = 0.02, camberPos = 0.4, points = 12): THREE.Vector2[] {
  const half = Math.max(3, Math.round(points / 2));
  const thick = (x: number): number => 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
  const mean = (x: number): number => (x < camberPos
    ? (camber / (camberPos * camberPos)) * (2 * camberPos * x - x * x)
    : (camber / ((1 - camberPos) * (1 - camberPos))) * ((1 - 2 * camberPos) + 2 * camberPos * x - x * x));
  const at = (index: number): number => (1 - Math.cos((Math.PI * index) / half)) / 2;
  const out: THREE.Vector2[] = [];
  for (let index = half; index >= 0; index--) { const x = at(index); out.push(new THREE.Vector2(x * chord, (mean(x) + thick(x)) * chord)); }
  for (let index = 1; index < half; index++) { const x = at(index); out.push(new THREE.Vector2(x * chord, (mean(x) - thick(x)) * chord)); }
  return out;
}

/** One spanwise slice of a lifting surface: how far out it is, where its leading edge sits, how long
 *  its chord is, and how much nose-up incidence it carries. */
export interface WingStation { span: number; chord: number; lead: number; rise: number; incidence?: number; }

/**
 * Loft an aerofoil across spanwise stations — one surface, so taper and dihedral are continuous.
 * `axis` is the span direction: 'x' for a wing or tailplane, 'y' for a fin. `lead` is always the
 * leading-edge z; `rise` is the height for a wing and the lateral offset for a fin. Stations must
 * run in increasing span order.
 */
export function wingLoft(stations: WingStation[], section: (station: WingStation) => THREE.Vector2[], axis: 'x' | 'y' = 'x'): THREE.BufferGeometry {
  return loft(stations.map((station) => {
    const incidence = station.incidence ?? 0;
    const c = Math.cos(incidence); const s = Math.sin(incidence);
    if (axis === 'x') {
      return {
        origin: new THREE.Vector3(station.span, station.rise, station.lead),
        right: new THREE.Vector3(0, -s, -c), up: new THREE.Vector3(0, c, -s),
        section: section(station),
      };
    }
    return {
      origin: new THREE.Vector3(station.rise, station.span, station.lead),
      right: new THREE.Vector3(-s, 0, -c), up: new THREE.Vector3(-c, 0, s),
      section: section(station),
    };
  }));
}
