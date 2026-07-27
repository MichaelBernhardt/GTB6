import { sanitizeProtestState, shutdownPending } from './protest.state';
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
    // A PURE predicate — one read, no side effect, and that is load-bearing.
    //
    // This used to tick the grievance clock here, on the grounds that `near()` is the only per-frame
    // hook an unloaded feature gets. It is, and it is also not reliable: `resolveInteraction` returns
    // on the FIRST descriptor that offers something, and `order: 60` puts this one below every other
    // feature. On a registry with only protest in it the clock ran; with anything else registered
    // above it the clock stopped dead wherever the player was standing — the cross-feature verifier
    // measured 3.90 outage-hours out in the open street and 0.00 on a street corner or a doorstep.
    // Since the ledger is this feature's ONLY unlock gate, that would have shipped a feature that can
    // never trigger. The clock now runs off powerGrid's own transition hook; see protest.state.ts.
    approach: {
      context: 'foot', order: 60, prompt: 'E  Follow the smoke',
      near: () => shutdownPending(false),
    },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
