import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Game.ts'), 'utf8');
const method = (name: string, next: string): string => {
  const start = source.indexOf(`private ${name}`); const end = source.indexOf(`private ${next}`, start + 1);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start); return source.slice(start, end);
};

describe('authoritative Game analytics hooks', () => {
  it('records player death and mission failure in the one-shot death transition', () => {
    const body = method('die()', 'restoreY'); expect(body).toContain("analytics.record('player_death'"); expect(body).toContain("this.processMissionUpdate(this.missions.fail('You were incapacitated'))");
  });

  it('records only piloted aircraft crashes in the active-plane crash handler', () => {
    const body = method('crashActivePlane', 'updatePlanes'); expect(body).toContain("analytics.record('aircraft_crash'");
    expect(method('updatePlanes', 'useStim')).not.toContain("analytics.record('aircraft_crash'");
  });

  it('uses the existing significant-impact threshold for driven vehicle collisions', () => {
    expect(method('handleVehicleCollisions', 'renderHUD')).toContain("if (impact > 12) analytics.record('vehicle_collision'");
    expect(method('updateDriving', 'recordCourierCrash')).toContain('this.prevDrivenSpeed > 12');
  });

  it('emits mission outcomes only from the centralized mission update processor', () => {
    const body = method('processMissionUpdate', 'celebrateMission');
    expect(body.match(/analytics\.record\('mission_fail'/g)).toHaveLength(1); expect(body.match(/analytics\.record\('mission_complete'/g)).toHaveLength(1);
    expect(source.match(/analytics\.record\('mission_start'/g)).toHaveLength(1);
  });

  it('reports required-asset failures without exposing asset payloads', () => {
    const body = method('async prepareAssets', 'setupRenderer'); expect(body).toContain("source: 'asset'"); expect(body).toContain("asset: 'required-3d-assets'");
  });
});
