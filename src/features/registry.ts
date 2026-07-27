import { sanitizeInteriorsState, streetsHere } from './interiors.state';
import type { FeatureApproach, FeatureDescriptor } from './types';

/**
 * The ONE eager module in the feature system. Everything here is loaded at boot, so keep it to
 * descriptors: an id, a save key, a label, an optional sanitizer, an optional proximity stand-in,
 * and a `load()` that dynamic-imports the body. No scene objects, no world geometry, no tables.
 *
 * Adding a feature is ONE entry in this array — see src/features/README.md.
 *
 * BUNDLE RULES (verified against a real build; breaking either one costs boot bytes forever):
 *  - Never import anything from `./<id>/` here except through the `load()` dynamic import. A static
 *    import would pull the whole feature body into the eager graph and defeat the entire design.
 *  - If a sanitizer is too big to write inline, put it in a TOP-LEVEL `src/features/<id>.state.ts`
 *    (one path segment), which vite.config.ts sweeps into the `gameplay-rules` chunk. A state module
 *    inside `src/features/<id>/` imported from BOTH here and the lazy body becomes its own extra
 *    eager chunk — import it with `import type` from the body.
 */

/** See host.descriptors(). An approach may ask to be loaded BEFORE the player is close enough to
 *  press anything, so a feature that puts things in the world has something to be seen. It is not on
 *  FeatureApproach yet — types.ts is frozen while five branches land — so it rides along as an
 *  optional extra the host duck-types. */
type PreloadingApproach = FeatureApproach & { preload(x: number, z: number): boolean };

export const FEATURES: readonly FeatureDescriptor[] = [
  {
    id: 'interiors', saveKey: 'interiors', label: 'Building interiors',
    sanitize: sanitizeInteriorsState,
    load: () => import('./interiors/interiors'),
    // `near` stays false on purpose: this feature's prompt belongs to real doors on real buildings,
    // and only the body knows where those are — CityGen cannot be reached from an eager chunk
    // without making gameplay-rules and simulation mutually uninitialisable (see interiors.state.ts).
    // `preload` is what makes the doorways EXIST to be walked up to: standing in a street is enough.
    approach: {
      context: 'foot', order: 50, prompt: 'E  Go inside',
      near: () => false,
      preload: (x, z) => streetsHere(x, z),
    } as PreloadingApproach,
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
