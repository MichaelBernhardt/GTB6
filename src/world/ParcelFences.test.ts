import { describe, expect, it } from 'vitest';
import { PLAYER } from '../config';
import {
  FENCE_HAZARD_COOLDOWN, FENCE_HAZARD_DAMAGE, fenceHazardTouch, stepVertical,
} from '../core/GameRules';
import { ARCHITECTURE_VARIANTS } from './BuildingArchitecture';
import {
  allBuildings, CELL_SIZE, footprintOverlapXZ, footprintRoadClearance, LAYOUT_SCALE, type GeneratedBuilding,
} from './CityGen';
import { districtAt, distanceToRoadEdge } from './mapData';
import { neighbourhoodBuildingVariant } from './data/neighbourhoods';
import {
  FENCE_ROAD_CLEARANCE, FENCE_SEGMENT_MAX, FENCE_SPECS, FENCE_THICKNESS,
  fenceKindFor, fenceSegmentCollider, GATE_HALF_WIDTH, planParcelFence,
  type FencePlan,
} from './ParcelFences';

/** The same massing derivation City feeds the planner (variant -> architecture massing index). */
const massingOf = (parcel: GeneratedBuilding): number =>
  neighbourhoodBuildingVariant(districtAt(parcel.x, parcel.z), parcel.variant) % ARCHITECTURE_VARIANTS[parcel.style];

