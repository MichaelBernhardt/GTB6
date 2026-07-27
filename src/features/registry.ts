import { approachNear, fuelHud, fuelTick, sanitizeFuelSave } from './fuel.state';
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
    id: 'fuel', saveKey: 'fuel', label: 'Petrol',
    sanitize: sanitizeFuelSave,
    load: () => import('./fuel/fuel'),
    // Petrol is the one feature that has to be TRUE before the player opts in — a tank that only
    // starts draining once you have pulled into a garage is a mechanic you can decline, and a gauge
    // that only appears once the chunk lands is a gauge nobody ever sees. Both live in the eager
    // slice; the body takes over the moment it loads. See FeatureEagerSlice in types.ts.
    eager: {
      tick: (dt, ctx) => fuelTick(dt, ctx),
      hud: (ctx) => fuelHud(ctx),
    },
    approach: {
      context: 'vehicle', order: 12, prompt: 'E  Pull in for petrol',
      near: (ctx) => approachNear(ctx.vehicle, ctx.position.x, ctx.position.z),
    },
  },
];

export function findFeature(id: string): FeatureDescriptor | undefined {
  return FEATURES.find((feature) => feature.id === id);
}
