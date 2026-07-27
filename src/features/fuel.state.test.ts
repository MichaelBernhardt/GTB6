import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPROACH_REACH, BASE_95_CENTS, CAN_LITRES, DEFAULT_FUEL_SAVE, IDLE_LPS, LOW_FRACTION,
  SPUTTER_FRACTION, THIRST, THROTTLE_LPS, TANKS, approachNear, burn, ensureForecourts, forecourtNear,
  forecourts, fractionIn, fuelHud, fuelTick, hasTank, isMetered, litresIn, markRevealed, resetLedger,
  sanitizeFuelSave, seedFill, setLitres, tankGauge, tankSize,
} from './fuel.state';
import type { InteractionCtx } from './types';
import type { Vehicle } from '../entities/Vehicle';
import { VEHICLE_SPECS, type VehicleKind } from '../config';

/** A Vehicle stand-in: burn() only reads spec, speed, position and the two damage flags. */
function car(kind: VehicleKind = 'compact', x = 0, z = 0, speed = 0): Vehicle {
  return {
    spec: VEHICLE_SPECS[kind], speed, wrecked: false, disabled: false,
    group: { position: { x, y: 0, z } },
  } as unknown as Vehicle;
}

/** The frame the host hands the eager hooks. */
function frame(vehicle: Vehicle | undefined, x = vehicle?.group.position.x ?? 0, z = vehicle?.group.position.z ?? 0): InteractionCtx {
  return { context: vehicle ? 'vehicle' : 'foot', position: { x, y: 0, z } as InteractionCtx['position'], vehicle, hour: 12 };
}

describe('fuel — the tank sizes', () => {
  it('gives every kind of car between eight and thirteen minutes of flat-out driving', () => {
    for (const kind of Object.keys(TANKS) as VehicleKind[]) {
      if (TANKS[kind] === 0) continue;
      const seconds = TANKS[kind] / (IDLE_LPS + THROTTLE_LPS * THIRST[kind]);
      expect(seconds, kind).toBeGreaterThan(400);
      expect(seconds, kind).toBeLessThan(800);
    }
  });
});

describe('fuel — burn', () => {
  it('drains faster under throttle than at idle', () => {
    resetLedger(); markRevealed();
    const idling = car('compact'); const flat = car('compact', 40, 40, VEHICLE_SPECS.compact.maxSpeed);
    setLitres(idling, 40); setLitres(flat, 40);
    burn(idling, 1); burn(flat, 1);
    expect(litresIn(flat)).toBeLessThan(litresIn(idling));
    expect(litresIn(idling)).toBeCloseTo(40 - IDLE_LPS, 5);
  });

  /**
   * The bug the owner's playtest exposed twice over. The burn used to take its own wall-clock delta
   * once per RENDERED frame and clamp it to 0.1 s, so a slow machine quietly under-burned: measured
   * in-engine at 0.0059 L/s against a design rate of 0.0825 — a 45 L tank lasting 127 minutes instead
   * of nine. It is driven by the host's fixed sim sub-step now, so the same wall-clock second costs
   * the same litres however the frame is sliced.
   */
  it('burns the same litres per second of SIMULATION however the frame is sliced', () => {
    const total = 12;
    const fills: number[] = [];
    for (const step of [0.05, 0.016, 0.5, 2]) {
      resetLedger(); markRevealed();
      const vehicle = car('compact', 60, 60, VEHICLE_SPECS.compact.maxSpeed);
      setLitres(vehicle, 40);
      for (let elapsed = 0; elapsed < total - 1e-9; elapsed += step) burn(vehicle, step);
      fills.push(litresIn(vehicle));
    }
    for (const fill of fills) expect(fill).toBeCloseTo(fills[0]!, 6);
    expect(40 - fills[0]!).toBeCloseTo(total * (IDLE_LPS + THROTTLE_LPS * THIRST.compact), 6);
  });

  it('never lets a tank go negative and never burns a bicycle', () => {
    resetLedger(); markRevealed();
    const bike = car('bicycle');
    expect(hasTank(bike)).toBe(false);
    expect(tankSize(bike)).toBe(0);
    expect(burn(bike, 100)).toBe(0);
    const golf = car('compact', 10, 10);
    setLitres(golf, 0.2);
    burn(golf, 60);
    expect(litresIn(golf)).toBe(0);
  });

  it('floors at a limp reserve until the player has actually met the mechanic', () => {
    resetLedger();
    const golf = car('compact', 20, 20, VEHICLE_SPECS.compact.maxSpeed);
    setLitres(golf, 20);
    for (let step = 0; step < 4000; step++) burn(golf, 0.1);
    expect(fractionIn(golf)).toBeCloseTo(0.09, 3);
    markRevealed();
    for (let step = 0; step < 4000; step++) burn(golf, 0.1);
    expect(litresIn(golf)).toBe(0);
  });

  it('never lets the reserve REFILL a tank that is already below it', () => {
    resetLedger();
    const golf = car('compact', 21, 21, 10);
    setLitres(golf, tankSize(golf) * 0.03); // a can poured, a save adopted, a QA drain
    const before = litresIn(golf);
    burn(golf, 1);
    expect(litresIn(golf)).toBeLessThanOrEqual(before);
  });

  it('does not burn a wrecked car', () => {
    resetLedger(); markRevealed();
    const golf = car('compact', 30, 30, 20);
    setLitres(golf, 10);
    (golf as { wrecked: boolean }).wrecked = true;
    burn(golf, 5);
    expect(litresIn(golf)).toBe(10);
  });

  it('warns before it sputters', () => {
    expect(SPUTTER_FRACTION).toBeLessThan(LOW_FRACTION);
  });
});

