import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Boot-order regression guard. Unit tests never construct Game (it needs a DOM and a GL
 * context), so a `this.<system>` used before its constructor line is a crash the whole
 * suite can't see — exactly what shipped once with the Kelvin Yard guards spawning before
 * PopulationSystem existed. This test reads the Game constructor source and asserts the
 * known cross-system dependencies are initialised before first use.
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Game.ts'), 'utf8');

/** The constructor body: from `constructor(` to the start of the next class member. */
const constructorBody = ((): string => {
  const start = source.indexOf('constructor(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n  private ', start);
  return source.slice(start, end === -1 ? undefined : end);
})();

const firstIndex = (needle: string): number => {
  const index = constructorBody.indexOf(needle);
  expect(index, `expected the Game constructor to contain: ${needle}`).toBeGreaterThan(-1);
  return index;
};

describe('Game constructor boot order', () => {
  it('constructs each system before anything uses it', () => {
    const pairs: Array<[dependency: string, use: string]> = [
      ['this.population = new PopulationSystem(', 'this.population.spawnYardGuard('], // the Kelvin Yard guard crash
      ['this.population = new PopulationSystem(', 'new LifecycleSystem(this.city, this.population)'],
      ['this.city = new City(', 'buildKelvinYard(this.scene, this.city)'],
      ['this.city = new City(', 'new ShopSystem(this.scene, this.city)'],
      ['this.city = new City(', 'new SafehouseSystem(this.scene, this.city)'],
      ['this.city = new City(', 'new PopulationSystem(this.scene, this.city'],
    ];
    for (const [dependency, use] of pairs) {
      expect(firstIndex(dependency), `"${use}" runs before "${dependency}" — boot crash`).toBeLessThan(firstIndex(use));
    }
  });
});
