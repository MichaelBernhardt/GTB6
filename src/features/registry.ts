import { nearestStreetSite, sanitizeStreetState, STREET_LOAD_RADIUS } from './street.state';
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
    // The proximity ring. FeatureHost.preloadNearby() watches this every 0.4 s and loads the body
    // the moment the player is inside it, so the corners are staffed, lit and blipped BEFORE the
    // player is close enough to see anybody — which is the whole difference between "there are
    // people on the street" and the owner's playtest, where pressing E on this prompt was the only
    // thing in the entire build that could make them exist.
    //
    // The prompt below is now a fallback that a player should never see: it only rejoins the ladder
    // if the chunk fetch itself fails. It stays because a failed fetch must not mean a dead street.
    approach: {
      context: 'foot', order: 58, prompt: 'E  Ask around · somebody works this block',
      near: (ctx) => {
        const near = nearestStreetSite(ctx.position.x, ctx.position.z);
        return near !== undefined && near.distanceSq < STREET_LOAD_RADIUS * STREET_LOAD_RADIUS;
      },
    },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
