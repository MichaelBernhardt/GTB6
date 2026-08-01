import { describe, expect, it } from 'vitest';
import type { VehicleKind } from '../config';
import {
  FLOW_COMBO_SECONDS,
  FLOW_MIN_CENTRE_GAP,
  JoziFlowSystem,
  nearMissAward,
  nearMissLabel,
  nearMissProbe,
  POTHOLE_PASS_MAX_CLEARANCE,
  POTHOLE_PASS_MIN_CLEARANCE,
  potholePassAward,
  potholePassProbe,
  scorableNearMiss,
  scorablePotholePass,
  type FlowHazard,
  type FlowVehicle,
} from './JoziFlowSystem';
import { potholeRadiusToward } from '../world/PotholeShape';

function vehicle(
  x: number,
  z: number,
  options: { kind?: VehicleKind; heading?: number; speed?: number; width?: number; length?: number; y?: number } = {},
): FlowVehicle {
  return {
    group: { position: { x, y: options.y ?? 0, z } },
    spec: { kind: options.kind ?? 'compact', size: [options.width ?? 1.8, 1.4, options.length ?? 3.7] },
    heading: options.heading ?? 0,
    speed: options.speed ?? 24,
    disabled: false,
    wrecked: false,
  };
}

describe('Jozi Flow near-miss geometry', () => {
  it('scores a clean behind-to-ahead pass through the non-contact side band', () => {
    const driver = vehicle(0, 0);
    const other = vehicle(FLOW_MIN_CENTRE_GAP + 0.25, -0.2, { speed: 0 });
    const probe = nearMissProbe(driver, other);
    expect(probe.centreGap).toBeCloseTo(FLOW_MIN_CENTRE_GAP + 0.25);
    expect(probe.visualClearance).toBeGreaterThan(0);
    expect(scorableNearMiss(0.2, probe, 1 / 60)).toBe(true);
  });

  it('rejects contact, wide passes, low speed, wrong crossing direction, and different storeys', () => {
    const driver = vehicle(0, 0);
    const probe = (x: number, speed = 24, y = 0) => nearMissProbe(vehicle(0, 0, { speed }), vehicle(x, -0.2, { speed: 0, y }));
    expect(scorableNearMiss(0.2, probe(FLOW_MIN_CENTRE_GAP - 0.1), 1 / 60)).toBe(false);
    expect(scorableNearMiss(0.2, probe(5.3), 1 / 60)).toBe(false);
    expect(scorableNearMiss(0.2, probe(3.5, 10), 1 / 60)).toBe(false);
    expect(scorableNearMiss(-0.2, probe(3.5), 1 / 60)).toBe(false);
    expect(scorableNearMiss(0.2, probe(3.5, 24, 4), 1 / 60)).toBe(false);
    expect(driver.speed).toBe(24); // the scorer is observational
  });

  it('names recognisable vehicles and rewards danger, chains, heat, and oncoming speed', () => {
    const driver = vehicle(0, 0);
    const taxi = vehicle(3.5, -0.1, { kind: 'taxi', speed: 0 });
    const taxiProbe = nearMissProbe(driver, taxi);
    expect(nearMissLabel(driver, taxi, taxiProbe, 0)).toBe('QUANTUM SQUEEZE');
    expect(nearMissLabel(driver, taxi, taxiProbe, 3)).toBe('BLUE-LIGHT NEEDLE');
    const oncoming = vehicle(3.5, -0.1, { heading: Math.PI, speed: 24 });
    const oncomingProbe = nearMissProbe(driver, oncoming);
    expect(nearMissLabel(driver, oncoming, oncomingProbe, 0)).toBe('WRONG-SIDE SPECIAL');
    expect(nearMissAward(oncomingProbe, 2, 4)).toBeGreaterThan(nearMissAward(taxiProbe, 0, 1));
  });
});