describe('fuel — the seeded starting tank', () => {
  it('gives the first car of a session a generous fill and later ones a real spread', () => {
    resetLedger();
    const first = seedFill(car('compact', 100, 100));
    expect(first / TANKS.compact).toBeGreaterThanOrEqual(0.62);
    const spread = new Set<number>();
    for (let index = 0; index < 40; index++) {
      spread.add(Math.round((seedFill(car('compact', index * 37, index * 53)) / TANKS.compact) * 100));
    }
    expect(Math.min(...spread)).toBeLessThan(45);
    expect(Math.max(...spread)).toBeGreaterThan(60);
    expect(spread.size).toBeGreaterThan(20); // not every stolen car is full, which is the whole point
  });

  it('is deterministic per parking spot', () => {
    resetLedger();
    seedFill(car('compact', 0, 0)); // burn the generous first-car roll
    expect(seedFill(car('van', 812, -455))).toBe(seedFill(car('van', 812, -455)));
  });

  it('only meters a vehicle once it has been looked at', () => {
    resetLedger();
    const golf = car('compact', 5, 5);
    expect(isMetered(golf)).toBe(false);
    litresIn(golf);
    expect(isMetered(golf)).toBe(true);
  });
});

/**
 * The owner's report, verbatim: "5182 petrol: I don't see a guage". He drove and never saw one,
 * because the chip was built inside the lazy body and the body only loads when you press E at a
 * forecourt. These are the tests that say it exists before any of that.
 */
describe('fuel — the gauge is eager', () => {
  it('reads out from the first frame behind the wheel, with no feature body anywhere', () => {
    resetLedger();
    const vehicle = car('compact', 700, -700);
    setLitres(vehicle, tankSize(vehicle) * 0.5);
    expect(fuelHud(frame(vehicle))).toEqual([{ id: 'fuel:tank', label: 'FUEL', value: '50%', fill: 50, warn: false }]);
  });

  it('goes warning-coloured below the low mark and reads DRY at nothing', () => {
    resetLedger();
    const vehicle = car('compact', 10, 10);
    setLitres(vehicle, tankSize(vehicle) * (LOW_FRACTION - 0.01));
    expect(tankGauge(vehicle)).toMatchObject({ warn: true });
    setLitres(vehicle, 0);
    expect(tankGauge(vehicle)).toMatchObject({ value: 'DRY', fill: 0, warn: true });
  });

  it('shows nothing on foot, and nothing on a bicycle', () => {
    resetLedger();
    expect(fuelHud(frame(undefined))).toEqual([]);
    expect(fuelHud(frame(car('bicycle', 3, 3)))).toEqual([]);
    expect(tankGauge(undefined)).toBeUndefined();
  });
});

