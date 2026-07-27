import { ASK_AROUND_RADIUS, nearestStreetSite, sanitizeStreetState } from './street.state';
import type { FeatureDescriptor } from './types';

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
export const FEATURES: readonly FeatureDescriptor[] = [
  // { id: 'golf', saveKey: 'golf', label: 'Golf', sanitize: sanitizeGolfState, load: () => import('./golf/golf') },
  {
    id: 'street', saveKey: 'street', label: 'Street economy',
    sanitize: sanitizeStreetState,
    load: () => import('./street/street'),
    // The eager stand-in, and — this is the part that bit — the ONLY thing in the whole build that
    // loads the street economy in ordinary play. There is no passive preload hook on FeatureApproach
    // and only one context per feature, so a player who never presses E on foot inside this ring
    // never fetches the chunk, and the twelve corners simply do not exist. The ring is therefore a
    // BLOCK (see ASK_AROUND_RADIUS), not a doorstep: standing anywhere on a block that has a trade on
    // it says so, and one press loads the feature, staffs the corner and tells you which way to walk.
    approach: {
      context: 'foot', order: 58, prompt: 'E  Ask around · somebody works this block',
      near: (ctx) => {
        const near = nearestStreetSite(ctx.position.x, ctx.position.z);
        return near !== undefined && near.distanceSq < ASK_AROUND_RADIUS * ASK_AROUND_RADIUS;
      },
    },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