/** Cell-bucketed parcels, mirroring generateCell so neighbour vetoes match the runtime exactly. */
function cellBuckets(): Map<string, GeneratedBuilding[]> {
  const cells = new Map<string, GeneratedBuilding[]>();
  for (const building of allBuildings()) {
    const key = `${Math.floor(building.x / CELL_SIZE)},${Math.floor(building.z / CELL_SIZE)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(building); else cells.set(key, [building]);
  }
  return cells;
}

function neighbourhood(cells: Map<string, GeneratedBuilding[]>, parcel: GeneratedBuilding): GeneratedBuilding[] {
  const cellX = Math.floor(parcel.x / CELL_SIZE); const cellZ = Math.floor(parcel.z / CELL_SIZE);
  const out: GeneratedBuilding[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(cells.get(`${cellX + dx},${cellZ + dz}`) ?? []));
  return out;
}

describe('fence rolls', () => {
  it('fences only residential parcels, as the norm with the odd open stand', () => {
    const parcels = allBuildings();
    let residential = 0; let fenced = 0;
    const kinds: Record<string, number> = {};
    for (const parcel of parcels) {
      const kind = fenceKindFor(parcel);
      if (parcel.zone !== 'residential') { expect(kind).toBeUndefined(); continue; }
      residential++;
      if (kind) { fenced++; kinds[kind] = (kinds[kind] ?? 0) + 1; }
    }
    expect(residential).toBeGreaterThan(3000); // denominator sanity: the suburbs pass landed
    const fraction = fenced / residential;
    expect(fraction).toBeGreaterThan(0.88); // fences are the norm...
    expect(fraction).toBeLessThan(0.97); // ...but not a bylaw: some stands stay open
    for (const kind of ['wall', 'palisade', 'razor']) expect(kinds[kind] ?? 0).toBeGreaterThan(100);
  });

  it('is deterministic: the same parcel plans the same fence twice', () => {
    const parcel = allBuildings().find((candidate) => candidate.zone === 'residential' && fenceKindFor(candidate))!;
    const options = { massing: massingOf(parcel), entranceX: 1.2, neighbours: [] };
    expect(planParcelFence(parcel, options)).toEqual(planParcelFence(parcel, options));
  });
});

describe('fence plans', () => {
  const cells = cellBuckets();
  const sample = allBuildings().filter((parcel, index) => parcel.zone === 'residential' && index % 17 === 0);
  const plans: Array<{ parcel: GeneratedBuilding; plan: FencePlan }> = [];
  for (const parcel of sample) {
    const plan = planParcelFence(parcel, { massing: massingOf(parcel), neighbours: neighbourhood(cells, parcel) });
    if (plan) plans.push({ parcel, plan });
  }

  it('samples enough parcels to mean something', () => {
    expect(plans.length).toBeGreaterThan(150); // denominator: every 17th residential parcel citywide
  });

  it('keeps every segment clear of roads, and off neighbouring footprints', { timeout: 30000 }, () => {
    let roadViolations = 0; let overlapViolations = 0; let overlong = 0;
    for (const { parcel, plan } of plans) {
      const neighbours = neighbourhood(cells, parcel);
      for (const segment of plan.segments) {
        if (segment.length > FENCE_SEGMENT_MAX + 1e-6) overlong++;
        if (footprintRoadClearance(segment.x, segment.z, segment.length, FENCE_THICKNESS, segment.heading) < FENCE_ROAD_CLEARANCE - 1e-6) roadViolations++;
        const rect = { x: segment.x, z: segment.z, width: segment.length, depth: FENCE_THICKNESS, heading: segment.heading };
        for (const other of neighbours) {
          if (other.x === parcel.x && other.z === parcel.z) continue;
          if ((other.x - segment.x) ** 2 + (other.z - segment.z) ** 2 > ((segment.length + other.width + other.depth) / 2 + 2) ** 2) continue;
          if (footprintOverlapXZ(rect, other) > 0.05 + 1e-6) overlapViolations++;
        }
      }
    }
    expect(overlong).toBe(0);
    expect(roadViolations).toBe(0);
    expect(overlapViolations).toBe(0);
  });

  it('places segments where the local frame says: world = parcel rotation of local', () => {
    for (const { parcel, plan } of plans) {
      const cos = Math.cos(parcel.heading); const sin = Math.sin(parcel.heading);
      for (const segment of plan.segments) {
        expect(segment.x).toBeCloseTo(parcel.x + segment.lx * cos + segment.lz * sin, 6);
        expect(segment.z).toBeCloseTo(parcel.z - segment.lx * sin + segment.lz * cos, 6);
      }
    }
  });

  it('leaves the gate open on the front run, aligned to the entrance', () => {
    for (const { parcel, plan } of plans) {
      const frontZ = Math.max(...plan.segments.map((segment) => segment.lz));
      for (const segment of plan.segments.filter((candidate) => candidate.along === 'x' && candidate.lz === frontZ)) {
        // No front panel may cover the gate opening.
        const from = segment.lx - segment.length / 2; const to = segment.lx + segment.length / 2;
        const overlapsGate = from < plan.gateLx + GATE_HALF_WIDTH - 1e-6 && to > plan.gateLx - GATE_HALF_WIDTH + 1e-6;
        expect(overlapsGate).toBe(false);
      }
      expect(Math.abs(plan.gateLx)).toBeLessThanOrEqual(parcel.width / 2 + 0.55);
    }
  });

  it('builds the collider from the drawn segment — tight, thin, oriented', () => {
    for (const { plan } of plans) {
      for (const segment of plan.segments) {
        const box = fenceSegmentCollider(segment, plan, 0);
        const cos = Math.cos(segment.heading); const sin = Math.sin(segment.heading);
        // Both segment endpoints sit on the collider's AABB boundary (the enclosing box is tight).
        for (const sign of [-1, 1]) {
          const endX = segment.x + sign * (segment.length / 2) * cos;
          const endZ = segment.z - sign * (segment.length / 2) * sin;
          expect(endX).toBeGreaterThanOrEqual(box.minX - 1e-6);
          expect(endX).toBeLessThanOrEqual(box.maxX + 1e-6);
          expect(endZ).toBeGreaterThanOrEqual(box.minZ - 1e-6);
          expect(endZ).toBeLessThanOrEqual(box.maxZ + 1e-6);
        }
        if (box.heading !== undefined) {
          expect(box.hw).toBeCloseTo(segment.length / 2, 6);
          expect(box.hd).toBeCloseTo(FENCE_THICKNESS / 2, 6);
        } else {
          // Quarter-snapped: the AABB itself must be the thin rect, not an inflation.
          expect(Math.min(box.maxX - box.minX, box.maxZ - box.minZ)).toBeLessThanOrEqual(FENCE_THICKNESS + 1e-6);
        }
        expect(box.height).toBe(plan.height);
        expect(box.hazard).toBe(plan.hazard);
      }
    }
  });
});

describe('the climb contract (collider height IS the mechanic)', () => {
  const apex = PLAYER.jumpSpeed ** 2 / (2 * PLAYER.gravity);

  it('orders the tiers and keeps razor barely crossable, spikes comfortably, walls trivially', () => {
    expect(FENCE_SPECS.wall.height).toBeLessThan(FENCE_SPECS.palisade.height);
    expect(FENCE_SPECS.palisade.height).toBeLessThan(FENCE_SPECS.razor.height);
    // Crossable at all: top <= jump apex + stepUp (the clamp band unlocks near the apex).
    expect(FENCE_SPECS.razor.height).toBeLessThanOrEqual(apex + PLAYER.stepUp - 0.05);
    // A house wall (or anything >= 2.6) stays a hard barrier.
    expect(apex + PLAYER.stepUp).toBeLessThan(2.6);
    expect(FENCE_HAZARD_DAMAGE.razor).toBeGreaterThan(FENCE_HAZARD_DAMAGE.spike);
    expect(FENCE_HAZARD_COOLDOWN).toBeGreaterThan(0.5);
  });

  /**
   * Jump a fence of the given collider height, mirroring the runtime semantics exactly:
   * clampMoveAt blocks horizontal motion while the fence top crosses [feet+stepUp, feet+height],
   * supportHeight offers the fence top once the capsule stands over it, and stepVertical (the
   * real one) integrates the jump. Returns whether the fence was crossed and whether the feet
   * ever touched the hazard band at the top.
   */
  function jumpOver(fenceTop: number): { crossed: boolean; touched: boolean } {
    const half = FENCE_THICKNESS / 2; const radius = PLAYER.radius; const speed = PLAYER.walkSpeed;
    let x = -1.4; // pressed toward the fence at x=0
    const motion = { y: 0, velocityY: 0, onGround: true, fallOriginY: 0 };
    let jump: number | undefined = PLAYER.jumpSpeed;
    let touched = false;
    for (let step = 0; step < 240; step++) {
      const dt = 1 / 60;
      const desired = x + speed * dt;
      // clampMoveAt: the fence blocks while its span crosses the capsule band above stepUp.
      const overlaps = Math.abs(desired) < half + radius;
      const blocks = overlaps && fenceTop > motion.y + PLAYER.stepUp;
      if (!blocks) x = desired;
      // supportHeight: the fence top is standable once within stepUp and the query circle overlaps.
      const support = Math.abs(x) < half + 0.35 && fenceTop <= motion.y + PLAYER.stepUp ? fenceTop : 0;
      stepVertical(motion, dt, support, jump);
      jump = undefined;
      if (fenceHazardTouch(fenceTop, motion.y) && Math.abs(x) < half + radius + 0.25) touched = true;
      if (x > half + radius + 0.3 && motion.onGround && motion.y <= 0.01) break;
    }
    return { crossed: x > half + radius + 0.3, touched };
  }

  it('crosses every fence tier with one jump, touching the hazard band on the way over', () => {
    for (const kind of ['wall', 'palisade', 'razor'] as const) {
      const outcome = jumpOver(FENCE_SPECS[kind].height);
      expect(outcome.crossed, `${kind} should be jumpable`).toBe(true);
      expect(outcome.touched, `${kind} crossing should touch its top band`).toBe(true);
    }
  });

  it('cannot cross a 2.6u wall — too tall is too tall', () => {
    expect(jumpOver(2.6).crossed).toBe(false);
  });

  it('reports no hazard touch when walking past at ground level', () => {
    expect(fenceHazardTouch(FENCE_SPECS.razor.height, 0)).toBe(false);
    expect(fenceHazardTouch(FENCE_SPECS.palisade.height, 0)).toBe(false);
    // Standing ON the top is a touch.
    expect(fenceHazardTouch(FENCE_SPECS.razor.height, FENCE_SPECS.razor.height)).toBe(true);
  });
});

/**
 * THE GATE HAS TO LEAD SOMEWHERE — the cross-parcel rule, and the fix for the citywide
 * reachability audit's headline finding (tools/qa/door-reachability.ts: 394 front doors sealed off
 * from the street by fences, every ring with a gate, every gate opening into a closed pocket).
 */
describe('a ring is only planned where its gate reaches the street', () => {
  const cells = cellBuckets();
  const fenced = allBuildings().filter((parcel) => parcel.zone === 'residential'
    && planParcelFence(parcel, { massing: massingOf(parcel), neighbours: neighbourhood(cells, parcel) }));

  it('rings stands that face a street, and never a mass buried in a block', () => {
    // The front fence line stands FRONT_MARGIN beyond the building face, and the frontage line puts
    // that a couple of units behind the kerb — so a ringed stand ALWAYS has tarmac within a few
    // units of its gate. A back-yard cottage's "front" faces the back wall of the house in front of
    // it, tens of units from any road; those are the parcels that used to be ringed anyway.
    expect(fenced.length).toBeGreaterThan(1200); // the suburbs are still fenced, and heavily
    let landlocked = 0;
    for (const parcel of fenced) {
      const front = parcel.depth / 2 + 3 * LAYOUT_SCALE;
      const gateX = parcel.x + front * Math.sin(parcel.heading);
      const gateZ = parcel.z + front * Math.cos(parcel.heading);
      if (distanceToRoadEdge(gateX, gateZ) > 12) landlocked++;
    }
    // Ratchet, not zero, and the reason is worth writing down: distanceToRoadEdge SATURATES at 14,
    // so this measures "the kerb is a long way off" rather than "there is no kerb", and the
    // density gradient made outer front gardens 1.35x deeper — which walks a handful of gates
    // toward that ceiling. The planner's own test is the obstacle-aware straight probe in
    // gateReachesStreet, which cleared every one of these; this bound just stops the class growing.
    expect(landlocked, `${landlocked} ringed stands have no street within reach of their gate`).toBeLessThanOrEqual(2);
  });

  it('refuses the ring rather than the gate — a planned ring always keeps its gate gap', () => {
    for (const parcel of fenced.slice(0, 400)) {
      const plan = planParcelFence(parcel, { massing: massingOf(parcel), neighbours: neighbourhood(cells, parcel) })!;
      const frontZ = parcel.depth / 2 + 3 * LAYOUT_SCALE - 1;
      const across = plan.segments.filter((segment) => segment.along === 'x' && Math.abs(segment.lz - frontZ) < 1e-6
        && Math.abs(segment.lx - plan.gateLx) < segment.length / 2 + GATE_HALF_WIDTH - 0.01);
      expect(across.length, `a front run crosses the gate at ${parcel.x},${parcel.z}`).toBe(0);
    }
  });
});
