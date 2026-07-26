import { sanitizeProtestState, shutdownPending, tickOutage } from './protest.state';
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
    id: 'protest', saveKey: 'protest', label: 'Protests + burning tyres',
    sanitize: sanitizeProtestState,
    load: () => import('./protest/protest'),
    // The eager stand-in does double duty, and both halves are cheap. `near()` is called once per
    // rendered frame on the foot ladder while the body is unloaded, which is the ONLY per-frame hook
    // an unloaded feature gets — so the grievance clock ticks here, off the live grid state, long
    // before any of the protest chunk exists. Then it answers the real question: is there a shutdown
    // to walk toward? `order: 60` keeps it below every other feature's rung, so ticking the clock can
    // never shadow a shop door or a tee box; it merely means the clock skips the frames where the
    // player is standing in someone else's doorway.
    approach: {
      context: 'foot', order: 60, prompt: 'E  Follow the smoke',
      near: (ctx) => { tickOutage(ctx.hour, ctx.position.x, ctx.position.z); return shutdownPending(false); },
    },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