describe('fuel — the eager tick', () => {
  it('burns while driving and leaves the world alone on foot', () => {
    resetLedger(); markRevealed();
    const vehicle = car('compact', 55, 55, VEHICLE_SPECS.compact.maxSpeed);
    setLitres(vehicle, 30);
    fuelTick(0.05, frame(vehicle));
    expect(litresIn(vehicle)).toBeCloseTo(30 - 0.05 * (IDLE_LPS + THROTTLE_LPS * THIRST.compact), 6);
    const before = litresIn(vehicle);
    fuelTick(0.05, frame(undefined));
    expect(litresIn(vehicle)).toBe(before);
  });

  /** The predicate is the prompt resolver: it runs off the render loop and a lower rung can skip it
   *  entirely. Anything that advances state has to be in the tick, not in here. */
  it('leaves approachNear pure — asking where you are must not move the needle', () => {
    resetLedger(); markRevealed();
    const vehicle = car('compact', 500, 500, 30);
    setLitres(vehicle, 20);
    for (let call = 0; call < 50; call++) approachNear(vehicle, 500, 500);
    expect(litresIn(vehicle)).toBe(20);
  });
});

describe('fuel — where the garages roughly are', () => {
  beforeAll(async () => { await ensureForecourts(); }, 180_000);

  it('finds them all in the models the map already scattered', () => {
    expect(forecourts().length).toBeGreaterThanOrEqual(12);
    expect(forecourts().every((spot) => Number.isFinite(spot.x) && Number.isFinite(spot.z))).toBe(true);
  });

  it('answers "am I at a garage" inside the pumps and not from the next street', () => {
    const spot = forecourts()[0]!;
    const cx = spot.x + Math.sin(spot.heading) * 1;
    const cz = spot.z + Math.cos(spot.heading) * 1;
    expect(forecourtNear(cx, cz)?.id).toBe(spot.id);
    expect(forecourtNear(cx + APPROACH_REACH + 4, cz)).toBeUndefined();
  });

  it('tells a low tank how far the nearest garage is — a red gauge with nowhere to go is a punishment', () => {
    resetLedger();
    const spot = forecourts()[0]!;
    const vehicle = car('compact', spot.x + 300, spot.z + 300);
    setLitres(vehicle, tankSize(vehicle) * 0.5);
    expect(fuelHud(frame(vehicle))).toHaveLength(1); // nothing to say while you have half a tank
    setLitres(vehicle, tankSize(vehicle) * 0.1);
    const chips = fuelHud(frame(vehicle));
    expect(chips).toHaveLength(2);
    expect(chips[1]).toMatchObject({ id: 'fuel:hint', label: 'GARAGE', warn: true });
    expect(chips[1]!.value).toMatch(/^\d+ m$/);
  });

  it('offers the pull-in only to a tanked vehicle that has actually slowed down', () => {
    resetLedger(); markRevealed();
    const spot = forecourts()[0]!;
    const at = { x: spot.x + Math.sin(spot.heading), z: spot.z + Math.cos(spot.heading) };
    expect(approachNear(car('compact', at.x, at.z, 0), at.x, at.z)).toBe(true);
    expect(approachNear(car('compact', at.x, at.z, 30), at.x, at.z)).toBe(false);
    expect(approachNear(car('bicycle', at.x, at.z, 0), at.x, at.z)).toBe(false);
    expect(approachNear(undefined, at.x, at.z)).toBe(false);
  });
});

describe('fuel — the save slice', () => {
  it('round-trips a real slice', () => {
    const slice = { driving: 21.5, can: 5, tipped: 40, cents: 2712, daysToHike: 1, hikeCents: 84, litresBought: 300 };
    expect(sanitizeFuelSave(slice)).toEqual(slice);
  });

  it('defaults an absent or hostile slice', () => {
    expect(sanitizeFuelSave(undefined)).toEqual(DEFAULT_FUEL_SAVE);
    expect(sanitizeFuelSave('vol-tank')).toEqual(DEFAULT_FUEL_SAVE);
    expect(sanitizeFuelSave({})).toEqual(DEFAULT_FUEL_SAVE);
  });

  it('clamps nonsense instead of trusting it', () => {
    const wild = sanitizeFuelSave({ driving: Number.NaN, can: 900, tipped: -5, cents: 999999, daysToHike: 400, hikeCents: -99999, litresBought: 'lots' });
    expect(wild.driving).toBeNull();
    expect(wild.can).toBe(CAN_LITRES);
    expect(wild.tipped).toBe(0);
    expect(wild.cents).toBe(6000);
    expect(wild.daysToHike).toBe(12);
    expect(wild.hikeCents).toBe(-400);
    expect(wild.litresBought).toBe(0);
  });

  it('opens at the inland pump price', () => {
    expect(DEFAULT_FUEL_SAVE.cents).toBe(BASE_95_CENTS);
  });
});
