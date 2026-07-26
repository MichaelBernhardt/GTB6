import { describe, expect, it } from 'vitest';
import { NEW_FIT, OLD_FIT, TRANSFORM_K, insideNewWorld, scaleLength, toNewWorld } from './coord-transform.mjs';
import * as client from '../src/world/coordTransform.ts';
import { MAP_FIT, MAP_WORLD_SIZE } from './road-network.mjs';

/**
 * The server cannot import the TypeScript transform, so it carries a second copy. This file is the
 * reason that duplication is safe: it pins the two implementations to each other. If someone edits
 * one fit and not the other, players spawn in a field and THIS fails first.
 */
describe('server coordinate transform', () => {
  it('agrees with src/world/coordTransform.ts to sub-millimetre across the whole world square', () => {
    let worst = 0;
    for (let x = -9600; x <= 9600; x += 401) {
      for (let z = -9600; z <= 9600; z += 397) {
        const mine = toNewWorld({ x, z });
        const theirs = client.toNewWorld({ x, z });
        worst = Math.max(worst, Math.abs(mine.x - theirs.x), Math.abs(mine.z - theirs.z));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(TRANSFORM_K).toBeCloseTo(client.TRANSFORM_K, 12);
    expect(scaleLength(1000)).toBeCloseTo(client.scaleLength(1000), 9);
  });

  it('reads the NEW fit out of the committed map rather than a hand-typed literal', () => {
    expect(MAP_FIT).toBeDefined();
    expect(NEW_FIT).toEqual(MAP_FIT);
    expect(OLD_FIT.scale).toBe(client.OLD_FIT.scale); // the old fit IS a frozen literal, and must match
    expect(OLD_FIT.cx).toBe(client.OLD_FIT.cx);
    expect(OLD_FIT.cz).toBe(client.OLD_FIT.cz);
  });

  it('bounds the world square the same way the client does', () => {
    const half = MAP_WORLD_SIZE / 2;
    expect(insideNewWorld({ x: 0, z: 0 })).toBe(true);
    expect(insideNewWorld({ x: half - 5, z: 0 })).toBe(false); // inside the square but within the 10u margin
    expect(insideNewWorld({ x: half + 500, z: 0 })).toBe(false);
    expect(insideNewWorld({ x: 0, z: -(half + 500) })).toBe(false);
  });
});
