import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { FUEL_ICON_COLOR, featureMapIcons } from './mapIcons';
import { ensureForecourts, forecourts } from './fuel.state';
import { SHOP_ICON_COLOR } from '../systems/ShopSystem';

const here = dirname(fileURLToPath(import.meta.url));

describe('the eager feature blips', () => {
  beforeAll(async () => { await ensureForecourts(); }, 180_000); // the citywide scatter, once

  it('hands over every forecourt the map derived, as pump-shaped orange markers', () => {
    const icons = featureMapIcons();
    expect(icons.length).toBe(forecourts().length);
    expect(icons.length).toBeGreaterThanOrEqual(19);
    for (const icon of icons) {
      expect(icon.shape).toBe('fuel');
      expect(icon.color).toBe(FUEL_ICON_COLOR);
      expect(Number.isFinite(icon.x) && Number.isFinite(icon.z)).toBe(true);
    }
  });

  it('does not reuse the shop colour — a garage must not read as a shop at a glance', () => {
    expect(FUEL_ICON_COLOR).not.toBe(SHOP_ICON_COLOR);
  });

  it('reuses the immutable marker set instead of allocating nineteen objects every render frame', () => {
    const first = featureMapIcons();
    const second = featureMapIcons();
    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });

  /**
   * The load-bearing invariant, and the whole reason this module exists: an icon that needs the lazy
   * body is an icon for a place the player has already found. Asserted at the SOURCE, because the
   * bundler is what actually enforces it — see the chunk rules in vite.config.ts.
   */
  it('imports nothing from a feature body, so a blip can never wait on a chunk', () => {
    const source = readFileSync(join(here, 'mapIcons.ts'), 'utf8');
    expect(source).not.toMatch(/from '\.\/[a-z-]+\//);   // ./fuel/… and friends
    expect(source).not.toMatch(/import\(/);              // and no dynamic escape hatch either
  });

  it('joins Game’s canonical marker frame, which feeds both map surfaces without a second merge', () => {
    const game = readFileSync(join(here, '..', 'Game.ts'), 'utf8');
    const ui = readFileSync(join(here, '..', 'ui', 'UIManager.ts'), 'utf8');
    expect(game).toContain("import { featureMapIcons } from './features/mapIcons'");
    expect(game.slice(game.indexOf('private mapMarkers()'), game.indexOf('private mapPolice()'))).toContain('...featureMapIcons()');
    expect(ui).not.toContain("from '../features/mapIcons'");
    expect(ui).toContain('openMap(frame: MapViewFrame): void { this.mapView.show(frame); }');
    expect(ui).toContain('this.minimapView.draw(x, z, heading, roads, markers, police');
  });
});
