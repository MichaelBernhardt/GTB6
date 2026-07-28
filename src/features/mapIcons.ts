/**
 * The always-on map blips features contribute — EAGER, and deliberately so.
 *
 * A feature body loads when you walk up to it, which is exactly right for the thing itself and
 * exactly wrong for the icon that tells you where the thing is. An icon you only get once you are
 * standing on the forecourt is an icon for a place you have already found. This is the same class of
 * bug as the fuel gauge that lived in the lazy chunk: the owner drove a whole session with a working
 * gauge and reported "I can't find a station" — because nothing on the map said where one was.
 *
 * So this module is one path segment under src/features/ (see vite.config.ts) and rides in the eager
 * `gameplay-rules` chunk with the registry and the state slices. It reads ONLY from `<id>.state.ts`
 * modules that are already eager; it never touches a feature body, and nothing here may import from
 * src/features/<id>/.
 *
 * THE SEAM. Game.mapMarkers() is the canonical marker source (shops, safehouses, the objective) and
 * Game.ts is off limits on this branch, so UIManager — the one funnel both the minimap and the M-map
 * pass through — merges these in. That is a strictly downward chunk edge (the Game chunk already
 * imports gameplay-rules) and it puts the blips on BOTH surfaces from one call site. If a future
 * branch may touch Game.ts, the tidier home is a `mapIcons` hook on FeatureDescriptor collected by
 * FeatureHost and spread into Game.mapMarkers() beside `this.shops.mapIcons()`.
 */
import { fuelMapIcons } from './fuel.state';

/** Petrol orange. Chosen against the palette already in play so it is not a second reading of an
 *  existing blip: shops are teal diamonds (#3fd1c4), missions and taxi hails gold, police blue
 *  squares, hostiles red dots. The pump silhouette carries the meaning; the colour only reinforces
 *  it, which is what keeps it legible for a colour-blind player. */
export const FUEL_ICON_COLOR = '#f2913d';

/** A blip in the minimap's own language — the same shape MapMarker takes, without importing it (that
 *  type lives in the `simulation` chunk and this module must stay a leaf of `gameplay-rules`). */
export interface FeatureMapIcon {
  readonly x: number;
  readonly z: number;
  readonly color: string;
  readonly shape: 'circle' | 'diamond' | 'house' | 'fuel';
}

/**
 * Every eager feature blip for this frame.
 *
 * Called once per rendered frame from UIManager.drawMap and again from updateMap while the M-map is
 * open, so it stays allocation-light: nineteen forecourts is the whole list today. A feature with a
 * bigger catalogue should memoize behind its own state module, not here.
 */
export function featureMapIcons(): FeatureMapIcon[] {
  const icons: FeatureMapIcon[] = [];
  for (const spot of fuelMapIcons()) icons.push({ x: spot.x, z: spot.z, color: FUEL_ICON_COLOR, shape: 'fuel' });
  return icons;
}