describe('Jozi Flow loop', () => {
  it('builds a combo, shows its bank timer, pays after a clean gap, and records a PB', () => {
    const flow = new JoziFlowSystem();
    const driver = vehicle(0, 0);
    const other = vehicle(3.5, 0.2, { kind: 'van', speed: 0 });
    expect(flow.update(1 / 60, driver, [other], [], true, 0)).toBeUndefined();
    (other.group.position as { z: number }).z = -0.2;
    const scored = flow.update(1 / 60, driver, [other], [], true, 0);
    expect(scored?.[0]).toMatchObject({ kind: 'near-miss', label: 'BAKKIE BRUSH', combo: 1 });
    expect(flow.hud()?.value).toMatch(/^×1 · R\d+$/);
    const banked = flow.update(FLOW_COMBO_SECONDS + 0.01, driver, [other], [], true, 0);
    expect(banked?.[0]).toMatchObject({ kind: 'bank', combo: 1, personalBest: true });
    expect(flow.bestBank).toBe((banked?.[0] as { amount: number }).amount);
    expect(flow.hud()).toBeUndefined();
  });

  it('does not farm one vehicle repeatedly during its cooldown', () => {
    const flow = new JoziFlowSystem();
    const driver = vehicle(0, 0); const other = vehicle(3.5, 0.2, { speed: 0 });
    flow.update(1 / 60, driver, [other], [], true, 0);
    (other.group.position as { z: number }).z = -0.2;
    expect(flow.update(1 / 60, driver, [other], [], true, 0)?.[0]?.kind).toBe('near-miss');
    (other.group.position as { z: number }).z = 0.2;
    flow.update(0.1, driver, [other], [], true, 0);
    (other.group.position as { z: number }).z = -0.2;
    expect(flow.update(0.1, driver, [other], [], true, 0)).toBeUndefined();
  });

  it('chains a close pothole dodge with traffic, but rejects a hit or a wide miss', () => {
    const driver = vehicle(0, 0);
    const pothole = { x: 1.3, z: 0.2, r: 1, axis: Math.PI / 2 }; // stretched down the lane the driver is in
    const probe = potholePassProbe(driver, pothole);
    // Clearance is the gap to the edge the driver can SEE — the outline reach facing the tyre line —
    // never to a circle of radius r. A hole broken along the lane is narrower across it than `r` says:
    // here the drawn edge is a quarter of a unit further from the tyre line than the scalar claims,
    // which is the difference between paying for a slalom and paying for a shave. The drawn shape and
    // the scored shape must never be allowed to drift apart silently.
    expect(probe.clearance).toBeCloseTo(Math.abs(probe.side) - potholeRadiusToward(pothole, -1, 0));
    expect(probe.clearance).toBeCloseTo(0.542, 2);
    expect(Math.abs(probe.side) - pothole.r).toBeCloseTo(0.3);
    expect(scorablePotholePass(0.2, { ...probe, ahead: -0.2 }, 1 / 60)).toBe(true);
    expect(scorablePotholePass(0.2, { ...probe, ahead: -0.2, clearance: POTHOLE_PASS_MIN_CLEARANCE - 0.01 }, 1 / 60)).toBe(false);
    expect(scorablePotholePass(0.2, { ...probe, ahead: -0.2, clearance: POTHOLE_PASS_MAX_CLEARANCE + 0.01 }, 1 / 60)).toBe(false);

    expect(flowUpdateAcrossPothole(driver, pothole)?.[0]).toMatchObject({
      kind: 'near-miss', label: 'TYRE-SHOP TEASER', combo: 1,
    });
    const safer = { ...probe, clearance: 1.4 };
    expect(potholePassAward(probe, 0, 1)).toBeGreaterThan(potholePassAward(safer, 0, 1));
    expect(potholePassAward(probe, 3, 4)).toBeGreaterThan(potholePassAward(probe, 0, 1));
  });

  it('loses an unbanked pot on a crash and keeps a saved best across ordinary resets', () => {
    const flow = new JoziFlowSystem(500);
    const driver = vehicle(0, 0); const other = vehicle(3.5, 0.2, { speed: 0 });
    flow.update(1 / 60, driver, [other], [], true, 0);
    (other.group.position as { z: number }).z = -0.2;
    flow.update(1 / 60, driver, [other], [], true, 0);
    expect(flow.fail('Pothole collected')).toMatchObject({ kind: 'lost', reason: 'Pothole collected' });
    expect(flow.hud()).toBeUndefined();
    flow.reset();
    expect(flow.bestBank).toBe(500);
  });
});

/** The DRIVER crosses the hole, not the other way round: a pothole's outline is derived from its own
 *  world position, so teleporting the hazard across the axle line would legitimately reshape it. */
function flowUpdateAcrossPothole(driver: FlowVehicle, pothole: FlowHazard) {
  const flow = new JoziFlowSystem();
  const moving = { ...driver, group: { position: { ...driver.group.position } } };
  flow.update(1 / 60, moving, [], [], true, 0, [pothole]);
  moving.group.position.z += 0.4;
  return flow.update(1 / 60, moving, [], [], true, 0, [pothole]);
}
