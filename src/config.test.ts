import { describe, expect, it } from 'vitest';
import { VEHICLE_SPECS } from './config';

describe('vehicle configuration', () => {
  it('gives each class a distinct handling role', () => {
    expect(VEHICLE_SPECS.sport.maxSpeed).toBeGreaterThan(VEHICLE_SPECS.compact.maxSpeed);
    expect(VEHICLE_SPECS.van.health).toBeGreaterThan(VEHICLE_SPECS.sport.health);
    expect(VEHICLE_SPECS.compact.steering).toBeGreaterThan(VEHICLE_SPECS.van.steering);
    for (const spec of Object.values(VEHICLE_SPECS)) expect(spec.acceleration).toBeGreaterThan(0);
  });
});
