import { describe, expect, it } from 'vitest';
import { METRES_PER_UNIT } from '../../world/mapData';
import {
  chooseCourse, courseName, dropZone, insetAt, lieAt, nearestInside, parForLength, pointInPolygon,
  rankCourses, resetCourseCache, routeCourse, type CourseLayout,
} from './layout';

/** The runtime terrain sampler is a City concern; routing only needs a height function. */
const flatGround = (): number => 0;

function built(): CourseLayout {
  const polygon = chooseCourse();
  if (!polygon) throw new Error('the committed map has no playable golf course');
  return routeCourse(polygon, flatGround);
}

describe('course selection', () => {
  it('ranks every golf polygon and flags the ones a freeway runs through', () => {
    const ranked = rankCourses();
    expect(ranked.length).toBeGreaterThanOrEqual(4);
    // Blocked courses sort last, whatever their score.
    const firstBlocked = ranked.findIndex((entry) => entry.blocked);
    if (firstBlocked >= 0) expect(ranked.slice(firstBlocked).every((entry) => entry.blocked)).toBe(true);
    // The two biggest polygons in this crop are Houghton and Wanderers, and the Egoli Orbital runs
    // through both — the size-only pick would put three holes across a motorway.
    const houghton = ranked.find((entry) => /houghton/i.test(entry.polygon.name));
    expect(houghton?.blocked).toBe(true);
  });

  it('picks a playable course with no major road inside it', () => {
    const chosen = chooseCourse();
    expect(chosen).toBeDefined();
    const entry = rankCourses().find((candidate) => candidate.polygon === chosen);
    expect(entry?.blocked).toBe(false);
    // and it is the best-scoring unblocked one — biggest course per unit of travel from the CBD.
    const bestUnblocked = rankCourses().filter((candidate) => !candidate.blocked)[0];
    expect(bestUnblocked?.polygon).toBe(chosen);
  });

  it('memoises the pick — the map does not move inside a session', () => {
    const first = chooseCourse();
    expect(chooseCourse()).toBe(first);
    resetCourseCache();
    expect(chooseCourse()).toBe(first);
  });

  it('dresses an unnamed OSM polygon up as a municipal course', () => {
    expect(courseName({ name: 'golf_course' } as never)).toBe('Municipal Golf Course');
    expect(courseName({ name: 'Parkview Golf Club' } as never)).toBe('Parkview Golf Club');
  });
});

describe('routing', () => {
  it('lays three holes entirely inside the boundary', () => {
    const layout = built();
    expect(layout.holes).toHaveLength(3);
    for (const hole of layout.holes) {
      expect(pointInPolygon(layout.polygon, hole.tee.x, hole.tee.z)).toBe(true);
      expect(pointInPolygon(layout.polygon, hole.pin.x, hole.pin.z)).toBe(true);
      // The green has to fit: the pin needs at least its own radius of room.
      expect(insetAt(layout.polygon, hole.pin.x, hole.pin.z)).toBeGreaterThan(hole.greenR);
      for (const bunker of hole.bunkers) expect(pointInPolygon(layout.polygon, bunker.x, bunker.z)).toBe(true);
    }
  });

  it('is a genuinely short round: three holes and under a kilometre of golf', () => {
    const layout = built();
    const totalM = layout.holes.reduce((sum, hole) => sum + hole.lengthM, 0);
    expect(totalM).toBeGreaterThan(300);
    expect(totalM).toBeLessThan(1200); // eighteen holes is ~6,000 m; this is a loop you finish
    expect(layout.parTotal).toBeGreaterThanOrEqual(9);
    expect(layout.parTotal).toBeLessThanOrEqual(14);
  });

  it('numbers the holes and measures them in metres', () => {
    const layout = built();
    expect(layout.holes.map((hole) => hole.number)).toEqual([1, 2, 3]);
    for (const hole of layout.holes) {
      expect(hole.lengthM).toBeCloseTo(hole.lengthU * METRES_PER_UNIT, 5);
      expect(hole.par).toBe(parForLength(hole.lengthM));
    }
  });

  it('puts the clubhouse inside the boundary and names the road it opens onto', () => {
    const layout = built();
    expect(pointInPolygon(layout.polygon, layout.clubhouse.x, layout.clubhouse.z)).toBe(true);
    expect(layout.gateRoad.length).toBeGreaterThan(0);
    // and near the first tee, not on the far side of the course
    const first = layout.holes[0]!;
    expect(Math.hypot(layout.clubhouse.x - first.tee.x, layout.clubhouse.z - first.tee.z)).toBeLessThan(220);
  });

  it('survives a degenerate polygon instead of throwing', () => {
    const sliver = {
      name: 'Sliver Golf Club', kind: 'green' as const, manicured: true,
      points: [{ x: 0, z: 0 }, { x: 60, z: 0 }, { x: 60, z: 8 }, { x: 0, z: 8 }],
      minX: 0, maxX: 60, minZ: 0, maxZ: 8, cx: 30, cz: 4, area: 480,
    };
    const layout = routeCourse(sliver, flatGround);
    expect(layout.holes).toHaveLength(3);
    for (const hole of layout.holes) expect(Number.isFinite(hole.lengthM)).toBe(true);
  });
});

describe('lies', () => {
  it('reads tee, green, bunker, fairway, rough and out', () => {
    const layout = built();
    const hole = layout.holes[1]!;
    expect(lieAt(layout, hole, hole.tee.x, hole.tee.z)).toBe('tee');
    expect(lieAt(layout, hole, hole.pin.x, hole.pin.z)).toBe('green');
    const middle = { x: (hole.tee.x + hole.pin.x) / 2, z: (hole.tee.z + hole.pin.z) / 2 };
    expect(lieAt(layout, hole, middle.x, middle.z)).toBe('fairway');
    expect(lieAt(layout, hole, layout.polygon.maxX + 500, layout.polygon.maxZ + 500)).toBe('out');
    if (hole.bunkers[0]) expect(lieAt(layout, hole, hole.bunkers[0].x, hole.bunkers[0].z)).toBe('bunker');
  });

  it('walks an out-of-bounds ball back inside the fence', () => {
    const layout = built();
    const drop = nearestInside(layout.polygon, layout.polygon.maxX + 90, layout.polygon.cz);
    expect(pointInPolygon(layout.polygon, drop.x, drop.z)).toBe(true);
  });

  it('drops an out-of-bounds ball on the fairway line, never past the green', () => {
    const layout = built();
    for (const hole of layout.holes) {
      // Through the back of the green, and wide of the tee: both must come back playable.
      for (const [x, z] of [[hole.pin.x + 120, hole.pin.z + 120], [hole.tee.x - 200, hole.tee.z - 200]]) {
        const drop = dropZone(layout.polygon, hole, x!, z!);
        expect(pointInPolygon(layout.polygon, drop.x, drop.z)).toBe(true);
        // never dropped INSIDE the hole: a drop that concedes the hole would be a scoring exploit
        expect(Math.hypot(drop.x - hole.pin.x, drop.z - hole.pin.z)).toBeGreaterThan(1);
      }
    }
  });
});
